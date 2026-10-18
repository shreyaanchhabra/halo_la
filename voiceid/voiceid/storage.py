"""SQLite storage for speaker metadata, per-recording embeddings and aggregated profiles.

Voice profiles are sensitive biometric-related data: the DB file is created with owner-only
permissions, ``secure_delete`` is on, and deleting a speaker cascades to every row about them.
"""
from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS speakers(
    speaker_id    TEXT PRIMARY KEY,
    source_key    TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    consent_at    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    profile       BLOB,
    profile_dim   INTEGER,
    model_id      TEXT,
    model_version TEXT,
    preproc_hash  TEXT,
    preproc_json  TEXT,
    n_recordings  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recordings(
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    speaker_id    TEXT NOT NULL REFERENCES speakers(speaker_id) ON DELETE CASCADE,
    rel_path      TEXT NOT NULL,
    abs_path      TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    duration_s    REAL,
    speech_s      REAL,
    embedding     BLOB NOT NULL,
    dim           INTEGER NOT NULL,
    model_id      TEXT NOT NULL,
    model_version TEXT NOT NULL,
    preproc_hash  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE(speaker_id, rel_path)
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass
class SpeakerRow:
    speaker_id: str
    source_key: str
    display_name: str
    consent_at: Optional[str]
    created_at: str
    updated_at: str
    profile_dim: Optional[int]
    model_id: Optional[str]
    model_version: Optional[str]
    preproc_hash: Optional[str]
    n_recordings: int


@dataclass
class StoredProfile:
    speaker_id: str
    display_name: str
    vector: np.ndarray
    dim: int
    model_id: str
    model_version: str
    preproc_hash: str


@dataclass
class RecordingRow:
    rel_path: str
    sha256: str
    embedding: np.ndarray
    model_id: str
    model_version: str
    preproc_hash: str
    duration_s: float
    speech_s: float


class ProfileStore:
    def __init__(self, path: str | Path):
        self.path = str(path)
        new = self.path != ":memory:" and not Path(self.path).exists()
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.execute("PRAGMA secure_delete=ON")  # overwrite deleted content
        self._db.executescript(SCHEMA)
        self._db.commit()
        if new:
            os.chmod(self.path, 0o600)

    def close(self) -> None:
        self._db.close()

    # ---- speakers ---------------------------------------------------------
    def _next_id(self) -> str:
        row = self._db.execute("SELECT value FROM meta WHERE key='next_id'").fetchone()
        n = int(row["value"]) if row else 1
        self._db.execute("INSERT INTO meta(key,value) VALUES('next_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (str(n + 1),))
        return f"person_{n:03d}"

    def create_speaker(self, source_key: str, display_name: str, consent_at: Optional[str]) -> str:
        sid = self._next_id()
        t = now_iso()
        self._db.execute("INSERT INTO speakers(speaker_id,source_key,display_name,consent_at,created_at,updated_at) "
                         "VALUES(?,?,?,?,?,?)", (sid, source_key, display_name, consent_at, t, t))
        self._db.commit()
        return sid

    def find_speaker(self, ident: str) -> Optional[SpeakerRow]:
        """Look up by speaker_id or by source_key (directory name)."""
        r = self._db.execute("SELECT * FROM speakers WHERE speaker_id=? OR source_key=?", (ident, ident)).fetchone()
        return _speaker_row(r) if r else None

    def list_speakers(self) -> list[SpeakerRow]:
        return [_speaker_row(r) for r in self._db.execute("SELECT * FROM speakers ORDER BY speaker_id")]

    def set_consent(self, speaker_id: str, consent_at: str) -> None:
        self._db.execute("UPDATE speakers SET consent_at=? WHERE speaker_id=?", (consent_at, speaker_id))
        self._db.commit()

    def rename_speaker(self, ident: str, display_name: str) -> bool:
        cur = self._db.execute("UPDATE speakers SET display_name=?, updated_at=? WHERE speaker_id=? OR source_key=?",
                               (display_name, now_iso(), ident, ident))
        self._db.commit()
        return cur.rowcount > 0

    def delete_speaker(self, ident: str) -> bool:
        """Remove the speaker, their profile and all recording metadata/embeddings."""
        row = self.find_speaker(ident)
        if row is None:
            return False
        self._db.execute("DELETE FROM speakers WHERE speaker_id=?", (row.speaker_id,))  # cascades to recordings
        self._db.commit()
        self._db.execute("VACUUM")
        return True

    # ---- recordings -------------------------------------------------------
    def get_recording(self, speaker_id: str, rel_path: str) -> Optional[RecordingRow]:
        r = self._db.execute("SELECT * FROM recordings WHERE speaker_id=? AND rel_path=?", (speaker_id, rel_path)).fetchone()
        return _recording_row(r) if r else None

    def list_recordings(self, speaker_id: str) -> list[RecordingRow]:
        return [_recording_row(r) for r in
                self._db.execute("SELECT * FROM recordings WHERE speaker_id=? ORDER BY rel_path", (speaker_id,))]

    def upsert_recording(self, speaker_id: str, rel_path: str, abs_path: str, sha256: str, duration_s: float,
                         speech_s: float, embedding: np.ndarray, model_id: str, model_version: str,
                         preproc_hash: str) -> None:
        emb = np.asarray(embedding, dtype=np.float32)
        self._db.execute(
            "INSERT INTO recordings(speaker_id,rel_path,abs_path,sha256,duration_s,speech_s,embedding,dim,model_id,"
            "model_version,preproc_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(speaker_id,rel_path) DO UPDATE SET abs_path=excluded.abs_path, sha256=excluded.sha256, "
            "duration_s=excluded.duration_s, speech_s=excluded.speech_s, embedding=excluded.embedding, dim=excluded.dim, "
            "model_id=excluded.model_id, model_version=excluded.model_version, preproc_hash=excluded.preproc_hash, "
            "created_at=excluded.created_at",
            (speaker_id, rel_path, abs_path, sha256, duration_s, speech_s, emb.tobytes(), emb.shape[0], model_id,
             model_version, preproc_hash, now_iso()))
        self._db.commit()

    def prune_recordings(self, speaker_id: str, keep_rel_paths: set[str]) -> list[str]:
        """Delete stored recordings that are no longer present/usable. Returns removed rel_paths."""
        existing = [r["rel_path"] for r in self._db.execute("SELECT rel_path FROM recordings WHERE speaker_id=?", (speaker_id,))]
        gone = [p for p in existing if p not in keep_rel_paths]
        for p in gone:
            self._db.execute("DELETE FROM recordings WHERE speaker_id=? AND rel_path=?", (speaker_id, p))
        self._db.commit()
        return gone

    # ---- profiles ---------------------------------------------------------
    def set_profile(self, speaker_id: str, vector: np.ndarray, model_id: str, model_version: str,
                    preproc_hash: str, preproc_json: str, n_recordings: int) -> bool:
        """Store profile; returns True if anything changed (and bumps updated_at only then)."""
        vec = np.asarray(vector, dtype=np.float32)
        r = self._db.execute("SELECT profile, model_id, model_version, preproc_hash, n_recordings FROM speakers "
                             "WHERE speaker_id=?", (speaker_id,)).fetchone()
        unchanged = (r is not None and r["profile"] == vec.tobytes() and r["model_id"] == model_id
                     and r["model_version"] == model_version and r["preproc_hash"] == preproc_hash
                     and r["n_recordings"] == n_recordings)
        if unchanged:
            return False
        self._db.execute("UPDATE speakers SET profile=?, profile_dim=?, model_id=?, model_version=?, preproc_hash=?, "
                         "preproc_json=?, n_recordings=?, updated_at=? WHERE speaker_id=?",
                         (vec.tobytes(), vec.shape[0], model_id, model_version, preproc_hash, preproc_json,
                          n_recordings, now_iso(), speaker_id))
        self._db.commit()
        return True

    def load_profiles(self) -> list[StoredProfile]:
        out = []
        for r in self._db.execute("SELECT * FROM speakers WHERE profile IS NOT NULL ORDER BY speaker_id"):
            out.append(StoredProfile(r["speaker_id"], r["display_name"], np.frombuffer(r["profile"], dtype=np.float32).copy(),
                                     r["profile_dim"], r["model_id"], r["model_version"], r["preproc_hash"]))
        return out


def _speaker_row(r: sqlite3.Row) -> SpeakerRow:
    return SpeakerRow(r["speaker_id"], r["source_key"], r["display_name"], r["consent_at"], r["created_at"],
                      r["updated_at"], r["profile_dim"], r["model_id"], r["model_version"], r["preproc_hash"],
                      r["n_recordings"])


def _recording_row(r: sqlite3.Row) -> RecordingRow:
    return RecordingRow(r["rel_path"], r["sha256"], np.frombuffer(r["embedding"], dtype=np.float32).copy(),
                        r["model_id"], r["model_version"], r["preproc_hash"], r["duration_s"], r["speech_s"])
