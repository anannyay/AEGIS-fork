"""Persistent synthetic patient registry for the operator demonstration.

This is deliberately separate from the frozen 100-patient research benchmark.
It contains no real patient data and never executes a clinical order. A transfer
is a proposed chart handover; an unsafe proposal is recorded as held, never
copied into another patient's chart.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import DATA_DIR
from .fhir.generator import generate_bundle

PATIENT_COUNT = 160
DESTINATIONS = ("Emergency", "Ward A", "Ward B", "ICU", "Outpatient")
RESOURCE_TYPES = ("Observation", "Condition", "Encounter", "MedicationRequest")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _label(resource: Dict[str, Any]) -> str:
    kind = resource["resourceType"]
    if kind in ("Observation", "Condition"):
        return resource.get("code", {}).get("text") or kind
    if kind == "MedicationRequest":
        return resource.get("medicationCodeableConcept", {}).get("text") or kind
    return resource.get("class", {}).get("code") or kind


class ClinicalRegistry:
    """Fixed synthetic FHIR fixture plus durable transfer/report history."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path or os.environ.get("AEGIS_CLINICAL_DB") or
                         DATA_DIR / "clinical_demo.sqlite3")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS patients (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, mrn TEXT NOT NULL,
                    birth_date TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS source_records (
                    record_key TEXT PRIMARY KEY, chart_patient_id TEXT NOT NULL,
                    source_patient_id TEXT NOT NULL, resource_type TEXT NOT NULL,
                    label TEXT NOT NULL, resource_json TEXT NOT NULL,
                    FOREIGN KEY(chart_patient_id) REFERENCES patients(id)
                );
                CREATE INDEX IF NOT EXISTS source_records_chart
                    ON source_records(chart_patient_id);
                CREATE TABLE IF NOT EXISTS transfers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_key TEXT NOT NULL, source_patient_id TEXT NOT NULL,
                    target_patient_id TEXT NOT NULL, destination TEXT NOT NULL,
                    status TEXT NOT NULL, issue_code TEXT, explanation TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS transfers_target
                    ON transfers(target_patient_id);
                CREATE TABLE IF NOT EXISTS manual_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    patient_id TEXT NOT NULL, record_key TEXT,
                    description TEXT NOT NULL, status TEXT NOT NULL,
                    created_at TEXT NOT NULL, resolution_note TEXT
                );
                CREATE INDEX IF NOT EXISTS reports_patient
                    ON manual_reports(patient_id);
            """)
            report_columns = {row[1] for row in db.execute("PRAGMA table_info(manual_reports)")}
            if "resolution_note" not in report_columns:
                db.execute("ALTER TABLE manual_reports ADD COLUMN resolution_note TEXT")
            if db.execute("SELECT COUNT(*) FROM patients").fetchone()[0]:
                return
            fixture = generate_bundle(PATIENT_COUNT)
            for patient in fixture["Patient"]:
                name = patient["name"][0]
                display = " ".join(name.get("given", []) + [name.get("family", "")]).strip()
                db.execute("INSERT INTO patients VALUES (?, ?, ?, ?)",
                           (patient["id"], display,
                            patient["identifier"][0]["value"], patient["birthDate"]))
            # Six deliberately misfiled synthetic source records give the
            # automatic identity scan something real and repeatable to find.
            misfiled = {f"S{1000 + i}-OBS1" for i in (7, 29, 53, 81, 117, 143)}
            for kind in RESOURCE_TYPES:
                for resource in fixture[kind]:
                    source = resource["subject"]["reference"].split("/", 1)[1]
                    chart = f"S{1000 + ((int(source[1:]) - 1000 + 1) % PATIENT_COUNT)}" \
                        if resource["id"] in misfiled else source
                    db.execute(
                        "INSERT INTO source_records VALUES (?, ?, ?, ?, ?, ?)",
                        (f"{kind}/{resource['id']}", chart, source, kind,
                         _label(resource), json.dumps(resource, sort_keys=True)),
                    )

    def patients(self) -> List[Dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM patients ORDER BY name, id").fetchall()
            return [dict(row) for row in rows]

    def patient(self, patient_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as db:
            row = db.execute("SELECT * FROM patients WHERE id = ?", (patient_id,)).fetchone()
            return dict(row) if row else None

    def records(self, patient_id: str) -> List[Dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM source_records WHERE chart_patient_id = ? "
                "ORDER BY resource_type, label, record_key", (patient_id,)).fetchall()
            reports = {row[0] for row in db.execute(
                "SELECT record_key FROM manual_reports WHERE patient_id = ? "
                "AND status = 'open' AND record_key IS NOT NULL", (patient_id,))}
        out = []
        for row in rows:
            resource = json.loads(row["resource_json"])
            issues = self._issues(row, patient_id, resource)
            if row["record_key"] in reports:
                issues.append("A person reported a possible problem; review is needed.")
            out.append({
                "record_key": row["record_key"], "resource_type": row["resource_type"],
                "label": "Restricted clinical record" if resource.get("_aegisRestricted")
                         else row["label"], "chart_patient_id": patient_id,
                "source_patient_id": row["source_patient_id"],
                "status": "held" if issues else "available",
                "issues": issues,
                "observed_at": resource.get("effectiveDateTime") or
                               resource.get("recordedDate") or resource.get("authoredOn") or
                               resource.get("period", {}).get("start"),
                "value": None if resource.get("_aegisRestricted") else
                         resource.get("valueQuantity", {}).get("value"),
                "unit": None if resource.get("_aegisRestricted") else
                        resource.get("valueQuantity", {}).get("unit"),
                "restricted": bool(resource.get("_aegisRestricted")),
            })
        return out

    @staticmethod
    def _issues(row: Any, chart_patient_id: str,
                resource: Dict[str, Any]) -> List[str]:
        issues = []
        if row["source_patient_id"] != chart_patient_id or \
                resource.get("subject", {}).get("reference") != f"Patient/{chart_patient_id}":
            issues.append("Patient identity mismatch: source and chart do not match.")
        if resource.get("status") in ("entered-in-error", "cancelled"):
            issues.append("Source record is no longer valid.")
        return issues

    def transfers(self, patient_id: str) -> List[Dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM transfers WHERE source_patient_id = ? OR target_patient_id = ? "
                "ORDER BY id DESC LIMIT 30", (patient_id, patient_id)).fetchall()
            return [dict(row) for row in rows]

    def reports(self, patient_id: str) -> List[Dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM manual_reports WHERE patient_id = ? "
                              "ORDER BY id DESC", (patient_id,)).fetchall()
            return [dict(row) for row in rows]

    def transfer(self, record_key: str, target_patient_id: str,
                 destination: str) -> Dict[str, Any]:
        if destination not in DESTINATIONS:
            raise ValueError("Choose a listed destination.")
        with self._connect() as db:
            row = db.execute("SELECT * FROM source_records WHERE record_key = ?",
                             (record_key,)).fetchone()
            target = db.execute("SELECT id FROM patients WHERE id = ?",
                                (target_patient_id,)).fetchone()
            if row is None or target is None:
                raise KeyError("Record or target patient not found.")
            resource = json.loads(row["resource_json"])
            issues = self._issues(row, row["chart_patient_id"], resource)
            if target_patient_id != row["source_patient_id"]:
                issues.append("Target patient differs from the source patient.")
            if resource.get("_aegisRestricted"):
                issues.append("Restricted record needs authorised review before transfer.")
            if db.execute("SELECT 1 FROM manual_reports WHERE record_key = ? "
                          "AND status = 'open' LIMIT 1", (record_key,)).fetchone():
                issues.append("This record has an open manual safety report.")
            status = "held" if issues else "completed"
            explanation = " ".join(issues) if issues else \
                "Identity and source checks passed; handover was recorded."
            cursor = db.execute(
                "INSERT INTO transfers (record_key, source_patient_id, "
                "target_patient_id, destination, status, issue_code, explanation, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (record_key, row["chart_patient_id"], target_patient_id,
                 destination, status, "identity_or_policy" if issues else None,
                 explanation, _now()),
            )
            return {"id": cursor.lastrowid, "record_key": record_key,
                    "source_patient_id": row["chart_patient_id"],
                    "target_patient_id": target_patient_id,
                    "destination": destination, "status": status,
                    "explanation": explanation, "issues": issues}

    def report(self, patient_id: str, record_key: Optional[str],
               description: str) -> Dict[str, Any]:
        if not self.patient(patient_id):
            raise KeyError("Patient not found.")
        if record_key:
            with self._connect() as db:
                row = db.execute("SELECT chart_patient_id FROM source_records "
                                 "WHERE record_key = ?", (record_key,)).fetchone()
                if not row or row[0] != patient_id:
                    raise ValueError("Choose a record in this patient's chart.")
        description = description.strip()
        if len(description) < 10:
            raise ValueError("Describe the concern in at least 10 characters.")
        with self._connect() as db:
            cursor = db.execute(
                "INSERT INTO manual_reports (patient_id, record_key, description, status, created_at) "
                "VALUES (?, ?, ?, 'open', ?)",
                (patient_id, record_key, description[:1000], _now()),
            )
            return {"id": cursor.lastrowid, "patient_id": patient_id,
                    "record_key": record_key, "status": "open",
                    "description": description[:1000]}

    def review_items(self) -> List[Dict[str, Any]]:
        """Open manual concerns and automatically detected chart mismatches."""
        with self._connect() as db:
            reports = [dict(row) for row in db.execute(
                "SELECT * FROM manual_reports WHERE status = 'open' ORDER BY id DESC")]
            mismatches = [dict(row) for row in db.execute(
                "SELECT record_key, chart_patient_id, source_patient_id, label "
                "FROM source_records WHERE chart_patient_id != source_patient_id "
                "ORDER BY chart_patient_id, record_key")]
        return ([{"kind": "manual", "report_id": row["id"],
                  "patient_id": row["patient_id"], "record_key": row["record_key"],
                  "description": row["description"], "created_at": row["created_at"]}
                 for row in reports] +
                [{"kind": "automatic", "report_id": None,
                  "patient_id": row["chart_patient_id"],
                  "record_key": row["record_key"],
                  "description": (f"{row['label']} is filed under "
                                  f"{row['chart_patient_id']} but its source identifies "
                                  f"{row['source_patient_id']}. Correct the source chart "
                                  "association before use."),
                  "created_at": None}
                 for row in mismatches])

    def dismiss_report(self, report_id: int, note: str) -> Dict[str, Any]:
        note = note.strip()
        if len(note) < 10:
            raise ValueError("Give a review reason of at least 10 characters.")
        with self._connect() as db:
            row = db.execute("SELECT * FROM manual_reports WHERE id = ? AND status = 'open'",
                             (report_id,)).fetchone()
            if row is None:
                raise KeyError("Open manual report not found.")
            db.execute("UPDATE manual_reports SET status = 'dismissed', "
                       "resolution_note = ? WHERE id = ?", (note[:1000], report_id))
            return {"id": report_id, "patient_id": row["patient_id"],
                    "status": "dismissed", "resolution_note": note[:1000]}

    def summary(self, patient_id: str) -> Dict[str, int]:
        rows = self.records(patient_id)
        with self._connect() as db:
            transfer_counts = dict(db.execute(
                "SELECT status, COUNT(*) FROM transfers WHERE source_patient_id = ? "
                "OR target_patient_id = ? GROUP BY status", (patient_id, patient_id)))
            open_reports = db.execute(
                "SELECT COUNT(*) FROM manual_reports WHERE patient_id = ? "
                "AND status = 'open'", (patient_id,)).fetchone()[0]
        return {
            "source_records": len(rows),
            "source_held": sum(row["status"] == "held" for row in rows),
            "completed_transfers": transfer_counts.get("completed", 0),
            "held_transfers": transfer_counts.get("held", 0),
            "open_reports": open_reports,
        }

    def reset_activity(self) -> None:
        """Reset demo actions without changing the fixed synthetic fixture."""
        with self._connect() as db:
            db.execute("DELETE FROM transfers")
            db.execute("DELETE FROM manual_reports")


__all__ = ["ClinicalRegistry", "PATIENT_COUNT", "DESTINATIONS"]
