from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path
from typing import Any, ClassVar

import pytest
from pypdf import PdfWriter
from turboocr.errors import TurboOcrError

import doc2webchat.ocr as ocr
from doc2webchat.database import Database
from doc2webchat.ocr import (
    ManagedContainer,
    OcrJobRequest,
    OcrManager,
    OutputPolicy,
    ProcessingStatus,
    ServerLifecycleError,
    ServerReadiness,
    build_output_plan,
    discover_sources,
    extract_pdf_text,
    process_task,
    to_extended_path,
    write_pdf_atomically,
)


def create_file(path: Path, content: bytes = b"image") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def valid_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=10, height=10)
    from io import BytesIO

    stream = BytesIO()
    writer.write(stream)
    return stream.getvalue()


def test_discovers_all_supported_suffixes_sorted_and_excludes_output_subtree(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input"
    output_path = input_path / "output"
    for name in [
        "z.WEBP",
        "a.bmp",
        "b.gif",
        "c.jpeg",
        "d.jpg",
        "e.png",
        "f.tif",
        "g.tiff",
        "h.pdf",
        "skip.txt",
    ]:
        create_file(input_path / name)
    create_file(input_path / "nested" / "i.png")
    create_file(output_path / "old.pdf")

    names = [
        path.relative_to(input_path.resolve()).as_posix()
        for path in discover_sources(input_path, output_path, recursive=True)
    ]
    assert names == [
        "a.bmp",
        "b.gif",
        "c.jpeg",
        "d.jpg",
        "e.png",
        "f.tif",
        "g.tiff",
        "h.pdf",
        "nested/i.png",
        "z.WEBP",
    ]
    assert all(
        not str(path).startswith("\\\\?\\") for path in discover_sources(input_path)
    )
    if sys.platform == "win32":
        assert str(to_extended_path(input_path)).startswith("\\\\?\\")


def test_rejects_source_symlinks_when_supported(tmp_path: Path) -> None:
    source = tmp_path / "source.png"
    link = tmp_path / "link.png"
    create_file(source)
    try:
        link.symlink_to(source)
    except OSError:
        pytest.skip("symlink creation unavailable")
    with pytest.raises(ValueError, match="symbolic link"):
        discover_sources(tmp_path)


def test_rejects_a_symlinked_input_ancestor_before_resolution(tmp_path: Path) -> None:
    real_input = tmp_path / "real" / "input"
    create_file(real_input / "page.png")
    linked_parent = tmp_path / "linked"
    try:
        linked_parent.symlink_to(tmp_path / "real", target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation unavailable")
    with pytest.raises(ValueError, match="symbolic link"):
        discover_sources(linked_parent / "input")


def test_plan_mirrors_recursive_paths_and_detects_collisions(tmp_path: Path) -> None:
    input_path = to_extended_path(tmp_path / "input")
    output_path = tmp_path / "output"
    first = input_path / "nested" / "a.png"
    create_file(first)
    plan = build_output_plan([first], input_path, output_path, True, OutputPolicy.ERROR)
    assert plan.tasks[0].output_path == output_path / "nested" / "a.pdf"

    second = input_path / "nested" / "a.jpg"
    create_file(second)
    with pytest.raises(ValueError, match="Multiple sources"):
        build_output_plan(
            [first, second], input_path, output_path, True, OutputPolicy.OVERWRITE
        )


def test_error_policy_reports_only_existing_outputs_as_overwrite_conflicts(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    source = input_path / "page.png"
    existing_output = output_path / "page.pdf"
    create_file(source)
    create_file(existing_output, valid_pdf())

    with pytest.raises(ocr.OutputConflictError) as raised:
        build_output_plan([source], input_path, output_path, False, OutputPolicy.ERROR)

    assert raised.value.conflicting_tasks == (
        ocr.ProcessingTask(source.resolve(), existing_output.resolve()),
    )
    assert raised.value.conflicting_outputs == (existing_output.resolve(),)
    assert str(raised.value) == (
        f"Output preflight failed:\n- Output already exists: {existing_output}"
    )


def test_new_output_between_confirmation_and_retry_requires_fresh_confirmation(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    first_source = input_path / "first.png"
    second_source = input_path / "second.png"
    first_output = output_path / "first.pdf"
    second_output = output_path / "second.pdf"
    create_file(first_source)
    create_file(second_source)
    create_file(first_output, valid_pdf())

    with pytest.raises(ocr.OutputConflictError) as initial:
        build_output_plan(
            [first_source, second_source],
            input_path,
            output_path,
            False,
            OutputPolicy.ERROR,
        )
    approved = frozenset(
        ocr.output_approval_key(task.output_path)
        for task in initial.value.conflicting_tasks
    )

    create_file(second_output, valid_pdf())
    with pytest.raises(ocr.OutputConflictError) as fresh:
        build_output_plan(
            [first_source, second_source],
            input_path,
            output_path,
            False,
            OutputPolicy.ERROR,
            approved,
        )

    assert fresh.value.conflicting_outputs == (
        first_output.resolve(),
        second_output.resolve(),
    )


def test_existing_output_mixed_with_other_preflight_errors_remains_fatal(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    first_collision = input_path / "same.png"
    second_collision = input_path / "same.jpg"
    existing_source = input_path / "existing.png"
    existing_output = output_path / "existing.pdf"
    for source in (first_collision, second_collision, existing_source):
        create_file(source)
    create_file(existing_output, valid_pdf())

    with pytest.raises(ValueError) as raised:
        build_output_plan(
            [first_collision, second_collision, existing_source],
            input_path,
            output_path,
            False,
            OutputPolicy.ERROR,
        )

    assert not isinstance(raised.value, ocr.OutputConflictError)
    assert "Multiple sources map to" in str(raised.value)
    assert f"Output already exists: {existing_output}" in str(raised.value)


def test_plan_refuses_input_pdf_overwrite_and_symlink_destination(
    tmp_path: Path,
) -> None:
    source = tmp_path / "same.pdf"
    create_file(source, valid_pdf())
    with pytest.raises(ValueError, match="Refusing to overwrite input"):
        build_output_plan(
            [to_extended_path(source)],
            to_extended_path(tmp_path),
            tmp_path,
            False,
            OutputPolicy.OVERWRITE,
        )


def test_atomic_publication_validates_and_applies_policies(tmp_path: Path) -> None:
    output = tmp_path / "out.pdf"
    assert (
        write_pdf_atomically(valid_pdf(), output, OutputPolicy.ERROR)
        is ProcessingStatus.WRITTEN
    )
    original = output.read_bytes()
    assert (
        write_pdf_atomically(valid_pdf(), output, OutputPolicy.SKIP)
        is ProcessingStatus.SKIPPED
    )
    assert output.read_bytes() == original
    with pytest.raises(ValueError, match="Invalid PDF"):
        write_pdf_atomically(b"not pdf", output, OutputPolicy.OVERWRITE)
    assert output.read_bytes() == original
    assert not list(tmp_path.glob(".ocr-*.tmp"))


@pytest.mark.asyncio
async def test_process_calls_pdfa4_once_then_extracts_published_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[Path, str]] = []

    class Client:
        async def make_searchable_pdf(self, source: Path, *, profile: str) -> bytes:
            calls.append((source, profile))
            return valid_pdf()

    task = build_output_plan(
        [to_extended_path(tmp_path / "input.png")],
        to_extended_path(tmp_path),
        tmp_path / "output",
        False,
        OutputPolicy.ERROR,
    ).tasks[0]
    create_file(tmp_path / "input.png")
    monkeypatch.setattr("doc2webchat.ocr.extract_pdf_text", lambda path: "page text")
    stages: list[str] = []
    result = await process_task(
        Client(), task, OutputPolicy.ERROR, lambda stage: stages.append(stage)
    )

    assert calls == [(to_extended_path(tmp_path / "input.png"), "pdfa-4")]
    assert result.text == "page text"
    assert stages == ["ocr-processing", "writing", "extracting"]


def test_extraction_joins_pages_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls = 0

    class Page:
        def __init__(self, value: str | None) -> None:
            self.value = value

        def extract_text(self) -> str | None:
            nonlocal calls
            calls += 1
            return self.value

    class Reader:
        pages: ClassVar[list[Page]] = [
            Page("one\nSão Paulo"),
            Page(None),
            Page("three\n東京 résumé"),
        ]

        def __init__(self, path: Path) -> None:
            del path

    monkeypatch.setattr("doc2webchat.ocr.PdfReader", Reader)
    assert (
        extract_pdf_text(tmp_path / "a.pdf") == "one\nSão Paulo\n\nthree\n東京 résumé"
    )
    assert calls == 3


@pytest.mark.asyncio
async def test_manager_bounds_requests_isolates_files_and_emits_monotonic_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    for index in range(5):
        create_file(input_path / f"{index}.png")
    active = 0
    maximum_active = 0
    profiles: list[str] = []

    class Client:
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *args: Any) -> None:
            del args

        async def make_searchable_pdf(self, source: Path, *, profile: str) -> bytes:
            nonlocal active, maximum_active
            profiles.append(profile)
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0.01)
            active -= 1
            if source.name == "3.png":
                raise TurboOcrError("isolated failure", code="TEST_FAILURE")
            return valid_pdf()

    database = Database(tmp_path / "app.sqlite3")
    events: list[dict[str, Any]] = []
    manager = OcrManager(
        database,
        events.append,
        client_factory=lambda **kwargs: Client(),
        ensure_ready=lambda base_url, timeout: None,
        max_inflight=2,
    )
    monkeypatch.setattr("doc2webchat.ocr.extract_pdf_text", lambda path: path.stem)
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "error")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR),
        )
        assert maximum_active == 2
        assert profiles == ["pdfa-4"] * 5
        assert len(database.list_chat_documents()) == 4
        assert database.get_ocr_job(job_id)["status"] == "completed-with-errors"
        failed_document = next(
            document
            for document in database.list_documents()
            if document["inputPath"].endswith("3.png")
        )
        assert failed_document["latestStatus"] == "ocr-failed"
        summary_counts = [
            event["completed"]
            for event in events
            if event["stage"] == "progress" and "completed" in event
        ]
        assert summary_counts == sorted(summary_counts)
        assert summary_counts[-1] == 5
        for document in database.list_documents():
            assert not document["inputPath"].startswith("\\\\?\\")
            if document["outputPath"] is not None:
                assert not document["outputPath"].startswith("\\\\?\\")
        assert not str(
            database.scalar("SELECT source_path FROM ocr_job_files ORDER BY id LIMIT 1")
        ).startswith("\\\\?\\")
    finally:
        database.close()


