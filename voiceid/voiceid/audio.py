"""Audio decoding, resampling and simple signal-quality measures."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
from math import gcd
from pathlib import Path

import numpy as np

# libsndfile handles wav/flac/ogg (and mp3 on libsndfile >= 1.1). Others need ffmpeg on PATH.
SUPPORTED_EXTENSIONS = {".wav", ".flac", ".ogg", ".oga", ".mp3", ".m4a", ".aac", ".opus", ".webm", ".wma", ".aiff", ".aif"}


# Files we never try to decode. EVERYTHING else is attempted (libsndfile first, then ffmpeg), so unusual
# audio/video containers (.mpv, .mp4, .mov, .mkv, .caf, .amr ...) are not silently skipped.
NON_AUDIO_EXTENSIONS = {".txt", ".md", ".json", ".csv", ".tsv", ".py", ".pdf", ".jpg", ".jpeg", ".png", ".gif",
                        ".heic", ".webp", ".db", ".yaml", ".yml", ".log", ".zip", ".docx", ".xlsx", ".ds_store",
                        ".srt", ".vtt", ".html", ".xml", ".ini", ".toml"}


def is_candidate_audio(path: str | Path) -> bool:
    p = Path(path)
    return p.is_file() and not p.name.startswith(".") and p.suffix.lower() not in NON_AUDIO_EXTENSIONS


class AudioError(Exception):
    """A recording could not be decoded or is unusable. The message is user-facing."""


def file_sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resample(audio: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return audio.astype(np.float32, copy=False)
    from scipy.signal import resample_poly

    g = gcd(sr_in, sr_out)
    return resample_poly(audio, sr_out // g, sr_in // g).astype(np.float32)


def _decode_ffmpeg(path: Path, sr: int) -> np.ndarray:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise AudioError("cannot decode this format with libsndfile and ffmpeg is not installed")
    proc = subprocess.run([exe, "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"],
                          capture_output=True)
    if proc.returncode != 0 or not proc.stdout:
        raise AudioError(f"ffmpeg could not decode file: {proc.stderr.decode(errors='replace').strip()[:200]}")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def load_audio(path: str | Path, target_sr: int = 16000) -> np.ndarray:
    """Decode to mono float32 at ``target_sr``. Raises AudioError with a readable reason."""
    import soundfile as sf

    path = Path(path)
    if not path.is_file():
        raise AudioError("file not found")
    if path.stat().st_size == 0:
        raise AudioError("file is empty")
    try:
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        mono = resample(data.mean(axis=1), sr, target_sr)
    except Exception as sf_err:  # noqa: BLE001 - fall back to ffmpeg for anything libsndfile rejects
        try:
            mono = _decode_ffmpeg(path, target_sr)
        except AudioError as ff_err:
            raise AudioError(f"unreadable audio ({sf_err}); {ff_err}") from None
    if mono.size == 0:
        raise AudioError("file contains no samples")
    if not np.all(np.isfinite(mono)):
        raise AudioError("audio contains NaN/inf samples")
    return mono


def rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if audio.size else 0.0


def clip_ratio(audio: np.ndarray, level: float = 0.999) -> float:
    return float(np.mean(np.abs(audio) >= level)) if audio.size else 0.0
