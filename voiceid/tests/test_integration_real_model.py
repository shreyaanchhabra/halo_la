"""Runs only when the real SpeechBrain model has been installed with `voiceid setup-models`."""
import socket
from pathlib import Path

import numpy as np
import pytest

MODEL_DIR = Path("models/spkrec-ecapa-voxceleb")
pytestmark = [pytest.mark.integration,
              pytest.mark.skipif(not (MODEL_DIR / "hyperparams.yaml").exists(), reason="real model not installed")]


def test_real_model_loads_and_embeds_offline(monkeypatch):
    from voiceid.config import ModelConfig
    from voiceid.embedder import SpeechBrainEmbedder

    def blocked(*a, **k):
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    emb = SpeechBrainEmbedder(ModelConfig())
    v = emb.embed(np.random.default_rng(1).standard_normal(16000).astype(np.float32) * 0.1)
    assert v.shape == (emb.dim,) and np.isfinite(v).all()
    print("embedding dim:", emb.dim, "version:", emb.model_version)
