import sys
from pathlib import Path

import soundfile as sf
from synthetic import SR, recording

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from evaluate import run_evaluation, wilson  # noqa: E402


def test_evaluation_script_end_to_end(cfg, embedder, vad, ref_dir, tmp_path):
    held = tmp_path / "held"
    for p in ("father", "mother", "brother"):
        (held / p).mkdir(parents=True)
        for i in range(3):
            sf.write(held / p / f"{i}.wav", recording(p, 5000 + i, 3.0), SR)
    (held / "_unregistered" / "stranger").mkdir(parents=True)
    for i in range(3):
        sf.write(held / "_unregistered" / "stranger" / f"{i}.wav", recording("stranger", 6000 + i, 3.0), SR)
    rep = run_evaluation(cfg, embedder, vad, ref_dir, held, segment_seconds=0, e2e=2)
    assert rep["genuine_trials"] == 9 and rep["unregistered_trials"] == 3
    assert rep["identification_accuracy"] == 1.0 and rep["FRR"] == 0.0 and rep["FAR"] == 0.0
    assert rep["closed_set_top1"] == 1.0 and rep["processing_ms"]["n"] == 12
    assert rep["e2e_latency_ms"]["utterances"] >= 1


def test_wilson_interval_is_wide_for_few_trials():
    lo, hi = wilson(0, 3)
    assert lo == 0.0 and hi > 0.5     # 0 errors in 3 trials proves very little
