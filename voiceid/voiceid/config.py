"""Configuration. Every tunable lives here; nothing is hard-coded elsewhere.

All values are plain dataclasses so they can be loaded from / dumped to JSON.
The defaults for ``PolicyConfig`` are *uncalibrated starting points*, not
universally valid thresholds. Run ``voiceid calibrate`` and
``scripts/evaluate.py`` on your own recordings and microphone.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any, Optional


@dataclass
class ModelConfig:
    backend: str = "speechbrain"
    # Hugging Face id used ONLY by `voiceid setup-models` (the explicit download stage).
    source: str = "speechbrain/spkrec-ecapa-voxceleb"
    # Local copy used for all inference. No network access happens against this directory.
    local_dir: str = "models/spkrec-ecapa-voxceleb"
    device: str = "cpu"
    sample_rate: int = 16000  # model was trained on 16 kHz mono audio


@dataclass
class VADConfig:
    backend: str = "silero"       # "silero" | "energy" (energy is a dependency-free fallback / test aid)
    threshold: float = 0.5        # speech probability needed to call a frame speech
    energy_rms_threshold: float = 0.01  # only for backend="energy"
    frame_samples: int = 512      # Silero requires 512 samples @ 16 kHz


@dataclass
class PreprocConfig:
    """Applied to reference recordings at enrollment. Part of the profile fingerprint."""
    sample_rate: int = 16000
    trim_silence: bool = True     # keep only speech frames (+ padding) before embedding
    trim_pad_ms: int = 100
    min_recording_s: float = 1.0  # shorter files are rejected
    min_speech_s: float = 1.0     # speech remaining after trimming must reach this
    max_recording_s: float = 60.0 # longer audio is truncated (embedding cost; diminishing returns)
    min_rms: float = 0.002        # near-silent files are rejected
    outlier_warn_cosine: float = 0.25  # warn (don't exclude) if a file is this dissimilar to the rest

    def fingerprint(self, vad: "VADConfig") -> str:
        pre = asdict(self)
        pre.pop("outlier_warn_cosine")  # reporting only; does not change any embedding
        payload = {"preproc": pre, "vad_backend": vad.backend,
                   "vad_threshold": vad.threshold, "vad_energy": vad.energy_rms_threshold,
                   "frame": vad.frame_samples}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


@dataclass
class SegmenterConfig:
    start_frames: int = 3          # consecutive speech frames needed to open an utterance
    preroll_ms: int = 300          # audio kept from before speech onset
    end_silence_ms: int = 600      # silence that closes an utterance
    tail_ms: int = 150             # trailing silence kept on emitted audio
    max_utterance_s: float = 10.0  # force a result at this length during continuous speech
    merge_gap_s: float = 1.5       # a too-short utterance is held this long, waiting for more speech
    emit_insufficient: bool = True # emit UNCERTAIN when held audio never reaches min speech


@dataclass
class PolicyConfig:
    # "simple": best score >= accept_threshold -> MATCH (best person), otherwise UNKNOWN. Nothing else.
    # "strict": also uses unknown_threshold (UNCERTAIN band) and the min_margin ambiguity check.
    mode: str = "simple"
    # Cosine-similarity thresholds. UNCALIBRATED starting points for ECAPA-TDNN.
    accept_threshold: float = 0.45   # best score must reach this for MATCH
    unknown_threshold: float = 0.30  # best score below this -> UNKNOWN; between -> UNCERTAIN
    min_margin: float = 0.08         # best - second_best must reach this for MATCH
    min_speech_s: float = 1.0        # practical starting point; evaluate on real data
    min_rms: float = 0.003           # quieter than this -> UNCERTAIN (poor audio)
    max_clip_ratio: float = 0.02     # more clipped samples than this -> UNCERTAIN
    calibrated: bool = False         # set True by `voiceid calibrate`


@dataclass
class TrackerConfig:
    establish_after: int = 1       # consecutive MATCHes to establish an identity from nothing
    switch_after: int = 2          # consecutive MATCHes for a *different* speaker to switch
    lose_after_unknown: int = 2    # consecutive UNKNOWNs before the identity is dropped
    expire_after_s: float = 60.0   # drop identity after this long without any MATCH


@dataclass
class QueueConfig:
    audio_queue_blocks: int = 600  # ~19 s of 512-sample blocks at 16 kHz
    utterance_queue_size: int = 8
    # Both queues are bounded. When full, the OLDEST item is discarded (never blocks capture)
    # and a counter is incremented. See README "Queue behaviour".


@dataclass
class Config:
    reference_dir: str = "reference_audio"
    db_path: str = "voiceid.db"
    model: ModelConfig = field(default_factory=ModelConfig)
    vad: VADConfig = field(default_factory=VADConfig)
    preproc: PreprocConfig = field(default_factory=PreprocConfig)
    segmenter: SegmenterConfig = field(default_factory=SegmenterConfig)
    policy: PolicyConfig = field(default_factory=PolicyConfig)
    tracker: TrackerConfig = field(default_factory=TrackerConfig)
    queues: QueueConfig = field(default_factory=QueueConfig)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Config":
        return _build(cls, data)

    @classmethod
    def from_json(cls, path: Optional[str | Path]) -> "Config":
        if path is None:
            return cls()
        return cls.from_dict(json.loads(Path(path).read_text()))

    def with_policy_file(self, path: Optional[str | Path]) -> "Config":
        if path is not None:
            self.policy = _build(PolicyConfig, json.loads(Path(path).read_text()))
        return self


def _build(cls, data: dict):
    known = {f.name for f in fields(cls)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"Unknown config keys for {cls.__name__}: {sorted(unknown)}")
    kwargs: dict[str, Any] = {}
    for name, value in data.items():
        default = getattr(cls(), name)
        kwargs[name] = _build(type(default), value) if is_dataclass(default) and isinstance(value, dict) else value
    return cls(**kwargs)
