import numpy as np
import pytest

from voiceid.calibration import calibrate_policy, leave_one_out_scores
from voiceid.config import Config, PolicyConfig


def test_calibration_places_accept_threshold_between_impostors_and_genuine(enrolled, store, cfg):
    gen, imp = leave_one_out_scores(store)
    assert len(gen) == 9 and len(imp) == 18
    policy, report = calibrate_policy(gen, imp, cfg.policy, target_far=0.0)
    assert policy.calibrated and imp.max() < policy.accept_threshold <= gen.min()
    assert policy.unknown_threshold <= policy.accept_threshold
    assert report["far_at_accept"] == 0.0 and report["frr_at_accept"] == 0.0


def test_calibration_needs_enough_data(store, enroller, ref_dir):
    with pytest.raises(ValueError):
        leave_one_out_scores(store)  # nobody enrolled yet


def test_config_roundtrip_and_validation(tmp_path):
    c = Config()
    c.policy.accept_threshold = 0.61
    assert Config.from_dict(c.to_dict()).policy.accept_threshold == 0.61
    with pytest.raises(ValueError):
        Config.from_dict({"policy": {"acept_threshold": 1}})


def test_fingerprint_tracks_embedding_relevant_settings():
    c = Config()
    base = c.preproc.fingerprint(c.vad)
    c.preproc.outlier_warn_cosine = 0.9           # reporting-only: must not invalidate profiles
    assert c.preproc.fingerprint(c.vad) == base
    c.preproc.trim_pad_ms += 50
    assert c.preproc.fingerprint(c.vad) != base


def test_cli_enroll_summary_and_identify(cfg, tmp_path, monkeypatch, capsys, ref_dir):
    import json
    import soundfile as sf
    from synthetic import SR, SpectralEmbedder, recording
    from voiceid import cli
    from voiceid.vad import make_vad

    emb = SpectralEmbedder()
    monkeypatch.setattr(cli, "_runtime", lambda c: (emb, make_vad(c.vad)))
    (ref_dir / "aksh").mkdir()
    (ref_dir / "aksh" / "bad.wav").write_bytes(b"")          # Aksh has no usable recordings
    cfgfile = tmp_path / "c.json"
    cfgfile.write_text(json.dumps({"db_path": cfg.db_path, "reference_dir": str(ref_dir),
                                   "vad": {"backend": "energy"}}))
    assert cli.main(["--config", str(cfgfile), "enroll", "--consent"]) == 1
    err = capsys.readouterr().err
    assert "[FAIL] aksh" in err and "NOT REGISTERED" in err and "bad.wav" in err and "[OK  ] father" in err

    wav = tmp_path / "t.wav"
    sf.write(wav, recording("mother", 31337, 3.0), SR)
    capsys.readouterr()
    assert cli.main(["--config", str(cfgfile), "identify", str(wav)]) == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["status"] in {"MATCH", "UNCERTAIN", "UNKNOWN"} and out["file"] == str(wav)