def test_managed_container_command_publishes_loopback_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from doc2webchat.ocr import create_managed_container

    commands: list[list[str]] = []

    def run(arguments: list[str], **kwargs: Any):
        import subprocess

        del kwargs
        commands.append(arguments)
        return subprocess.CompletedProcess(arguments, 0, "container", "")

    monkeypatch.setattr("doc2webchat.ocr.subprocess.run", run)
    create_managed_container(10)
    command = commands[-1]
    assert "127.0.0.1:8000:8000" in command
    assert "127.0.0.1:50051:50051" in command
    assert "8000:8000" not in command
    assert command[command.index("--pull") + 1] == "never"
    assert "PIPELINE_POOL_SIZE=1" in command
    assert "doc2webchat.managed.config=cpu-single-pipeline-v1" in command


def test_managed_container_retries_transient_image_pull(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    from doc2webchat.ocr import SERVER_CONTAINER_IMAGE, create_managed_container

    commands: list[list[str]] = []
    results = iter(
        [
            subprocess.CompletedProcess(
                [], 1, "[]", f"No such image: {SERVER_CONTAINER_IMAGE}"
            ),
            subprocess.CompletedProcess(
                [],
                1,
                "",
                "failed to do request: Get https://example.invalid/layer: EOF",
            ),
            subprocess.CompletedProcess([], 0, "pulled", ""),
            subprocess.CompletedProcess([], 0, "container", ""),
        ]
    )
    command_timeouts: list[float] = []

    def run(arguments: list[str], **kwargs: Any):
        commands.append(arguments)
        command_timeouts.append(kwargs["timeout"])
        return next(results)

    sleeps: list[float] = []
    monkeypatch.setattr("doc2webchat.ocr.subprocess.run", run)
    monkeypatch.setattr("doc2webchat.ocr.time.monotonic", lambda: 100.0)
    monkeypatch.setattr("doc2webchat.ocr.time.sleep", sleeps.append)

    create_managed_container(10)

    assert commands[:3] == [
        ["docker", "image", "inspect", SERVER_CONTAINER_IMAGE],
        ["docker", "pull", SERVER_CONTAINER_IMAGE],
        ["docker", "pull", SERVER_CONTAINER_IMAGE],
    ]
    assert commands[3][:2] == ["docker", "run"]
    assert command_timeouts == [1800.0, 1800.0, 1800.0, 10.0]
    assert sleeps == [1.0]


def test_managed_container_does_not_retry_permanent_pull_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    from doc2webchat.ocr import SERVER_CONTAINER_IMAGE, create_managed_container

    commands: list[list[str]] = []
    results = iter(
        [
            subprocess.CompletedProcess(
                [], 1, "[]", f"No such image: {SERVER_CONTAINER_IMAGE}"
            ),
            subprocess.CompletedProcess([], 1, "", "denied: permission denied"),
        ]
    )

    def run(arguments: list[str], **kwargs: Any):
        del kwargs
        commands.append(arguments)
        return next(results)

    monkeypatch.setattr("doc2webchat.ocr.subprocess.run", run)

    with pytest.raises(ServerLifecycleError, match="permission denied"):
        create_managed_container(10)

    assert commands == [
        ["docker", "image", "inspect", SERVER_CONTAINER_IMAGE],
        ["docker", "pull", SERVER_CONTAINER_IMAGE],
    ]


@pytest.mark.asyncio
async def test_server_failure_marks_every_planned_file_failed(tmp_path: Path) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    create_file(input_path / "a.png")
    create_file(input_path / "b.png")

    def fail_server(base_url: str, timeout: int) -> None:
        del base_url, timeout
        raise ServerLifecycleError("server unavailable")

    database = Database(tmp_path / "app.sqlite3")
    manager = OcrManager(database, lambda event: None, ensure_ready=fail_server)
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "error")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR),
        )
        assert database.get_ocr_job(job_id)["status"] == "failed"
        assert (
            database.scalar(
                "SELECT COUNT(*) FROM ocr_job_files WHERE status = 'failed'"
            )
            == 2
        )
        assert len(database.list_documents()) == 2
        assert database.list_chat_documents() == []
    finally:
        database.close()


