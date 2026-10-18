"""With every network path blocked, enrollment, matching and the live engine must still work."""
import socket

import pytest
from synthetic import silence, voice

from voiceid.enrollment import Enroller
from voiceid.live import LiveEngine
from voiceid.matching import DecisionPolicy, SpeakerIdentifier, SpeakerIndex


@pytest.fixture
def no_network(monkeypatch):
    def blocked(*a, **k):
        raise AssertionError("network access attempted")

    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)


def test_pipeline_runs_with_network_blocked(no_network, cfg, store, embedder, vad, ref_dir):
    Enroller(cfg, store, embedder, vad).enroll_all(ref_dir, consent=True)
    index, _ = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
    out = []
    eng = LiveEngine(cfg, SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy)), vad, on_decision=out.append)
    eng.start()
    import numpy as np

    audio = np.concatenate([silence(0.4), voice("mother", 2.5, 8), silence(1.0)])
    for i in range(0, len(audio), 512):
        eng.audio_callback(audio[i:i + 512].reshape(-1, 1))
    eng.stop()
    assert [d["speaker_name"] for d in out] == ["Mother"] and eng.stats.errors == 0
