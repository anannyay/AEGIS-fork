"""FastAPI application: the live AEGIS-Care prototype.

Exposes the FHIR sandbox, the three role-separated agent runtimes, incident
construction, the CARE recovery loop, human review (requirement F10), recovery
certificates (F9), the privacy audit, and the experiment runner - plus the
reviewer dashboard.

Role separation is enforced at the API boundary too: the coordinator endpoints
never return memory content, and content endpoints require the owning role.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..assistant import Router
from ..assistant.intents import normalise_param
from ..care.coordinator import CAREOptions, RecoveryCoordinator
from ..clinical_registry import ClinicalRegistry, DESTINATIONS, PATIENT_COUNT
from ..config import CONFIG, PROJECT_ROOT, RESULTS_DIR
from ..environment import AegisEnvironment
from ..eval.baselines import CONDITION_INFO, BaselineRunner
from ..eval.metrics import MetricsEvaluator
from ..eval.privacy import PrivacyAuditor
from ..eval.report import build_report, make_figures
from ..eval.runner import ExperimentRunner
from ..incident.masks import ProvenanceMask
from ..incident.scenarios import FAMILIES, FAMILY_INFO, Incident, ScenarioBuilder
from ..memory.models import MemoryState
from ..policy.rbac import ROLE_FIELD_MATRIX, Role

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class AppState:
    """Holds the live environment and everything derived from it."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.env = AegisEnvironment()
        self.registry = ClinicalRegistry()
        self.builder = ScenarioBuilder(self.env)
        self.incidents: Dict[str, Incident] = {}
        self.recoveries: Dict[str, Any] = {}
        self.snapshots: Dict[str, Any] = {}
        self.masks: Dict[str, Any] = {}
        self.experiment: Optional[Dict[str, Any]] = None
        self.experiment_status = "idle"
        self.experiment_log: List[str] = []
        self.assistant = Router()
        # Keep conversational context scoped to one browser session.  The
        # default router preserves backwards compatibility for API clients
        # that have not adopted session ids yet.
        self.assistant_sessions: Dict[str, Router] = {"default": self.assistant}
        self.experiment_runner: Optional[ExperimentRunner] = None
        self.experiment_error: Optional[str] = None
        self.experiment_started_at: Optional[float] = None

    def reset(self) -> None:
        self.registry.reset_activity()
        self.env = AegisEnvironment()
        self.builder = ScenarioBuilder(self.env)
        self.incidents.clear()
        self.recoveries.clear()
        self.snapshots.clear()
        self.masks.clear()
        self.assistant = Router()
        self.assistant_sessions = {"default": self.assistant}

    def assistant_for(self, session_id: str) -> Router:
        """Return isolated assistant context for one browser session."""
        key = re.sub(r"[^A-Za-z0-9_.:-]", "", session_id or "default")[:96]
        key = key or "default"
        if key not in self.assistant_sessions:
            # This prototype has no durable user store yet, so bound the
            # in-process session cache rather than letting abandoned tabs grow
            # it forever.
            if len(self.assistant_sessions) >= 64:
                oldest = next(k for k in self.assistant_sessions if k != "default")
                self.assistant_sessions.pop(oldest, None)
            self.assistant_sessions[key] = Router()
        return self.assistant_sessions[key]


state = AppState()

app = FastAPI(
    title="AEGIS-Care",
    version="5.0",
    description="A privacy-bounded memory recompiler for recovering poisoned "
                "clinical AI agents. Simulated FHIR sandbox only - not for "
                "clinical use.",
)


@app.middleware("http")
async def prevent_stale_live_state(request, call_next):
    """The dashboard is a live incident console; API snapshots must not be cached.

    A cached patient roll-up beside a fresh assistant answer is actively
    misleading, not merely cosmetically stale. Static assets may still use the
    browser's normal cache, but every state-bearing API/FHIR response is forced
    through to the current in-process workspace.
    """
    response = await call_next(request)
    if request.url.path.startswith(("/api/", "/fhir/")):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# ======================================================================
# Models
# ======================================================================
class IncidentRequest(BaseModel):
    family: str = Field("F1", description="F1 | F2 | F3 | F4")
    task_id: Optional[str] = None
    depth: int = Field(4, ge=1, le=4)
    n_controls: int = Field(1, ge=0, le=3)
    provenance: str = Field("complete",
                            description="complete | random20 | random40 | random60 | targeted")


class RecoveryRequest(BaseModel):
    incident_id: str
    use_sketch: bool = True
    use_explicit_lineage: bool = True
    use_counterfactual: bool = True
    use_recompilation: bool = True
    use_enforcement: bool = True
    use_scoping: bool = True


class BaselineRequest(BaseModel):
    incident_id: str
    conditions: List[str] = Field(default_factory=lambda: list(CONDITION_INFO.keys()))


class ReviewRequest(BaseModel):
    memory_key: str
    decision: str = Field(..., description="approve | reject | keep_quarantined")
    reviewer: str = "reviewer"
    note: str = ""


class ExperimentRequest(BaseModel):
    families: List[str] = Field(default_factory=lambda: list(FAMILIES))
    depths: List[int] = Field(default_factory=lambda: [2, 3, 4])
    provenance_conditions: List[str] = Field(
        default_factory=lambda: ["complete", "random40", "targeted"])
    conditions: List[str] = Field(default_factory=lambda: list(CONDITION_INFO.keys()))
    tasks_per_family: int = 2
    n_controls: int = 1


class TransferRequest(BaseModel):
    record_key: str = Field(..., min_length=3, max_length=160)
    target_patient_id: str = Field(..., min_length=2, max_length=32)
    destination: str = Field(..., max_length=40)


class ManualReportRequest(BaseModel):
    patient_id: str = Field(..., min_length=2, max_length=32)
    record_key: Optional[str] = Field(None, max_length=160)
    description: str = Field(..., min_length=10, max_length=1000)


class ReportResolutionRequest(BaseModel):
    note: str = Field(..., min_length=10, max_length=1000)


# ======================================================================
# System
# ======================================================================
@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "version": app.version,
            "model": state.env.model.name, "config_seed": CONFIG.seed}


@app.get("/api/system")
def system() -> Dict[str, Any]:
    env = state.env
    return {
        "stats": env.stats(),
        "roles": {
            role.value: {
                "fields": sorted(f.value for f in ROLE_FIELD_MATRIX[role]),
                "memory": env.runtime(role).vault.stats() if role in env.runtimes else {},
            }
            for role in (Role.REGISTRATION, Role.NURSING, Role.CLINICAL_SUMMARY,
                         Role.COORDINATOR)
        },
        "families": FAMILY_INFO,
        "conditions": {k: {"name": v[0], "purpose": v[1]}
                       for k, v in CONDITION_INFO.items()},
        "provenance_conditions": list(ProvenanceMask.CONDITIONS),
        "tasks": [{"task_id": t["task_id"], "family": t["family"],
                   "label": t["label"], "patient_id": t["patient_id"],
                   "depth": t["depth"]} for t in env.tasks],
        "sketch": {"dim": CONFIG.sketch.sketch_dim, "bits": CONFIG.sketch.quant_bits,
                   "bytes": env.encoder.bytes_per_sketch()},
    }


@app.get("/api/evidence")
def evidence() -> Dict[str, Any]:
    """Return the latest independently hash-bound evaluation summary."""
    evidence_dir = RESULTS_DIR / "external_validation"
    manifest_path = evidence_dir / "evidence_manifest.json"
    results_path = evidence_dir / "results.json"
    if not manifest_path.is_file() or not results_path.is_file():
        return {
            "status": "not_run",
            "claim_tier": "internal mechanism validation only",
            "next_command": "python -m aegis_care.cli external-validate --fhir <synthea.zip>",
        }
    try:
        from ..eval.evidence import verify_evidence_manifest

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        results = json.loads(results_path.read_text(encoding="utf-8"))
        integrity = verify_evidence_manifest(manifest_path)
        full_care = next(
            (row for row in results.get("by_condition", [])
             if row.get("condition") == "I"),
            {},
        )
        return {
            "status": "verified" if integrity["valid"] else "integrity_failure",
            "claim": manifest.get("claim", {}),
            "data_source": manifest.get("data_source", {}),
            "evaluation": {
                "condition_runs": len(results.get("rows", [])),
                "incidents": len(results.get("incidents", [])),
                "verification_failures": results.get("verification_failures", []),
                "full_care": full_care,
            },
            "integrity": integrity,
            "artifacts": sorted(manifest.get("artifacts", {}).keys()),
        }
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {"status": "unreadable", "error": str(exc)}


