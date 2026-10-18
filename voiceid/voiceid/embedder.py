"""Speaker-embedding backends.

Model facts (verified against the model card and SpeechBrain 1.1.2 source):
  * id:        speechbrain/spkrec-ecapa-voxceleb (ECAPA-TDNN)
  * input:     16 kHz, single-channel waveform
  * licence:   Apache-2.0 for the model weights/code. Trained on VoxCeleb1+2; see docs/LICENSES.md.
  * dimension: read from the loaded model at start-up and stored with every profile
               (not assumed), so a model swap is always detected.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Protocol

import numpy as np

from .config import ModelConfig


class ModelNotInstalledError(RuntimeError):
    pass


class Embedder(Protocol):
    model_id: str
    model_version: str
    dim: int
    sample_rate: int

    def embed(self, audio: np.ndarray) -> np.ndarray:
        """16 kHz mono float32 waveform -> raw (un-normalised) embedding of shape (dim,)."""


def l2_normalize(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    n = float(np.linalg.norm(v))
    if n == 0.0 or not np.isfinite(n):
        raise ValueError("cannot normalise a zero or non-finite embedding")
    return v / n


def _import_encoder():
    try:  # speechbrain >= 1.0
        from speechbrain.inference.classifiers import EncoderClassifier
    except ImportError:  # pragma: no cover - older releases
        from speechbrain.pretrained import EncoderClassifier
    return EncoderClassifier


def download_model(cfg: ModelConfig) -> Path:
    """EXPLICIT SETUP STAGE: the only function that contacts the network (Hugging Face)."""
    EncoderClassifier = _import_encoder()
    dest = Path(cfg.local_dir)
    dest.mkdir(parents=True, exist_ok=True)
    kwargs = {}
    try:
        from speechbrain.utils.fetching import LocalStrategy
        kwargs["local_strategy"] = LocalStrategy.COPY  # real files in local_dir, not symlinks into a cache
    except Exception:  # noqa: BLE001
        pass
    EncoderClassifier.from_hparams(source=cfg.source, savedir=str(dest), run_opts={"device": cfg.device}, **kwargs)
    return dest


class SpeechBrainEmbedder:
    def __init__(self, cfg: ModelConfig):
        local = Path(cfg.local_dir)
        if not (local / "hyperparams.yaml").is_file():
            raise ModelNotInstalledError(
                f"Model not found in '{local}'. Run `voiceid setup-models` once while online.")
        # Inference must never reach out to the network.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import torch
        import speechbrain

        self._torch = torch
        EncoderClassifier = _import_encoder()
        # source == savedir: SpeechBrain finds every file already present and fetches nothing.
        self._clf = EncoderClassifier.from_hparams(source=str(local), savedir=str(local),
                                                   run_opts={"device": cfg.device})
        self._clf.eval()
        self.sample_rate = cfg.sample_rate
        self.model_id = cfg.source
        ckpt = local / "embedding_model.ckpt"
        digest = hashlib.sha256(ckpt.read_bytes()).hexdigest()[:12] if ckpt.is_file() else "unknown"
        self.model_version = f"ckpt-{digest}+speechbrain-{speechbrain.__version__}"
        self.dim = int(self.embed(np.random.default_rng(0).standard_normal(cfg.sample_rate).astype(np.float32) * 0.1).shape[0])

    def embed(self, audio: np.ndarray) -> np.ndarray:
        wav = self._torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).unsqueeze(0)
        with self._torch.no_grad():
            emb = self._clf.encode_batch(wav)  # (batch, 1, dim)
        return emb.squeeze().cpu().numpy().astype(np.float32)


def make_embedder(cfg: ModelConfig) -> Embedder:
    if cfg.backend == "speechbrain":
        return SpeechBrainEmbedder(cfg)
    raise ValueError(f"unknown model backend {cfg.backend!r}")