@pytest.mark.asyncio
async def test_existing_outputs_await_bounded_overwrite_confirmation(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    conflict_total = ocr.MAX_OVERWRITE_CONFLICT_PATHS + 3
    expected_outputs: list[str] = []
    for index in range(conflict_total):
        name = f"page-{index:02d}"
        create_file(input_path / f"{name}.png")
        output = output_path / f"{name}.pdf"
        create_file(output, valid_pdf())
        expected_outputs.append(str(output))

    events: list[dict[str, Any]] = []
    database = Database(tmp_path / "app.sqlite3")
    manager = OcrManager(
        database,
        events.append,
        ensure_ready=lambda base_url, timeout: pytest.fail(
            f"server should not start while awaiting overwrite: {base_url} {timeout}"
        ),
    )
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "error")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR),
        )

        job = database.get_ocr_job(job_id)
        assert job["status"] == "awaiting-overwrite"
        assert job["total_files"] == conflict_total
        assert job["completed_at"] is not None
        assert job["completed_files"] == 0
        assert job["failed_files"] == 0
        assert (
            database.scalar(
                "SELECT COUNT(*) FROM ocr_job_files "
                "WHERE stage = 'awaiting-overwrite' "
                "AND status = 'awaiting-overwrite'"
            )
            == conflict_total
        )
        assert database.list_documents() == []
        assert [event["stage"] for event in events] == [
            "discovery",
            "plan-validation",
            "overwrite-confirmation-required",
        ]
        assert events[-1] == {
            "type": "ocr",
            "jobId": job_id,
            "stage": "overwrite-confirmation-required",
            "overwriteConfirmationJobId": job_id,
            "inputPath": str(input_path),
            "outputPath": str(output_path),
            "recursive": False,
            "conflictCount": conflict_total,
            "conflictingOutputs": expected_outputs[: ocr.MAX_OVERWRITE_CONFLICT_PATHS],
        }
    finally:
        database.close()


