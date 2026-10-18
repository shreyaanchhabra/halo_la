"""Speaker matching and the decision policy. Independent of any display or hardware."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

import numpy as np

from .audio import clip_ratio, rms
from .config import PolicyConfig
from .embedder import Embedder, l2_normalize
from .storage import ProfileStore


class Status(str, Enum):
    MATCH = "MATCH"
    UNKNOWN = "UNKNOWN"
    UNCERTAIN = "UNCERTAIN"


@dataclass
class Candidate:
    speaker_id: str
    speaker_name: str
    score: float


@dataclass
class Decision:
    status: Status
    speaker_id: Optional[str]
    speaker_name: Optional[str]
    similarity_score: Optional[float]   # best candidate's RAW cosine similarity. Not a probability/confidence.
    timestamp: str
    reason: str
    margin: Optional[float] = None      # best minus second-best
    speech_seconds: float = 0.0
    processing_ms: Optional[float] = None   # embedding + matching time
    latency_ms: Optional[float] = None      # end of utterance -> decision (set by the live engine)
    candidates: list[Candidate] = field(default_factory=list)  # top-3, for debugging/evaluation only

    def to_dict(self) -> dict:
        return {
            "status": self.status.value,
            "speaker_id": self.speaker_id,
            "speaker_name": self.speaker_name,
            "similarity_score": None if self.similarity_score is None else round(self.similarity_score, 4),
            "timestamp": self.timestamp,
            "reason": self.reason,
            "margin": None if self.margin is None else round(self.margin, 4),
            "speech_seconds": round(self.speech_seconds, 2),
            "processing_ms": None if self.processing_ms is None else round(self.processing_ms, 1),
            "latency_ms": None if self.latency_ms is None else round(self.latency_ms, 1),
            "candidates": [{"speaker_id": c.speaker_id, "speaker_name": c.speaker_name, "score": round(c.score, 4)}
                           for c in self.candidates],
        }


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class SpeakerIndex:
    """All registered profiles that are compatible with the active model + preprocessing."""

    def __init__(self, ids: list[str], names: list[str], matrix: np.ndarray):
        self.ids, self.names, self.matrix = ids, names, matrix  # matrix rows are unit vectors

    def __len__(self) -> int:
        return len(self.ids)

    @classmethod
    def from_store(cls, store: ProfileStore, embedder: Embedder, preproc_hash: str):
        ids, names, rows, skipped = [], [], [], []
        for p in store.load_profiles():
            problem = None
            if p.model_id != embedder.model_id or p.model_version != embedder.model_version:
                problem = f"built with model {p.model_id}/{p.model_version}, running {embedder.model_id}/{embedder.model_version}"
            elif p.dim != embedder.dim or p.vector.shape[0] != embedder.dim:
                problem = f"embedding dimension {p.dim} != {embedder.dim}"
            elif p.preproc_hash != preproc_hash:
                problem = "preprocessing configuration changed since enrollment"
            if problem:
                skipped.append((p.speaker_id, f"{problem}; re-run enrollment"))
                continue
            ids.append(p.speaker_id)
            names.append(p.display_name)
            rows.append(l2_normalize(p.vector))
        matrix = np.stack(rows) if rows else np.zeros((0, embedder.dim), dtype=np.float32)
        return cls(ids, names, matrix), skipped

    def rank(self, embedding: np.ndarray) -> list[Candidate]:
        if len(self) == 0:
            return []
        scores = self.matrix @ l2_normalize(embedding)  # cosine similarity
        order = np.argsort(-scores)
        return [Candidate(self.ids[i], self.names[i], float(scores[i])) for i in order]


class DecisionPolicy:
    def __init__(self, cfg: PolicyConfig):
        self.cfg = cfg

    def check_quality(self, audio: np.ndarray, speech_seconds: float) -> Optional[str]:
        c = self.cfg
        if speech_seconds < c.min_speech_s:
            return f"insufficient speech ({speech_seconds:.2f}s < {c.min_speech_s}s)"
        if rms(audio) < c.min_rms:
            return "audio too quiet to identify reliably"
        if clip_ratio(audio) > c.max_clip_ratio:
            return "audio is clipped/distorted"
        return None

    def decide(self, ranked: list[Candidate]) -> tuple[Status, str]:
        c = self.cfg
        if not ranked:
            return Status.UNKNOWN, "no compatible registered profiles to compare against"
        best = ranked[0].score
        if c.mode == "simple":
            if best < c.accept_threshold:
                return Status.UNKNOWN, f"all registered speakers scored low (best {best:.3f} < {c.accept_threshold})"
            return Status.MATCH, "Best candidate passed the configured acceptance criteria."
        if c.mode != "strict":
            raise ValueError(f"unknown policy mode {c.mode!r} (use 'simple' or 'strict')")
        if best < c.unknown_threshold:
            return Status.UNKNOWN, f"best score {best:.3f} is below the unknown threshold {c.unknown_threshold}"
        if best < c.accept_threshold:
            return Status.UNCERTAIN, (f"best score {best:.3f} is between the unknown ({c.unknown_threshold}) "
                                      f"and acceptance ({c.accept_threshold}) thresholds")
        if len(ranked) > 1:
            margin = best - ranked[1].score
            if margin < c.min_margin:
                return Status.UNCERTAIN, (f"top two candidates are too close (margin {margin:.3f} < {c.min_margin})")
        return Status.MATCH, "Best candidate passed the configured acceptance criteria."


class SpeakerIdentifier:
    """embedding + ranking + policy. Models are loaded once by the caller and reused."""

    def __init__(self, embedder: Embedder, index: SpeakerIndex, policy: DecisionPolicy):
        self.embedder, self.index, self.policy = embedder, index, policy

    def set_index(self, index: SpeakerIndex) -> None:
        self.index = index  # single attribute assignment: safe to call while the worker is running

    def identify(self, audio: np.ndarray, speech_seconds: Optional[float] = None,
                 timestamp: Optional[str] = None) -> Decision:
        ts = timestamp or iso_now()
        speech = len(audio) / self.embedder.sample_rate if speech_seconds is None else speech_seconds
        problem = self.policy.check_quality(audio, speech)
        if problem:
            return Decision(Status.UNCERTAIN, None, None, None, ts, problem, speech_seconds=speech)
        t0 = time.perf_counter()
        ranked = self.index.rank(self.embedder.embed(audio))
        status, reason = self.policy.decide(ranked)
        ms = (time.perf_counter() - t0) * 1000
        best = ranked[0] if ranked else None
        margin = (ranked[0].score - ranked[1].score) if len(ranked) > 1 else None
        is_match = status is Status.MATCH
        return Decision(status, best.speaker_id if is_match else None, best.speaker_name if is_match else None,
                        best.score if best else None, ts, reason, margin=margin, speech_seconds=speech,
                        processing_ms=ms, candidates=ranked[:3])
