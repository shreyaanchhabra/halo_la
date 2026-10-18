# Offline operation

| Step | Network? |
|---|---|
| `pip install ...` | yes (once) |
| `voiceid setup-models` | **yes**, downloads `speechbrain/spkrec-ecapa-voxceleb` from Hugging Face into `./models` (once) |
| `enroll`, `update`, `list`, `delete`, `calibrate`, `run`, `scripts/evaluate.py` | **no** |

How it is enforced:
* Inference loads the model from the local directory (`source == savedir`), so SpeechBrain finds every file already present and fetches nothing.
* `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` are set before the model loads.
* Silero VAD is bundled in the `silero-vad` wheel.
* `tests/test_offline.py` runs enrollment, matching and the live engine with sockets, DNS and `create_connection` patched to raise; `tests/test_integration_real_model.py` does the same for the real model once installed.

To move to an air-gapped machine: copy the project, the `models/` directory and a pip wheelhouse (`pip download -r requirements.txt -d wheels`).
