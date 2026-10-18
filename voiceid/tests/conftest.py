import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from synthetic import SpectralEmbedder, write_reference_dir  # noqa: E402

from voiceid.config import Config, PolicyConfig  # noqa: E402
from voiceid.enrollment import Enroller  # noqa: E402
from voiceid.matching import DecisionPolicy, SpeakerIdentifier, SpeakerIndex  # noqa: E402
from voiceid.storage import ProfileStore  # noqa: E402
from voiceid.vad import make_vad  # noqa: E402


@pytest.fixture
def cfg(tmp_path):
    c = Config(reference_dir=str(tmp_path / "ref"), db_path=str(tmp_path / "t.db"))
    c.vad.backend = "energy"
    # thresholds suited to the synthetic embedder only (genuine ~1.0, impostors <= ~0.52)
    c.policy = PolicyConfig(mode="strict", accept_threshold=0.8, unknown_threshold=0.65, min_margin=0.1, min_speech_s=1.0)
    return c


@pytest.fixture
def embedder():
    return SpectralEmbedder()


@pytest.fixture
def vad(cfg):
    return make_vad(cfg.vad)


@pytest.fixture
def store(cfg):
    s = ProfileStore(cfg.db_path)
    yield s
    s.close()


@pytest.fixture
def enroller(cfg, store, embedder, vad):
    return Enroller(cfg, store, embedder, vad)


@pytest.fixture
def ref_dir(cfg):
    return write_reference_dir(Path(cfg.reference_dir))


@pytest.fixture
def enrolled(cfg, store, embedder, enroller, ref_dir):
    rep = enroller.enroll_all(ref_dir, consent=True)
    assert not rep.failed_recordings
    index, skipped = SpeakerIndex.from_store(store, embedder, cfg.preproc.fingerprint(cfg.vad))
    assert not skipped
    return SpeakerIdentifier(embedder, index, DecisionPolicy(cfg.policy))