@pytest.mark.asyncio
async def test_mixed_preflight_failure_does_not_request_overwrite(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    create_file(input_path / "same.png")
    create_file(input_path / "same.jpg")
    create_file(input_path / "existing.png")
    create_file(output_path / "existing.pdf", valid_pdf())

    events: list[dict[str, Any]] = []
    database = Database(tmp_path / "app.sqlite3")
    manager = OcrManager(
        database,
        events.append,
        ensure_ready=lambda base_url, timeout: pytest.fail(
            f"server should not start after failed preflight: {base_url} {timeout}"
        ),
    )
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "error")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR),
        )

        assert database.get_ocr_job(job_id)["status"] == "failed"
        assert database.scalar("SELECT COUNT(*) FROM ocr_job_files") == 0
        assert events[-1]["stage"] == "job-failed"
        assert "Multiple sources map to" in events[-1]["error"]
        assert all(
            event["stage"] != "overwrite-confirmation-required" for event in events
        )
    finally:
        database.close()


def test_confirmation_callback_can_start_retry_after_active_job_release(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    source = input_path / "page.png"
    output = output_path / "page.pdf"
    create_file(source)
    create_file(output, valid_pdf())

    class Client:
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *args: Any) -> None:
            del args

        async def make_searchable_pdf(self, source: Path, *, profile: str) -> bytes:
            del source, profile
            return valid_pdf()

    monkeypatch.setattr(ocr, "extract_pdf_text", lambda path: "searchable")
    events: list[dict[str, Any]] = []
    retry_job_ids: list[int] = []
    completed = threading.Event()
    database = Database(tmp_path / "app.sqlite3")

    def emit(event: dict[str, Any]) -> None:
        events.append(event)
        if event["stage"] == "overwrite-confirmation-required":
            retry_job_ids.append(
                manager.start_job(
                    OcrJobRequest(
                        input_path,
                        output_path,
                        False,
                        OutputPolicy.ERROR,
                        frozenset({ocr.output_approval_key(output)}),
                    )
                )
            )
        elif event["stage"] == "job-finished":
            completed.set()

    manager = OcrManager(
        database,
        emit,
        client_factory=lambda **kwargs: Client(),
        ensure_ready=lambda base_url, timeout: None,
    )
    try:
        initial_job_id = manager.start_job(
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR)
        )
        assert completed.wait(5), events
        assert len(retry_job_ids) == 1
        assert database.get_ocr_job(initial_job_id)["status"] == "awaiting-overwrite"
        assert database.get_ocr_job(retry_job_ids[0])["status"] == "completed"
        active_thread = manager.active_thread
        if active_thread is not None:
            active_thread.join(timeout=5)
        assert manager.active_job_id is None
    finally:
        manager.close()
        database.close()


