"""API surface: FHIR endpoints, incidents, recovery, baselines, review, audit."""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from aegis_care.api.app import app, state
from aegis_care.clinical_registry import ClinicalRegistry
from aegis_care.fhir.generator import generate_bundle


@pytest.fixture
def client():
    client = TestClient(app)
    client.post("/api/system/reset")
    return client


@pytest.fixture
def incident(client):
    response = client.post("/api/incidents", json={
        "family": "F1", "depth": 4, "provenance": "targeted", "n_controls": 1})
    assert response.status_code == 200, response.text
    return response.json()


class TestSystem:
    def test_health(self, client):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"

    def test_system_description(self, client):
        body = client.get("/api/system").json()
        assert body["stats"]["fhir"]["Patient"] == 100
        assert len(body["tasks"]) == 24
        assert set(body["families"]) == {"F1", "F2", "F3", "F4"}
        assert len(body["conditions"]) == 9

    def test_coordinator_has_no_field_rights(self, client):
        body = client.get("/api/system").json()
        assert body["roles"]["coordinator"]["fields"] == []

    def test_dashboard_serves(self, client):
        response = client.get("/")
        assert response.status_code == 200
        assert "AEGIS" in response.text

    def test_static_assets_serve(self, client):
        assert client.get("/static/app.js").status_code == 200
        assert client.get("/static/styles.css").status_code == 200

    def test_live_state_endpoints_cannot_be_browser_cached(self, client):
        for path in ("/api/patients", "/api/cases", "/fhir/Patient/S1000"):
            response = client.get(path)
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store, max-age=0"

    def test_clinician_total_is_not_labelled_as_held(self, client):
        script = client.get("/static/app.js").text
        assert 's.total, "total records"' in script
        assert 's.total, "records held"' not in script
        assert 'Complete memory history' in script

    def test_nurse_workspace_exposes_plain_language_and_accessibility_controls(self, client):
        page = client.get("/").text
        script = client.get("/static/app.js").text

        assert "Know what needs attention." in page
        assert "Find a patient" in page
        assert "Report a concern" in script
        assert 'id="accessibility-dialog"' in page
        assert 'id="pref-large-text"' in page
        assert 'id="pref-high-contrast"' in page
        assert 'id="pref-reduce-motion"' in page
        assert "Demo access — not production authentication" in page
        assert "Nurses cannot approve quarantined records" in script
        assert 'if ($("role-gate").hidden) toggleChat(true);' not in script

    def test_role_workspace_is_session_locked(self, client):
        page = client.get("/").text
        script = client.get("/static/app.js").text

        assert "Four protected workspaces" in page
        assert "Role-locked session" in page
        assert 'id="session-dialog"' in page
        assert 'id="confirm-end-session"' in page
        assert 'sessionStorage.setItem(ROLE_KEY, id)' in script
        assert 'localStorage.setItem(ROLE_KEY, id)' not in script
        assert "This session is locked to" in script
        assert "selectRole(ui.role)" not in script


class TestFHIREndpoints:
    def test_read_patient(self, client):
        body = client.get("/fhir/Patient/S1000").json()
        assert body["resourceType"] == "Patient"

    def test_missing_resource_404s(self, client):
        assert client.get("/fhir/Patient/NOPE").status_code == 404

    def test_search_returns_bundle(self, client):
        body = client.get("/fhir/Observation", params={"patient": "S1000"}).json()
        assert body["resourceType"] == "Bundle"
        assert body["total"] > 0

    def test_search_by_identifier(self, client):
        mrn = client.get("/fhir/Patient/S1005").json()["identifier"][0]["value"]
        body = client.get("/fhir/Patient", params={"identifier": mrn}).json()
        assert body["total"] == 1


class TestIncidents:
    def test_create(self, incident):
        assert incident["family"] == "F1"
        assert incident["true_contaminated"]
        assert incident["provenance"]["edges_removed"] > 0

    def test_detail_includes_trajectory_and_controls(self, client, incident):
        body = client.get(f"/api/incidents/{incident['incident_id']}").json()
        assert len(body["trajectory"]) == 5
        assert body["controls"]
        assert any(n["contaminated"] for n in body["trajectory"])

    def test_unknown_family_rejected(self, client):
        response = client.post("/api/incidents", json={"family": "F9"})
        assert response.status_code == 400
        assert "unknown family" in response.json()["detail"]

    def test_depth_shallower_than_seed_rejected(self, client):
        response = client.post("/api/incidents",
                               json={"family": "F2", "depth": 1, "provenance": "complete"})
        assert response.status_code == 400
        assert "depth" in response.json()["detail"]

    def test_list(self, client, incident):
        body = client.get("/api/incidents").json()
        assert any(i["incident_id"] == incident["incident_id"] for i in body["incidents"])


