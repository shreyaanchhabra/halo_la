# voiceid: offline speaker identification from a microphone

Identifies **registered** people (family, close friends) from live microphone audio by comparing
speaker embeddings against profiles built from your existing reference recordings.
No transcription, LLM, RAG, cloud API, web server or particular display is involved; the engine just
emits structured JSON that any other program can consume.

```
mic ─► [bounded audio queue] ─► Silero VAD + utterance segmenter ─► [bounded queue] ─► SpeechBrain ECAPA embedding
                                                                                     ─► cosine ranking ─► decision policy
                                                                                     ─► identity tracker (hysteresis) ─► JSON results / events
```

## Status: what has and has not been verified

* **Verified here (automated, 51 tests):** enrollment, caching, updates, deletion, consent gate, invalid-file handling,
  matching/decision logic, ambiguity, insufficient speech, hysteresis, bounded queues / non-blocking capture,
  error recovery, calibration maths, evaluation script, and operation with all network access blocked.
  These use synthetic voices and a stand-in embedder, so they test the **pipeline logic only**.
* **Not verified here:** the real SpeechBrain model, Silero VAD and a physical microphone (the build sandbox could not
  download the model or access audio hardware). `tests/test_integration_real_model.py` runs automatically once the model is installed.
* **No accuracy or latency numbers are claimed.** Measure them with `scripts/evaluate.py` on your own recordings.

## Setup (needs internet once)

Python 3.11 recommended (3.10-3.12 should work). From this folder:

```bash
python -m venv .venv && source .venv/bin/activate
pip install torch torchaudio            # pick the build for your machine: https://pytorch.org
pip install -r requirements.txt
pip install -e .                        # provides the `voiceid` command
voiceid setup-models                    # downloads the model into ./models (the ONLY network step)
```

macOS: `brew install portaudio` may be needed for `sounddevice`; grant your terminal microphone permission.
**Install `ffmpeg`** (macOS: `brew install ffmpeg`) if your recordings are anything other than wav/flac/ogg: phone voice memos (.m4a), video files (.mp4/.mov) and unusual extensions are decoded through it. Every non-text file in a person's folder is attempted; failures are listed with the reason, never skipped silently.

