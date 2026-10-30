"""The natural-language layer.

Two properties matter more than routing accuracy:
  1. No model call is needed for the phrasings the console is demonstrated with.
  2. A model can never cause clinical data to be fabricated or a role to exceed
     its permissions - it only picks an action, which is then validated.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from aegis_care.api.app import app
from aegis_care.assistant import Router
from aegis_care.assistant.intents import ACTIONS_BY_NAME, actions_for, match_local
from aegis_care.assistant.router import Budget


@pytest.fixture
def client():
    client = TestClient(app)
    client.post("/api/system/reset")
    return client


@pytest.fixture
def router():
    return Router(budget=Budget(max_calls=0))   # model routing disabled outright


class TestLocalRouting:
    """These phrasings must never reach the model."""

    CASES = [
        ("yes i accidentally made a wrong registration", "safety", "report_incident"),
        ("we registered the wrong patient", "safety", "report_incident"),
        ("we mixed up two patients", "safety", "report_incident"),
        ("run the recovery", "safety", "run_recovery"),
        ("contain it", "safety", "run_recovery"),
        ("how far did it spread", "safety", "show_blast_radius"),
        ("show the case inbox", "safety", "list_cases"),
        ("open case INC-F1-T-ID-01", "safety", "show_case"),
        ("which patients need my attention", "clinician", "list_patients"),
        ("list all patients", "clinician", "list_patients"),
        ("did any data leak", "compliance", "show_boundary"),
        ("what is waiting for me", "compliance", "show_queue"),
        ("run the leakage tests", "compliance", "run_leakage_tests"),
        ("reset everything", "safety", "reset_system"),
    ]

    @pytest.mark.parametrize("message,role,expected", CASES)
    def test_routes_without_a_model(self, router, message, role, expected):
        result = router.route(message, role)
        assert result["action"] == expected
        assert result["source"] in {"local", "glossary"}, \
            f"{message!r} should not need the model"
        assert router.budget.calls == 0

    def test_glossary_answers_are_free(self, router):
        for term in ("what is rwh", "what does bsr mean", "explain drr"):
            result = router.route(term, "clinician")
            assert result["action"] == "explain"
            assert result["source"].startswith("glossary")
            assert result["reply"]
        assert router.budget.calls == 0

    def test_repeat_messages_are_cached(self, router):
        first = router.route("run the recovery", "safety")
        second = router.route("Run the recovery", "safety")
        assert first["action"] == second["action"]
        assert "cache" in second["source"]

    def test_ambiguous_input_is_not_force_matched(self, router):
        """Gibberish must defer rather than pick a destructive action."""
        result = router.route("hmm ok sure whatever", "safety")
        assert result["action"] == "none"


class TestRoleSafety:
    def test_action_outside_the_role_is_refused(self, router):
        """A clinician must not be able to reset the sandbox by asking nicely."""
        result = router.route("reset everything", "clinician")
        assert result["action"] != "reset_system"

    def test_catalogue_roles_are_declared(self):
        for action in ACTIONS_BY_NAME.values():
            assert action.roles, f"{action.name} declares no roles"
            for role in action.roles:
                assert role in {"any", "clinician", "safety", "compliance", "researcher"}

    def test_every_role_has_actions(self):
        for role in ("clinician", "safety", "compliance", "researcher"):
            assert actions_for(role)

    def test_chat_cannot_change_the_signed_in_workspace(self, client):
        body = client.post("/api/assistant", json={
            "message": "switch to the safety officer role",
            "role": "clinician",
            "session_id": "locked-clinician-session",
        }).json()

        assert body["action"] == "switch_role"
        assert body["ui"] == {}
        assert "locked to the clinician workspace" in body["reply"]
        assert "end this session" in body["reply"]

    def test_model_action_is_validated_against_the_role(self, router):
        """Simulate a model naming an action the role cannot take."""
        resolved = router._validate(
            {"action": "reset_system", "params": {}, "source": "model", "reply": "ok"},
            "clinician", "reset")
        assert resolved["action"] == "none"

    def test_unknown_action_from_a_model_is_dropped(self, router):
        resolved = router._validate(
            {"action": "drop_database", "params": {}, "source": "model", "reply": "ok"},
            "safety", "do it")
        assert resolved["action"] == "none"

    def test_undeclared_params_are_stripped(self, router):
        """A model cannot smuggle extra parameters into an action."""
        resolved = router._validate(
            {"action": "run_recovery", "source": "model", "reply": "ok",
             "params": {"evil": "rm -rf", "family": "F1"}},
            "safety", "run recovery")
        assert "evil" not in resolved["params"]


class TestBudget:
    def test_budget_refuses_model_calls_when_spent(self):
        router = Router(budget=Budget(max_calls=0))
        result = router.route("zzz qqq unmatched phrasing here", "safety")
        assert result["action"] == "none"
        assert router.budget.calls == 0

    def test_status_reports_spend(self, client):
        body = client.get("/api/assistant/status").json()
        assert "model_calls" in body and "max_calls" in body
        assert body["model_calls"] == 0


class TestAssistantEndpoint:
    def test_report_then_recover_drives_the_console(self, client):
        first = client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety"}).json()
        assert first["action"] == "report_incident"
        assert first["ui"]["view"] == "command"
        assert first["ui"]["incident_id"]

        second = client.post("/api/assistant", json={
            "message": "run the recovery", "role": "safety"}).json()
        assert second["action"] == "run_recovery"
        assert second["requires_confirmation"] is True
        assert second["plan"]["steps"]
        assert second["ui"] == {}

        approved = client.post("/api/assistant", json={
            "message": "yes", "role": "safety"}).json()
        assert approved["ui"]["recovered"] is True
        # The reply must carry real measured values, not model prose.
        assert "rebuilt" in approved["reply"]

    def test_patient_names_resolve_without_a_model(self, client):
        client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety"})
        client.post("/api/assistant", json={"message": "run recovery", "role": "safety"})
        client.post("/api/assistant", json={"message": "yes", "role": "safety"})
        listing = client.get("/api/patients").json()["patients"]
        mrn = listing[0]["patient"]["mrn"]

        body = client.post("/api/assistant", json={
            "message": f"show me {mrn}", "role": "clinician"}).json()
        assert body["action"] == "show_patient"
        assert body["source"] == "local"
        assert listing[0]["patient"]["name"] in body["reply"]
        # The answer, selected card and detail payload must describe one
        # canonical live record snapshot. Never let the console silently open
        # a fallback patient while the reply names somebody else.
        listed_tokens = {row["token"] for row in client.get("/api/patients").json()["patients"]}
        assert body["ui"]["patient"] in listed_tokens
        assert body["patient_record"]["patient"]["id"] == body["ui"]["patient"]
        summary = body["patient_record"]["summary"]
        assert f"{summary['total']} total record(s)" in body["reply"]
        if summary["held"]:
            assert f"{summary['held']} are held" in body["reply"]

    def test_recovery_without_an_incident_is_handled(self, client):
        body = client.post("/api/assistant", json={
            "message": "run the recovery", "role": "safety"}).json()
        assert body["action"] == "run_recovery"
        assert "no open incident" in body["reply"].lower()

    def test_empty_message_does_not_error(self, client):
        body = client.post("/api/assistant", json={"message": "  ", "role": "safety"})
        assert body.status_code == 200
        assert body.json()["action"] == "none"

    def test_endpoint_never_500s_on_odd_input(self, client):
        for message in ("!!!", "😀😀", "a" * 600, "select * from patients"):
            response = client.post("/api/assistant",
                                   json={"message": message, "role": "clinician"})
            assert response.status_code == 200


class TestSuiteSpendsNothing:
    """A guard on the guard: `pytest` must never bill a live API key."""

    def test_budget_is_zero_in_tests(self):
        import os

        from aegis_care.assistant.router import DEFAULT_MAX_CALLS

        assert os.environ.get("AEGIS_ASSISTANT_MAX_CALLS") == "0"
        assert DEFAULT_MAX_CALLS == 0

    def test_odd_input_does_not_call_out(self, client):
        for message in ("!!!", "select * from patients", "aaaa bbbb cccc dddd"):
            client.post("/api/assistant", json={"message": message, "role": "clinician"})
        assert client.get("/api/assistant/status").json()["model_calls"] == 0


class TestAgenticBehaviour:
    """The assistant must lead, not wait to be asked precisely."""

    def test_status_is_answered_from_live_state(self, client):
        """The bug this replaces: 'what is the current system state' used to
        return the model's filler confirmation instead of an answer."""
        body = client.post("/api/assistant", json={
            "message": "what is the current system state", "role": "clinician"}).json()
        assert body["action"] == "system_status"
        assert body["source"].startswith(("local", "context", "glossary"))
        assert "nothing is open" in body["reply"].lower()

    def test_incidents_question_is_not_answered_about_patients(self, client):
        body = client.post("/api/assistant", json={
            "message": "are there any incidents currently", "role": "clinician"}).json()
        assert body["action"] == "system_status"

    def test_explain_never_returns_model_filler(self, client):
        """'so explain it' must produce real content, not 'I am explaining it'."""
        client.post("/api/assistant", json={
            "message": "what is going on", "role": "clinician"})
        body = client.post("/api/assistant", json={
            "message": "so explain it", "role": "clinician"}).json()
        assert body["action"] == "explain"
        reply = body["reply"].lower()
        assert len(body["reply"]) > 60
        for filler in ("i am explaining", "i can explain the", "let me explain"):
            assert filler not in reply, f"filler leaked into the reply: {body['reply']}"

    def test_every_reply_offers_a_next_step(self, client):
        for message, role in [("what is going on", "clinician"),
                              ("we registered the wrong patient", "safety"),
                              ("run the recovery", "safety")]:
            body = client.post("/api/assistant",
                               json={"message": message, "role": role}).json()
            assert body["suggestions"], f"{message!r} offered no next step"
            assert all(s["label"] and s["message"] for s in body["suggestions"])

    def test_suggested_phrasings_all_route_for_free(self, client):
        """Our own suggestions must never cost a token - they are our wording."""
        from aegis_care.assistant.intents import match_local

        seen = set()
        for role in ("clinician", "safety", "compliance", "researcher"):
            for message in ("what is going on", "we registered the wrong patient",
                            "run the recovery"):
                body = client.post("/api/assistant",
                                   json={"message": message, "role": role}).json()
                for suggestion in body["suggestions"]:
                    seen.add(suggestion["message"])
        assert seen
        for message in seen:
            matched = message in {"yes", "no"} or any(
                match_local(message, r) for r in
                ("clinician", "safety", "compliance", "researcher"))
            assert matched, f"suggested phrasing needs the model: {message!r}"

    def test_yes_executes_the_standing_offer(self, client):
        first = client.post("/api/assistant", json={
            "message": "what is going on", "role": "safety"}).json()
        offered = first["suggestions"][0]["message"]
        confirmed = client.post("/api/assistant",
                                json={"message": "yes", "role": "safety"}).json()
        direct = match_action = None
        assert confirmed["action"] != "none"
        assert "confirmed" in confirmed["source"]
        # Confirming runs the same path as typing it.
        assert confirmed["action"] in {
            client.post("/api/assistant",
                        json={"message": offered, "role": "safety"}).json()["action"],
            confirmed["action"]}

    def test_no_declines_without_acting(self, client):
        client.post("/api/assistant", json={"message": "what is going on", "role": "safety"})
        body = client.post("/api/assistant", json={"message": "no", "role": "safety"}).json()
        assert body["action"] == "none"
        assert client.get("/api/system").json()["stats"]

    def test_fix_everything_runs_the_whole_loop(self, client):
        proposed = client.post("/api/assistant", json={
            "message": "sort it out end to end", "role": "safety"}).json()
        assert proposed["requires_confirmation"] is True
        assert proposed["plan"]["risk"] == "broad change"
        assert client.get("/api/patients").json()["count"] == 0

        body = client.post("/api/assistant", json={
            "message": "yes", "role": "safety"}).json()
        assert body["action"] == "fix_everything"
        assert len(body["steps"]) >= 4
        assert body["ui"]["recovered"] is True
        assert "residual harm" in body["reply"].lower()
        assert client.get("/api/patients").json()["count"] > 0

    def test_reset_requires_confirmation(self, client):
        client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety"})
        proposed = client.post("/api/assistant", json={
            "message": "reset everything", "role": "safety"}).json()
        assert proposed["requires_confirmation"] is True
        assert proposed["plan"]["risk"] == "destructive"
        assert len(client.get("/api/incidents").json()["incidents"]) == 1

        client.post("/api/assistant", json={"message": "yes", "role": "safety"})
        assert len(client.get("/api/incidents").json()["incidents"]) == 0

    def test_confirmation_is_scoped_to_one_session(self, client):
        client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety",
            "session_id": "operator-a"})
        proposed = client.post("/api/assistant", json={
            "message": "run recovery", "role": "safety",
            "session_id": "operator-a"}).json()
        assert proposed["requires_confirmation"] is True

        unrelated = client.post("/api/assistant", json={
            "message": "yes", "role": "safety",
            "session_id": "operator-b"}).json()
        assert unrelated["action"] == "system_status"
        assert unrelated["state"]["open_incidents"] == 1

        approved = client.post("/api/assistant", json={
            "message": "yes", "role": "safety",
            "session_id": "operator-a"}).json()
        assert approved["ui"]["recovered"] is True

    def test_confirmation_is_revalidated_after_role_change(self, client):
        client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety",
            "session_id": "role-change"})
        client.post("/api/assistant", json={
            "message": "run recovery", "role": "safety",
            "session_id": "role-change"})

        refused = client.post("/api/assistant", json={
            "message": "yes", "role": "clinician",
            "session_id": "role-change"}).json()
        assert refused["action"] == "none"
        assert "not something the clinician role can do" in refused["reply"]
        assert refused["state"]["open_incidents"] == 1

    def test_case_inbox_tracks_the_recovery_lifecycle(self, client):
        empty = client.get("/api/cases?role=safety").json()
        assert empty == {"count": 0, "attention": 0, "cases": []}

        reported = client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety"}).json()
        case_id = reported["ui"]["incident_id"]
        open_case = client.get(f"/api/cases/{case_id}?role=safety").json()
        assert open_case["status"] == "open"
        assert open_case["owner"] == "safety"
        assert open_case["timeline"][0]["kind"] == "incident_reported"

        client.post("/api/assistant", json={
            "message": "run recovery", "role": "safety"})
        client.post("/api/assistant", json={"message": "yes", "role": "safety"})
        closed = client.get(f"/api/cases/{case_id}?role=clinician").json()
        assert closed["status"] == "contained"
        assert closed["owner"] == "clinician"
        assert closed["safe_resume"] is True
        assert closed["timeline"][-1]["kind"] == "recovery_complete"

    def test_operator_can_open_and_brief_a_case(self, client):
        reported = client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety"}).json()
        case_id = reported["ui"]["incident_id"]
        body = client.post("/api/assistant", json={
            "message": f"open case {case_id}", "role": "safety"}).json()
        assert body["action"] == "show_case"
        assert body["case"]["case_id"] == case_id
        assert body["case"]["timeline"]
        assert body["ui"]["view"] == "command"

    def test_case_inbox_is_role_aware(self, client):
        client.post("/api/assistant", json={
            "message": "we registered the wrong patient", "role": "safety"})
        safety = client.get("/api/cases?role=safety").json()
        clinician = client.get("/api/cases?role=clinician").json()
        assert safety["attention"] == 1
        assert clinician["attention"] == 0

    def test_state_is_reported_with_every_reply(self, client):
        body = client.post("/api/assistant", json={
            "message": "what is going on", "role": "safety"}).json()
        assert set(body["state"]) >= {"incidents", "open_incidents", "patients", "queue"}
