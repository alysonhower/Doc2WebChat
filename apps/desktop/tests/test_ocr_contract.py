import subprocess
import sys
from pathlib import Path
from typing import Any, cast

import pytest

from doc2webchat.database import Database, DatabaseError
from doc2webchat.ocr import OcrManager
from doc2webchat.ocr_contract import OcrEventStage, OcrJobStatus


def test_generated_typescript_contract_matches_python_enums() -> None:
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "scripts/generate_ocr_contract.py", "--check"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_ocr_emitter_rejects_untyped_stages(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.sqlite3")
    events: list[dict[str, Any]] = []
    manager = OcrManager(database, events.append)
    try:
        manager.job_event(7, OcrEventStage.PROGRESS, completed=1)
        assert events == [
            {
                "type": "ocr",
                "jobId": 7,
                "stage": "progress",
                "completed": 1,
            }
        ]
        with pytest.raises(TypeError, match="OcrEventStage"):
            manager.job_event(7, cast(Any, "future-stage"))
        with pytest.raises(TypeError, match="Finished OCR event status"):
            manager.job_event(7, OcrEventStage.JOB_FINISHED)
    finally:
        database.close()


def test_database_rejects_untyped_ocr_statuses(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.sqlite3")
    try:
        job_id = database.create_ocr_job("in", "out", False, "error")
        with pytest.raises(TypeError, match="OcrJobStatus"):
            database.update_ocr_job(job_id, cast(Any, "running"))
        database.update_ocr_job(job_id, OcrJobStatus.RUNNING)
        assert database.get_ocr_job(job_id)["status"] == "running"
    finally:
        database.close()


def test_invalid_persisted_ocr_values_fail_before_serialization(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "app.sqlite3")
    try:
        job_id = database.create_ocr_job("in", "out", False, "error")
        database.record_document_success("in/a.png", "out/a.pdf", "text", job_id)

        def corrupt(connection: Any) -> None:
            with connection:
                connection.execute(
                    "UPDATE ocr_jobs SET status = 'future-status' WHERE id = ?",
                    (job_id,),
                )
                connection.execute(
                    "UPDATE documents SET latest_status = 'future-status'"
                )

        database.call(corrupt)
        with pytest.raises(DatabaseError, match="Invalid persisted OCR job status"):
            database.get_ocr_job(job_id)
        with pytest.raises(
            DatabaseError, match="Invalid persisted OCR document status"
        ):
            database.list_documents()
    finally:
        database.close()
