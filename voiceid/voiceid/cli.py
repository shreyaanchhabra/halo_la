"""Command-line interface. Everything prints JSON (one object per line) so other programs can consume it."""
from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
from pathlib import Path

from .config import Config


def _emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _load(args) -> Config:
    return Config.from_json(args.config).with_policy_file(getattr(args, "policy", None))


def _runtime(cfg: Config):
    from .embedder import make_embedder
    from .vad import make_vad

    return make_embedder(cfg.model), make_vad(cfg.vad, cfg.preproc.sample_rate)


def cmd_setup_models(args, cfg):
    from .embedder import download_model

    path = download_model(cfg.model)
    print(f"Model downloaded to {path}. From now on inference runs offline.")


def _summarize(speakers) -> None:
    """Plain-English summary on stderr (the JSON on stdout stays machine-readable)."""
    for sp in speakers:
        mark = "OK  " if sp.status == "ok" else "FAIL"
        print(f"[{mark}] {sp.source_key}: {sp.usable} usable recording(s) "
              f"({sp.embedded} new, {sp.reused} reused), {len(sp.failed)} failed -> "
              f"{sp.speaker_id or 'NOT REGISTERED'}", file=sys.stderr)
        for path, why in sp.failed:
            print(f"        x {path}: {why}", file=sys.stderr)
        for path in sp.ignored:
            print(f"        - ignored (not an audio file type): {path}", file=sys.stderr)
        for w in sp.warnings:
            print(f"        ! {w}", file=sys.stderr)


def _ffmpeg_hint(speakers) -> None:
    if any("ffmpeg" in why for sp in speakers for _, why in sp.failed):
        print("\nHINT: some files need ffmpeg to be decoded. Install it (macOS: `brew install ffmpeg`) and re-run.",
              file=sys.stderr)


def _enroll(args, cfg, only=None):
    from .enrollment import ConsentRequired, Enroller
    from .storage import ProfileStore

    store = ProfileStore(cfg.db_path)
    emb, vad = _runtime(cfg)
    enr = Enroller(cfg, store, emb, vad)
    try:
        if only:
            rep = enr.enroll_speaker(only, args.reference_dir or cfg.reference_dir, consent=args.consent)
            _summarize([rep])
            _ffmpeg_hint([rep])
            _emit({"speakers": [rep.__dict__]})
            return 0 if rep.status == "ok" else 1
        rep = enr.enroll_all(args.reference_dir or cfg.reference_dir, consent=args.consent,
                             remove_missing=getattr(args, "remove_missing", False))
    except ConsentRequired as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    _summarize(rep.speakers)
    _ffmpeg_hint(rep.speakers)
    for key in rep.registered_without_directory:
        print(f"[WARN] '{key}' is registered but has no folder under the reference dir", file=sys.stderr)
    if not rep.speakers:
        print(f"[FAIL] no speaker folders found under '{args.reference_dir or cfg.reference_dir}'. "
              "Expected <reference-dir>/<person>/<recordings>. Did you point --reference-dir one level too deep?",
              file=sys.stderr)
    _emit(rep.to_dict())
    return 1 if (rep.failed_recordings or not rep.speakers) else 0


def cmd_enroll(args, cfg):
    return _enroll(args, cfg)


def cmd_update(args, cfg):
    return _enroll(args, cfg, only=args.speaker)


def cmd_list(args, cfg):
    from .storage import ProfileStore

    for s in ProfileStore(cfg.db_path).list_speakers():
        _emit(s.__dict__)


def cmd_delete(args, cfg):
    from .storage import ProfileStore

    if not args.yes and input(f"Permanently delete '{args.speaker}' and their voice profile? [y/N] ").lower() != "y":
        return 1
    ok = ProfileStore(cfg.db_path).delete_speaker(args.speaker)
    print("deleted" if ok else "no such speaker")
    return 0 if ok else 1


def cmd_calibrate(args, cfg):
    from .calibration import calibrate_policy, leave_one_out_scores
    from .storage import ProfileStore

    extra = []
    if args.impostor_dir:
        from .audio import is_candidate_audio, load_audio
        from .vad import trim_to_speech

        emb, vad = _runtime(cfg)
        for p in sorted(Path(args.impostor_dir).rglob("*")):
            if is_candidate_audio(p):
                a, sp = trim_to_speech(load_audio(p, cfg.preproc.sample_rate), vad, cfg.vad.threshold,
                                       cfg.preproc.trim_pad_ms, cfg.preproc.sample_rate)
                if sp >= cfg.preproc.min_speech_s:
                    extra.append(emb.embed(a))
    gen, imp = leave_one_out_scores(ProfileStore(cfg.db_path), extra)
    policy, report = calibrate_policy(gen, imp, cfg.policy, target_far=args.target_far)
    Path(args.out).write_text(json.dumps(report["policy"], indent=2))
    _emit(report)
    print(f"Wrote calibrated policy to {args.out}. Use it with: voiceid run --policy {args.out}", file=sys.stderr)


def cmd_devices(args, cfg):
    import sounddevice as sd

    print(sd.query_devices())


