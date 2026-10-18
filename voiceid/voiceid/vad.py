"""Voice activity detection. Frame-level interface shared by enrollment trimming and live capture."""
from __future__ import annotations

from typing import Protocol

import numpy as np

from .config import VADConfig


class FrameVAD(Protocol):
    frame_samples: int

    def prob(self, frame: np.ndarray) -> float: ...
    def reset(self) -> None: ...


class EnergyVAD:
    """RMS gate. Not a replacement for Silero; used for tests and as a no-dependency fallback."""

    def __init__(self, cfg: VADConfig):
        self.frame_samples = cfg.frame_samples
        self._thr = cfg.energy_rms_threshold

    def prob(self, frame: np.ndarray) -> float:
        return 1.0 if float(np.sqrt(np.mean(np.square(frame, dtype=np.float64)))) >= self._thr else 0.0

    def reset(self) -> None:
        pass


class SileroVAD:
    """Silero VAD (MIT). The model ships inside the `silero-vad` pip package, so no download is needed."""

    def __init__(self, cfg: VADConfig, sample_rate: int = 16000):
        import torch
        from silero_vad import load_silero_vad

        if sample_rate != 16000 or cfg.frame_samples != 512:
            raise ValueError("Silero VAD is configured for 16 kHz audio and 512-sample frames")
        self._torch = torch
        self._model = load_silero_vad()
        self.frame_samples = cfg.frame_samples
        self._sr = sample_rate

    def prob(self, frame: np.ndarray) -> float:
        with self._torch.no_grad():
            return float(self._model(self._torch.from_numpy(np.ascontiguousarray(frame, dtype=np.float32)), self._sr).item())

    def reset(self) -> None:
        self._model.reset_states()


def make_vad(cfg: VADConfig, sample_rate: int = 16000) -> FrameVAD:
    if cfg.backend == "silero":
        return SileroVAD(cfg, sample_rate)
    if cfg.backend == "energy":
        return EnergyVAD(cfg)
    raise ValueError(f"unknown VAD backend {cfg.backend!r}")


def frame_probs(audio: np.ndarray, vad: FrameVAD) -> np.ndarray:
    n = vad.frame_samples
    vad.reset()
    out = []
    for start in range(0, len(audio), n):
        frame = audio[start:start + n]
        if len(frame) < n:
            frame = np.pad(frame, (0, n - len(frame)))
        out.append(vad.prob(frame))
    return np.asarray(out, dtype=np.float32)


def trim_to_speech(audio: np.ndarray, vad: FrameVAD, threshold: float, pad_ms: int, sample_rate: int):
    """Return (speech_audio, speech_seconds). Keeps speech frames plus ``pad_ms`` of context each side."""
    n = vad.frame_samples
    is_speech = frame_probs(audio, vad) >= threshold
    pad = int(round(pad_ms / 1000 * sample_rate / n))
    keep = is_speech.copy()
    for i in np.flatnonzero(is_speech):
        keep[max(0, i - pad): i + pad + 1] = True
    pieces = [audio[i * n:(i + 1) * n] for i in np.flatnonzero(keep)]
    trimmed = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    return trimmed, float(is_speech.sum() * n / sample_rate)
