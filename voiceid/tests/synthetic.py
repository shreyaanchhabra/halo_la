"""Synthetic 'voices' and a deterministic stand-in embedder so tests run without the real model.

These tests exercise the pipeline logic (enrollment, caching, queues, decisions, hysteresis). They say
NOTHING about real-world accuracy: that must be measured with scripts/evaluate.py on real recordings.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
# name -> (fundamental Hz, formant centre Hz)
VOICES = {"father": (110, 600), "mother": (210, 1500), "brother": (140, 2600), "stranger": (170, 3800)}


def voice(name: str, seconds: float, seed: int) -> np.ndarray:
    f0, formant = VOICES[name]
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    inst = f0 * (1 + 0.04 * np.sin(2 * np.pi * 0.7 * t + rng.uniform(0, 6.28)))
    phase = np.cumsum(2 * np.pi * inst / SR)
    sig = np.zeros_like(t)
    for k in range(1, 40):
        if k * f0 > 7500:
            break
        sig += (np.exp(-0.5 * ((k * f0 - formant) / 350) ** 2) + 0.03) * np.sin(k * phase)
    env = 0.65 + 0.35 * np.sin(2 * np.pi * rng.uniform(2.5, 4.0) * t + rng.uniform(0, 6.28)) ** 2
    sig = sig * env + 0.01 * rng.standard_normal(len(t))
    return (0.5 * sig / np.max(np.abs(sig))).astype(np.float32)


def silence(seconds: float, seed: int = 0) -> np.ndarray:
    return (0.0005 * np.random.default_rng(seed).standard_normal(int(seconds * SR))).astype(np.float32)


def recording(name: str, seed: int, speech_s: float = 3.5) -> np.ndarray:
    return np.concatenate([silence(0.3, seed), voice(name, speech_s * 0.45, seed), silence(0.5, seed + 1),
                           voice(name, speech_s * 0.55, seed + 100), silence(0.3, seed + 2)])


def write_reference_dir(root: Path, people=("father", "mother", "brother"), per_person=3, seed0=1000) -> Path:
    for p in people:
        (root / p).mkdir(parents=True, exist_ok=True)
        for i in range(per_person):
            sf.write(root / p / f"recording_{i + 1:02d}.wav", recording(p, seed0 + 17 * i + sum(map(ord, p)) % 97), SR)
    return root


class SpectralEmbedder:
    """Mean log-spectrum over active frames, level-removed. Same speaker -> high cosine."""
    model_id = "test/spectral-demo"
    model_version = "1"
    dim = 64
    sample_rate = SR

    def __init__(self, delay_s: float = 0.0):
        self.calls = 0
        self.delay_s = delay_s

    def embed(self, audio: np.ndarray) -> np.ndarray:
        self.calls += 1
        if self.delay_s:
            time.sleep(self.delay_s)
        n = 512
        frames = [audio[i:i + n] for i in range(0, len(audio) - n, n)]
        frames = [f for f in frames if np.sqrt(np.mean(f ** 2)) > 0.01] or frames
        spec = np.mean([np.abs(np.fft.rfft(f * np.hanning(n)))[:256] ** 2 for f in frames], axis=0)
        v = np.log10(spec.reshape(64, 4).mean(axis=1) + 1e-8)
        return (v - v.mean()).astype(np.float32)
