"""Shared fixtures. Environments are session-scoped where possible because
building the FHIR sandbox and running trajectories dominates test time."""
from __future__ import annotations

import atexit
import os
import shutil
import tempfile
import warnings

# MUST run before any aegis_care import: config.RESULTS_DIR is resolved at
# import time, and the API writes tables, figures, and the report to it on
# every POST /api/experiment. Without this redirect a plain `pytest -q`
# overwrites the committed evidence package in results/ with whatever tiny
# matrix the API test happened to request.
_RESULTS_TMP = tempfile.mkdtemp(prefix="aegis-test-results-")
os.environ["AEGIS_RESULTS_DIR"] = _RESULTS_TMP
atexit.register(shutil.rmtree, _RESULTS_TMP, True)

# API tests reset the synthetic operator workspace. Keep its durable SQLite
# registry away from the user's live demo database.
_CLINICAL_TMP = tempfile.mkdtemp(prefix="aegis-test-clinical-")
os.environ["AEGIS_CLINICAL_DB"] = os.path.join(_CLINICAL_TMP, "registry.sqlite3")
atexit.register(shutil.rmtree, _CLINICAL_TMP, True)

# Running the test suite must never cost money. The assistant's odd-input and
# robustness tests deliberately send text the local matcher cannot place, which
# is exactly the input that would otherwise be billed to a live API key. Force
# the model budget to zero before aegis_care is imported, so routing degrades to
# "ask me to rephrase" instead of calling out.
os.environ["AEGIS_ASSISTANT_MAX_CALLS"] = "0"

import pytest

from aegis_care.care.coordinator import CAREOptions, RecoveryCoordinator
from aegis_care.environment import AegisEnvironment
from aegis_care.incident.scenarios import ScenarioBuilder

warnings.filterwarnings("ignore")


@pytest.fixture(scope="session")
def results_tmp_dir() -> str:
    """Where the suite is allowed to write evidence artifacts."""
    return _RESULTS_TMP


@pytest.fixture
def env() -> AegisEnvironment:
    return AegisEnvironment()


@pytest.fixture
def builder(env) -> ScenarioBuilder:
    return ScenarioBuilder(env)


@pytest.fixture
def f1_incident(env, builder):
    """A depth-4 wrong-patient-alias incident with a matched clean control."""
    return builder.build("F1", env.tasks[0], depth=4, n_controls=1)


@pytest.fixture
def recovered(env, f1_incident):
    """The F1 incident after a full CARE recovery."""
    coordinator = RecoveryCoordinator(env)
    result = coordinator.recover(f1_incident.incident_id, [f1_incident.seed_key],
                                 options=CAREOptions(),
                                 followup_tasks=[f1_incident.task])
    return f1_incident, result
