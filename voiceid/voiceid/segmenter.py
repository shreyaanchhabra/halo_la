"""Frame-driven utterance segmentation on top of a speech-probability stream.

States:  IDLE -> SPEECH -> (emit) IDLE
                    or SPEECH -> HOLD (utterance ended but had too little speech)
         HOLD keeps buffering for ``merge_gap_s``: if speech resumes it is merged into the same
         utterance (accumulating enough speech to identify); if not, an "insufficient" utterance is
         emitted so the caller can report UNCERTAIN.
Sample-clock only (no wall time), so it is deterministic and unit-testable.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Optional

import numpy as np

from .config import SegmenterConfig

IDLE, SPEECH, HOLD = "idle", "speech", "hold"


@dataclass
class Utterance:
    audio: np.ndarray
    speech_seconds: float
    duration_s: float
    insufficient: bool = False   # True: never reached min speech -> report UNCERTAIN, don't embed
    forced_split: bool = False   # True: cut at max_utterance_s while the person was still talking


class UtteranceSegmenter:
    def __init__(self, cfg: SegmenterConfig, min_speech_s: float, vad_threshold: float,
                 frame_samples: int = 512, sample_rate: int = 16000):
        self.cfg, self.thr, self.n, self.sr = cfg, vad_threshold, frame_samples, sample_rate
        self.min_speech_s = min_speech_s
        ms = lambda x: max(1, int(round(x / 1000 * sample_rate / frame_samples)))  # noqa: E731
        self.end_frames = ms(cfg.end_silence_ms)
        self.tail_frames = ms(cfg.tail_ms)
        self.preroll_frames = ms(cfg.preroll_ms)
        self.max_frames = int(cfg.max_utterance_s * sample_rate / frame_samples)
        self.gap_frames = int(cfg.merge_gap_s * sample_rate / frame_samples)
        self._reset()

    def _reset(self) -> None:
        self.state = IDLE
        self._preroll: deque = deque(maxlen=self.preroll_frames + self.cfg.start_frames)
        self._cur: list[np.ndarray] = []
        self._speech_frames = 0
        self._start_run = 0
        self._silence_run = 0
        self._hold_frames = 0
        self._hold_run = 0

    def _speech_s(self, frames: int) -> float:
        return frames * self.n / self.sr

    def _build(self, trim_trailing: bool, insufficient: bool, forced: bool = False) -> Utterance:
        frames = self._cur
        if trim_trailing and self._silence_run > self.tail_frames:
            frames = frames[: len(frames) - (self._silence_run - self.tail_frames)]
        audio = np.concatenate(frames) if frames else np.zeros(0, dtype=np.float32)
        return Utterance(audio, self._speech_s(self._speech_frames), len(audio) / self.sr, insufficient, forced)

    def push(self, frame: np.ndarray, prob: float) -> list[Utterance]:
        out: list[Utterance] = []
        is_speech = prob >= self.thr

        if self.state == IDLE:
            self._preroll.append(frame)
            self._start_run = self._start_run + 1 if is_speech else 0
            if self._start_run >= self.cfg.start_frames:
                self.state = SPEECH
                self._cur = list(self._preroll)
                self._speech_frames, self._silence_run = self._start_run, 0
                self._preroll.clear()

        elif self.state == SPEECH:
            self._cur.append(frame)
            if is_speech:
                self._speech_frames += 1
                self._silence_run = 0
            else:
                self._silence_run += 1
            if self._silence_run >= self.end_frames:
                utt = self._build(trim_trailing=True, insufficient=False)
                if utt.speech_seconds >= self.min_speech_s:
                    out.append(utt)
                    self._reset()
                else:  # too little speech so far: keep buffering instead of deciding
                    self._cur = self._cur[: len(utt.audio) // self.n]
                    self.state, self._hold_frames, self._hold_run = HOLD, 0, 0
            elif len(self._cur) >= self.max_frames:
                out.append(self._build(trim_trailing=False, insufficient=False, forced=True))
                self._cur, self._speech_frames, self._silence_run = [], 0, 0

        else:  # HOLD
            self._cur.append(frame)
            self._hold_frames += 1
            self._hold_run = self._hold_run + 1 if is_speech else 0
            if self._hold_run >= self.cfg.start_frames:
                self.state = SPEECH
                self._speech_frames += self._hold_run
                self._silence_run = 0
            elif self._hold_frames >= self.gap_frames:
                if self.cfg.emit_insufficient:
                    out.append(self._build(trim_trailing=False, insufficient=True))
                self._reset()
        return out

    def flush(self) -> list[Utterance]:
        """End of stream: emit whatever is buffered."""
        out: list[Utterance] = []
        if self.state in (SPEECH, HOLD) and self._cur:
            utt = self._build(trim_trailing=True, insufficient=False)
            if utt.speech_seconds >= self.min_speech_s:
                out.append(utt)
            elif self.cfg.emit_insufficient:
                utt.insufficient = True
                out.append(utt)
        self._reset()
        return out