class TestRecovery:
    def test_full_care(self, client, incident):
        body = client.post("/api/recover",
                           json={"incident_id": incident["incident_id"]}).json()
        assert body["closure_reached"]
        assert body["repaired"]
        assert body["metrics"]["descendant_recall"] == 1.0
        assert body["metrics"]["bsr"] == 1.0
        assert body["metrics"]["rwh"] == 0.0
        assert "AEGIS-CARE RECOVERY CERTIFICATE" in body["certificate_text"]

    def test_capsules_expose_no_content(self, client, incident):
        body = client.post("/api/recover",
                           json={"incident_id": incident["incident_id"]}).json()
        for capsule in body["capsules"]:
            assert "content" not in capsule
            assert "sketch" not in capsule    # only the dimension is reported
            assert "support_tokens" not in capsule  # only a bounded count is public
            assert 0 <= capsule["support_token_count"] <= 16

    def test_verdicts_carry_bands_not_text(self, client, incident):
        body = client.post("/api/recover",
                           json={"incident_id": incident["incident_id"]}).json()
        assert body["verdicts"]
        for verdict in body["verdicts"]:
            assert verdict["influence_band"] in ("none", "low", "medium", "high")
            assert "content" not in verdict

    def test_ablation_changes_outcome(self, client, incident):
        """Disabling latent discovery under a targeted mask must hurt recall."""
        full = client.post("/api/recover",
                           json={"incident_id": incident["incident_id"]}).json()
        client.post("/api/system/reset")
        again = client.post("/api/incidents", json={
            "family": "F1", "depth": 4, "provenance": "targeted", "n_controls": 1}).json()
        ablated = client.post("/api/recover", json={
            "incident_id": again["incident_id"], "use_sketch": False}).json()
        assert len(ablated["confirmed"]) < len(full["confirmed"])

    def test_certificate_endpoint(self, client, incident):
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        text = client.get(
            f"/api/recover/{incident['incident_id']}/certificate").text
        assert "SAFE RESUME" in text

    def test_unknown_incident_404s(self, client):
        assert client.post("/api/recover",
                           json={"incident_id": "nope"}).status_code == 404


class TestBaselinesEndpoint:
    def test_all_conditions(self, client, incident):
        body = client.post("/api/baselines",
                           json={"incident_id": incident["incident_id"]}).json()
        results = {r["condition"]: r for r in body["results"] if "condition" in r}
        assert len(results) == 9
        assert results["I"]["rwh"] <= results["A"]["rwh"]
        assert results["I"]["bsr"] > results["C"]["bsr"]

    def test_baselines_do_not_rewind_the_live_clinician_workspace(self, client, incident):
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        before = client.get("/api/patients").json()
        assert before["count"] > 0

        response = client.post("/api/baselines", json={
            "incident_id": incident["incident_id"],
            "conditions": ["A", "C", "I"],
        })
        assert response.status_code == 200, response.text

        after = client.get("/api/patients").json()
        assert after == before, (
            "counterfactual baselines must not replace live post-recovery patient state")


class TestMemoryEndpoints:
    def test_public_view_excludes_content(self, client, incident):
        body = client.get("/api/memory", params={"include_content": False}).json()
        assert body["count"] > 0
        assert all("content" not in m for m in body["memories"])

    def test_local_view_includes_content(self, client, incident):
        body = client.get("/api/memory").json()
        assert any(m.get("content") for m in body["memories"])

    def test_graph_marks_masked_edges(self, client, incident):
        body = client.get("/api/memory/any/graph").json()
        assert body["nodes"]
        assert any(not e["observed"] for e in body["edges"]), (
            "targeted masking should leave ground-truth-only edges in the graph")


class TestReviewAndAudit:
    def test_review_queue_reachable(self, client, incident):
        assert "count" in client.get("/api/review/queue").json()

    def test_review_decision_applies(self, client, incident):
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        queue = client.get("/api/review/queue").json()
        if not queue["count"]:
            pytest.skip("no artifact required escalation in this incident")
        key = f"{queue['items'][0]['memory_id']}@v{queue['items'][0]['version']}"
        body = client.post("/api/review",
                           json={"memory_key": key, "decision": "reject"}).json()
        assert body["state"] == "tombstoned"

    def test_events_recorded(self, client, incident):
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        kinds = {e["kind"] for e in client.get("/api/events").json()["events"]}
        assert "recovery_started" in kinds

    def test_privacy_audit_endpoint(self, client, incident):
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        body = client.get(f"/api/privacy/{incident['incident_id']}").json()
        assert body["released_fields"]["raw_content_exported"] is False
        assert "membership" in body


