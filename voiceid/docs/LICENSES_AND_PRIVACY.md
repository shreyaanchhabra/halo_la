# Model licensing and privacy

## Licences (verify before redistributing or commercial use)

| Component | Licence (as checked) | Notes |
|---|---|---|
| `speechbrain/spkrec-ecapa-voxceleb` | Apache-2.0 (model card) | Trained on VoxCeleb 1+2. The model card gives no warranty outside the training data. If you plan **commercial** deployment, review the VoxCeleb dataset terms and get your own legal advice. |
| SpeechBrain library | Apache-2.0 | |
| Silero VAD (`silero-vad`) | MIT | model bundled in the pip package |
| PyTorch, NumPy, SciPy, SoundFile, SoundDevice | BSD-style / MIT-style | PortAudio (used by SoundDevice) is MIT-style; libsndfile is LGPL |

Licences were read from the published model cards/package metadata at build time and can change. Re-check the versions you install.

## Privacy

* Voice profiles and per-recording embeddings are **sensitive biometric-related data** (they may fall under laws such as GDPR, BIPA, CCPA/CPRA). Enroll only people who have given informed consent; `voiceid enroll` refuses to register a new person without `--consent` and records the consent time.
* Everything is local: reference audio, live microphone audio, embeddings and names are never sent anywhere. Live audio is processed in memory and **not written to disk**.
* The SQLite file is created with owner-only permissions (0600), uses `secure_delete`, and `voiceid delete <speaker>` removes the profile, all recording embeddings and metadata, then runs `VACUUM`. Note the original reference audio files are yours to delete separately.
* The database is not encrypted. If the machine is shared or may be lost, use full-disk encryption.
* Tell people in the room when the microphone is listening; recording or analysing voices without consent may be unlawful where you live.
