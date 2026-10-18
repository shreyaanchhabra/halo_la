"""Live pipeline:  microphone callback -> [audio queue] -> VAD/segmenter thread -> [utterance queue]
                  -> inference thread (embed + match + policy + tracker) -> callbacks.

* The audio callback only copies samples into a bounded queue and returns; it never touches a model.
* If a queue is full the OLDEST item is dropped and counted (``stats``). Capture is never blocked.
* All models are created by the caller once and reused for the life of the engine.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional

import numpy as np

from .config import Config
from .matching import Decision, SpeakerIdentifier, Status, iso_now
from .segmenter import Utterance, UtteranceSegmenter
from .smoothing import IdentityTracker
from .vad import FrameVAD

log = logging.getLogger("voiceid.live")
_STOP = object()


@dataclass
class EngineStats:
    blocks_received: int = 0
    dropped_audio_blocks: int = 0
    dropped_utterances: int = 0
    utterances_processed: int = 0
    errors: int = 0


class LiveEngine:
    def __init__(self, cfg: Config, identifier: SpeakerIdentifier, vad: FrameVAD,
                 on_decision: Optional[Callable[[dict], None]] = None,
                 on_event: Optional[Callable[[dict], None]] = None,
                 clock: Callable[[], float] = time.monotonic):
        self.cfg, self.identifier, self.vad = cfg, identifier, vad
        self.on_decision = on_decision or (lambda d: None)
        self.on_event = on_event or (lambda e: None)
        self.tracker = IdentityTracker(cfg.tracker)
        self.stats = EngineStats()
        self._clock = clock
        self._audio_q: queue.Queue = queue.Queue(maxsize=cfg.queues.audio_queue_blocks)
        self._utt_q: queue.Queue = queue.Queue(maxsize=cfg.queues.utterance_queue_size)
        self._seg = UtteranceSegmenter(cfg.segmenter, cfg.policy.min_speech_s, cfg.vad.threshold,
                                       cfg.vad.frame_samples, cfg.preproc.sample_rate)
        self._threads: list[threading.Thread] = []
        self._last_drop_log = 0.0

    # ---- capture side (runs in the audio driver's thread) -------------------
    def audio_callback(self, indata, frames=None, time_info=None, status=None) -> None:
        """sounddevice-compatible callback. Must stay fast and non-blocking."""
        block = np.array(indata[:, 0] if getattr(indata, "ndim", 1) == 2 else indata, dtype=np.float32, copy=True)
        self.stats.blocks_received += 1
        self._put_drop_oldest(self._audio_q, block, "dropped_audio_blocks", "audio queue full (inference falling behind?)")

    def _put_drop_oldest(self, q: queue.Queue, item, counter: str, msg: str) -> None:
        try:
            q.put_nowait(item)
            return
        except queue.Full:
            pass
        try:
            q.get_nowait()
        except queue.Empty:
            pass
        try:
            q.put_nowait(item)
        except queue.Full:
            pass
        setattr(self.stats, counter, getattr(self.stats, counter) + 1)
        now = time.monotonic()
        if now - self._last_drop_log > 5:  # rate-limited, and never from the audio thread's critical path for long
            self._last_drop_log = now
            log.warning("%s - discarding oldest data (total dropped: %s)", msg, getattr(self.stats, counter))

    # ---- worker threads ------------------------------------------------------
    def start(self) -> None:
        self._threads = [threading.Thread(target=self._segment_loop, name="voiceid-vad", daemon=True),
                         threading.Thread(target=self._inference_loop, name="voiceid-infer", daemon=True)]
        for t in self._threads:
            t.start()

    def stop(self, timeout: float = 10.0) -> None:
        """Flush buffered audio, let queued utterances finish, and join the workers."""
        self._audio_q.put(_STOP)  # blocking put is fine here: we are not in the audio thread
        self._threads[0].join(timeout)
        self._utt_q.put(_STOP)
        self._threads[1].join(timeout)

    def _emit_utterance(self, u: Utterance) -> None:
        self._put_drop_oldest(self._utt_q, (u, self._clock()), "dropped_utterances",
                              "utterance queue full (model too slow for this speech rate)")

    def _segment_loop(self) -> None:
        n = self.cfg.vad.frame_samples
        buf = np.zeros(0, dtype=np.float32)
        self.vad.reset()
        while True:
            item = self._audio_q.get()
            if item is _STOP:
                for u in self._seg.flush():
                    self._emit_utterance(u)
                return
            buf = np.concatenate([buf, item]) if buf.size else item
            while len(buf) >= n:
                frame, buf = buf[:n], buf[n:]
                try:
                    p = self.vad.prob(frame)
                    for u in self._seg.push(frame, p):
                        self._emit_utterance(u)
                except Exception:  # noqa: BLE001
                    self.stats.errors += 1
                    log.exception("segmentation error")

    def _inference_loop(self) -> None:
        while True:
            item = self._utt_q.get()
            if item is _STOP:
                return
            utt, t_end = item
            try:
                d = self.identifier.identify(utt.audio, utt.speech_seconds, timestamp=iso_now())
                d.latency_ms = (self._clock() - t_end) * 1000
                self.stats.utterances_processed += 1
                self.on_decision(d.to_dict())
                for ev in self.tracker.update(d, self._clock()):
                    self.on_event(ev)
            except Exception:  # noqa: BLE001 - keep running; one bad utterance must not kill the engine
                self.stats.errors += 1
                log.exception("identification error")


def run_microphone(engine: LiveEngine, device=None, sample_rate: int = 16000):
    """Context manager that streams the default (or chosen) microphone into the engine."""
    import sounddevice as sd

    return sd.InputStream(samplerate=sample_rate, channels=1, dtype="float32", device=device,
                          blocksize=engine.cfg.vad.frame_samples, callback=engine.audio_callback)