class TestExperimentEndpoint:
    def test_run_small_experiment(self, client):
        body = client.post("/api/experiment", json={
            "families": ["F1"], "depths": [4],
            "provenance_conditions": ["complete"], "tasks_per_family": 1}).json()
        assert body["status"] == "complete"
        assert body["by_condition"]

    def test_report_available_after_run(self, client):
        client.post("/api/experiment", json={
            "families": ["F1"], "depths": [4],
            "provenance_conditions": ["complete"], "tasks_per_family": 1})
        text = client.get("/api/experiment/report").text
        assert "AEGIS-Care experimental report" in text


class TestEvidenceDirectoryIsolation:
    """A plain `pytest -q` must never overwrite the committed evidence package.

    POST /api/experiment writes tables, figures, and the report to
    config.RESULTS_DIR. conftest redirects that to a temporary directory before
    aegis_care is imported; this asserts the redirect is actually in force.
    """

    def test_results_dir_is_redirected_away_from_the_repo(self):
        from aegis_care.config import PROJECT_ROOT, RESULTS_DIR

        assert RESULTS_DIR != PROJECT_ROOT / "results"
        assert PROJECT_ROOT not in RESULTS_DIR.parents

    def test_experiment_writes_only_to_the_redirected_dir(self, client, results_tmp_dir):
        from pathlib import Path

        committed = Path(__file__).resolve().parent.parent / "results" / "results.json"
        before = committed.read_bytes() if committed.exists() else None

        body = client.post("/api/experiment", json={
            "families": ["F1"], "depths": [4],
            "provenance_conditions": ["complete"], "tasks_per_family": 1}).json()
        assert body["status"] == "complete"

        assert (Path(results_tmp_dir) / "results.json").exists()
        if before is not None:
            assert committed.read_bytes() == before, \
                "the test suite overwrote the committed evidence package"


class TestExperimentStatus:
    def test_status_is_idle_and_determinate_before_any_run(self, client):
        body = client.get("/api/experiment/status").json()
        assert body["status"] in {"idle", "complete", "failed"}
        assert body["total_cells"] >= 0
        assert 0.0 <= body["fraction"] <= 1.0

    def test_status_reports_progress_fields_after_a_run(self, client):
        client.post("/api/experiment", json={
            "families": ["F1"], "depths": [4],
            "provenance_conditions": ["complete"], "tasks_per_family": 1})
        body = client.get("/api/experiment/status").json()
        assert body["status"] == "complete"
        assert body["has_results"] is True
        assert body["error"] is None
        assert body["elapsed_seconds"] >= 0
        assert any("planned" in line for line in body["log"])


class TestPatientView:
    """The record-shaped surface the clinician role is built on."""

    def test_lists_patients_with_a_plain_language_status(self, client, incident):
        body = client.get("/api/patients").json()
        assert body["count"] > 0
        for row in body["patients"]:
            assert row["status"] in {"attention", "checking", "corrected",
                                     "withdrawn", "clear"}
            assert row["headline"]
            assert row["patient"]["name"]
            assert row["records"] >= 1

    def test_record_detail_reports_a_summary(self, client, incident):
        token = client.get("/api/patients").json()["patients"][0]["token"]
        body = client.get(f"/api/patients/{token}/record").json()
        assert body["patient"]["id"] == token
        assert body["records"]
        assert set(body["summary"]) == {"total", "in_use", "corrected", "held", "withdrawn"}

    def test_unknown_patient_is_404(self, client):
        assert client.get("/api/patients/NOPE/record").status_code == 404

    def test_repair_produces_a_before_and_after(self, client, incident):
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        patients = client.get("/api/patients").json()["patients"]
        corrected = [p for p in patients if p["repaired"]]
        assert corrected, "recovery should leave at least one corrected patient"

        body = client.get(f"/api/patients/{corrected[0]['token']}/record").json()
        assert body["changes"], "a corrected patient must expose what changed"
        change = body["changes"][0]
        assert change["before"] != change["after"]
        assert change["to_version"] > change["from_version"]

    def test_wrong_patient_repair_is_reported_as_refiled(self, client, incident):
        """A wrong-patient incident files records under the WRONG patient, so the
        repaired version sits under a different scope than the one it replaced.
        The clinician has to be told that, not just shown new text."""
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        patients = client.get("/api/patients").json()["patients"]
        corrected = [p for p in patients if p["repaired"]]
        body = client.get(f"/api/patients/{corrected[0]['token']}/record").json()
        refiled = [c for c in body["changes"] if c["refiled"]]
        assert refiled, "an F1 repair must be reported as re-filed"
        assert refiled[0]["previously_filed_under"] != body["patient"]["id"]

    def test_withdrawn_only_patient_is_not_reported_as_clear(self, client, incident):
        """The patient the records were WRONGLY filed under keeps only withdrawn
        versions. Calling that 'No issues found' would hide from a clinician that
        entries were filed against their patient in error."""
        client.post("/api/recover", json={"incident_id": incident["incident_id"]})
        patients = client.get("/api/patients").json()["patients"]
        withdrawn_only = [p for p in patients
                          if p["withdrawn"] and not p["active"] and not p["repaired"]]
        if not withdrawn_only:
            pytest.skip("this incident left no withdrawn-only patient")
        assert withdrawn_only[0]["status"] == "withdrawn"
        assert "removed" in withdrawn_only[0]["headline"].lower()


