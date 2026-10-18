"""Identity tracking with hysteresis: turns a stream of per-utterance decisions into stable events."""
from __future__ import annotations

from typing import Optional

from .config import TrackerConfig
from .matching import Decision, Status


class IdentityTracker:
    """Events: IDENTITY_ESTABLISHED, IDENTITY_CHANGED, IDENTITY_LOST.

    * A different speaker must win ``switch_after`` consecutive MATCHes before the identity changes,
      so one noisy utterance cannot flip it.
    * UNCERTAIN results never change state (they carry no evidence either way).
    * The identity is dropped after ``lose_after_unknown`` consecutive UNKNOWNs or ``expire_after_s`` of silence.
    """

    def __init__(self, cfg: TrackerConfig):
        self.cfg = cfg
        self.current_id: Optional[str] = None
        self.current_name: Optional[str] = None
        self._last_match_t: float = 0.0
        self._pending_id: Optional[str] = None
        self._pending_n = 0
        self._unknown_run = 0

    def _event(self, kind: str, d: Optional[Decision], prev_id, prev_name, reason: str) -> dict:
        return {"event": kind, "speaker_id": self.current_id, "speaker_name": self.current_name,
                "previous_speaker_id": prev_id, "previous_speaker_name": prev_name,
                "similarity_score": None if d is None or d.similarity_score is None else round(d.similarity_score, 4),
                "timestamp": d.timestamp if d else None, "reason": reason}

    def _drop(self, d: Optional[Decision], reason: str) -> dict:
        prev = (self.current_id, self.current_name)
        self.current_id = self.current_name = None
        self._pending_id, self._pending_n, self._unknown_run = None, 0, 0
        return self._event("IDENTITY_LOST", d, prev[0], prev[1], reason)

    def tick(self, now: float, d: Optional[Decision] = None) -> list[dict]:
        """Call periodically (or via update) so a stale identity expires."""
        if self.current_id and now - self._last_match_t > self.cfg.expire_after_s:
            return [self._drop(d, f"no matching speech for {self.cfg.expire_after_s:.0f}s")]
        return []

    def update(self, d: Decision, now: float) -> list[dict]:
        events = self.tick(now, d)
        if d.status is Status.UNCERTAIN:
            return events
        if d.status is Status.UNKNOWN:
            self._pending_id, self._pending_n = None, 0
            self._unknown_run += 1
            if self.current_id and self._unknown_run >= self.cfg.lose_after_unknown:
                events.append(self._drop(d, f"{self._unknown_run} consecutive unrecognised utterances"))
            return events

        # MATCH
        self._unknown_run = 0
        sid = d.speaker_id
        if sid == self.current_id:
            self._last_match_t = now
            self._pending_id, self._pending_n = None, 0
            return events
        self._pending_n = self._pending_n + 1 if self._pending_id == sid else 1
        self._pending_id = sid
        needed = self.cfg.establish_after if self.current_id is None else self.cfg.switch_after
        if self._pending_n >= needed:
            prev = (self.current_id, self.current_name)
            self.current_id, self.current_name = sid, d.speaker_name
            self._last_match_t = now
            self._pending_id, self._pending_n = None, 0
            kind = "IDENTITY_ESTABLISHED" if prev[0] is None else "IDENTITY_CHANGED"
            events.append(self._event(kind, d, prev[0], prev[1],
                                      "speaker identity established" if prev[0] is None
                                      else f"{needed} consecutive matches for a different speaker"))
        return events
