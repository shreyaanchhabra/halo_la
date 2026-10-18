#!/usr/bin/env python3
"""Measure accuracy and latency on recordings that were NOT used for enrollment.

Layout of --heldout-dir:
    heldout_audio/<registered_person>/*.wav          genuine trials (folder name must match a reference folder)
    heldout_audio/_unregistered/<anyone>/*.wav       impostor trials: people who are NOT enrolled

Reports (per trial = one segment of --segment-seconds, or whole files if 0):
    FRR  : genuine trials that did not produce MATCH
    misID: genuine trials that produced MATCH for the wrong person
    FAR  : unregistered-speaker trials that produced MATCH
    top-1: closed-set accuracy ignoring thresholds (is the best-scoring profile the right one?)
    latency: model processing time per trial (embedding + matching) and, with --e2e, real-time pipeline latency.
Nothing here is a claim about your system until you run it on your recordings.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from voiceid.audio import is_candidate_audio, load_audio  # noqa: E402
from voiceid.config import Config  # noqa: E402
from voiceid.enrollment import Enroller  # noqa: E402
from voiceid.matching import DecisionPolicy, SpeakerIdentifier, SpeakerIndex, Status  # noqa: E402
from voiceid.storage import ProfileStore  # noqa: E402
from voiceid.vad import trim_to_speech  # noqa: E402


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def _segments(audio, sr, seconds):
    if seconds <= 0 or len(audio) <= seconds * sr * 1.25:
        return [audio]
    step = int(seconds * sr)
    return [audio[i:i + step] for i in range(0, len(audio) - step // 2, step)]


def _files(folder: Path):
    return sorted(p for p in folder.rglob("*") if is_candidate_audio(p))


def run_evaluation(cfg: Config, embedder, vad, reference_dir, heldout_dir, segment_seconds=3.0, e2e=0):
    sr = cfg.preproc.sample_rate
    with tempfile.TemporaryDirectory() as tmp:
        store = ProfileStore(Path(tmp) / "eval.db")  # throw-away DB: never touches your real profiles
        enr = Enroller(cfg, store, embedder, vad).enroll_all(reference_dir, consent=True)
        index, skipped = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
        ident = SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy))
        key_to_id = {s.source_key: s.speaker_id for s in store.list_speakers()}

        genuine, impostor, proc_ms, top1_ok, top1_n = [], [], [], 0, 0
        trials = []
        for folder in sorted(p for p in Path(heldout_dir).iterdir() if p.is_dir()):
            is_imp = folder.name == "_unregistered"
            if not is_imp and folder.name not in key_to_id:
                print(f"warning: held-out folder '{folder.name}' has no registered speaker; skipped", file=sys.stderr)
                continue
            for f in _files(folder):
                for seg in _segments(load_audio(f, sr), sr, segment_seconds):
                    trimmed, speech_s = trim_to_speech(seg, vad, cfg.vad.threshold, cfg.preproc.trim_pad_ms, sr)
                    d = ident.identify(seg, speech_seconds=speech_s)
                    if d.processing_ms is not None:
                        proc_ms.append(d.processing_ms)
                    trials.append(seg)
                    if is_imp:
                        impostor.append(d)
                    else:
                        genuine.append((key_to_id[folder.name], d))
                        if d.candidates:
                            top1_n += 1
                            top1_ok += d.candidates[0].speaker_id == key_to_id[folder.name]

        n_g, n_i = len(genuine), len(impostor)
        not_match = sum(d.status is not Status.MATCH for _, d in genuine)
        mis = sum(d.status is Status.MATCH and d.speaker_id != t for t, d in genuine)
        correct = sum(d.status is Status.MATCH and d.speaker_id == t for t, d in genuine)
        far_k = sum(d.status is Status.MATCH for d in impostor)
        rep = {
            "policy": cfg.policy.__dict__, "enrollment_failures": enr.failed_recordings,
            "incompatible_profiles": skipped, "segment_seconds": segment_seconds,
            "genuine_trials": n_g, "unregistered_trials": n_i,
            "genuine_outcomes": dict(Counter(d.status.value for _, d in genuine)),
            "unregistered_outcomes": dict(Counter(d.status.value for d in impostor)),
            "identification_accuracy": correct / n_g if n_g else None,
            "closed_set_top1": top1_ok / top1_n if top1_n else None,
            "FRR": not_match / n_g if n_g else None, "FRR_95ci": wilson(not_match, n_g),
            "misidentification_rate": mis / n_g if n_g else None,
            "FAR": far_k / n_i if n_i else None, "FAR_95ci": wilson(far_k, n_i),
            "processing_ms": ({"mean": float(np.mean(proc_ms)), "p50": float(np.percentile(proc_ms, 50)),
                               "p95": float(np.percentile(proc_ms, 95)), "n": len(proc_ms)} if proc_ms else None),
        }
        if e2e and trials:
            rep["e2e_latency_ms"] = _e2e(cfg, ident, vad, trials[:e2e], sr)
        store.close()
        return rep


def _e2e(cfg, ident, vad, segs, sr):
    """Stream segments through the real LiveEngine at real-time pace; latency = utterance emitted -> decision."""
    from voiceid.live import LiveEngine

    out = []
    eng = LiveEngine(cfg, ident, vad, on_decision=out.append)
    eng.start()
    n = cfg.vad.frame_samples
    gap = np.zeros(int(1.5 * sr), dtype=np.float32)
    for seg in segs:
        audio = np.concatenate([seg, gap])
        t0 = time.perf_counter()
        for i in range(0, len(audio), n):
            eng.audio_callback(audio[i:i + n].reshape(-1, 1))
            time.sleep(max(0.0, t0 + (i + n) / sr - time.perf_counter()))
    eng.stop()
    lat = [d["latency_ms"] for d in out if d["latency_ms"] is not None]
    return {"utterances": len(lat), "mean": float(np.mean(lat)) if lat else None,
            "p95": float(np.percentile(lat, 95)) if lat else None,
            "note": f"measured from the moment the utterance is closed; add the {cfg.segmenter.end_silence_ms} ms "
                    "end-of-speech silence the segmenter waits for to get speech-end -> decision"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reference-dir", required=True)
    ap.add_argument("--heldout-dir", required=True)
    ap.add_argument("--config")
    ap.add_argument("--policy")
    ap.add_argument("--segment-seconds", type=float, default=3.0)
    ap.add_argument("--e2e", type=int, default=0, metavar="N", help="also stream N segments through the live engine in real time")
    ap.add_argument("--out", help="write JSON report here")
    a = ap.parse_args()
    cfg = Config.from_json(a.config).with_policy_file(a.policy)
    from voiceid.embedder import make_embedder
    from voiceid.vad import make_vad

    rep = run_evaluation(cfg, make_embedder(cfg.model), make_vad(cfg.vad, cfg.preproc.sample_rate), a.reference_dir,
                         a.heldout_dir, a.segment_seconds, a.e2e)
    text = json.dumps(rep, indent=2, default=str)
    print(text)
    if a.out:
        Path(a.out).write_text(text)


if __name__ == "__main__":
    main()
