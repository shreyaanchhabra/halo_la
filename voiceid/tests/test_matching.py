import numpy as np
import pytest
from synthetic import VOICES, SpectralEmbedder, recording, silence, voice

from voiceid.config import PolicyConfig
from voiceid.enrollment import Enroller
from voiceid.matching import Candidate, DecisionPolicy, SpeakerIdentifier, SpeakerIndex, Status


def heldout(name, seed=9001, speech_s=2.0):
    return np.concatenate([silence(0.2), voice(name, speech_s, seed), silence(0.2)])


@pytest.mark.parametrize("name", ["father", "mother", "brother"])
def test_known_speakers_match_from_heldout_audio(enrolled, name):
    d = enrolled.identify(heldout(name))
    assert d.status is Status.MATCH
    assert d.speaker_name == name.title() and d.speaker_id.startswith("person_")
    assert d.margin > 0.1


def test_unregistered_speaker_is_rejected(enrolled):
    d = enrolled.identify(heldout("stranger"))
    assert d.status is Status.UNKNOWN and d.speaker_id is None and d.speaker_name is None


def test_insufficient_speech_is_uncertain_and_skips_the_model(enrolled, embedder):
    calls = embedder.calls
    d = enrolled.identify(voice("father", 0.4, 5))
    assert d.status is Status.UNCERTAIN and "insufficient speech" in d.reason
    assert d.speaker_id is None and embedder.calls == calls


def test_quiet_audio_is_uncertain(enrolled):
    d = enrolled.identify(heldout("father") * 0.001, speech_seconds=2.0)
    assert d.status is Status.UNCERTAIN and "quiet" in d.reason


def test_clipped_audio_is_uncertain(enrolled):
    d = enrolled.identify(np.clip(heldout("father") * 50, -1, 1), speech_seconds=2.0)
    assert d.status is Status.UNCERTAIN and "clipped" in d.reason


def test_ambiguous_candidates_are_uncertain(cfg, store, embedder, vad, ref_dir, monkeypatch):
    import soundfile as sf
    from synthetic import SR

    monkeypatch.setitem(VOICES, "father_twin", (112, 610))   # nearly identical to "father"
    (ref_dir / "father_twin").mkdir()
    for i in range(3):
        sf.write(ref_dir / "father_twin" / f"{i}.wav", recording("father_twin", 300 + i), SR)
    Enroller(cfg, store, embedder, vad).enroll_all(ref_dir, consent=True)
    index, _ = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
    d = SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy)).identify(heldout("father"))
    assert d.status is Status.UNCERTAIN and "too close" in d.reason
    assert d.speaker_id is None and d.similarity_score > 0.8


def test_policy_branches():
    pol = DecisionPolicy(PolicyConfig(mode="strict", accept_threshold=0.5, unknown_threshold=0.3, min_margin=0.1))
    c = lambda *s: [Candidate(f"p{i}", f"P{i}", x) for i, x in enumerate(s)]  # noqa: E731
    assert pol.decide([])[0] is Status.UNKNOWN
    assert pol.decide(c(0.2, 0.1))[0] is Status.UNKNOWN
    assert pol.decide(c(0.4, 0.1))[0] is Status.UNCERTAIN       # between thresholds
    assert pol.decide(c(0.7, 0.65))[0] is Status.UNCERTAIN      # ambiguous
    assert pol.decide(c(0.7, 0.3))[0] is Status.MATCH
    assert pol.decide(c(0.5))[0] is Status.MATCH                # single profile: margin not applicable


def test_incompatible_profiles_are_excluded_with_reason(cfg, store, embedder, enrolled):
    store._db.execute("UPDATE speakers SET model_version='old' WHERE source_key='father'")
    store._db.execute("UPDATE speakers SET preproc_hash='zzz' WHERE source_key='mother'")
    store._db.commit()
    index, skipped = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
    assert index.names == ["Brother"] and len(skipped) == 2
    assert all("re-run enrollment" in why for _, why in skipped)
    assert SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy)).identify(heldout("father")).status is not Status.MATCH


def test_no_profiles_gives_unknown(cfg, store, embedder):
    index, _ = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
    d = SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy)).identify(heldout("father"))
    assert d.status is Status.UNKNOWN and "no compatible" in d.reason


def test_output_schema(enrolled):
    m = enrolled.identify(heldout("father")).to_dict()
    assert {"status", "speaker_id", "speaker_name", "similarity_score", "timestamp", "reason"} <= set(m)
    assert not any("confidence" in k or "probab" in k for k in m)
    assert m["timestamp"].endswith("+00:00")
    u = enrolled.identify(heldout("stranger")).to_dict()
    assert u["speaker_id"] is None and u["speaker_name"] is None and isinstance(u["similarity_score"], float)


def test_simple_mode_is_just_low_means_unknown_otherwise_known():
    pol = DecisionPolicy(PolicyConfig(mode="simple", accept_threshold=0.45))
    c = lambda *s: [Candidate(f"p{i}", f"P{i}", x) for i, x in enumerate(s)]  # noqa: E731
    assert pol.decide([])[0] is Status.UNKNOWN
    assert pol.decide(c(0.30, 0.10))[0] is Status.UNKNOWN          # everyone scored low
    assert pol.decide(c(0.40, 0.39))[0] is Status.UNKNOWN          # still all below the line
    assert pol.decide(c(0.60, 0.58))[0] is Status.MATCH            # close runner-up does NOT make it uncertain
    assert pol.decide(c(0.46))[0] is Status.MATCH


def test_simple_mode_end_to_end(cfg, store, embedder, enrolled):
    from dataclasses import replace
    pol = DecisionPolicy(replace(cfg.policy, mode="simple", accept_threshold=0.8))
    ident = SpeakerIdentifier(embedder, enrolled.index, pol)
    assert ident.identify(heldout("mother")).speaker_name == "Mother"
    u = ident.identify(heldout("stranger"))
    assert u.status is Status.UNKNOWN and u.speaker_id is None
    with pytest.raises(ValueError):
        DecisionPolicy(replace(cfg.policy, mode="nope")).decide(enrolled.index.rank(embedder.embed(heldout("mother"))))
