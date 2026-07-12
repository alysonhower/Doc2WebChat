from __future__ import annotations

import concurrent.futures
import json
import threading
from pathlib import Path
from typing import Any

import pytest

from doc2webchat.api import DesktopApi, WebviewApi
from doc2webchat.database import Database, DatabaseError, canonical_path
from doc2webchat.ocr import (
    MAX_OVERWRITE_CONFLICT_PATHS,
    OcrJobRequest,
    OutputPolicy,
    output_approval_key,
)
from doc2webchat.providers import ProviderRegistry


class FakeWindow:
    def __init__(self, result: tuple[str, ...] | None = None) -> None:
        self.result = result
        self.calls: list[tuple[Any, ...]] = []

    def create_file_dialog(self, *args: Any, **kwargs: Any) -> tuple[str, ...] | None:
        self.calls.append((args, kwargs))
        return self.result


class FakeDialogDispatcher:
    def __init__(self, window: FakeWindow) -> None:
        self.window = window

    def select_folder(self) -> tuple[str, ...] | None:
        return self.window.create_file_dialog("folder", allow_multiple=False)


class FakeBridge:
    def __init__(self) -> None:
        self.browsers = [
            {"browserInstanceId": "browser", "version": "1", "userAgent": "x"}
        ]
        self.dispatched: list[dict[str, Any]] = []

    def list_browsers(self) -> list[dict[str, Any]]:
        return self.browsers

    def dispatch_interaction(self, **kwargs: Any) -> dict[str, Any]:
        self.dispatched.append(kwargs)
        return {"handoff_id": "opaque", "expires_at": 1}


class FakeEventBridge(FakeBridge):
    def __init__(self) -> None:
        super().__init__()
        self.import_results: list[tuple[str, str, str | None]] = []

    def get_event(self, timeout: float | None = None) -> dict[str, Any]:
        del timeout
        raise TimeoutError

    def report_import_result(
        self, event: dict[str, Any], status: str, code: str | None = None
    ) -> None:
        self.import_results.append((str(event["interaction_id"]), status, code))


class FakeClipboard:
    def __init__(self, sequence: int = 1, text: str = "") -> None:
        self.current_sequence = sequence
        self.text = text

    def sequence(self) -> int:
        return self.current_sequence

    def read_text(self) -> str:
        return self.text


