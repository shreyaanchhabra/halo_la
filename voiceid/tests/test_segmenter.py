import numpy as np

from voiceid.config import SegmenterConfig
from voiceid.segmenter import UtteranceSegmenter

N, SR = 512, 16000
FR = N / SR  # 32 ms


def feed(seg, pattern):
    """pattern: list of (is_speech, seconds)."""
    out = []
    for speech, secs in pattern:
        for _ in range(round(secs / FR)):
            out += seg.push(np.full(N, 0.1 if speech else 0.0, dtype=np.float32), 1.0 if speech else 0.0)
    return out


def make(**kw):
    return UtteranceSegmenter(SegmenterConfig(**kw), min_speech_s=1.0, vad_threshold=0.5)


def test_one_utterance_with_boundaries():
    seg = make()
    out = feed(seg, [(False, 1), (True, 2), (False, 1)])
    assert len(out) == 1 and not out[0].insufficient
    assert 1.9 < out[0].speech_seconds < 2.2 and out[0].duration_s < 3.0   # preroll + tail, not the whole second of silence


def test_short_burst_is_held_then_reported_insufficient():
    seg = make()
    out = feed(seg, [(True, 0.3), (False, 3)])
    assert len(out) == 1 and out[0].insufficient and out[0].speech_seconds < 1.0


def test_short_bursts_are_merged_until_enough_speech():
    seg = make()
    out = feed(seg, [(True, 0.6), (False, 0.9), (True, 0.6), (False, 1.0)])
    assert len(out) == 1 and not out[0].insufficient and out[0].speech_seconds >= 1.0


def test_continuous_speech_is_split_at_max_length():
    seg = make(max_utterance_s=4.0)
    out = feed(seg, [(True, 10), (False, 1)])
    assert len(out) >= 2 and out[0].forced_split and all(u.duration_s <= 4.1 for u in out[:2])


def test_flush_emits_buffered_speech():
    seg = make()
    assert feed(seg, [(True, 2)]) == []
    out = seg.flush()
    assert len(out) == 1 and not out[0].insufficient


def test_emit_insufficient_can_be_disabled():
    seg = make(emit_insufficient=False)
    assert feed(seg, [(True, 0.3), (False, 3)]) == []
