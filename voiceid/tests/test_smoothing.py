from voiceid.config import TrackerConfig
from voiceid.matching import Decision, Status
from voiceid.smoothing import IdentityTracker


def dec(status, sid=None, name=None, ts="t"):
    return Decision(status, sid, name, 0.9 if sid else 0.1, ts, "r")


A = lambda: dec(Status.MATCH, "a", "Alice")  # noqa: E731
B = lambda: dec(Status.MATCH, "b", "Bob")    # noqa: E731
U = lambda: dec(Status.UNKNOWN)              # noqa: E731
Q = lambda: dec(Status.UNCERTAIN)            # noqa: E731


def run(tr, seq):
    out, t = [], 0.0
    for d in seq:
        t += 3
        out += [(e["event"], e["speaker_id"]) for e in tr.update(d(), t)]
    return out


def test_establish_then_stable():
    assert run(IdentityTracker(TrackerConfig()), [A, A, A]) == [("IDENTITY_ESTABLISHED", "a")]


def test_single_outlier_does_not_switch():
    assert run(IdentityTracker(TrackerConfig()), [A, B, A, A, B, A]) == [("IDENTITY_ESTABLISHED", "a")]


def test_rapid_alternation_never_switches():
    assert run(IdentityTracker(TrackerConfig(switch_after=2)), [A] + [B, A] * 10) == [("IDENTITY_ESTABLISHED", "a")]


def test_sustained_new_speaker_switches():
    assert run(IdentityTracker(TrackerConfig(switch_after=2)), [A, B, B]) == [("IDENTITY_ESTABLISHED", "a"), ("IDENTITY_CHANGED", "b")]


def test_uncertain_changes_nothing_and_does_not_break_a_run():
    assert run(IdentityTracker(TrackerConfig()), [A, B, Q, B]) == [("IDENTITY_ESTABLISHED", "a"), ("IDENTITY_CHANGED", "b")]


def test_identity_lost_after_consecutive_unknowns():
    tr = IdentityTracker(TrackerConfig(lose_after_unknown=2))
    assert run(tr, [A, U, A, U, U]) == [("IDENTITY_ESTABLISHED", "a"), ("IDENTITY_LOST", None)]


def test_identity_expires_with_time():
    tr = IdentityTracker(TrackerConfig(expire_after_s=10))
    tr.update(A(), 0.0)
    assert [e["event"] for e in tr.tick(5.0)] == []
    assert [e["event"] for e in tr.tick(11.0)] == ["IDENTITY_LOST"]


def test_establish_after_n():
    assert run(IdentityTracker(TrackerConfig(establish_after=2)), [A, B, A]) == []
    assert run(IdentityTracker(TrackerConfig(establish_after=2)), [A, A]) == [("IDENTITY_ESTABLISHED", "a")]