@app.post("/api/system/reset")
def reset_system() -> Dict[str, Any]:
    with state.lock:
        state.reset()
    return {"status": "reset", "stats": state.env.stats()}


# ======================================================================
# FHIR sandbox
# ======================================================================
@app.get("/fhir/{resource_type}/{resource_id}")
def fhir_read(resource_type: str, resource_id: str) -> Dict[str, Any]:
    found = state.env.fhir.read(resource_type, resource_id)
    if found is None:
        raise HTTPException(404, f"{resource_type}/{resource_id} not found")
    return found


@app.get("/fhir/{resource_type}")
def fhir_search(resource_type: str, identifier: Optional[str] = None,
                family: Optional[str] = None, given: Optional[str] = None,
                birthdate: Optional[str] = None, patient: Optional[str] = None,
                code: Optional[str] = None, category: Optional[str] = None) -> Dict[str, Any]:
    params = {k: v for k, v in {
        "identifier": identifier, "family": family, "given": given,
        "birthdate": birthdate, "patient": patient, "code": code,
        "category": category}.items() if v}
    results = state.env.fhir.search(resource_type, **params)
    return state.env.fhir.bundle(resource_type, results)


# ======================================================================
# Memory
# ======================================================================
@app.get("/api/memory")
def list_memory(role: Optional[str] = None, state_filter: Optional[str] = None,
                include_content: bool = True) -> Dict[str, Any]:
    """Memory listing. `include_content=false` gives the coordinator-safe view."""
    env = state.env
    roles = [Role(role)] if role else list(env.runtimes.keys())
    out: List[Dict[str, Any]] = []
    for r in roles:
        if r not in env.runtimes:
            continue
        for artifact in env.runtime(r).vault.all():
            if state_filter and artifact.state.value != state_filter:
                continue
            out.append(artifact.to_local_dict() if include_content
                       else artifact.to_public_dict())
    out.sort(key=lambda a: (a["owner"], a["memory_id"], a["version"]))
    return {"count": len(out), "memories": out}


@app.get("/api/memory/{memory_key}")
def get_memory(memory_key: str) -> Dict[str, Any]:
    artifact = state.env.find_artifact(memory_key)
    if artifact is None:
        raise HTTPException(404, f"memory {memory_key} not found")
    data = artifact.to_local_dict()
    data["history"] = state.env.ledger.version_history(artifact.memory_id)
    return data


@app.get("/api/memory/{memory_key}/graph")
def memory_graph(memory_key: str) -> Dict[str, Any]:
    """Derivation graph around one artifact, for the dashboard visualiser."""
    env = state.env
    nodes, edges = [], []
    for artifact in env.all_artifacts():
        nodes.append({
            "key": artifact.key, "type": artifact.artifact_type.value,
            "owner": artifact.owner.value, "state": artifact.state.value,
            "patient": artifact.patient_scope,
            "focus": artifact.key == memory_key,
        })
        for parent in artifact.explicit_parent_commitments:
            parent_artifact = env.artifact_by_commitment(parent)
            if parent_artifact is not None:
                edges.append({"from": parent_artifact.key, "to": artifact.key,
                              "observed": True})
    # Ground-truth edges the operational system cannot see (masked).
    observed = {(e["from"], e["to"]) for e in edges}
    for parent, child in env.truth.edges:
        if (parent, child) not in observed:
            edges.append({"from": parent, "to": child, "observed": False})
    return {"nodes": nodes, "edges": edges}


# ======================================================================
# Patient-centric view
#
# The role-separated console needs a record-shaped surface, not a memory-graph
# one: a nurse asks "can I trust what the assistant told me about this
# patient", which is a question about one patient's records and their current
# trust state. These endpoints roll the vaults up per patient. They are
# clinical-content endpoints, so they are only ever served to a clinical role -
# the coordinator persona must not reach them.
# ======================================================================
TRUST_ORDER = {"quarantined": 0, "suspected": 1, "repaired": 2,
               "superseded": 3, "tombstoned": 4, "active": 5}


def _patient_display(env: Any, patient_id: str) -> Dict[str, Any]:
    """Use the fixed registry identity throughout the patient workspace."""
    fixed = state.registry.patient(patient_id)
    if fixed:
        return {"id": patient_id, "name": fixed["name"],
                "mrn": fixed["mrn"], "birth_date": fixed["birth_date"]}
    resource = env.fhir.read("Patient", patient_id)
    if not resource:
        return {"id": patient_id, "name": patient_id, "mrn": None, "birth_date": None}
    name = (resource.get("name") or [{}])[0]
    given = " ".join(name.get("given") or [])
    identifiers = resource.get("identifier") or [{}]
    return {
        "id": patient_id,
        "name": f"{given} {name.get('family', '')}".strip() or patient_id,
        "mrn": identifiers[0].get("value"),
        "birth_date": resource.get("birthDate"),
    }


