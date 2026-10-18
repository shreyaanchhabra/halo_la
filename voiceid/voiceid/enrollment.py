"""Enrollment: reference recordings -> per-recording embeddings -> one profile per person.

Aggregation strategy (documented, deterministic):
    profile = L2_normalise( mean( L2_normalise(e_i) for each valid recording i ) )
i.e. a length-normalised centroid, so every recording counts equally regardless of length.
Scoring against a profile is cosine similarity.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

from .audio import AudioError, file_sha256, is_candidate_audio, load_audio, rms
from .config import Config
from .embedder import Embedder, l2_normalize
from .storage import ProfileStore, now_iso
from .vad import FrameVAD, trim_to_speech


class ConsentRequired(RuntimeError):
    pass


@dataclass
class SpeakerReport:
    source_key: str
    speaker_id: Optional[str] = None
    display_name: Optional[str] = None
    status: str = "ok"             # ok | no_usable_recordings | directory_missing
    embedded: int = 0              # newly computed this run
    reused: int = 0                # served from stored embeddings (file + settings unchanged)
    failed: list[tuple[str, str]] = field(default_factory=list)   # (rel_path, reason)
    warnings: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)              # stored recordings no longer on disk
    profile_changed: bool = False
    ignored: list[str] = field(default_factory=list)   # skipped on purpose (e.g. .txt/.jpg), listed so nothing vanishes silently

    @property
    def ignored_files(self) -> int:
        return len(self.ignored)

    @property
    def usable(self) -> int:
        return self.embedded + self.reused


@dataclass
class EnrollmentReport:
    speakers: list[SpeakerReport] = field(default_factory=list)
    registered_without_directory: list[str] = field(default_factory=list)
    removed_speakers: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def failed_recordings(self) -> list[tuple[str, str, str]]:
        return [(s.source_key, p, r) for s in self.speakers for p, r in s.failed]


def display_name_from_key(key: str) -> str:
    return key.replace("_", " ").replace("-", " ").strip().title()


class Enroller:
    def __init__(self, cfg: Config, store: ProfileStore, embedder: Embedder, vad: FrameVAD):
        self.cfg, self.store, self.embedder, self.vad = cfg, store, embedder, vad
        self.preproc_hash = cfg.preproc.fingerprint(cfg.vad)
        self._preproc_json = json.dumps({"preproc": asdict(cfg.preproc), "vad": asdict(cfg.vad),
                                         "aggregation": "mean_of_l2_normalised_embeddings,l2_normalised"}, sort_keys=True)

    # ---- public -----------------------------------------------------------
    def enroll_all(self, reference_dir: Optional[str | Path] = None, consent: bool = False,
                   remove_missing: bool = False) -> EnrollmentReport:
        root = Path(reference_dir or self.cfg.reference_dir)
        if not root.is_dir():
            raise FileNotFoundError(f"reference directory not found: {root}")
        report = EnrollmentReport()
        keys = sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))
        for key in keys:
            report.speakers.append(self.enroll_speaker(key, root, consent))
        known = {s.source_key for s in self.store.list_speakers()}
        for missing in sorted(known - set(keys)):
            if remove_missing:
                self.store.delete_speaker(missing)
                report.removed_speakers.append(missing)
            else:
                report.registered_without_directory.append(missing)
        return report

    def enroll_speaker(self, key: str, reference_dir: Optional[str | Path] = None, consent: bool = False) -> SpeakerReport:
        """Register or update ONE speaker from <reference_dir>/<key>/. Other speakers are untouched."""
        root = Path(reference_dir or self.cfg.reference_dir)
        folder = root / key
        rep = SpeakerReport(source_key=key)
        if not folder.is_dir():
            rep.status = "directory_missing"
            rep.failed.append((key, "speaker directory not found"))
            return rep

        existing = self.store.find_speaker(key)
        if existing is None and not consent:
            raise ConsentRequired(
                f"'{key}' is not registered yet. Voice profiles are biometric-related data: confirm you have "
                "the person's consent (pass consent=True / --consent).")

        files = sorted(p for p in folder.rglob("*") if p.is_file() and not p.name.startswith("."))
        audio_files = [p for p in files if is_candidate_audio(p)]
        rep.ignored = [p.relative_to(folder).as_posix() for p in files if not is_candidate_audio(p)]
        if not files:
            rep.failed.append((key, "folder contains no files"))

        results = []  # (rel_path, abs_path, sha, embedding, duration, speech_s, reused)
        for path in audio_files:
            rel = path.relative_to(folder).as_posix()
            try:
                results.append(self._process(existing.speaker_id if existing else None, rel, path, rep))
            except (AudioError, ValueError) as e:
                rep.failed.append((rel, str(e)))
            except Exception as e:  # noqa: BLE001 - one bad file must never abort the batch
                rep.failed.append((rel, f"unexpected error: {type(e).__name__}: {e}"))

        if not results:
            rep.status = "no_usable_recordings"
            if existing:
                rep.speaker_id, rep.display_name = existing.speaker_id, existing.display_name
                rep.warnings.append("no usable recordings; the existing stored profile was left unchanged")
            return rep

        if existing is None:
            sid = self.store.create_speaker(key, display_name_from_key(key), now_iso())
            existing = self.store.find_speaker(sid)
        elif consent:
            self.store.set_consent(existing.speaker_id, now_iso())
        rep.speaker_id, rep.display_name = existing.speaker_id, existing.display_name

        normed = []
        for rel, apath, sha, emb, dur, sp, reused in results:
            normed.append(l2_normalize(emb))
            rep.reused += reused
            rep.embedded += (not reused)
            self.store.upsert_recording(existing.speaker_id, rel, str(apath), sha, dur, sp, emb,
                                        self.embedder.model_id, self.embedder.model_version, self.preproc_hash)
        rep.removed = self.store.prune_recordings(existing.speaker_id, {r[0] for r in results})

        mat = np.stack(normed)
        try:
            profile = l2_normalize(mat.mean(axis=0))
        except ValueError:
            rep.status = "no_usable_recordings"
            rep.failed.append((key, "embeddings cancelled out; recordings may not be of one voice"))
            return rep
        if len(normed) >= 3:  # mislabelled-file check: cosine of each file to the centroid of the others
            for i, (rel, *_rest) in enumerate(results):
                others = l2_normalize(np.delete(mat, i, axis=0).mean(axis=0))
                cos = float(mat[i] @ others)
                if cos < self.cfg.preproc.outlier_warn_cosine:
                    rep.warnings.append(f"{rel}: only {cos:.2f} similar to the other recordings; wrong person or bad audio?")
        rep.profile_changed = self.store.set_profile(existing.speaker_id, profile, self.embedder.model_id,
                                                     self.embedder.model_version, self.preproc_hash,
                                                     self._preproc_json, len(results))
        return rep

    # ---- internals ----------------------------------------------------------
    def _process(self, speaker_id, rel: str, path: Path, rep: SpeakerReport):
        sha = file_sha256(path)
        if speaker_id:
            cached = self.store.get_recording(speaker_id, rel)
            if (cached and cached.sha256 == sha and cached.preproc_hash == self.preproc_hash
                    and cached.model_id == self.embedder.model_id and cached.model_version == self.embedder.model_version
                    and cached.embedding.shape[0] == self.embedder.dim):
                return rel, path, sha, cached.embedding, cached.duration_s, cached.speech_s, True

        pc = self.cfg.preproc
        audio = load_audio(path, pc.sample_rate)
        duration = len(audio) / pc.sample_rate
        if duration < pc.min_recording_s:
            raise AudioError(f"too short ({duration:.2f}s < {pc.min_recording_s}s)")
        if rms(audio) < pc.min_rms:
            raise AudioError("recording is silent or nearly silent")
        audio = audio[: int(pc.max_recording_s * pc.sample_rate)]
        if pc.trim_silence:
            audio, speech_s = trim_to_speech(audio, self.vad, self.cfg.vad.threshold, pc.trim_pad_ms, pc.sample_rate)
        else:
            speech_s = len(audio) / pc.sample_rate
        if speech_s < pc.min_speech_s:
            raise AudioError(f"only {speech_s:.2f}s of speech detected (need {pc.min_speech_s}s)")
        emb = self.embedder.embed(audio)
        if emb.shape[0] != self.embedder.dim or not np.all(np.isfinite(emb)) or not np.any(emb):
            raise ValueError("model produced an invalid embedding")
        return rel, path, sha, emb, duration, speech_s, False