@pytest.mark.asyncio
async def test_empty_extraction_keeps_pdf_visible_but_excludes_chat(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    create_file(input_path / "page.png")

    class Client:
        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *args: Any) -> None:
            del args

        async def make_searchable_pdf(self, source: Path, *, profile: str) -> bytes:
            del source, profile
            return valid_pdf()

    database = Database(tmp_path / "app.sqlite3")
    manager = OcrManager(
        database,
        lambda event: None,
        client_factory=lambda **kwargs: Client(),
        ensure_ready=lambda base_url, timeout: None,
    )
    monkeypatch.setattr(ocr, "extract_pdf_text", lambda path: "")
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "error")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR),
        )
        produced = output_path / "page.pdf"
        assert produced.is_file()
        document = database.list_documents()[0]
        assert document["resultAvailable"] is False
        assert document["latestStatus"] == "extract-failed"
        assert document["latestOutputPath"] == os.path.normcase(str(produced.resolve()))
        assert database.list_chat_documents() == []
    finally:
        database.close()


@pytest.mark.asyncio
async def test_preflight_skip_counts_survive_later_server_failure(
    tmp_path: Path,
) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    create_file(input_path / "existing.png")
    create_file(input_path / "pending.png")
    create_file(output_path / "existing.pdf", valid_pdf())

    def fail_server(base_url: str, timeout: int) -> None:
        del base_url, timeout
        raise ServerLifecycleError("server unavailable")

    database = Database(tmp_path / "app.sqlite3")
    manager = OcrManager(database, lambda event: None, ensure_ready=fail_server)
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "skip")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.SKIP),
        )
        job = database.get_ocr_job(job_id)
        assert job["status"] == "failed"
        assert job["completed_files"] == 1
        assert job["skipped_files"] == 1
        assert (
            database.scalar(
                "SELECT COUNT(*) FROM ocr_job_files WHERE status = 'skipped'"
            )
            == 1
        )
        assert (
            database.scalar(
                "SELECT COUNT(*) FROM ocr_job_files WHERE status = 'failed'"
            )
            == 1
        )
    finally:
        database.close()