class TestClinicalRegistry:
    def test_patient_names_are_distinct_and_existing_activity_survives_upgrade(self, tmp_path):
        path = tmp_path / "clinical.sqlite3"
        registry = ClinicalRegistry(path)
        patients = registry.patients()
        assert len(patients) == 160
        assert len({row["name"] for row in patients}) == 160
        assert registry.patient("S1054")["name"] == "Rania Chowdhury"
        assert registry.patient("S1030")["name"] != registry.patient("S1082")["name"]

        # Recreate the old duplicate-name database, including one local edit.
        original = generate_bundle(160)["Patient"]
        with sqlite3.connect(path) as db:
            for patient in original:
                name = patient["name"][0]
                display = " ".join(name["given"] + [name["family"]])
                db.execute("UPDATE patients SET name = ? WHERE id = ?",
                           (display, patient["id"]))
            db.execute("UPDATE patients SET name = ? WHERE id = ?",
                       ("Custom Patient", "S1000"))
        record = next(row for row in registry.records("S1001")
                      if row["status"] == "available" and not row["restricted"])
        assert registry.transfer(record["record_key"], "S1001", "Ward A")["status"] == "completed"
        original_mrns = {row["id"]: row["mrn"] for row in patients}

        upgraded = ClinicalRegistry(path)
        upgraded_patients = upgraded.patients()
        assert len({row["name"] for row in upgraded_patients}) == 160
        assert upgraded.patient("S1000")["name"] == "Custom Patient"
        assert {row["id"]: row["mrn"] for row in upgraded_patients} == original_mrns
        assert upgraded.summary("S1001")["completed_transfers"] == 1

    def test_fixed_patients_and_automatic_scan(self, client):
        body = client.get("/api/patients", params={"only_with_memory": False}).json()
        assert body["count"] == 160
        assert len({row["patient"]["name"] for row in body["patients"]}) == 160
        assert all(row["source_records"] > 0 for row in body["patients"])
        flagged = [row for row in body["patients"] if row["source_held"]]
        assert len(flagged) == 6
        patient = flagged[0]["token"]
        detail = client.get(f"/api/patients/{patient}/record").json()
        assert any("identity mismatch" in issue.lower()
                   for record in detail["source_records"]
                   for issue in record["issues"])

    def test_safe_and_unsafe_transfers_are_recorded_without_moving_source(self, client):
        patient_id = "S1000"
        detail = client.get(f"/api/patients/{patient_id}/record").json()
        record = next(r for r in detail["source_records"]
                      if r["status"] == "available" and not r["restricted"])
        safe = client.post("/api/registry/transfers", json={
            "record_key": record["record_key"], "target_patient_id": patient_id,
            "destination": "Ward A",
        }).json()
        assert safe["status"] == "completed"
        held = client.post("/api/registry/transfers", json={
            "record_key": record["record_key"], "target_patient_id": "S1001",
            "destination": "ICU",
        }).json()
        assert held["status"] == "held"
        assert "Target patient differs" in held["explanation"]
        after = client.get(f"/api/patients/{patient_id}/record").json()
        assert {r["record_key"] for r in after["source_records"]} == \
               {r["record_key"] for r in detail["source_records"]}
        assert after["source_summary"]["completed_transfers"] == 1
        assert after["source_summary"]["held_transfers"] == 1
        # The transfer log survives a new connection / registry object.
        assert ClinicalRegistry(state.registry.path).summary(patient_id)["held_transfers"] == 1

    def test_manual_fallback_holds_record_and_reset_keeps_fixture(self, client):
        record = client.get("/api/patients/S1000/record").json()["source_records"][0]
        response = client.post("/api/registry/reports", json={
            "patient_id": "S1000", "record_key": record["record_key"],
            "description": "The observation appears to have an incorrect source.",
        })
        assert response.status_code == 200, response.text
        detail = client.get("/api/patients/S1000/record").json()
        assert detail["source_summary"]["open_reports"] == 1
        assert next(r for r in detail["source_records"]
                    if r["record_key"] == record["record_key"])["status"] == "held"
        client.post("/api/system/reset")
        reset = client.get("/api/patients/S1000/record").json()
        assert reset["source_summary"]["open_reports"] == 0
        assert reset["source_summary"]["source_records"] > 0

    def test_manual_concern_appears_in_review_queue_and_can_be_dismissed(self, client):
        record = client.get("/api/patients/S1000/record").json()["source_records"][0]
        created = client.post("/api/registry/reports", json={
            "patient_id": "S1000", "record_key": record["record_key"],
            "description": "The source observation appears duplicated.",
        }).json()
        queue = client.get("/api/review/queue").json()
        assert any(item.get("report_id") == created["id"]
                   for item in queue["registry_items"])
        dismissed = client.post(f"/api/registry/reports/{created['id']}/dismiss",
                                json={"note": "Checked the source chart; this is valid."})
        assert dismissed.status_code == 200
        assert client.get("/api/patients/S1000/record").json()["source_summary"]["open_reports"] == 0

    def test_source_chart_correction_and_separate_manual_resolution(self, client):
        key = "Observation/S1029-OBS1"
        source_chart, filed_chart = "S1029", "S1030"
        before = client.get(f"/api/patients/{filed_chart}/record").json()
        assert any(r["record_key"] == key and r["status"] == "held"
                   for r in before["source_records"])
        report = client.post("/api/registry/reports", json={
            "patient_id": filed_chart, "record_key": key,
            "description": "This observation was filed under the wrong chart.",
        }).json()
        assert client.post("/api/registry/corrections", json={
            "record_key": key, "note": "too short",
        }).status_code in {400, 422}
        correction = client.post("/api/registry/corrections", json={
            "record_key": key,
            "note": "Verified FHIR subject Patient/S1029 against the synthetic source chart.",
        })
        assert correction.status_code == 200, correction.text
        assert correction.json()["to_patient_id"] == source_chart
        assert not any(i["kind"] == "automatic" and i["record_key"] == key
                       for i in client.get("/api/review/queue").json()["registry_items"])
        old = client.get(f"/api/patients/{filed_chart}/record").json()
        new = client.get(f"/api/patients/{source_chart}/record").json()
        assert all(r["record_key"] != key for r in old["source_records"])
        assert old["source_summary"]["source_corrected"] == 1
        assert any(r["record_key"] == key and r["status"] == "held"
                   for r in new["source_records"])
        assert old["source_summary"]["open_reports"] == 1
        assert new["source_corrections"][0]["record_key"] == key
        assert client.post("/api/registry/corrections", json={
            "record_key": key, "note": "Verified again against the source chart.",
        }).status_code == 400
        resolved = client.post(f"/api/registry/reports/{report['id']}/resolve", json={
            "note": "The source association was corrected after reviewing the FHIR subject.",
        })
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["status"] == "resolved"
        new = client.get(f"/api/patients/{source_chart}/record").json()
        assert any(r["record_key"] == key and r["status"] == "available"
                   for r in new["source_records"])
        assert client.get(f"/api/patients/{filed_chart}/record").json()["manual_reports"][0]["status"] == "resolved"
        client.post("/api/system/reset")
        reset = client.get(f"/api/patients/{filed_chart}/record").json()
        assert any(r["record_key"] == key and r["status"] == "held"
                   for r in reset["source_records"])
        assert reset["source_corrections"] == []

    def test_restricted_value_is_not_exposed_to_clinician_record_view(self, client):
        records = client.get("/api/patients/S1000/record").json()["source_records"]
        restricted = [row for row in records if row["restricted"]]
        assert restricted
        assert all(row["value"] is None and row["label"] == "Restricted clinical record"
                   for row in restricted)
