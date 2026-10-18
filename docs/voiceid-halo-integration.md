# HALO + VoiceID integration

VoiceID is an optional local speaker-identification sidecar for HALO's existing audio pipeline.
HALO continues to use its current Whisper transcription and calendar logic. The sidecar only adds
speaker metadata; it does not transcribe audio and does not send audio to a remote endpoint.

## 1. Install VoiceID

Use Python 3.10–3.12 (recommended by VoiceID), from the repository's `voiceid/` directory:

```bash
cd voiceid
python -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[live]'
```

Install the model once and enroll speakers who have explicitly consented, following [voiceid/README.md](../voiceid/README.md):

```bash
voiceid setup-models
voiceid enroll --consent --reference-dir reference_audio
voiceid list
```

The model and SQLite database are local runtime assets and must not be committed.

## 2. Start the sidecar

Keep the working directory at `voiceid/`, because the default model and database paths are relative to it:

```bash
source .venv/bin/activate
python -m voiceid.service
```

The service binds to `127.0.0.1:8765` only. It loads the model and enrolled profiles once, then handles each finished WAV utterance. Check it with:

```bash
curl http://127.0.0.1:8765/health
```

For a different local port, set `VOICEID_PORT` before starting the service and set `HALO_VOICEID_URL` to the matching base URL in the environment running HALO's portal server. Do not expose this service to a network: it has no authentication and is intended for loopback use only.

## 3. Start HALO

In another terminal, run the portal as usual. Set `HALO_VOICEID_URL=http://127.0.0.1:8765` in the portal server's environment if you changed the default. If the sidecar is unavailable, times out, or rejects a clip, HALO falls back to its existing speaker header / `unknown` behavior and still processes the Whisper transcript.

For the glasses app to reach the service, the VoiceID sidecar must run on the same machine as the HALO server. Do not point a packaged glasses app directly at localhost: the sidecar is server-side.

## Behavior and limitations

- Only a VoiceID `MATCH` result contributes a display name. `UNKNOWN` and `UNCERTAIN` remain anonymous.
- HALO's transcription is unchanged; identity is supplementary metadata passed into the existing calendar processing path.
- VoiceID thresholds are uncalibrated defaults until you run `voiceid calibrate` with representative recordings. Do not treat cosine similarity as a probability.
- Voice profiles are biometric-related data. Enroll only with explicit consent, keep the SQLite database local, and don't commit recordings, model weights, `.venv`, or the database.
- The integration has not been run against a real microphone or real pretrained model by this change authoring environment. Run VoiceID's own tests and verify end-to-end behavior locally.