@pytest.mark.asyncio
async def test_client_context_failure_terminally_fails_batch(tmp_path: Path) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    create_file(input_path / "page.png")

    class Client:
        async def __aenter__(self) -> Client:
            raise TurboOcrError("client enter failed", code="ENTER_FAILED")

        async def __aexit__(self, *args: Any) -> None:
            del args

    database = Database(tmp_path / "app.sqlite3")
    manager = OcrManager(
        database,
        lambda event: None,
        client_factory=lambda **kwargs: Client(),
        ensure_ready=lambda base_url, timeout: None,
    )
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "error")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR),
        )
        assert database.get_ocr_job(job_id)["status"] == "failed"
        assert (
            database.scalar(
                "SELECT status FROM ocr_job_files WHERE job_id = ?", (job_id,)
            )
            == "failed"
        )
    finally:
        database.close()


def test_initial_unmanaged_502_is_fatal_without_docker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        ocr,
        "probe_server_readiness",
        lambda base_url, timeout: ServerReadiness.GATEWAY_UNAVAILABLE,
    )
    monkeypatch.setattr(
        ocr,
        "ensure_docker",
        lambda timeout: (_ for _ in ()).throw(AssertionError("Docker must not run")),
    )
    with pytest.raises(ServerLifecycleError, match="502"):
        ocr.ensure_server_ready(ocr.DEFAULT_BASE_URL, 10)


def test_managed_container_early_exit_includes_log_tail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    containers = iter(
        [
            ManagedContainer(True, "running", 0),
            ManagedContainer(False, "exited", 17),
        ]
    )
    monkeypatch.setattr(
        ocr,
        "probe_server_readiness",
        lambda base_url, timeout: ServerReadiness.UNAVAILABLE,
    )
    monkeypatch.setattr(ocr, "ensure_docker", lambda timeout: None)
    monkeypatch.setattr(
        ocr, "inspect_managed_container", lambda timeout: next(containers)
    )
    monkeypatch.setattr(ocr, "container_log_tail", lambda timeout=5: "fatal engine log")

    with pytest.raises(ServerLifecycleError, match="fatal engine log"):
        ocr.ensure_server_ready(ocr.DEFAULT_BASE_URL, 10)


def test_new_container_gets_full_readiness_window_after_image_download(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"value": 0.0}
    readiness = iter([ServerReadiness.UNAVAILABLE, ServerReadiness.READY])
    containers = iter([None, ManagedContainer(True, "running", 0)])
    create_timeouts: list[float] = []

    monkeypatch.setattr(ocr.time, "monotonic", lambda: clock["value"])
    monkeypatch.setattr(
        ocr.time,
        "sleep",
        lambda seconds: clock.__setitem__("value", clock["value"] + seconds),
    )
    monkeypatch.setattr(
        ocr, "probe_server_readiness", lambda base_url, timeout: next(readiness)
    )
    monkeypatch.setattr(ocr, "ensure_docker", lambda timeout: None)
    monkeypatch.setattr(
        ocr, "inspect_managed_container", lambda timeout: next(containers)
    )

    def create(timeout: float) -> None:
        create_timeouts.append(timeout)
        clock["value"] += 600

    monkeypatch.setattr(ocr, "create_managed_container", create)

    ocr.ensure_server_ready(ocr.DEFAULT_BASE_URL, 10)

    assert create_timeouts == [10]
    assert clock["value"] == 601


