import time

import numpy as np
from synthetic import SR, SpectralEmbedder, silence, voice

from voiceid.live import LiveEngine
from voiceid.matching import DecisionPolicy, SpeakerIdentifier, SpeakerIndex
from voiceid.vad import make_vad


def make_engine(cfg, store, embedder, **qkw):
    for k, v in qkw.items():
        setattr(cfg.queues, k, v)
    index, _ = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
    decisions, events = [], []
    eng = LiveEngine(cfg, SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy)), make_vad(cfg.vad),
                     on_decision=decisions.append, on_event=events.append)
    return eng, decisions, events


def feed(eng, audio, block=512):
    worst = 0.0
    for i in range(0, len(audio), block):
        t = time.perf_counter()
        eng.audio_callback(audio[i:i + block].reshape(-1, 1))
        worst = max(worst, time.perf_counter() - t)
    return worst


def test_end_to_end_decisions_and_events(cfg, store, embedder, enrolled):
    eng, decisions, events = make_engine(cfg, store, embedder)
    eng.start()
    gap = silence(1.0)
    stream = np.concatenate([silence(0.5), voice("father", 2.5, 11), gap, voice("father", 2.5, 12), gap,
                             voice("stranger", 2.5, 13), gap,
                             voice("mother", 2.5, 14), gap, voice("mother", 2.5, 15), gap])
    feed(eng, stream)
    eng.stop()
    assert [(d["status"], d["speaker_name"]) for d in decisions] == [
        ("MATCH", "Father"), ("MATCH", "Father"), ("UNKNOWN", None), ("MATCH", "Mother"), ("MATCH", "Mother")]
    # one stranger utterance neither drops the identity nor flips it; mother needs 2 consecutive matches
    assert [(e["event"], e["speaker_name"]) for e in events] == [
        ("IDENTITY_ESTABLISHED", "Father"), ("IDENTITY_CHANGED", "Mother")]
    assert all(d["latency_ms"] is not None and d["processing_ms"] is not None for d in decisions)
    assert eng.stats.dropped_audio_blocks == 0 and eng.stats.errors == 0


def test_insufficient_speech_reports_uncertain(cfg, store, embedder, enrolled):
    eng, decisions, _ = make_engine(cfg, store, embedder)
    eng.start()
    feed(eng, np.concatenate([silence(0.5), voice("father", 0.35, 3), silence(3.0)]))
    eng.stop()
    assert [d["status"] for d in decisions] == ["UNCERTAIN"] and "insufficient" in decisions[0]["reason"]


def test_audio_still_buffered_when_stream_ends_mid_speech(cfg, store, embedder, enrolled):
    eng, decisions, _ = make_engine(cfg, store, embedder)
    eng.start()
    feed(eng, np.concatenate([silence(0.3), voice("brother", 3.0, 21)]))
    eng.stop()
    assert [d["speaker_name"] for d in decisions] == ["Brother"]


def test_capture_never_blocks_when_the_model_is_slow(cfg, store, enrolled):
    slow = SpectralEmbedder(delay_s=0.25)
    # same profiles (identical model id/version), but 0.25 s per inference
    eng, decisions, _ = make_engine(cfg, store, slow, audio_queue_blocks=2000, utterance_queue_size=2)
    eng.start()
    chunks = []
    for i in range(12):
        chunks += [voice("father", 1.6, 100 + i), silence(0.8, i)]
    worst = feed(eng, np.concatenate(chunks))          # ~29 s of audio pushed as fast as possible
    assert worst < 0.05, f"audio callback blocked for {worst:.3f}s"
    eng.stop(timeout=20)
    assert eng.stats.dropped_utterances > 0            # bounded queue overflowed -> oldest discarded, counted
    assert 0 < len(decisions) < 12 and eng.stats.errors == 0


def test_audio_queue_overflow_drops_oldest_without_blocking(cfg, store, embedder, enrolled):
    eng, _, _ = make_engine(cfg, store, embedder, audio_queue_blocks=10)   # workers NOT started
    worst = feed(eng, voice("father", 2.0, 1))
    assert worst < 0.05 and eng.stats.dropped_audio_blocks > 0
    assert eng._audio_q.qsize() == 10


def test_engine_keeps_running_after_a_model_error(cfg, store, embedder, enrolled):
    eng, decisions, _ = make_engine(cfg, store, embedder)
    real, state = embedder.embed, {"n": 0}

    def flaky(a):
        state["n"] += 1
        if state["n"] == 1:
            raise RuntimeError("boom")
        return real(a)

    embedder.embed = flaky
    eng.start()
    feed(eng, np.concatenate([voice("father", 2.5, 1), silence(1.0), voice("father", 2.5, 2), silence(1.0)]))
    eng.stop()
    assert eng.stats.errors == 1 and [d["status"] for d in decisions] == ["MATCH"]
