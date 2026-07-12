from __future__ import annotations

import concurrent.futures
import sqlite3
from pathlib import Path

import pytest

import doc2webchat.database as database_module
from doc2webchat.database import Database, DatabaseError


@pytest.fixture
def database(tmp_path: Path) -> Database:
    value = Database(tmp_path / "app.sqlite3")
    yield value
    value.close()


def test_migrations_enable_foreign_keys_wal_and_restart_recovery(
    tmp_path: Path,
) -> None:
    path = tmp_path / "app.sqlite3"
    first = Database(path)
    job_id = first.create_ocr_job("in", "out", True, "error")
    job_file_id = first.create_ocr_job_file(job_id, "in/a.png", "out/a.pdf")
    first.create_interaction(
        "00000000-0000-4000-8000-000000000001",
        "browser",
        "open-webui",
        "http://localhost:3000/",
        {"version": 1, "root": {"version": 1, "nodes": []}, "definitions": {}},
        "go",
        "hash",
        2,
        [],
    )
    first.update_interaction("00000000-0000-4000-8000-000000000001", "awaiting-import")
    first.close()

    second = Database(path)
    try:
        assert second.scalar("PRAGMA foreign_keys") == 1
        assert str(second.scalar("PRAGMA journal_mode")).lower() == "wal"
        assert second.get_ocr_job(job_id)["status"] == "interrupted"
        assert (
            second.scalar(
                "SELECT status FROM ocr_job_files WHERE id = ?", (job_file_id,)
            )
            == "interrupted"
        )
        assert (
            second.get_interaction("00000000-0000-4000-8000-000000000001")["status"]
            == "expired"
        )
    finally:
        second.close()


def test_overwrite_confirmations_survive_restart_and_load_all_conflicts(
    tmp_path: Path,
) -> None:
    path = tmp_path / "app.sqlite3"
    first = Database(path)
    confirmed_id = first.create_ocr_job("in-confirmed", "out-confirmed", False, "error")
    first.create_ocr_job_file(
        confirmed_id, "in-confirmed/a.png", "out-confirmed/a.pdf", "awaiting-overwrite"
    )
    first.update_ocr_job(confirmed_id, "awaiting-overwrite", finished=True)
    first.set_overwrite_confirmation_status(confirmed_id, "overwrite-confirmed")

    declined_id = first.create_ocr_job("in-declined", "out-declined", False, "error")
    first.create_ocr_job_file(
        declined_id, "in-declined/a.png", "out-declined/a.pdf", "awaiting-overwrite"
    )
    first.update_ocr_job(declined_id, "awaiting-overwrite", finished=True)
    first.set_overwrite_confirmation_status(declined_id, "overwrite-declined")

    pending_id = first.create_ocr_job("in-pending", "out-pending", True, "error")
    for name in ("a", "b"):
        first.create_ocr_job_file(
            pending_id,
            f"in-pending/{name}.png",
            f"out-pending/{name}.pdf",
            "awaiting-overwrite",
        )
    first.update_ocr_job(pending_id, "awaiting-overwrite", total_files=2, finished=True)
    assert first.claim_pending_overwrite_job(pending_id) is not None
    assert first.get_ocr_job(pending_id)["status"] == "overwrite-claimed"
    first.close()

    second = Database(path)
    try:
        assert second.get_ocr_job(confirmed_id)["status"] == "overwrite-confirmed"
        assert second.get_ocr_job(declined_id)["status"] == "overwrite-declined"
        assert second.get_ocr_job(pending_id)["status"] == "awaiting-overwrite"
        pending = second.get_pending_overwrite_job()
        assert pending is not None
        assert pending["id"] == pending_id
        assert pending["recursive"] == 1
        assert [item["outputPath"] for item in pending["conflicts"]] == [
            database_module.canonical_path("out-pending/a.pdf"),
            database_module.canonical_path("out-pending/b.pdf"),
        ]
        assert (
            second.scalar(
                "SELECT COUNT(*) FROM ocr_job_files WHERE status = 'awaiting-overwrite'"
            )
            == 2
        )
    finally:
        second.close()


def test_declining_pending_overwrites_preserves_excepted_job(
    database: Database,
) -> None:
    declined_id = database.create_ocr_job("in-one", "out-one", False, "error")
    kept_id = database.create_ocr_job("in-two", "out-two", False, "error")
    for job_id, name in ((declined_id, "one"), (kept_id, "two")):
        database.create_ocr_job_file(
            job_id, f"in-{name}/a.png", f"out-{name}/a.pdf", "awaiting-overwrite"
        )
        database.update_ocr_job(job_id, "awaiting-overwrite", finished=True)

    assert database.decline_pending_overwrite_jobs(except_job_id=kept_id) == 1
    assert database.get_ocr_job(declined_id)["status"] == "overwrite-declined"
    assert database.get_ocr_job(kept_id)["status"] == "awaiting-overwrite"
    assert (
        database.scalar(
            "SELECT status FROM ocr_job_files WHERE job_id = ?", (declined_id,)
        )
        == "overwrite-declined"
    )