def test_outdated_starting_managed_container_is_replaced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    clock = {"value": 0.0}
    readiness = iter([ServerReadiness.STARTING, ServerReadiness.READY])
    containers = iter(
        [
            ManagedContainer(True, "running", 0, configuration_matches=False),
            ManagedContainer(True, "running", 0),
        ]
    )
    commands: list[list[str]] = []
    create_timeouts: list[float] = []

    monkeypatch.setattr(ocr.time, "monotonic", lambda: clock["value"])
    monkeypatch.setattr(
        ocr.time,
        "sleep",
        lambda seconds: clock.__setitem__("value", clock["value"] + seconds),
    )
    monkeypatch.setattr(
        ocr, "probe_server_readiness", lambda base_url, timeout: next(readiness)
    )
    monkeypatch.setattr(
        ocr, "inspect_managed_container", lambda timeout: next(containers)
    )
    monkeypatch.setattr(
        ocr,
        "run_command",
        lambda arguments, timeout: (
            commands.append(arguments)
            or subprocess.CompletedProcess(arguments, 0, "", "")
        ),
    )
    monkeypatch.setattr(
        ocr, "create_managed_container", lambda timeout: create_timeouts.append(timeout)
    )

    ocr.ensure_server_ready(ocr.DEFAULT_BASE_URL, 10)

    assert commands == [["docker", "rm", "--force", ocr.SERVER_CONTAINER_NAME]]
    assert create_timeouts == [10]
    assert clock["value"] == 1


def test_atomic_skip_handles_publish_race(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    output = tmp_path / "race.pdf"

    def race(temporary_path: Path, output_path: Path) -> None:
        del temporary_path
        output_path.write_bytes(valid_pdf())
        raise FileExistsError("raced")

    monkeypatch.setattr(ocr, "publish_without_overwrite", race)
    assert (
        write_pdf_atomically(valid_pdf(), output, OutputPolicy.SKIP)
        is ProcessingStatus.SKIPPED
    )
    assert not list(tmp_path.glob(".ocr-*.tmp"))


def test_extended_path_prefix_handles_unc_and_local_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ocr.sys, "platform", "win32")
    assert str(ocr.add_extended_path_prefix(Path("C:/folder/file"))).startswith(
        "\\\\?\\"
    )
    assert str(ocr.add_extended_path_prefix(Path("//server/share/file"))).startswith(
        "\\\\?\\UNC\\"
    )


@pytest.mark.asyncio
async def test_process_rechecks_published_output_before_extraction(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "source.png"
    output = tmp_path / "output.pdf"
    create_file(source)

    class Client:
        async def make_searchable_pdf(self, source: Path, *, profile: str) -> bytes:
            del source, profile
            return valid_pdf()

    monkeypatch.setattr(
        ocr,
        "write_pdf_atomically",
        lambda content, path, policy: ProcessingStatus.WRITTEN,
    )
    monkeypatch.setattr(
        ocr, "classify_destination", lambda path: ocr.DestinationKind.SYMBOLIC_LINK
    )
    extracted = False

    def extract(path: Path) -> str:
        nonlocal extracted
        del path
        extracted = True
        return "text"

    monkeypatch.setattr(ocr, "extract_pdf_text", extract)
    with pytest.raises(OSError, match="not a regular file"):
        await process_task(
            Client(),
            ocr.ProcessingTask(source, output),
            OutputPolicy.ERROR,
            lambda stage: None,
        )
    assert extracted is False


@pytest.mark.asyncio
async def test_empty_plan_emits_terminal_job_event(tmp_path: Path) -> None:
    input_path = tmp_path / "input"
    output_path = tmp_path / "output"
    input_path.mkdir()
    events: list[dict[str, Any]] = []

    database = Database(tmp_path / "app.sqlite3")
    manager = OcrManager(
        database,
        events.append,
        ensure_ready=lambda base_url, timeout: pytest.fail(
            f"server should not start for an empty plan: {base_url} {timeout}"
        ),
    )
    job_id = database.create_ocr_job(str(input_path), str(output_path), False, "error")
    try:
        await manager.run_job(
            job_id,
            OcrJobRequest(input_path, output_path, False, OutputPolicy.ERROR),
        )
        assert events[-1] == {
            "type": "ocr",
            "jobId": job_id,
            "stage": "job-finished",
            "status": "completed",
            "completed": 0,
            "failed": 0,
            "skipped": 0,
            "total": 0,
        }
    finally:
        database.close()