**Model:** `speechbrain/spkrec-ecapa-voxceleb`, ECAPA-TDNN, 16 kHz mono input, Apache-2.0 licence. The embedding
dimension is read from the loaded model at start-up and stored with each profile (the project doesn't assume it).
Silero VAD ships inside the `silero-vad` package, so it needs no separate download.

## Enroll

```
reference_audio/
    father/   recording_01.wav  recording_02.wav
    mother/   ...
```

```bash
voiceid enroll --consent               # register everyone (names come from folder names; nothing is hard-coded)
voiceid update father --reference-dir reference_audio   # refresh one person after adding/removing files
voiceid list
voiceid delete brother                 # removes profile, embeddings and metadata, then VACUUMs
```

* `--consent` is required the first time a person is registered. Voice profiles are biometric-related data: only enroll people who agreed.
* Each recording is decoded → mono 16 kHz → silence trimmed with VAD → embedded. Unusable files (empty, corrupt, too short,
  silent, too little speech) are **reported with a reason and skipped**; they never abort the run.
* **Aggregation:** every recording's embedding is L2-normalised, averaged, and re-normalised (length-normalised centroid).
* **Reuse:** a recording is re-embedded only if its SHA-256, the model version, or the preprocessing fingerprint changed.
* Warnings are printed if one file looks unlike the person's other recordings (possible mislabelled file).
* Use several recordings per person across different days/rooms/devices; 3+ recordings gives the mislabel check something to work with.

## Troubleshooting: "someone isn't recognised"

1. `voiceid enroll --consent --reference-dir <dir>` prints one line per person to stderr. `[FAIL] name ... NOT REGISTERED`
   lists exactly which files were rejected and why. `<dir>` must contain one folder per person
   (`recordings/Aashu/`, `recordings/Aksh/`), not point inside a person's folder.
2. `voiceid list` must show every person. Only registered people can ever be named.
3. Test each person **separately from files** instead of guessing from live results:
   `voiceid identify new_clip_of_aksh.wav new_clip_of_aashu.wav --segment-seconds 4`
4. With only ONE registered person, there is no runner-up, so the margin check can't help and anyone scoring above
   `accept_threshold` is accepted. Register at least two people, then run `voiceid calibrate`.
5. Several `UNKNOWN`s while someone is talking usually mean a threshold/microphone mismatch or enrollment audio that
   differs from live audio (different mic/room). Add reference recordings made with the same laptop mic.

## Calibrate, then evaluate (do this before trusting results)

The default thresholds in `config.py` are **uncalibrated placeholders**. Raw cosine scores are not probabilities and
are not comparable across models, microphones or rooms.

```bash
voiceid calibrate --out policy.json [--impostor-dir some_unregistered_people/] [--target-far 0.01]
```
Uses leave-one-recording-out trials on your reference audio. Needs ≥2 speakers with ≥2 recordings each.
Without `--impostor-dir` the impostors are only your other registered people, so the false-accept estimate is optimistic.

```
heldout_audio/
    father/  new_clip.wav ...          # recordings NOT used for enrollment
    mother/  ...
    _unregistered/anyone/ clip.wav     # people who are not enrolled
```
```bash
python scripts/evaluate.py --reference-dir reference_audio --heldout-dir heldout_audio \
       --policy policy.json --segment-seconds 3 --e2e 10 --out report.json
```
Reports identification accuracy, closed-set top-1, FRR, mis-identification rate, FAR (each with a 95% Wilson interval where relevant),
model processing time (mean/p50/p95), and optionally real-time end-to-end latency. Re-run with different `--segment-seconds`
to choose `min_speech_s` for your setup. It enrolls into a throw-away database; your real profiles are untouched.

## Run live

```bash
voiceid devices                          # find your input device
voiceid --policy policy.json run [--device 2] [--events-only]
```
Models load once at start-up. One JSON object per line on stdout (logs go to stderr):

```json
{"type":"result","status":"MATCH","speaker_id":"person_001","speaker_name":"Father","similarity_score":0.87,
 "timestamp":"2026-10-17T21:04:11.482+00:00","reason":"Best candidate passed the configured acceptance criteria.",
 "margin":0.31,"speech_seconds":2.4,"processing_ms":96.1,"latency_ms":104.3,"candidates":[...]}
{"type":"event","event":"IDENTITY_ESTABLISHED","speaker_id":"person_001","speaker_name":"Father", ...}
```
(The score above is illustrative.) `similarity_score` is the best candidate's raw cosine similarity. It is **not** a confidence or probability.

**Decision mode** (`policy.mode`, default `simple`): `simple` = if the best score among all registered people is below `accept_threshold` the result is `UNKNOWN`, otherwise `MATCH` with the best-scoring person. `strict` adds the `UNCERTAIN` score band and the runner-up margin check (table below describes `strict`; in `simple` mode `UNCERTAIN` only appears for too little speech or bad audio).

| status | meaning | speaker_id / speaker_name |
|---|---|---|
| `MATCH` | best score ≥ `accept_threshold` **and** margin over runner-up ≥ `min_margin` | set |
| `UNKNOWN` | best score < `unknown_threshold` (not a registered voice), or no compatible profiles | `null` |
| `UNCERTAIN` | too little speech, too quiet, clipped, score between the two thresholds, or top two candidates too close | `null` |

Events: `IDENTITY_ESTABLISHED`, `IDENTITY_CHANGED`, `IDENTITY_LOST`. Hysteresis (`TrackerConfig`): a different speaker needs
`switch_after` consecutive MATCHes to take over; `UNCERTAIN` never changes state; identity is dropped after `lose_after_unknown`
consecutive UNKNOWNs or `expire_after_s` without a match.

Use as a library: build `LiveEngine(cfg, identifier, vad, on_decision=..., on_event=...)` (see `voiceid/cli.py:cmd_run`),
or call `SpeakerIdentifier.identify(audio)` on any 16 kHz float32 array. The engine knows nothing about displays or hardware.

### Queue behaviour

The audio callback only copies a block into a bounded queue (`audio_queue_blocks`, default 600 ≈ 19 s) and returns.
If a queue is full the **oldest** item is discarded, counted in `engine.stats` (`dropped_audio_blocks`, `dropped_utterances`),
and a rate-limited warning is logged. Capture is never blocked. Frequent drops mean the model is too slow for your hardware
(use a GPU `device`, or raise `min_speech_s` / `max_utterance_s`).

### Accumulating enough speech

Segmentation is VAD-driven (`SegmenterConfig`). An utterance closes after `end_silence_ms` of silence. If it contains less than
`policy.min_speech_s` of speech it is **held** for `merge_gap_s`; more speech in that window is merged into the same utterance.
Otherwise an `UNCERTAIN` ("insufficient speech") result is emitted (disable with `emit_insufficient=false`). Continuous speech
is cut every `max_utterance_s` so results keep flowing. `min_speech_s=1.0` is a practical starting point, not a rule.

## Configuration

Everything is in `voiceid/config.py` (dataclasses). Pass `--config my.json` with only the keys you want to override, e.g.

```json
{"reference_dir": "reference_audio", "db_path": "voiceid.db",
 "model": {"device": "cpu"}, "segmenter": {"end_silence_ms": 500}, "policy": {"min_speech_s": 1.5}}
```
Unknown keys are rejected. `--policy policy.json` (from `calibrate`) overrides the policy section.

## Tests

```bash
pip install -r requirements-dev.txt
pytest -q
```
Covers: multi-speaker registration, missing/invalid recordings, non-blocking capture with a slow model, embedding reuse,
profile updates, held-out matching, unregistered rejection, insufficient speech, ambiguous candidates, no rapid switching,
and a full pipeline run with the network blocked.

## More

* [docs/LIMITATIONS.md](docs/LIMITATIONS.md): what this can and can't do
* [docs/LICENSES_AND_PRIVACY.md](docs/LICENSES_AND_PRIVACY.md): model licensing, consent, data handling
* [docs/OFFLINE.md](docs/OFFLINE.md): exactly which steps need internet