@pytest.fixture
def registry(tmp_path: Path) -> ProviderRegistry:
    path = tmp_path / "providers.json"
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "providers": [
                    {
                        "id": "open-webui",
                        "label": "Open WebUI",
                        "adapter_key": "open-webui",
                        "canonical_url": "http://localhost:3000/",
                        "allowed_url_prefixes": ["http://localhost:3000/"],
                        "manifest_matches": ["http://localhost:3000/*"],
                        "detection": {},
                        "controls": {"temperature": True},
                        "dom_controls": ["composer", "copy"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return ProviderRegistry.load(path)


@pytest.fixture
def api(tmp_path: Path, registry: ProviderRegistry):
    database = Database(tmp_path / "app.sqlite3")
    bridge = FakeBridge()
    value = DesktopApi(database, bridge, registry)
    yield value, database, bridge
    value.close()
    database.close()


def unwrap(result: dict[str, Any]) -> Any:
    assert result["ok"] is True, result
    return result["value"]


def test_methods_return_safe_error_envelopes(
    api: tuple[DesktopApi, Database, FakeBridge],
) -> None:
    value, _, _ = api
    result = value.start_ocr_job({"inputPath": "missing"})
    assert result["ok"] is False
    assert result["error"]["code"] == "invalid-request"
    assert "traceback" not in json.dumps(result).lower()


def test_native_directory_selection(
    api: tuple[DesktopApi, Database, FakeBridge], tmp_path: Path
) -> None:
    value, _, _ = api
    window = FakeWindow((str(tmp_path),))
    value.attach_window(window, FakeDialogDispatcher(window))
    selected = unwrap(value.select_directory({"purpose": "input"}))
    assert selected == {"path": str(tmp_path.resolve())}
    assert window.calls


def test_bootstrap_and_prompt_crud(
    api: tuple[DesktopApi, Database, FakeBridge],
) -> None:
    value, _, _ = api
    content = {
        "version": 1,
        "root": {"version": 1, "nodes": [{"type": "text", "text": "Go"}]},
        "definitions": {},
    }
    created = unwrap(value.save_prompt({"name": "Default", "document": content}))[
        "prompt"
    ]
    assert (
        unwrap(value.load_prompt({"promptId": created["id"]}))["prompt"]["document"]
        == content
    )
    bootstrap = unwrap(value.get_bootstrap_state())
    assert bootstrap["prompts"][0]["name"] == "Default"
    assert bootstrap["providers"][0]["id"] == "open-webui"


def test_bootstrap_recovers_latest_pending_overwrite_confirmation(
    api: tuple[DesktopApi, Database, FakeBridge], tmp_path: Path
) -> None:
    value, database, _ = api
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    pending_id = database.create_ocr_job(
        str(input_path), str(output_path), True, "error"
    )
    conflict_total = MAX_OVERWRITE_CONFLICT_PATHS + 3
    expected_outputs: list[str] = []
    for index in range(conflict_total):
        output = output_path / f"page-{index:02d}.pdf"
        database.create_ocr_job_file(
            pending_id,
            str(input_path / f"page-{index:02d}.png"),
            str(output),
            "awaiting-overwrite",
        )
        expected_outputs.append(canonical_path(output))
    database.update_ocr_job(
        pending_id,
        "awaiting-overwrite",
        total_files=conflict_total,
        finished=True,
    )

    active_job = unwrap(value.get_bootstrap_state())["activeJob"]
    assert active_job == {
        "jobId": pending_id,
        "status": "awaiting-overwrite",
        "total": conflict_total,
        "completed": 0,
        "failed": 0,
        "skipped": 0,
        "overwriteConfirmationJobId": pending_id,
        "inputPath": canonical_path(input_path),
        "outputPath": canonical_path(output_path),
        "recursive": True,
        "conflictCount": conflict_total,
        "conflictingOutputs": expected_outputs[:MAX_OVERWRITE_CONFLICT_PATHS],
    }


def test_confirmation_is_bound_to_pending_job_and_approves_only_its_outputs(
    api: tuple[DesktopApi, Database, FakeBridge],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    value, database, _ = api
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    input_path.mkdir()
    output_path.mkdir()
    pending_id = database.create_ocr_job(
        str(input_path), str(output_path), False, "error"
    )
    approved_outputs = [output_path / "a.pdf", output_path / "b.pdf"]
    for index, output in enumerate(approved_outputs):
        database.create_ocr_job_file(
            pending_id,
            str(input_path / f"{index}.png"),
            str(output),
            "awaiting-overwrite",
        )
    database.update_ocr_job(pending_id, "awaiting-overwrite", finished=True)

    unrelated_id = database.create_ocr_job("other-in", "other-out", False, "error")
    database.create_ocr_job_file(
        unrelated_id,
        "other-in/a.png",
        "other-out/a.pdf",
        "awaiting-overwrite",
    )
    database.update_ocr_job(unrelated_id, "awaiting-overwrite", finished=True)
    started: list[OcrJobRequest] = []

    def start_job(request: OcrJobRequest) -> int:
        started.append(request)
        return database.create_ocr_job(
            str(request.input_path),
            str(request.output_path),
            request.recursive,
            request.policy.value,
        )

    monkeypatch.setattr(value.ocr_manager, "start_job", start_job)
    mismatched = value.start_ocr_job(
        {
            "inputPath": str(tmp_path / "different"),
            "outputPath": str(output_path),
            "recursive": False,
            "conflictPolicy": "error",
            "overwriteConfirmationJobId": pending_id,
        }
    )
    assert mismatched["ok"] is False
    assert mismatched["error"]["code"] == "invalid-overwrite-confirmation"
    assert started == []

    result = unwrap(
        value.start_ocr_job(
            {
                "inputPath": str(input_path),
                "outputPath": str(output_path),
                "recursive": False,
                "conflictPolicy": "error",
                "overwriteConfirmationJobId": pending_id,
            }
        )
    )

    assert result["jobId"] > pending_id
    assert len(started) == 1
    assert started[0].policy is OutputPolicy.ERROR
    assert started[0].approved_overwrites == frozenset(
        output_approval_key(output) for output in approved_outputs
    )
    assert database.get_ocr_job(pending_id)["status"] == "overwrite-confirmed"
    assert database.scalar(
        "SELECT COUNT(*) FROM ocr_job_files "
        "WHERE job_id = ? AND status = 'overwrite-confirmed'",
        (pending_id,),
    ) == len(approved_outputs)
    assert database.get_ocr_job(unrelated_id)["status"] == "overwrite-declined"


def test_concurrent_confirmation_consumption_starts_exactly_one_retry(
    api: tuple[DesktopApi, Database, FakeBridge],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    value, database, _ = api
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    input_path.mkdir()
    output_path.mkdir()
    pending_id = database.create_ocr_job(
        str(input_path), str(output_path), False, "error"
    )
    database.create_ocr_job_file(
        pending_id,
        str(input_path / "page.png"),
        str(output_path / "page.pdf"),
        "awaiting-overwrite",
    )
    database.update_ocr_job(pending_id, "awaiting-overwrite", finished=True)

    original_get = database.get_pending_overwrite_job
    both_read_pending = threading.Barrier(2)

    def synchronized_get(job_id: int | None = None) -> dict[str, Any] | None:
        pending = original_get(job_id)
        if job_id == pending_id:
            both_read_pending.wait(timeout=5)
        return pending

    started: list[OcrJobRequest] = []

    def start_job(request: OcrJobRequest) -> int:
        started.append(request)
        return database.create_ocr_job(
            str(request.input_path),
            str(request.output_path),
            request.recursive,
            request.policy.value,
        )

    monkeypatch.setattr(database, "get_pending_overwrite_job", synchronized_get)
    monkeypatch.setattr(value.ocr_manager, "start_job", start_job)
    request = {
        "inputPath": str(input_path),
        "outputPath": str(output_path),
        "recursive": False,
        "conflictPolicy": "error",
        "overwriteConfirmationJobId": pending_id,
    }
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: value.start_ocr_job(request), range(2)))

    assert sum(result["ok"] is True for result in results) == 1
    assert (
        sum(
            result["ok"] is False
            and result["error"]["code"] == "invalid-overwrite-confirmation"
            for result in results
        )
        == 1
    )
    assert len(started) == 1
    assert database.get_ocr_job(pending_id)["status"] == "overwrite-confirmed"


def test_failed_confirmed_retry_releases_database_claim(
    api: tuple[DesktopApi, Database, FakeBridge],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    value, database, _ = api
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    input_path.mkdir()
    output_path.mkdir()
    pending_id = database.create_ocr_job(
        str(input_path), str(output_path), False, "error"
    )
    database.create_ocr_job_file(
        pending_id,
        str(input_path / "page.png"),
        str(output_path / "page.pdf"),
        "awaiting-overwrite",
    )
    database.update_ocr_job(pending_id, "awaiting-overwrite", finished=True)
    monkeypatch.setattr(
        value.ocr_manager,
        "start_job",
        lambda request: (_ for _ in ()).throw(RuntimeError("start failed")),
    )

    result = value.start_ocr_job(
        {
            "inputPath": str(input_path),
            "outputPath": str(output_path),
            "conflictPolicy": "error",
            "overwriteConfirmationJobId": pending_id,
        }
    )

    assert result["ok"] is False
    assert database.get_ocr_job(pending_id)["status"] == "awaiting-overwrite"
    assert database.get_pending_overwrite_job(pending_id) is not None
    assert (
        database.scalar(
            "SELECT status FROM ocr_job_files WHERE job_id = ?", (pending_id,)
        )
        == "awaiting-overwrite"
    )


def test_start_interaction_persists_before_dispatch(
    api: tuple[DesktopApi, Database, FakeBridge], monkeypatch: pytest.MonkeyPatch
) -> None:
    value, database, bridge = api
    database.record_document_success("in", "out", "file text", 1)
    request = {
        "instructions": {
            "version": 1,
            "root": {"version": 1, "nodes": [{"type": "text", "text": "Read"}]},
            "definitions": {},
        },
        "providerId": "open-webui",
        "settings": {"temperature": 0.2},
        "reuseTab": True,
    }
    result = unwrap(value.start_interaction(request))
    assert result["status"] == "dispatched"
    assert result["promptBytes"] > 0
    assert bridge.dispatched[0]["prompt"].startswith("Read\n<files>")
    history = database.list_history()
    assert history[0]["messages"][0]["role"] == "user"
    preferences = database.get_preferences()
    assert preferences["reuseTab"] is True
    assert preferences["providerUrls"]["open-webui"] == "http://localhost:3000/"
    assert preferences["providerSettings"]["open-webui"]["temperature"] == 0.2


def test_start_interaction_is_dispatched_before_bridge_can_report_prefill(
    tmp_path: Path, registry: ProviderRegistry
) -> None:
    database = Database(tmp_path / "race.sqlite3")

    class ImmediatePrefillBridge(FakeBridge):
        api: DesktopApi

        def dispatch_interaction(self, **kwargs: Any) -> dict[str, Any]:
            result = super().dispatch_interaction(**kwargs)
            self.api.handle_bridge_event(
                {
                    "action": "prefill-completed",
                    "interaction_id": kwargs["interaction_id"],
                    "browser_instance_id": kwargs["browser_instance_id"],
                    "provider_id": kwargs["provider_id"],
                    "provider_url": kwargs["provider_url"],
                    "tab_id": 1,
                    "duplicate": False,
                },
                self,  # type: ignore[arg-type]
            )
            return result

    bridge = ImmediatePrefillBridge()
    value = DesktopApi(database, bridge, registry)
    bridge.api = value
    try:
        result = unwrap(
            value.start_interaction(
                {
                    "instructions": {
                        "version": 1,
                        "root": {"version": 1, "nodes": []},
                        "definitions": {},
                    },
                    "providerId": "open-webui",
                }
            )
        )
        interaction = database.get_interaction(result["interactionId"])
        assert interaction["status"] == "prefilled"
    finally:
        value.close()
        database.close()


def test_start_interaction_marks_dispatch_failure_terminal(
    tmp_path: Path, registry: ProviderRegistry
) -> None:
    database = Database(tmp_path / "dispatch-failure.sqlite3")

    class FailingBridge(FakeBridge):
        def dispatch_interaction(self, **kwargs: Any) -> dict[str, Any]:
            del kwargs
            raise RuntimeError("socket closed")

    value = DesktopApi(database, FailingBridge(), registry)
    try:
        result = value.start_interaction(
            {
                "instructions": {
                    "version": 1,
                    "root": {"version": 1, "nodes": []},
                    "definitions": {},
                },
                "providerId": "open-webui",
            }
        )
        assert result["ok"] is False
        assert result["error"]["code"] == "operation-failed"
        assert database.list_history()[0]["status"] == "failed"
    finally:
        value.close()
        database.close()


def test_multiple_browsers_require_selection(
    api: tuple[DesktopApi, Database, FakeBridge],
) -> None:
    value, _, bridge = api
    bridge.browsers.append(
        {"browserInstanceId": "second", "version": "1", "userAgent": "y"}
    )
    result = value.start_interaction(
        {
            "instructions": {
                "version": 1,
                "root": {"version": 1, "nodes": []},
                "definitions": {},
            },
            "providerId": "open-webui",
        }
    )
    assert result["ok"] is False
    assert result["error"]["code"] == "browser-selection-required"


def test_webview_surface_exposes_only_the_documented_methods(
    api: tuple[DesktopApi, Database, FakeBridge],
) -> None:
    value, _, _ = api
    surface = WebviewApi(value)
    public_members = {name for name in dir(surface) if not name.startswith("_")}
    assert public_members == {
        "get_bootstrap_state",
        "select_directory",
        "start_ocr_job",
        "poll_events",
        "list_documents",
        "list_prompts",
        "load_prompt",
        "save_prompt",
        "rename_prompt",
        "delete_prompt",
        "start_interaction",
        "list_browsers",
        "list_history",
    }
    assert all(callable(getattr(surface, name)) for name in public_members)


def test_clipboard_baseline_precedes_native_copy(
    api: tuple[DesktopApi, Database, FakeBridge],
) -> None:
    value, database, _ = api
    interaction_id = "00000000-0000-4000-8000-000000000099"
    database.create_interaction(
        interaction_id,
        "browser",
        "open-webui",
        "http://localhost:3000/",
        {"version": 1, "root": {"version": 1, "nodes": []}, "definitions": {}},
        "",
        "hash",
        0,
        [],
    )
    database.update_interaction(interaction_id, "prefilled")
    clipboard = FakeClipboard(sequence=7)
    value.clipboard = clipboard
    identity = {
        "interaction_id": interaction_id,
        "browser_instance_id": "browser",
        "provider_id": "open-webui",
        "provider_url": "http://localhost:3000/",
        "tab_id": 1,
    }
    event_bridge = FakeEventBridge()
    value.handle_bridge_event(
        {**identity, "action": "response-finished", "duplicate": False},
        event_bridge,
    )
    value.handle_bridge_event(
        {**identity, "action": "import-started", "duplicate": False},
        event_bridge,
    )
    assert value.clipboard_sequences[interaction_id] == 7
    assert event_bridge.import_results == [(interaction_id, "ready", None)]
    clipboard.current_sequence = 8


def test_clipboard_lease_rejects_interleaved_imports_and_allows_retry(
    api: tuple[DesktopApi, Database, FakeBridge],
) -> None:
    value, database, _ = api
    clipboard = FakeClipboard(sequence=10)
    value.clipboard = clipboard
    event_bridge = FakeEventBridge()
    interaction_ids = [
        "00000000-0000-4000-8000-000000000101",
        "00000000-0000-4000-8000-000000000102",
    ]
    for interaction_id in interaction_ids:
        database.create_interaction(
            interaction_id,
            "browser",
            "open-webui",
            "http://localhost:3000/",
            {"version": 1, "root": {"version": 1, "nodes": []}, "definitions": {}},
            "",
            "hash",
            0,
            [],
        )
        database.update_interaction(interaction_id, "awaiting-import")

    def event(interaction_id: str, action: str, **extra: Any) -> dict[str, Any]:
        return {
            "interaction_id": interaction_id,
            "browser_instance_id": "browser",
            "provider_id": "open-webui",
            "provider_url": "http://localhost:3000/",
            "tab_id": 1,
            "action": action,
            "duplicate": False,
            **extra,
        }

    value.handle_bridge_event(event(interaction_ids[0], "import-started"), event_bridge)
    value.handle_bridge_event(event(interaction_ids[1], "import-started"), event_bridge)
    assert event_bridge.import_results[-1] == (
        interaction_ids[1],
        "failed",
        "clipboard-busy",
    )
    assert database.get_interaction(interaction_ids[1])["status"] == "awaiting-import"

    value.handle_bridge_event(
        event(interaction_ids[0], "import-failed", code="NATIVE_COPY_FAILED"),
        event_bridge,
    )
    clipboard.current_sequence = 11
    value.handle_bridge_event(event(interaction_ids[1], "import-started"), event_bridge)
    assert event_bridge.import_results[-1] == (interaction_ids[1], "ready", None)
    assert value.clipboard_owner == interaction_ids[1]


def test_stale_clipboard_can_retry_then_complete(
    api: tuple[DesktopApi, Database, FakeBridge],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    value, database, _ = api
    interaction_id = "00000000-0000-4000-8000-000000000103"
    database.create_interaction(
        interaction_id,
        "browser",
        "open-webui",
        "http://localhost:3000/",
        {"version": 1, "root": {"version": 1, "nodes": []}, "definitions": {}},
        "",
        "hash",
        0,
        [],
    )
    database.update_interaction(interaction_id, "awaiting-import")
    clipboard = FakeClipboard(sequence=20)
    value.clipboard = clipboard
    event_bridge = FakeEventBridge()
    monkeypatch.setattr("doc2webchat.api.CLIPBOARD_WAIT_SECONDS", 0.01)

    def event(action: str) -> dict[str, Any]:
        return {
            "interaction_id": interaction_id,
            "browser_instance_id": "browser",
            "provider_id": "open-webui",
            "provider_url": "http://localhost:3000/",
            "tab_id": 1,
            "action": action,
            "duplicate": False,
        }

    value.handle_bridge_event(event("import-started"), event_bridge)
    value.handle_bridge_event(event("import-response"), event_bridge)
    assert database.get_interaction(interaction_id)["status"] == "awaiting-import"
    assert event_bridge.import_results[-1] == (
        interaction_id,
        "failed",
        "clipboard-stale",
    )

    value.handle_bridge_event(event("import-started"), event_bridge)
    clipboard.current_sequence = 21
    clipboard.text = "assistant response"
    value.handle_bridge_event(event("import-response"), event_bridge)
    assert database.get_interaction(interaction_id)["status"] == "completed"
    assert event_bridge.import_results[-1] == (interaction_id, "accepted", None)


def test_lost_accepted_ack_retry_returns_duplicate(
    api: tuple[DesktopApi, Database, FakeBridge],
) -> None:
    value, database, _ = api
    interaction_id = "00000000-0000-4000-8000-000000000104"
    database.create_interaction(
        interaction_id,
        "browser",
        "open-webui",
        "http://localhost:3000/",
        {"version": 1, "root": {"version": 1, "nodes": []}, "definitions": {}},
        "",
        "hash",
        0,
        [],
    )
    database.update_interaction(interaction_id, "awaiting-import")
    clipboard = FakeClipboard(sequence=30, text="response")
    value.clipboard = clipboard

    class LostAckBridge(FakeEventBridge):
        def report_import_result(
            self, event: dict[str, Any], status: str, code: str | None = None
        ) -> None:
            if status == "accepted":
                raise ConnectionError("ack lost")
            super().report_import_result(event, status, code)

    event_bridge = LostAckBridge()

    def event(action: str, duplicate: bool = False) -> dict[str, Any]:
        return {
            "interaction_id": interaction_id,
            "browser_instance_id": "browser",
            "provider_id": "open-webui",
            "provider_url": "http://localhost:3000/",
            "tab_id": 1,
            "action": action,
            "duplicate": duplicate,
        }

    value.handle_bridge_event(event("import-started"), event_bridge)
    clipboard.current_sequence = 31
    value.handle_bridge_event(event("import-response"), event_bridge)
    assert database.get_interaction(interaction_id)["status"] == "completed"

    value.handle_bridge_event(event("import-started", duplicate=True), event_bridge)
    assert event_bridge.import_results[-1] == (interaction_id, "duplicate", None)


def test_persistence_failure_releases_import_for_retry(
    api: tuple[DesktopApi, Database, FakeBridge], monkeypatch: pytest.MonkeyPatch
) -> None:
    value, database, _ = api
    interaction_id = "00000000-0000-4000-8000-000000000105"
    database.create_interaction(
        interaction_id,
        "browser",
        "open-webui",
        "http://localhost:3000/",
        {"version": 1, "root": {"version": 1, "nodes": []}, "definitions": {}},
        "",
        "hash",
        0,
        [],
    )
    database.update_interaction(interaction_id, "awaiting-import")
    clipboard = FakeClipboard(sequence=40, text="response")
    value.clipboard = clipboard
    event_bridge = FakeEventBridge()
    original_complete = database.complete_interaction_with_assistant
    monkeypatch.setattr(
        database,
        "complete_interaction_with_assistant",
        lambda *args, **kwargs: (_ for _ in ()).throw(DatabaseError("busy")),
    )

    def event(action: str) -> dict[str, Any]:
        return {
            "interaction_id": interaction_id,
            "browser_instance_id": "browser",
            "provider_id": "open-webui",
            "provider_url": "http://localhost:3000/",
            "tab_id": 1,
            "action": action,
            "duplicate": False,
        }

    value.handle_bridge_event(event("import-started"), event_bridge)
    clipboard.current_sequence = 41
    value.handle_bridge_event(event("import-response"), event_bridge)
    assert database.get_interaction(interaction_id)["status"] == "awaiting-import"
    assert value.clipboard_owner is None

    monkeypatch.setattr(
        database, "complete_interaction_with_assistant", original_complete
    )
    value.handle_bridge_event(event("import-started"), event_bridge)
    clipboard.current_sequence = 42
    value.handle_bridge_event(event("import-response"), event_bridge)
    assert database.get_interaction(interaction_id)["status"] == "completed"
