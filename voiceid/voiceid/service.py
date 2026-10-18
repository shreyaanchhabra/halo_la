"""Optional local HTTP adapter for HALO's TypeScript audio pipeline.

Run from the voiceid/ project directory after enrolling speakers and installing the model:
    python -m voiceid.service

The service binds to loopback only. It never transcribes audio or sends it to a remote service.
"""
from __future__ import annotations

import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .config import Config
from .embedder import make_embedder
from .matching import DecisionPolicy, SpeakerIdentifier, SpeakerIndex
from .storage import ProfileStore
from .audio import load_audio
from .vad import make_vad, trim_to_speech

HOST = os.environ.get("VOICEID_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICEID_PORT", "8765"))
MAX_BODY = 8 * 1024 * 1024


def build_runtime():
    cfg = Config.from_json(os.environ.get("VOICEID_CONFIG"))
    embedder = make_embedder(cfg.model)
    vad = make_vad(cfg.vad, cfg.preproc.sample_rate)
    store = ProfileStore(cfg.db_path)
    index, skipped = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
    for speaker_id, reason in skipped:
        print(f"[voiceid] skipped {speaker_id}: {reason}", flush=True)
    if not len(index):
        store.close()
        raise RuntimeError(f"No compatible enrolled speakers in {cfg.db_path!r}; enroll speakers first.")
    return cfg, vad, store, SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy))


def make_handler(runtime):
    cfg, vad, store, identifier = runtime

    class Handler(BaseHTTPRequestHandler):
        server_version = "VoiceIDAdapter/1.0"

        def send_json(self, status, payload):
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if urlparse(self.path).path == "/health":
                self.send_json(200, {"ok": True, "registered_speakers": len(identifier.index)})
            else:
                self.send_json(404, {"error": "not found"})

        def do_POST(self):
            if urlparse(self.path).path != "/identify":
                self.send_json(404, {"error": "not found"})
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "audio/wav":
                self.send_json(415, {"error": "Content-Type must be audio/wav"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                size = 0
            if size <= 0 or size > MAX_BODY:
                self.send_json(413 if size > MAX_BODY else 400, {"error": "invalid audio body size"})
                return
            wav = self.rfile.read(size)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    f.write(wav)
                    temp_path = f.name
                audio = load_audio(temp_path, cfg.preproc.sample_rate)
                _, speech_seconds = trim_to_speech(
                    audio, vad, cfg.vad.threshold, cfg.preproc.trim_pad_ms, cfg.preproc.sample_rate
                )
                decision = identifier.identify(audio, speech_seconds=speech_seconds).to_dict()
                # Only MATCH yields a name. UNKNOWN/UNCERTAIN are intentionally anonymous.
                self.send_json(200, {
                    "status": decision["status"],
                    "speaker_id": decision["speaker_id"] if decision["status"] == "MATCH" else None,
                    "speaker_name": decision["speaker_name"] if decision["status"] == "MATCH" else None,
                    "similarity_score": decision["similarity_score"],
                    "reason": decision["reason"],
                    "speech_seconds": decision["speech_seconds"],
                    "processing_ms": decision["processing_ms"],
                })
            except Exception as exc:
                self.send_json(422, {"error": str(exc)[:300]})
            finally:
                if temp_path:
                    Path(temp_path).unlink(missing_ok=True)

        def log_message(self, fmt, *args):
            print("[voiceid-http] " + (fmt % args), flush=True)

    return Handler


def main():
    runtime = build_runtime()
    cfg, _vad, store, identifier = runtime
    server = ThreadingHTTPServer((HOST, PORT), make_handler(runtime))
    print(f"[voiceid] adapter listening on http://{HOST}:{PORT}; {len(identifier.index)} speaker(s); DB={cfg.db_path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        store.close()


if __name__ == "__main__":
    main()
