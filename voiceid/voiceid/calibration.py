"""Derive decision thresholds from YOUR recordings instead of trusting a universal number.

Scores come from leave-one-recording-out trials on the reference audio (and optionally an extra
directory of unregistered speakers):
  genuine  = a recording scored against its own speaker's profile built WITHOUT that recording
  impostor = a recording scored against every OTHER speaker's profile (plus unregistered speakers' recordings)
accept_threshold  = lowest threshold whose impostor false-accept rate is <= target_far
unknown_threshold = the genuine-score quantile below which a genuine trial is "very unlikely" (default 5th percentile)
"""
from __future__ import annotations

from dataclasses import asdict, replace
from typing import Optional

import numpy as np

from .config import PolicyConfig
from .embedder import l2_normalize
from .storage import ProfileStore


def leave_one_out_scores(store: ProfileStore, extra_impostors: Optional[list[np.ndarray]] = None):
    speakers = [s for s in store.list_speakers() if s.profile_dim]
    embs = {s.speaker_id: [l2_normalize(r.embedding) for r in store.list_recordings(s.speaker_id)] for s in speakers}
    if len(speakers) < 2:
        raise ValueError("need at least 2 registered speakers to calibrate")
    if any(len(v) < 2 for v in embs.values()):
        raise ValueError("every speaker needs at least 2 recordings for leave-one-out calibration")
    genuine, impostor = [], []
    for sid, vecs in embs.items():
        mat = np.stack(vecs)
        for i, v in enumerate(vecs):
            own = l2_normalize(np.delete(mat, i, axis=0).mean(axis=0))
            genuine.append(float(v @ own))
            for oid, ovecs in embs.items():
                if oid != sid:
                    impostor.append(float(v @ l2_normalize(np.stack(ovecs).mean(axis=0))))
    for v in extra_impostors or []:
        for ovecs in embs.values():
            impostor.append(float(l2_normalize(v) @ l2_normalize(np.stack(ovecs).mean(axis=0))))
    return np.asarray(genuine), np.asarray(impostor)


def far_frr_curve(genuine: np.ndarray, impostor: np.ndarray, thresholds: np.ndarray):
    far = np.array([(impostor >= t).mean() for t in thresholds])
    frr = np.array([(genuine < t).mean() for t in thresholds])
    return far, frr


def calibrate_policy(genuine: np.ndarray, impostor: np.ndarray, base: PolicyConfig, target_far: float = 0.01,
                     unknown_genuine_quantile: float = 0.05) -> tuple[PolicyConfig, dict]:
    ths = np.unique(np.concatenate([genuine, impostor]))
    far, frr = far_frr_curve(genuine, impostor, ths)
    ok = np.flatnonzero(far <= target_far)
    if ok.size and ok[0] > 0:
        accept = float((ths[ok[0]] + ths[ok[0] - 1]) / 2)   # midpoint between adjacent observed scores
    elif ok.size:
        accept = float(ths[0])
    else:
        accept = float(impostor.max()) + 1e-3
    eer_i = int(np.argmin(np.abs(far - frr)))
    unknown = min(float(np.quantile(genuine, unknown_genuine_quantile)), accept)
    # margin: the 90th percentile of the (own - best-other) gap would need full ranking; keep the base value
    # and report it, rather than inventing one.
    policy = replace(base, accept_threshold=round(accept, 4), unknown_threshold=round(unknown, 4), calibrated=True)
    report = {
        "n_genuine_trials": int(genuine.size), "n_impostor_trials": int(impostor.size), "target_far": target_far,
        "genuine_mean": float(genuine.mean()), "impostor_mean": float(impostor.mean()),
        "impostor_max": float(impostor.max()), "genuine_min": float(genuine.min()),
        "eer_approx": float((far[eer_i] + frr[eer_i]) / 2), "eer_threshold": float(ths[eer_i]),
        "frr_at_accept": float((genuine < accept).mean()), "far_at_accept": float((impostor >= accept).mean()),
        "policy": asdict(policy),
        "caveat": ("Few trials give coarse estimates, and impostors here are only registered speakers (plus any "
                   "extra recordings you supplied). Re-check with scripts/evaluate.py on held-out audio."),
    }
    return policy, report