def _record_rows(env: Any, patient_id: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for artifact in env.all_artifacts():
        if artifact.patient_scope != patient_id:
            continue
        rows.append({
            "key": artifact.key,
            "memory_id": artifact.memory_id,
            "version": artifact.version,
            "owner": artifact.owner.value,
            "artifact_type": artifact.artifact_type.value,
            "state": artifact.state.value,
            "servable": artifact.is_servable(),
            "created_at": artifact.created_at,
            "purpose": artifact.purpose,
            "quarantine_reason": artifact.quarantine_reason,
            "content": artifact.content,
        })
    rows.sort(key=lambda r: (TRUST_ORDER.get(r["state"], 9), r["memory_id"], r["version"]))
    return rows


@app.get("/api/patients")
def list_patients(only_with_memory: bool = True) -> Dict[str, Any]:
    """Patient registry and agent memory, with separate authoritative counts.

    The legacy memory-only default keeps research API clients stable. The
    operator workspace explicitly requests all 160 fixed synthetic patients.
    """
    env = state.env
    buckets: Dict[str, Dict[str, Any]] = {}
    for artifact in env.all_artifacts():
        token = artifact.patient_scope
        if not token:
            continue
        bucket = buckets.setdefault(token, {
            "patient": _patient_display(env, token),
            "records": 0, "active": 0, "repaired": 0,
            "quarantined": 0, "withdrawn": 0, "under_review": 0,
        })
        bucket["records"] += 1
        s = artifact.state.value
        if s == "active":
            bucket["active"] += 1
        elif s == "repaired":
            bucket["repaired"] += 1
        elif s == "quarantined":
            bucket["quarantined"] += 1
        elif s in ("superseded", "tombstoned"):
            bucket["withdrawn"] += 1
        elif s == "suspected":
            bucket["under_review"] += 1

    if not only_with_memory:
        for patient in state.registry.patients():
            buckets.setdefault(patient["id"], {
                "patient": _patient_display(env, patient["id"]),
                "records": 0, "active": 0, "repaired": 0,
                "quarantined": 0, "withdrawn": 0, "under_review": 0,
            })

    out = []
    for token, bucket in buckets.items():
        source = state.registry.summary(token) if state.registry.patient(token) else {
            "source_records": 0, "source_held": 0, "completed_transfers": 0,
            "held_transfers": 0, "open_reports": 0,
        }
        # One plain-language status per patient - this is what a nurse reads.
        # A patient whose only remaining records were withdrawn is NOT "no
        # issues": entries were wrongly filed against them and then removed,
        # and the clinician needs to know that happened.
        live = bucket["active"] + bucket["repaired"]
        if bucket["quarantined"] or source["source_held"] or source["held_transfers"] or source["open_reports"]:
            status, headline = "attention", "Record needs review"
        elif bucket["under_review"]:
            status, headline = "checking", "Being checked"
        elif bucket["repaired"]:
            status, headline = "corrected", "Corrected and safe to use"
        elif bucket["withdrawn"] and not live:
            status, headline = "withdrawn", "Incorrect entries removed"
        else:
            status, headline = "clear", "No record mismatch detected"
        out.append({**bucket, **source, "token": token,
                    "status": status, "headline": headline})

    order = {"attention": 0, "checking": 1, "corrected": 2, "withdrawn": 3, "clear": 4}
    out.sort(key=lambda r: (order[r["status"]], r["patient"]["name"]))
    return {"count": len(out), "patients": out}


@app.get("/api/patients/{patient_id}/record")
def patient_record(patient_id: str) -> Dict[str, Any]:
    """One patient's records, newest state first, with what changed and why.

    `changes` pairs each repaired record with the version it replaced so the
    interface can show a real before/after rather than asserting a correction.
    """
    env = state.env
    rows = _record_rows(env, patient_id)
    fixed = state.registry.patient(patient_id)
    if not rows and not fixed:
        raise HTTPException(404, f"patient {patient_id} not found")

    # A wrong-patient incident files a record under the WRONG patient, so the
    # repaired version and the version it replaced sit under different patient
    # scopes. Predecessors are therefore looked up across every vault by
    # memory_id, and the change reports which patient the record used to be
    # filed under - which is the fact a clinician actually needs.
    all_versions: Dict[str, List[Any]] = {}
    for artifact in env.all_artifacts():
        all_versions.setdefault(artifact.memory_id, []).append(artifact)

    changes = []
    for row in rows:
        if row["state"] != "repaired":
            continue
        siblings = sorted(all_versions.get(row["memory_id"], []), key=lambda a: a.version)
        previous = next((a for a in reversed(siblings) if a.version < row["version"]), None)
        if previous is None:
            continue
        changes.append({
            "memory_id": row["memory_id"],
            "artifact_type": row["artifact_type"],
            "owner": row["owner"],
            "from_version": previous.version,
            "to_version": row["version"],
            "before": previous.content,
            "after": row["content"],
            "previously_filed_under": previous.patient_scope,
            "refiled": previous.patient_scope != patient_id,
            "rebuilt_at": row["created_at"],
        })

    held = [r for r in rows if r["state"] == "quarantined"]
    source_records = state.registry.records(patient_id) if fixed else []
    source_summary = state.registry.summary(patient_id) if fixed else {
        "source_records": 0, "source_held": 0, "completed_transfers": 0,
        "held_transfers": 0, "open_reports": 0,
    }
    return {
        "patient": _patient_display(env, patient_id),
        "records": rows,
        "source_records": source_records,
        "source_summary": source_summary,
        "transfers": state.registry.transfers(patient_id) if fixed else [],
        "manual_reports": state.registry.reports(patient_id) if fixed else [],
        "transfer_destinations": DESTINATIONS,
        "changes": changes,
        "held_for_review": held,
        "summary": {
            "total": len(rows),
            "in_use": sum(1 for r in rows if r["servable"]),
            "corrected": len(changes),
            "held": len(held),
            "withdrawn": sum(1 for r in rows if r["state"] in ("superseded", "tombstoned")),
        },
    }


@app.get("/api/registry")
def registry_overview() -> Dict[str, Any]:
    patients = list_patients(only_with_memory=False)["patients"]
    return {"patients": PATIENT_COUNT, "source_records": sum(p["source_records"] for p in patients),
            "patients_needing_review": sum(p["status"] == "attention" for p in patients),
            "synthetic_only": True,
            "automatic_checks": ["patient identity", "source status", "transfer scope"],
            "destinations": DESTINATIONS}


@app.post("/api/registry/transfers")
def transfer_record(req: TransferRequest) -> Dict[str, Any]:
    """Check and record a proposed handover; unsafe transfers are held."""
    try:
        with state.lock:
            return state.registry.transfer(req.record_key, req.target_patient_id,
                                           req.destination)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/registry/reports")
def report_record(req: ManualReportRequest) -> Dict[str, Any]:
    """Manual fallback for a concern that deterministic checks cannot assess."""
    try:
        with state.lock:
            return state.registry.report(req.patient_id, req.record_key,
                                         req.description)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/registry/reports/{report_id}/dismiss")
def dismiss_manual_report(report_id: int, req: ReportResolutionRequest) -> Dict[str, Any]:
    """Record a reasoned review of a manually raised demo concern."""
    try:
        with state.lock:
            return state.registry.dismiss_report(report_id, req.note)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


# ======================================================================
# Incidents
# ======================================================================
@app.post("/api/incidents")
def create_incident(req: IncidentRequest) -> Dict[str, Any]:
    if req.family not in FAMILIES:
        raise HTTPException(400, f"unknown family {req.family}")
    env = state.env
    with state.lock:
        task = next((t for t in env.tasks if t["task_id"] == req.task_id), None) \
            if req.task_id else env.tasks[0]
        if task is None:
            raise HTTPException(400, f"unknown task {req.task_id}")
        seed_depth = FAMILY_INFO[req.family]["seed_depth"]
        if req.depth < seed_depth + 1:
            raise HTTPException(
                400, f"family {req.family} seeds at depth {seed_depth}; "
                     f"requires depth >= {seed_depth + 1}")

        incident = state.builder.build(req.family, task, depth=req.depth,
                                       n_controls=req.n_controls)
        mask = ProvenanceMask(env, CONFIG.seed).apply(req.provenance)
        state.incidents[incident.incident_id] = incident
        state.snapshots[incident.incident_id] = env.snapshot()
        state.masks[incident.incident_id] = mask
        env.ledger.log_event(
            incident.incident_id, "safety", "incident_reported", incident.seed_key,
            {"family": incident.family,
             "affected": len(incident.true_contaminated),
             "provenance": req.provenance},
        )

    return _incident_payload(incident, mask)


@app.get("/api/incidents")
def list_incidents() -> Dict[str, Any]:
    return {"incidents": [
        _incident_payload(inc, state.masks.get(inc.incident_id))
        for inc in state.incidents.values()]}


@app.get("/api/incidents/{incident_id}")
def get_incident(incident_id: str) -> Dict[str, Any]:
    incident = state.incidents.get(incident_id)
    if incident is None:
        raise HTTPException(404, f"incident {incident_id} not found")
    return _incident_payload(incident, state.masks.get(incident_id), detailed=True)


CASE_EVENT_LABELS = {
    "incident_reported": ("reported", "Incident reported"),
    "recovery_started": ("working", "Containment started"),
    "recompiled": ("working", "Record rebuilt from trusted source"),
    "quarantined": ("review", "Record held for human review"),
    "enforcement_armed": ("working", "Withdrawn versions blocked"),
    "recovery_complete": ("verified", "Recovery verification completed"),
    "review_decision": ("verified", "Human review decision recorded"),
}


def _case_payload(incident: Incident, role: str = "researcher",
                  include_timeline: bool = False) -> Dict[str, Any]:
    """Project technical incident state into one user-facing case."""
    result = state.recoveries.get(incident.incident_id)
    quarantined = len(result.quarantined) if result else 0
    safe_resume = bool(result and result.certificate and result.certificate.safe_resume)
    if result and (quarantined or not safe_resume):
        status, owner = "review_required", "compliance"
        next_action = "Review the records AEGIS refused to rebuild automatically"
    elif result:
        status, owner = "contained", "clinician"
        next_action = "Verify the corrected patient record before relying on it"
    else:
        status, owner = "open", "safety"
        next_action = "Review the proposed containment plan and start recovery"

    events_for_case = list(reversed(
        state.env.ledger.events(incident.incident_id, limit=300)))
    created_at = events_for_case[0]["at"] if events_for_case else None
    updated_at = events_for_case[-1]["at"] if events_for_case else created_at
    payload: Dict[str, Any] = {
        "case_id": incident.incident_id,
        "title": FAMILY_INFO[incident.family]["name"],
        "family": incident.family,
        "status": status,
        "owner": owner,
        "attention": role in (owner, "researcher"),
        "affected_records": len(incident.true_contaminated),
        "repaired_records": len(result.repaired) if result else 0,
        "held_records": quarantined,
        "safe_resume": safe_resume,
        "next_action": next_action,
        "created_at": created_at,
        "updated_at": updated_at,
    }
    if include_timeline:
        timeline = []
        for event in events_for_case:
            display = CASE_EVENT_LABELS.get(event["kind"])
            if not display:
                continue
            stage, label = display
            timeline.append({
                "at": event["at"], "stage": stage, "label": label,
                "actor": event["actor"], "kind": event["kind"],
                "subject": event.get("subject"), "detail": event.get("detail", {}),
            })
        payload["timeline"] = timeline
    return payload


@app.get("/api/cases")
def list_cases(role: str = "researcher") -> Dict[str, Any]:
    if role not in {"clinician", "safety", "compliance", "researcher"}:
        role = "researcher"
    rows = [_case_payload(incident, role) for incident in state.incidents.values()]
    priority = {"open": 0, "review_required": 1, "contained": 2}
    rows.sort(key=lambda row: (not row["attention"], priority[row["status"]],
                               row["updated_at"] or ""))
    return {"count": len(rows),
            "attention": sum(1 for row in rows if row["attention"]),
            "cases": rows}


@app.get("/api/cases/{case_id}")
def get_case(case_id: str, role: str = "researcher") -> Dict[str, Any]:
    incident = state.incidents.get(case_id)
    if incident is None:
        raise HTTPException(404, f"case {case_id} not found")
    return _case_payload(incident, role, include_timeline=True)


def _incident_payload(incident: Incident, mask=None,
                      detailed: bool = False) -> Dict[str, Any]:
    env = state.env
    payload: Dict[str, Any] = {
        "incident_id": incident.incident_id,
        "family": incident.family,
        "family_info": FAMILY_INFO[incident.family],
        "task_id": incident.task["task_id"],
        "task_label": incident.task["label"],
        "intended_patient": incident.task["patient_id"],
        "wrong_patient": incident.wrong_patient,
        "depth": incident.depth,
        "seed_key": incident.seed_key,
        "true_contaminated": sorted(incident.true_contaminated),
        "clean_keys": sorted(incident.clean_keys),
        "recovered": incident.incident_id in state.recoveries,
    }
    if mask is not None:
        payload["provenance"] = {
            "condition": mask.condition,
            "edges_before": mask.edges_before,
            "edges_removed": mask.edges_removed,
            "loss_fraction": round(mask.loss_fraction, 3),
            "description": ProvenanceMask.describe(mask.condition),
        }
    if detailed:
        payload["trajectory"] = [
            {"key": n.key, "depth": n.depth, "role": n.role.value,
             "type": n.artifact_type.value, "patient": n.true_patient,
             "contaminated": n.contaminated,
             "state": (env.find_artifact(n.key).state.value
                       if env.find_artifact(n.key) else "missing")}
            for n in incident.contaminated.nodes
        ]
        payload["controls"] = [
            {"trajectory_id": c.trajectory_id,
             "nodes": [{"key": n.key, "type": n.artifact_type.value,
                        "patient": n.true_patient,
                        "state": (env.find_artifact(n.key).state.value
                                  if env.find_artifact(n.key) else "missing")}
                       for n in c.nodes]}
            for c in incident.controls
        ]
    return payload


# ======================================================================
# Recovery
# ======================================================================
@app.post("/api/recover")
def recover(req: RecoveryRequest) -> Dict[str, Any]:
    incident = state.incidents.get(req.incident_id)
    if incident is None:
        raise HTTPException(404, f"incident {req.incident_id} not found")

    options = CAREOptions(
        use_sketch=req.use_sketch,
        use_explicit_lineage=req.use_explicit_lineage,
        use_counterfactual=req.use_counterfactual,
        use_recompilation=req.use_recompilation,
        use_enforcement=req.use_enforcement,
        use_scoping=req.use_scoping,
    )
    env = state.env
    with state.lock:
        coordinator = RecoveryCoordinator(env)
        result = coordinator.recover(incident.incident_id, [incident.seed_key],
                                     options=options, followup_tasks=[incident.task])
        state.recoveries[incident.incident_id] = result

        evaluator = MetricsEvaluator(env)
        from ..eval.baselines import ConditionOutcome
        repaired = {r["memory_key"] for r in result.repaired}
        quarantined = {q["memory_key"] for q in result.quarantined}
        outcome = ConditionOutcome(
            condition="I", incident_id=incident.incident_id,
            withdrawn={incident.seed_key} | repaired | quarantined,
            repaired=repaired, touched=repaired | quarantined | {incident.seed_key},
            cleared=set(result.cleared), overhead=dict(result.overhead),
            certificate=result.certificate, recovery=result)
        metrics = evaluator.evaluate(outcome, incident,
                                     provenance=state.masks[incident.incident_id].condition
                                     if incident.incident_id in state.masks else "complete",
                                     followup_tasks=[incident.task])

    return {
        "incident_id": incident.incident_id,
        "options": asdict(options),
        "rounds": result.rounds,
        "closure_reached": result.closure_reached,
        "candidates": result.candidates_considered,
        "confirmed": result.confirmed,
        "cleared": result.cleared,
        "repaired": result.repaired,
        "quarantined": result.quarantined,
        "verdicts": [v.signable() | {"signature": v.signature[:24] + "..."}
                     for v in result.verdicts],
        "capsules": [
            {**{k: v for k, v in asdict(c).items()
                 if k not in {"sketch", "support_tokens"}},
             "sketch_dim": len(c.sketch), "size_bytes": c.size_bytes(),
             "support_token_count": len(c.support_tokens),
             "signature": c.signature[:24] + "..."}
            for c in result.capsules[:6]
        ],
        "enforcement": result.enforcement,
        "resurrection_probe": result.resurrection_probe,
        "overhead": result.overhead,
        "certificate": asdict(result.certificate) if result.certificate else None,
        "certificate_text": result.certificate.to_text() if result.certificate else "",
        "metrics": metrics.to_row(),
    }


@app.get("/api/recover/{incident_id}/certificate", response_class=PlainTextResponse)
def certificate_text(incident_id: str) -> str:
    result = state.recoveries.get(incident_id)
    if result is None or result.certificate is None:
        raise HTTPException(404, f"no certificate for {incident_id}")
    return result.certificate.to_text()


@app.post("/api/baselines")
def run_baselines(req: BaselineRequest) -> Dict[str, Any]:
    incident = state.incidents.get(req.incident_id)
    if incident is None:
        raise HTTPException(404, f"incident {req.incident_id} not found")
    snapshot = state.snapshots.get(req.incident_id)
    if snapshot is None:
        raise HTTPException(400, "no frozen snapshot for this incident")

    env = state.env
    provenance = (state.masks[req.incident_id].condition
                  if req.incident_id in state.masks else "complete")
    rows = []
    with state.lock:
        # Baselines are counterfactual experiments, not operations on the live
        # clinician workspace. Preserve the exact live vault before replaying
        # the frozen incident snapshot and restore it even if a condition fails.
        # Restoring `snapshot` here used to rewind a successfully recovered
        # workspace, making patients disappear while case/chat state remained.
        live_snapshot = env.snapshot()
        try:
            evaluator = MetricsEvaluator(env)
            for condition in req.conditions:
                env.restore(snapshot)
                try:
                    outcome = BaselineRunner(env).run(condition, incident,
                                                      followup_tasks=[incident.task])
                except Exception as exc:
                    rows.append({"condition": condition, "error": str(exc)})
                    continue
                metrics = evaluator.evaluate(outcome, incident, provenance=provenance,
                                             followup_tasks=[incident.task])
                row = metrics.to_row()
                row["name"] = CONDITION_INFO[condition][0]
                row["purpose"] = CONDITION_INFO[condition][1]
                rows.append(row)
        finally:
            env.restore(live_snapshot)
    return {"incident_id": req.incident_id, "provenance": provenance, "results": rows}


# ======================================================================
# Human review (requirement F10)
# ======================================================================
@app.get("/api/review/queue")
def review_queue() -> Dict[str, Any]:
    env = state.env
    items = []
    for runtime in env.runtimes.values():
        for artifact in runtime.vault.all():
            if artifact.state == MemoryState.QUARANTINED:
                items.append({
                    **artifact.to_local_dict(),
                    "quarantine_reason": artifact.quarantine_reason,
                })
    registry_items = state.registry.review_items()
    return {"count": len(items), "items": items,
            "registry_count": len(registry_items),
            "registry_items": registry_items,
            "total_count": len(items) + len(registry_items)}


@app.post("/api/review")
def review(req: ReviewRequest) -> Dict[str, Any]:
    env = state.env
    artifact = env.find_artifact(req.memory_key)
    if artifact is None:
        raise HTTPException(404, f"memory {req.memory_key} not found")
    if req.decision not in ("approve", "reject", "keep_quarantined"):
        raise HTTPException(400, f"unknown decision {req.decision}")

    runtime = env.runtime(artifact.owner)
    if req.decision == "reject":
        runtime.vault.set_state(artifact.key, MemoryState.TOMBSTONED,
                                "human_review", f"rejected by {req.reviewer}: {req.note}")
        result = "tombstoned"
    elif req.decision == "approve":
        # Safe resume requires follow-up validation, so an approved artifact is
        # republished as a repaired version rather than silently reactivated.
        runtime.vault.set_state(artifact.key, MemoryState.REPAIRED,
                                "human_review", f"approved by {req.reviewer}: {req.note}")
        runtime.vault.index.add(artifact.key, artifact.content)
        result = "repaired"
    else:
        result = "kept_quarantined"

    env.ledger.log_event("human_review", req.reviewer, "review_decision",
                         artifact.key, {"decision": req.decision, "note": req.note})
    return {"memory_key": artifact.key, "decision": req.decision, "result": result,
            "state": artifact.state.value}


# ======================================================================
# Privacy audit
# ======================================================================
@app.get("/api/privacy/{incident_id}")
def privacy_audit(incident_id: str) -> Dict[str, Any]:
    incident = state.incidents.get(incident_id)
    if incident is None:
        raise HTTPException(404, f"incident {incident_id} not found")
    result = state.recoveries.get(incident_id)
    capsules = result.capsules if result else []
    auditor = PrivacyAuditor(state.env)
    return auditor.full_audit(incident, capsules)


# ======================================================================
# Audit log
# ======================================================================
@app.get("/api/events")
def events(incident_id: Optional[str] = None, limit: int = Query(200, le=2000)) -> Dict[str, Any]:
    return {"events": state.env.ledger.events(incident_id, limit)}


@app.get("/api/verdicts/{incident_id}")
def verdicts(incident_id: str) -> Dict[str, Any]:
    return {"verdicts": state.env.ledger.verdicts(incident_id)}


# ======================================================================
# Experiments
# ======================================================================
@app.post("/api/experiment")
async def run_experiment(req: ExperimentRequest) -> Dict[str, Any]:
    if state.experiment_status == "running":
        raise HTTPException(409, "an experiment is already running")

    state.experiment_status = "running"
    state.experiment_log = []
    state.experiment_error = None
    state.experiment_started_at = time.time()

    def progress(message: str) -> None:
        state.experiment_log.append(message)

    runner = ExperimentRunner(progress=progress)
    # Published before the first cell runs so /api/experiment/status can report a
    # determinate completed/total from the very first poll.
    runner.total_cells = len(ExperimentRunner.plan(
        families=tuple(req.families), depths=tuple(req.depths),
        provenance_conditions=tuple(req.provenance_conditions),
        tasks_per_family=req.tasks_per_family))
    state.experiment_runner = runner

    def work() -> Dict[str, Any]:
        return runner.run(
            families=tuple(req.families), depths=tuple(req.depths),
            provenance_conditions=tuple(req.provenance_conditions),
            conditions=tuple(req.conditions),
            tasks_per_family=req.tasks_per_family, n_controls=req.n_controls)

    try:
        results = await asyncio.to_thread(work)
    except Exception as exc:
        state.experiment_status = "failed"
        state.experiment_error = str(exc)
        raise HTTPException(500, f"experiment failed: {exc}")
    finally:
        state.experiment_runner = None

    state.experiment = results
    state.experiment_status = "complete"
    ExperimentRunner.save(results, RESULTS_DIR)
    make_figures(results, RESULTS_DIR)
    build_report(results, out_dir=RESULTS_DIR)

    return {
        "status": "complete",
        "wall_seconds": results["wall_seconds"],
        "incidents": len(results["incidents"]),
        "runs": len(results["rows"]),
        "by_condition": results["by_condition"],
        "by_condition_provenance": results["by_condition_provenance"],
        "oracle_regret": results["oracle_regret"],
        "verification_failures": results["verification_failures"],
    }


@app.get("/api/experiment/status")
def experiment_status() -> Dict[str, Any]:
    runner = state.experiment_runner
    total = runner.total_cells if runner else 0
    completed = runner.completed_cells if runner else 0
    if state.experiment_status == "complete" and total == 0:
        total = completed = len(state.experiment["incidents"]) if state.experiment else 0
    elapsed = (round(time.time() - state.experiment_started_at, 1)
               if state.experiment_started_at else 0.0)
    return {"status": state.experiment_status,
            "log": state.experiment_log[-50:],
            "completed_cells": completed,
            "total_cells": total,
            "fraction": round(completed / total, 4) if total else 0.0,
            "elapsed_seconds": elapsed,
            "error": state.experiment_error,
            "has_results": state.experiment is not None}


@app.get("/api/experiment/results")
def experiment_results() -> Dict[str, Any]:
    if state.experiment is None:
        raise HTTPException(404, "no experiment results yet")
    return {k: v for k, v in state.experiment.items() if k != "metrics"}


@app.get("/api/experiment/report", response_class=PlainTextResponse)
def experiment_report() -> str:
    if state.experiment is None:
        raise HTTPException(404, "no experiment results yet")
    privacy = None
    if state.incidents and state.recoveries:
        incident_id = next(iter(state.recoveries))
        incident = state.incidents[incident_id]
        privacy = PrivacyAuditor(state.env).full_audit(
            incident, state.recoveries[incident_id].capsules)
    return build_report(state.experiment, privacy=privacy)




# ======================================================================
# Assistant
#
# The model chooses an action; this endpoint executes it against the real
# environment and returns real results. No clinical value, metric, or chart
# datum is ever taken from a model response - the worst a bad routing decision
# can do is open the wrong screen.
# ======================================================================
class AssistantRequest(BaseModel):
    message: str = Field(..., max_length=600)
    role: str = Field("researcher",
                      description="clinician | safety | compliance | researcher")
    session_id: str = Field("default", max_length=96,
                            description="Browser-scoped assistant session")


def _resolve_patient_token(env: Any, needle: str) -> Optional[str]:
    """Resolve one synthetic patient; ambiguous names require an ID or MRN."""
    if not needle:
        return None
    probe = needle.strip().lower()
    tokens = {p["id"] for p in state.registry.patients()}
    tokens.update(a.patient_scope for a in env.all_artifacts() if a.patient_scope)
    exact = [token for token in tokens if probe in (
        token.lower(), str(_patient_display(env, token)["mrn"] or "").lower())]
    if len(exact) == 1:
        return exact[0]
    names = [token for token in tokens
             if _patient_display(env, token)["name"].lower() == probe]
    return names[0] if len(names) == 1 else None



def _live_state() -> Dict[str, Any]:
    """What is actually true right now. Every assistant answer is built on this."""
    env = state.env
    incidents = list(state.incidents.values())
    recovered = set(state.recoveries)
    open_incidents = [i for i in incidents if i.incident_id not in recovered]
    patients = list_patients(only_with_memory=False)["patients"]
    try:
        queue = review_queue()["total_count"]
    except Exception:
        queue = 0
    last = None
    if state.recoveries:
        last_id = next(reversed(state.recoveries))
        result = state.recoveries[last_id]
        last = {
            "incident_id": last_id,
            "safe_resume": bool(getattr(result.certificate, "safe_resume", False)),
            "repaired": len(result.repaired),
            "quarantined": len(result.quarantined),
        }
    return {
        "incidents": len(incidents),
        "open_incidents": len(open_incidents),
        "open_incident_id": open_incidents[-1].incident_id if open_incidents else None,
        "recovered": len(recovered),
        "patients": len(patients),
        "patients_attention": sum(1 for p in patients if p["status"] == "attention"),
        "patients_corrected": sum(1 for p in patients if p["status"] == "corrected"),
        "patients_withdrawn": sum(1 for p in patients if p["status"] == "withdrawn"),
        "memories": sum(1 for _ in env.all_artifacts()),
        "queue": queue,
        "last_recovery": last,
    }


def _suggest(role: str, live: Dict[str, Any]) -> List[Dict[str, str]]:
    """The next steps worth offering, given what is actually true.

    Every suggestion must be something this role can actually do from here. A
    Suggestions stay inside the signed-in workspace. Cross-role work is named as
    an escalation, never implemented as an invisible role switch.
    """
    out: List[Dict[str, str]] = []

    if live["open_incidents"]:
        if role in ("safety", "researcher"):
            out.append({"label": "Run the recovery", "message": "run the recovery"})
            out.append({"label": "How far did it spread?",
                        "message": "how far did it spread"})
        else:
            out.append({"label": "What should my role do now?",
                        "message": "what should I do about the open incident"})
            out.append({"label": "Show the case inbox",
                        "message": "show the case inbox"})

    elif not live["incidents"]:
        if live["patients_attention"] and role in ("clinician", "researcher"):
            out.append({"label": "Who needs attention?",
                        "message": "which patients need attention"})
        if live["queue"] and role in ("compliance", "researcher"):
            out.append({"label": "What needs review?",
                        "message": "what is waiting for me"})
        if role in ("safety", "researcher"):
            out.append({"label": "Do the whole thing for me",
                        "message": "sort it out end to end"})
            out.append({"label": "Just report a wrong registration",
                        "message": "we registered the wrong patient"})
        else:
            out.append({"label": "What can this system do?",
                        "message": "explain the care loop"})
            out.append({"label": "Show the case inbox",
                        "message": "show the case inbox"})

    else:
        if live["patients_attention"] and role in ("clinician", "researcher"):
            out.append({"label": "Who needs attention?",
                        "message": "which patients need attention"})
        if live["queue"] and role in ("compliance", "researcher"):
            out.append({"label": "Clear the review queue",
                        "message": "what is waiting for me"})
        if live["patients_corrected"]:
            if role in ("clinician", "researcher"):
                out.append({"label": "See what changed",
                            "message": "which patients were corrected"})
            elif role == "safety":
                out.append({"label": "Review containment status",
                            "message": "what is the current system status"})
        if role in ("compliance", "researcher"):
            out.append({"label": "Did anything leak?", "message": "did any data leak"})
        if role in ("safety", "researcher"):
            out.append({"label": "Report a different kind of error",
                        "message": "we copied a fact from the wrong chart"})
        if role == "clinician":
            out.append({"label": "Show the case inbox",
                        "message": "show the case inbox"})

    # Never repeat a label; never offer more than fits comfortably.
    seen, unique = set(), []
    for item in out:
        if item["label"] not in seen:
            seen.add(item["label"])
            unique.append(item)
    return unique[:3]


def _explain_state(topic: str, role: str, live: Dict[str, Any]) -> str:
    """Answer 'explain this' from the live console, not from a language model."""
    from ..assistant.router import GLOSSARY

    probe = (topic or "").strip().lower()
    for term in sorted(GLOSSARY, key=len, reverse=True):
        if term and term in probe:
            return GLOSSARY[term]

    if live["open_incidents"]:
        return (f"An error has been reported and not yet contained. "
                f"{live['memories']} stored records exist, and the affected ones are "
                "still live. The next step is to run the recovery, which finds every "
                "record that inherited the error, proves which ones really did, and "
                "rebuilds them from the source records.")
    if live["last_recovery"]:
        last = live["last_recovery"]
        return (f"The last incident was handled: {last['repaired']} record(s) were "
                f"rebuilt from source data and {last['quarantined']} were held for a "
                f"person. Safe resume was "
                f"{'approved' if last['safe_resume'] else 'withheld'}. "
                f"{live['patients']} patient(s) have records, "
                f"{live['patients_corrected']} of them corrected.")
    return (f"The fixed synthetic registry contains {live['patients']} patients. "
            "AEGIS checks patient identity and source status during handover. "
            "No recovery incident has been reported yet. Open a patient to inspect "
            "source records, try a transfer, or report a concern manually.")


@app.get("/api/assistant/status")
def assistant_status(session_id: str = "default") -> Dict[str, Any]:
    return state.assistant_for(session_id).budget.to_dict()


def _confirmation_plan(action: str, params: Dict[str, Any],
                       live: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Describe consequential work before the assistant is allowed to run it."""
    if action == "run_recovery":
        incident_id = live.get("open_incident_id")
        if not incident_id:
            return None
        return {
            "title": "Contain the open incident",
            "summary": ("AEGIS will identify causal descendants, rebuild only the "
                        "confirmed records, and prevent withdrawn versions returning."),
            "risk": "controlled change",
            "scope": f"Incident {incident_id}",
            "steps": [
                "Find candidate descendants from lineage and scoped fingerprints",
                "Prove influence with local counterfactual replay",
                "Rebuild confirmed records or hold uncertain ones for a person",
                "Withdraw affected versions and verify that they cannot return",
            ],
        }
    if action == "fix_everything":
        family = normalise_param("family", params.get("family")) or "F1"
        provenance = normalise_param("provenance", params.get("provenance")) or "targeted"
        return {
            "title": "Run an end-to-end simulated recovery",
            "summary": ("AEGIS will create a synthetic incident and execute the full "
                        "containment loop without pausing between stages."),
            "risk": "broad change",
            "scope": f"{family} incident · {provenance} provenance · depth 4",
            "steps": [
                "Create the synthetic incident and freeze its pre-incident snapshot",
                "Discover and causally confirm the blast radius",
                "Rebuild or quarantine every confirmed descendant",
                "Verify safe resume and issue the recovery certificate",
            ],
        }
    if action == "reset_system":
        return {
            "title": "Reset the synthetic workspace",
            "summary": ("This clears every incident, recovery and review decision in "
                        "the current sandbox. The operation cannot be undone."),
            "risk": "destructive",
            "scope": (f"{live['incidents']} incident(s) · {live['patients']} patient(s) · "
                      f"{live['queue']} queued decision(s)"),
            "steps": [
                "Clear incidents, snapshots and recovery results",
                "Recreate the deterministic synthetic environment",
                "Return every role console to its clean initial state",
            ],
        }
    return None


def _patient_name_intent(env: Any, message: str, role: str) -> Optional[Dict[str, Any]]:
    """Resolve a patient locally without guessing between repeated names.

    Doing this here rather than in the model costs nothing, is exact, and means
    patient names never have to be sent to an external API to be understood.
    """
    if role not in ("clinician", "researcher"):
        return None
    tokens = {p["id"] for p in state.registry.patients()}
    tokens.update(a.patient_scope for a in env.all_artifacts() if a.patient_scope)
    lower = message.lower()
    matches = []
    for token in tokens:
        display = _patient_display(env, token)
        mrn = str(display["mrn"] or "").lower()
        if re.search(rf"\b{re.escape(token.lower())}\b", lower) or \
                (mrn and re.search(rf"\b{re.escape(mrn)}\b", lower)):
            return {"action": "show_patient", "params": {"patient": token},
                    "source": "local", "reply": ""}
        if re.search(rf"\b{re.escape(display['name'].lower())}\b", lower):
            matches.append(token)
    if len(matches) == 1:
        return {"action": "show_patient", "params": {"patient": matches[0]},
                "source": "local", "reply": ""}
    if len(matches) > 1:
        return {"action": "none", "params": {}, "source": "local",
                "reply": "More than one synthetic patient has that name. Please use an MRN or patient ID."}
    return None


@app.post("/api/assistant")
def assistant(req: AssistantRequest) -> Dict[str, Any]:
    """Route one natural-language message to an action and execute it."""
    router = state.assistant_for(req.session_id)
    routed = (_patient_name_intent(state.env, req.message, req.role)
              or router.route(req.message, req.role))
    action = routed.get("action", "none")
    params = routed.get("params", {})
    env = state.env

    # `ui` tells the console what to do; `reply` is what the user reads. Both
    # are built from real results below, never from the model.
    out: Dict[str, Any] = {
        "action": action,
        "params": params,
        "source": routed.get("source", "local"),
        "reply": routed.get("reply", ""),
        "ui": {},
        "budget": router.budget.to_dict(),
    }

    # Consequential actions are proposed before they are executed.  A direct
    # request creates a grounded plan; only an explicit yes from the same
    # browser session re-enters the endpoint with a confirmed source marker.
    plan = _confirmation_plan(action, params, _live_state())
    confirmed = "confirmed" in out["source"]
    if plan is not None and not confirmed:
        router.offer(action, params, plan["title"])
        out["requires_confirmation"] = True
        out["plan"] = plan
        out["reply"] = f"I have prepared a plan: {plan['title']}. Review its scope before I act."
        out["suggestions"] = [
            {"label": "Approve plan", "message": "yes"},
            {"label": "Cancel", "message": "no"},
        ]
        out["state"] = _live_state()
        return out

    try:
        if action == "report_incident":
            family = params.get("family", "F1")
            if family not in FAMILIES:
                family = "F1"
            provenance = params.get("provenance", "targeted")
            if provenance not in ProvenanceMask.CONDITIONS:
                provenance = "targeted"
            with state.lock:
                task = env.tasks[0]
                incident = state.builder.build(family, task, depth=4, n_controls=1)
                state.incidents[incident.incident_id] = incident
                state.snapshots[incident.incident_id] = env.snapshot()
                mask = ProvenanceMask(env, CONFIG.seed).apply(provenance)
                state.masks[incident.incident_id] = mask
                env.ledger.log_event(
                    incident.incident_id, "safety", "incident_reported",
                    incident.seed_key, {"family": family,
                                        "affected": len(incident.true_contaminated),
                                        "provenance": provenance})
            out["ui"] = {"role": "safety", "view": "command",
                         "incident_id": incident.incident_id, "refresh": True}
            out["reply"] = (
                f"Logged it as {FAMILY_INFO[family]['name'].lower()}. "
                f"{len(incident.true_contaminated)} record(s) inherited the error and "
                f"{mask.edges_removed} of {mask.edges_before} provenance links are "
                f"missing. Say 'run the recovery' when you are ready.")

        elif action == "run_recovery":
            incident_id = params.get("incident_id") or _live_state().get("open_incident_id")
            if not incident_id:
                out["reply"] = ("There is no open incident. Tell me what went wrong "
                                "first - for example 'we registered the wrong patient'.")
            else:
                result = recover(RecoveryRequest(incident_id=incident_id))
                metrics = result.get("metrics", {})
                cert = result.get("certificate", {})
                out["ui"] = {"role": "safety", "view": "command",
                             "incident_id": incident_id, "recovered": True,
                             "refresh": True, "recovery": result}
                out["reply"] = (
                    f"{'Contained.' if cert.get('safe_resume') else 'Review required.'} "
                    f"{len(result['repaired'])} record(s) rebuilt from source data, "
                    f"{len(result['quarantined'])} held for a person. Residual harm "
                    f"{metrics.get('rwh', 0):.3f}, untouched state kept "
                    f"{metrics.get('bsr', 0):.3f}.")

        elif action == "show_blast_radius":
            if not state.incidents:
                out["reply"] = "No incident is open yet, so nothing has spread."
            else:
                incident_id = next(reversed(state.incidents))
                incident = state.incidents[incident_id]
                out["ui"] = {"role": "safety", "view": "command",
                             "incident_id": incident_id, "focus": "blast"}
                out["reply"] = (
                    f"The error reached {len(incident.true_contaminated)} record(s) "
                    f"across {incident.depth} hop(s). The rings show how far.")

        elif action == "list_cases":
            cases = list_cases(req.role)
            out["cases"] = cases["cases"]
            if not cases["count"]:
                out["reply"] = "The case inbox is clear. No incidents have been reported."
            elif cases["attention"]:
                lead = next(row for row in cases["cases"] if row["attention"])
                out["reply"] = (
                    f"{cases['count']} case(s) in the inbox; {cases['attention']} need "
                    f"the {req.role} role. {lead['case_id']} is {lead['status'].replace('_', ' ')}. "
                    f"Next: {lead['next_action']}.")
            else:
                out["reply"] = (f"{cases['count']} case(s) are visible, but none are "
                                f"waiting on the {req.role} role.")

        elif action == "show_case":
            case_id = str(params.get("case_id") or "")
            if not case_id and state.incidents:
                case_id = next(reversed(state.incidents))
            if not case_id or case_id not in state.incidents:
                out["reply"] = "I could not find that case. Ask me to show the case inbox."
            else:
                case = get_case(case_id, req.role)
                out["case"] = case
                if case["status"] == "open":
                    out["ui"] = {"role": "safety", "view": "command",
                                 "incident_id": case_id}
                elif case["status"] == "review_required":
                    out["ui"] = {"role": "compliance", "view": "assurance",
                                 "panel": "queue"}
                else:
                    out["ui"] = {"role": "clinician", "view": "records"}
                out["reply"] = (
                    f"{case['case_id']}: {case['title']} is "
                    f"{case['status'].replace('_', ' ')}. Owner: {case['owner']}. "
                    f"{case['affected_records']} affected, {case['repaired_records']} rebuilt, "
                    f"{case['held_records']} held. Next: {case['next_action']}.")

        elif action == "list_patients":
            data = list_patients(only_with_memory=False)
            wanted = params.get("filter", "all")
            rows = data["patients"]
            if wanted != "all":
                rows = [r for r in rows if r["status"] == wanted]
            out["ui"] = {"role": "clinician", "view": "records",
                         "filter": wanted, "refresh": True}
            if not data["count"]:
                out["reply"] = "No synthetic patients are loaded in this workspace."
            elif not rows:
                out["reply"] = f"No patients are in the '{wanted}' state right now."
            else:
                names = ", ".join(r["patient"]["name"] for r in rows[:4])
                out["reply"] = (f"{len(rows)} synthetic patient(s): {names}"
                                f"{' and others' if len(rows) > 4 else ''}. "
                                "Search by name or MRN to choose one safely.")

        elif action == "show_patient":
            token = _resolve_patient_token(env, str(params.get("patient", "")))
            if not token:
                out["reply"] = ("I could not find that patient. Ask me to list "
                                "patients and pick one by name.")
            else:
                record = patient_record(token)
                summary = record["summary"]
                # Resolve the detail and the clinician roll-up from the same
                # workspace before claiming that the patient can be opened.
                # If state changed between routing and execution, fail closed
                # instead of silently selecting a different patient's card.
                current = list_patients(only_with_memory=False)["patients"]
                listed = next((row for row in current if row["token"] == token), None)
                if listed is None or listed["records"] != summary["total"]:
                    out["reply"] = (
                        "The patient workspace changed while I was opening that record. "
                        "I have not shown a different patient; please ask me to list "
                        "patients again.")
                    out["ui"] = {"role": "clinician", "view": "records",
                                 "refresh": True}
                else:
                    out["ui"] = {"role": "clinician", "view": "records",
                                 "patient": token, "refresh": True}
                    out["patient_record"] = record
                    total = summary["total"]
                    source = record["source_summary"]
                    if source["source_held"] or source["held_transfers"] or source["open_reports"]:
                        verdict = (
                            f"{source['source_records']} source record(s), "
                            f"{source['source_held']} held by identity or status checks, "
                            f"{source['held_transfers']} blocked handover(s), and "
                            f"{source['open_reports']} manual concern(s). "
                            "Do not rely on held items; open the patient page to review why.")
                    elif summary["held"]:
                        verdict = (
                            f"{total} total record(s) in assistant memory; {summary['held']} are held for "
                            "review. Do not rely on the held records yet.")
                    elif summary["corrected"]:
                        verdict = (
                            f"{total} total record(s); {summary['corrected']} were "
                            "corrected and are safe to use.")
                    elif summary["withdrawn"] and not summary["in_use"]:
                        verdict = (
                            f"{total} total record(s); {summary['withdrawn']} were "
                            "filed here in error and have been removed.")
                    else:
                        verdict = (f"{source['source_records']} source record(s) and "
                                   f"{total} assistant memory entries; no identity or "
                                   "status mismatch detected. Clinical correctness is not assessed.")
                    out["reply"] = f"{record['patient']['name']}: {verdict}"

        elif action == "show_boundary":
            out["ui"] = {"role": "compliance", "view": "assurance", "panel": "boundary"}
            out["reply"] = ("Opening the data boundary. Clinical content stays inside "
                            "each runtime; only 14 metadata fields cross to the "
                            "coordinator, and none of them can carry a name, note or "
                            "measured value.")

        elif action == "show_queue":
            queue = review_queue()
            out["ui"] = {"role": "compliance", "view": "assurance", "panel": "queue"}
            out["reply"] = (f"{queue['total_count']} item(s) need review: "
                            f"{queue['registry_count']} source-record or manual concerns "
                            f"and {queue['count']} assistant-memory items."
                            if queue["total_count"]
                            else "Nothing is waiting on you - the queue is empty.")

        elif action == "run_leakage_tests":
            if not state.recoveries:
                out["reply"] = ("Run a recovery first - the leakage tests attack the "
                                "capsules a recovery produces.")
            else:
                incident_id = next(reversed(state.recoveries))
                out["ui"] = {"role": "compliance", "view": "assurance",
                             "panel": "leakage", "incident_id": incident_id,
                             "run": True}
                out["reply"] = "Running the attacks against our own recovery interface."

        elif action == "reset_system":
            with state.lock:
                state.reset()
            out["ui"] = {"refresh": True, "reset": True}
            out["reply"] = "Cleared. The sandbox is back to a clean state."

        elif action == "switch_role":
            out["reply"] = (
                f"This session is locked to the {req.role} workspace. I cannot "
                "change roles from chat. Use the workspace menu to end this session, "
                "then choose a different role at login.")

        elif action == "navigate":
            view = params.get("view")
            if view:
                out["ui"] = {"view": view}
                out["reply"] = f"Opening {view}."
            else:
                out["reply"] = "Which screen would you like?"

        elif action == "system_status":
            live = _live_state()
            if not live["incidents"]:
                out["reply"] = (
                    "Nothing is open. No error has been reported in this sandbox, so "
                    "there are no affected records and nothing waiting on a person.")
            else:
                bits = []
                if live["open_incidents"]:
                    bits.append(f"{live['open_incidents']} incident(s) still open")
                if live["recovered"]:
                    bits.append(f"{live['recovered']} contained")
                if live["patients_attention"]:
                    bits.append(f"{live['patients_attention']} patient(s) need attention")
                if live["queue"]:
                    bits.append(f"{live['queue']} record(s) waiting on a decision")
                if live["patients_corrected"]:
                    bits.append(f"{live['patients_corrected']} patient(s) corrected")
                out["reply"] = (
                    f"{live['incidents']} incident(s) so far: " + ", ".join(bits) + "."
                    if bits else f"{live['incidents']} incident(s) recorded, all clear.")
                if live["open_incident_id"]:
                    out["ui"] = {"role": "safety", "view": "command",
                                 "incident_id": live["open_incident_id"]}

        elif action == "fix_everything":
            # The agentic path: report, contain, and report back in one turn.
            family = normalise_param("family", params.get("family")) or "F1"
            provenance = normalise_param("provenance", params.get("provenance")) or "targeted"
            with state.lock:
                incident = state.builder.build(family, env.tasks[0], depth=4, n_controls=1)
                state.incidents[incident.incident_id] = incident
                state.snapshots[incident.incident_id] = env.snapshot()
                mask = ProvenanceMask(env, CONFIG.seed).apply(provenance)
                state.masks[incident.incident_id] = mask
                env.ledger.log_event(
                    incident.incident_id, "safety", "incident_reported",
                    incident.seed_key, {"family": family,
                                        "affected": len(incident.true_contaminated),
                                        "provenance": provenance})
            result = recover(RecoveryRequest(incident_id=incident.incident_id))
            metrics = result.get("metrics", {})
            cert = result.get("certificate", {})
            out["ui"] = {"role": "safety", "view": "command",
                         "incident_id": incident.incident_id, "recovered": True,
                         "refresh": True, "recovery": result}
            out["steps"] = [
                f"Logged a {FAMILY_INFO[family]['name'].lower()} incident",
                f"{len(incident.true_contaminated)} record(s) had inherited the error, "
                f"with {mask.edges_removed} of {mask.edges_before} provenance links missing",
                f"Confirmed {len(result['confirmed'])} by replay and cleared "
                f"{len(result['cleared'])}",
                f"Rebuilt {len(result['repaired'])} from source records, held "
                f"{len(result['quarantined'])} for a person",
                f"Withdrew {result['enforcement']['tombstones']} version(s) and blocked "
                f"{result['resurrection_probe']['blocked']}/"
                f"{result['resurrection_probe']['attempts']} return attempts",
            ]
            out["reply"] = (
                f"Done end to end. {'Safe to resume.' if cert.get('safe_resume') else 'Review required.'} "
                f"Residual harm {metrics.get('rwh', 0):.3f}, untouched state kept "
                f"{metrics.get('bsr', 0):.3f}. Switch to the clinician view to see it "
                "from a nurse's side.")

        elif action == "explain":
            if not out["reply"]:
                out["reply"] = _explain_state(
                    str(params.get("topic", "")), req.role, _live_state())

    except HTTPException as exc:
        out["reply"] = f"That did not work: {exc.detail}"
    except Exception as exc:                      # never 500 on a chat message
        out["reply"] = f"That did not work: {exc}"

    # Always offer the next steps that make sense from here. This is what makes
    # the assistant lead rather than wait, and it keeps the console reachable
    # for anyone who does not know what to type.
    live_after = _live_state()
    # UI instructions may identify which role owns a case, but a chat response
    # can never change the signed-in role. Keep the client session canonical.
    if out.get("ui", {}).get("role"):
        out["ui"]["role"] = req.role
    out["suggestions"] = _suggest(req.role, live_after)
    out["state"] = live_after
    if out["suggestions"]:
        # A standing offer, so a bare "yes" executes the obvious next step.
        router.offer_message(out["suggestions"][0]["message"],
                             out["suggestions"][0]["label"])
    if out.get("action") == "explain":
        router.note_topic(str(params.get("topic") or ""))
    out["budget"] = router.budget.to_dict()
    return out


# ======================================================================
# Dashboard
# ======================================================================
if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
def dashboard() -> str:
    index = WEB_DIR / "index.html"
    if not index.exists():
        return "<h1>AEGIS-Care</h1><p>Dashboard assets not found.</p>"
    return index.read_text(encoding="utf-8")


__all__ = ["app", "state"]
