# Limitations

* **Not a security control.** Speaker recognition can be fooled by recordings, voice cloning and impersonation. Don't use it to unlock or authorise anything.
* **Accuracy depends on your data.** Models trained on VoxCeleb (celebrity interview audio) can degrade with far-field/noisy microphones,
  different rooms, illness, whispering, shouting, children whose voices change, accents/languages that differ from training data,
  and codec/phone audio. Enrollment audio recorded on a different device or in a different room from live use lowers scores.
* **Short utterances are weaker evidence.** Scores on 1 s of speech are noisier than on 5 s. Tune `min_speech_s` with `scripts/evaluate.py`.
* **Overlapping speech is not handled.** Two people talking at once yield one mixed embedding (likely UNCERTAIN/UNKNOWN). There is no diarization.
* **One utterance = one speaker.** If someone else starts talking without a pause, the segment is mixed (the max-length cut limits, but doesn't solve, this).
* **Open-set rejection is imperfect.** Thresholds trade false accepts against false rejects; unregistered speakers who sound similar to a registered person can pass. Calibrate with `--impostor-dir` containing realistic non-registered voices.
* **Raw cosine scores are not probabilities** and shift with model, mic and environment. Recalibrate after changing any of them.
* **Calibration is only as good as its data.** With few recordings the thresholds are coarse; the report prints trial counts.
* **Capture rate:** the mic stream is opened at 16 kHz; if your device refuses that rate, `sounddevice` raises an error (no automatic resampling in the live path yet).
* **CPU latency:** ECAPA on CPU is usually fast enough for utterance-level results, but this is hardware-dependent. Measure with `--e2e`.
* **Silero VAD can be fooled** by music/TV speech; background voices from a TV will be identified like anyone else's (typically UNKNOWN).
* **FAISS** is not included. Linear search over a few dozen profiles is negligible; add an index only for thousands of profiles.
