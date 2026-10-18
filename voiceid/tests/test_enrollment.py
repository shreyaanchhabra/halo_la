import numpy as np
import pytest
import soundfile as sf
from synthetic import SR, SpectralEmbedder, recording, silence

from voiceid.enrollment import ConsentRequired, Enroller


def test_registers_multiple_speakers(enroller, store, ref_dir):
    rep = enroller.enroll_all(ref_dir, consent=True)
    assert [s.source_key for s in rep.speakers] == ["brother", "father", "mother"]
    assert all(s.status == "ok" and s.embedded == 3 for s in rep.speakers)
    rows = store.list_speakers()
    assert [r.speaker_id for r in rows] == ["person_001", "person_002", "person_003"]
    for p in store.load_profiles():
        assert p.dim == 64 and abs(np.linalg.norm(p.vector) - 1) < 1e-5
        assert p.model_id == "test/spectral-demo"


def test_new_speakers_require_consent(enroller, ref_dir, store):
    with pytest.raises(ConsentRequired):
        enroller.enroll_all(ref_dir, consent=False)
    assert store.list_speakers() == []


def test_missing_reference_dir(enroller, tmp_path):
    with pytest.raises(FileNotFoundError):
        enroller.enroll_all(tmp_path / "nope", consent=True)


def test_invalid_recordings_are_reported_not_fatal(enroller, ref_dir, store):
    d = ref_dir / "father"
    (d / "empty.wav").write_bytes(b"")
    (d / "corrupt.wav").write_bytes(b"this is not audio" * 50)
    sf.write(d / "tiny.wav", recording("father", 5)[: SR // 4], SR)
    sf.write(d / "silent.wav", np.zeros(SR * 2, dtype=np.float32), SR)
    sf.write(d / "noise_only.wav", silence(3.0), SR)
    (d / "notes.txt").write_text("not audio")
    rep = enroller.enroll_speaker("father", ref_dir, consent=True)
    reasons = dict(rep.failed)
    assert set(reasons) == {"empty.wav", "corrupt.wav", "tiny.wav", "silent.wav", "noise_only.wav"}
    assert "empty" in reasons["empty.wav"] and "too short" in reasons["tiny.wav"]
    assert "silent" in reasons["silent.wav"] or "nearly silent" in reasons["silent.wav"]
    assert "speech" in reasons["noise_only.wav"] or "silent" in reasons["noise_only.wav"]
    assert rep.status == "ok" and rep.usable == 3 and rep.ignored_files == 1
    assert store.find_speaker("father").n_recordings == 3


def test_speaker_without_usable_recordings_is_not_registered(enroller, ref_dir, store):
    (ref_dir / "ghost").mkdir()
    (ref_dir / "ghost" / "a.wav").write_bytes(b"")
    rep = enroller.enroll_all(ref_dir, consent=True)
    ghost = next(s for s in rep.speakers if s.source_key == "ghost")
    assert ghost.status == "no_usable_recordings" and ghost.speaker_id is None
    assert store.find_speaker("ghost") is None and len(store.list_speakers()) == 3


def test_unchanged_embeddings_are_reused(enroller, embedder, ref_dir, store):
    enroller.enroll_all(ref_dir, consent=True)
    calls, stamp = embedder.calls, {s.speaker_id: s.updated_at for s in store.list_speakers()}
    rep = enroller.enroll_all(ref_dir)
    assert embedder.calls == calls
    assert all(s.reused == 3 and s.embedded == 0 and not s.profile_changed for s in rep.speakers)
    assert {s.speaker_id: s.updated_at for s in store.list_speakers()} == stamp


def test_update_single_speaker_only_touches_that_speaker(enroller, embedder, ref_dir, store):
    enroller.enroll_all(ref_dir, consent=True)
    before = {p.speaker_id: p.vector.copy() for p in store.load_profiles()}
    mother = store.find_speaker("mother").speaker_id
    sf.write(ref_dir / "mother" / "recording_04.wav", recording("mother", 777), SR)
    calls = embedder.calls
    rep = enroller.enroll_speaker("mother", ref_dir)
    assert embedder.calls == calls + 1 and rep.embedded == 1 and rep.reused == 3 and rep.profile_changed
    after = {p.speaker_id: p.vector for p in store.load_profiles()}
    for sid, v in before.items():
        assert (not np.allclose(v, after[sid])) == (sid == mother)
    # removing a file prunes it and updates the profile again
    (ref_dir / "mother" / "recording_04.wav").unlink()
    rep = enroller.enroll_speaker("mother", ref_dir)
    assert rep.removed == ["recording_04.wav"] and store.find_speaker("mother").n_recordings == 3


def test_modified_file_is_reembedded(enroller, embedder, ref_dir):
    enroller.enroll_all(ref_dir, consent=True)
    sf.write(ref_dir / "father" / "recording_01.wav", recording("father", 4242), SR)
    calls = embedder.calls
    rep = enroller.enroll_speaker("father", ref_dir)
    assert embedder.calls == calls + 1 and rep.embedded == 1 and rep.reused == 2


def test_changed_preprocessing_invalidates_cache(cfg, store, embedder, vad, ref_dir):
    Enroller(cfg, store, embedder, vad).enroll_all(ref_dir, consent=True)
    cfg.preproc.trim_pad_ms = 250
    rep = Enroller(cfg, store, embedder, vad).enroll_all(ref_dir)
    assert all(s.embedded == 3 and s.reused == 0 for s in rep.speakers)


def test_changed_model_invalidates_cache(cfg, store, vad, ref_dir, embedder):
    Enroller(cfg, store, embedder, vad).enroll_all(ref_dir, consent=True)
    other = SpectralEmbedder()
    other.model_version = "2"
    rep = Enroller(cfg, store, other, vad).enroll_all(ref_dir)
    assert all(s.embedded == 3 for s in rep.speakers)


def test_delete_removes_all_stored_data(enroller, ref_dir, store):
    enroller.enroll_all(ref_dir, consent=True)
    assert store.delete_speaker("father")
    assert store.find_speaker("father") is None
    assert all(p.display_name != "Father" for p in store.load_profiles())
    n = store._db.execute("SELECT COUNT(*) FROM recordings WHERE rel_path LIKE 'recording%'").fetchone()[0]
    assert n == 6  # only mother + brother remain
    assert not store.delete_speaker("father")


def test_directory_names_are_not_hard_coded(enroller, ref_dir, store):
    (ref_dir / "aunt_maria").mkdir()
    for i in range(2):
        sf.write(ref_dir / "aunt_maria" / f"{i}.wav", recording("mother", 50 + i), SR)
    enroller.enroll_all(ref_dir, consent=True)
    assert store.find_speaker("aunt_maria").display_name == "Aunt Maria"


def test_unusual_extensions_are_attempted_not_silently_skipped(enroller, ref_dir, store, tmp_path):
    """Regression: a folder of '.mpv' files used to be ignored with no message, so the person never registered."""
    import shutil
    import subprocess

    (ref_dir / "aksh").mkdir()
    (ref_dir / "aksh" / "readme.txt").write_text("not audio")
    rep = enroller.enroll_speaker("aksh", ref_dir, consent=True)           # only a .txt inside
    assert rep.status == "no_usable_recordings" and rep.ignored == ["readme.txt"]

    (ref_dir / "aksh" / "garbage.mpv").write_bytes(b"\x00\x01not really audio" * 100)
    rep = enroller.enroll_speaker("aksh", ref_dir, consent=True)           # undecodable -> a visible FAILURE
    assert [p for p, _ in rep.failed] == ["garbage.mpv"] and store.find_speaker("aksh") is None

    if shutil.which("ffmpeg"):                                              # decodable only via ffmpeg
        for i in range(3):
            wav = tmp_path / f"a{i}.wav"
            sf.write(wav, recording("brother", 900 + i), SR)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "aac", "-f", "mp4",
                            str(ref_dir / "aksh" / f"voice_{i}.mpv")], check=True)
        rep = enroller.enroll_speaker("aksh", ref_dir, consent=True)
        assert rep.embedded == 3 and rep.status == "ok" and store.find_speaker("aksh") is not None
        assert [p for p, _ in rep.failed] == ["garbage.mpv"]