def _build_identifier(cfg):
    from .matching import DecisionPolicy, SpeakerIdentifier, SpeakerIndex
    from .storage import ProfileStore

    emb, vad = _runtime(cfg)
    index, skipped = SpeakerIndex.from_store(ProfileStore(cfg.db_path), emb, cfg.preproc.fingerprint(cfg.vad))
    for sid, why in skipped:
        logging.warning("profile %s skipped: %s", sid, why)
    return emb, vad, index, SpeakerIdentifier(emb, index, DecisionPolicy(cfg.policy))


def cmd_identify(args, cfg):
    """Score recordings against the registered profiles. Use it to test each person separately."""
    from .audio import load_audio
    from .vad import trim_to_speech

    emb, vad, index, ident = _build_identifier(cfg)
    print(f"registered speakers in use: {index.names or 'NONE'}", file=sys.stderr)
    sr = cfg.preproc.sample_rate
    for f in args.files:
        audio = load_audio(f, sr)
        step = int(args.segment_seconds * sr) if args.segment_seconds > 0 else len(audio)
        for i in range(0, max(1, len(audio) - step // 2), step):
            seg = audio[i:i + step]
            _, speech_s = trim_to_speech(seg, vad, cfg.vad.threshold, cfg.preproc.trim_pad_ms, sr)
            d = ident.identify(seg, speech_seconds=speech_s).to_dict()
            _emit({"file": str(f), "offset_s": round(i / sr, 1), **d})


def cmd_run(args, cfg):
    from .live import LiveEngine, run_microphone
    from .matching import DecisionPolicy, SpeakerIdentifier, SpeakerIndex
    from .storage import ProfileStore

    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    emb, vad = _runtime(cfg)          # models are loaded once, here
    store = ProfileStore(cfg.db_path)
    index, skipped = SpeakerIndex.from_store(store, emb, cfg.preproc.fingerprint(cfg.vad))
    for sid, why in skipped:
        logging.warning("profile %s skipped: %s", sid, why)
    if len(index) == 0:
        print("error: no usable registered speakers. Run `voiceid enroll` first.", file=sys.stderr)
        return 1
    if not cfg.policy.calibrated:
        logging.warning("decision thresholds are UNCALIBRATED defaults; run `voiceid calibrate` / scripts/evaluate.py")
    ident = SpeakerIdentifier(emb, index, DecisionPolicy(cfg.policy))
    engine = LiveEngine(cfg, ident, vad,
                        on_decision=(lambda d: None) if args.events_only else (lambda d: _emit({"type": "result", **d})),
                        on_event=lambda e: _emit({"type": "event", **e}))
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    engine.start()
    logging.info("listening on %s (Ctrl+C to stop); %d registered speaker(s)", args.device or "default input", len(index))
    with run_microphone(engine, args.device, cfg.preproc.sample_rate):
        stop.wait()
    engine.stop()
    logging.info("stats: %s", engine.stats)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="voiceid", description=__doc__)
    ap.add_argument("--config", help="JSON config file (see README)")
    ap.add_argument("--policy", help="JSON policy file written by `voiceid calibrate`")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("setup-models", help="download the speaker model (the only step that needs internet)").set_defaults(fn=cmd_setup_models)

    p = sub.add_parser("enroll", help="register/refresh every speaker directory under the reference dir")
    p.add_argument("--reference-dir")
    p.add_argument("--consent", action="store_true", help="confirm every NEW person in the directory consented to being enrolled")
    p.add_argument("--remove-missing", action="store_true", help="delete registered speakers whose directory is gone")
    p.set_defaults(fn=cmd_enroll)

    p = sub.add_parser("update", help="re-enroll a single speaker (directory name or speaker id)")
    p.add_argument("speaker")
    p.add_argument("--reference-dir")
    p.add_argument("--consent", action="store_true")
    p.set_defaults(fn=cmd_update)

    sub.add_parser("list", help="list registered speakers").set_defaults(fn=cmd_list)

    p = sub.add_parser("delete", help="remove a speaker and all of their stored voice data")
    p.add_argument("speaker")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_delete)

    p = sub.add_parser("calibrate", help="derive thresholds from your recordings")
    p.add_argument("--out", default="policy.json")
    p.add_argument("--target-far", type=float, default=0.01)
    p.add_argument("--impostor-dir", help="optional recordings of people who are NOT registered")
    p.set_defaults(fn=cmd_calibrate)

    p = sub.add_parser("identify", help="score audio file(s) against registered profiles (for testing)")
    p.add_argument("files", nargs="+")
    p.add_argument("--segment-seconds", type=float, default=0, help="split each file into chunks of this length (0 = whole file)")
    p.set_defaults(fn=cmd_identify)

    sub.add_parser("devices", help="list audio input devices").set_defaults(fn=cmd_devices)

    p = sub.add_parser("run", help="identify speakers from the microphone")
    p.add_argument("--device", help="sounddevice input device index or name")
    p.add_argument("--events-only", action="store_true", help="print identity events but not every result")
    p.set_defaults(fn=cmd_run)

    args = ap.parse_args(argv)
    cfg = _load(args)
    return args.fn(args, cfg) or 0


if __name__ == "__main__":
    sys.exit(main())