def test_prompt_crud_round_trips_structured_json(database: Database) -> None:
    content = {
        "version": 1,
        "root": {"version": 1, "nodes": [{"type": "text", "text": "Hi"}]},
        "definitions": {},
    }
    created = database.save_prompt(None, "First", content)
    assert database.load_prompt(created["id"])["document"] == content
    updated = database.save_prompt(created["id"], "First", {**content, "version": 1})
    assert updated["id"] == created["id"]
    assert database.rename_prompt(created["id"], "Renamed")["name"] == "Renamed"
    assert [item["name"] for item in database.list_prompts()] == ["Renamed"]
    database.delete_prompt(created["id"])
    with pytest.raises(DatabaseError, match="not found"):
        database.load_prompt(created["id"])


def test_document_failure_preserves_previous_success(database: Database) -> None:
    document_id = database.record_document_success(
        "C:/in/a.png", "C:/out/a.pdf", "searchable", 1
    )
    database.record_document_failure(
        "C:/in/a.png",
        "extract_failed",
        "empty",
        2,
        output_path="C:/out/new-a.pdf",
    )

    row = database.list_documents()[0]
    assert row["id"] == document_id
    assert row["text"] == "searchable"
    assert row["resultAvailable"] is True
    assert row["latestStatus"] == "extract_failed"
    assert row["latestError"] == "empty"
    assert row["latestOutputPath"].endswith("new-a.pdf")
    assert [item["id"] for item in database.list_chat_documents()] == [document_id]


def test_first_failure_is_not_chat_eligible(database: Database) -> None:
    database.record_document_failure("C:/in/b.png", "ocr_failed", "bad", 1)
    assert database.list_chat_documents() == []


def test_messages_tags_warnings_and_history_are_ordered(database: Database) -> None:
    document_id = database.record_document_success("in", "out", "text", 1)
    interaction_id = "00000000-0000-4000-8000-000000000010"
    database.create_interaction(
        interaction_id,
        "browser",
        "open-webui",
        "http://localhost:3000/",
        {"version": 1, "root": {"version": 1, "nodes": []}, "definitions": {}},
        "go",
        "abc",
        2,
        [document_id],
    )
    database.add_message(interaction_id, "user", "go")
    assistant_id = database.add_message(interaction_id, "assistant", "<a>x</a>")
    database.replace_message_analysis(
        assistant_id,
        [
            {
                "name": "a",
                "raw": "x",
                "trimmed": "x",
                "start": 0,
                "end": 8,
                "parentIndex": None,
            }
        ],
        [{"code": "missing-required", "message": "missing b", "tagName": "b"}],
    )
    history = database.list_history()
    assert [message["role"] for message in history[0]["messages"]] == [
        "user",
        "assistant",
    ]
    assert history[0]["messages"][1]["tagValues"][0]["name"] == "a"
    assert history[0]["messages"][1]["warnings"][0]["code"] == "missing-required"


def test_all_calls_are_serialized_through_owner_thread(database: Database) -> None:
    def write(index: int) -> int:
        return database.record_document_success(
            f"C:/in/{index}.png", f"C:/out/{index}.pdf", str(index), index
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        ids = list(pool.map(write, range(40)))

    assert len(set(ids)) == 40
    assert len(database.list_documents()) == 40


def test_database_connection_is_not_exposed(database: Database) -> None:
    assert not any(
        isinstance(value, sqlite3.Connection) for value in vars(database).values()
    )


def test_ocr_job_started_at_is_not_replaced_by_progress_updates(
    database: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = ["created"]
    monkeypatch.setattr(database_module, "timestamp", lambda: clock[0])
    job_id = database.create_ocr_job("in", "out", False, "error")
    clock[0] = "started"
    database.update_ocr_job(job_id, "running")
    clock[0] = "later-progress"
    database.update_ocr_job(job_id, "running", completed_files=1)
    assert database.get_ocr_job(job_id)["started_at"] == "started"


def test_assistant_completion_is_atomic_and_idempotent(database: Database) -> None:
    interaction_id = "00000000-0000-4000-8000-000000000055"
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
    database.update_interaction(interaction_id, "importing")
    values = [
        {
            "name": "answer",
            "raw": "yes",
            "trimmed": "yes",
            "start": 0,
            "end": 20,
            "parentIndex": None,
        }
    ]
    warnings = [{"code": "empty-occurrence", "message": "test", "tagName": "answer"}]

    accepted = database.complete_interaction_with_assistant(
        interaction_id, "<answer>yes</answer>", values, warnings
    )
    duplicate = database.complete_interaction_with_assistant(
        interaction_id, "different", [], []
    )

    assert accepted["status"] == "accepted"
    assert duplicate == {
        "status": "duplicate",
        "messageId": accepted["messageId"],
    }
    history = database.list_history()[0]
    assert history["status"] == "completed"
    assert len(history["messages"]) == 1
    assert history["messages"][0]["tagValues"][0]["name"] == "answer"
