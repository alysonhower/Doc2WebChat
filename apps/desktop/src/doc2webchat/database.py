from __future__ import annotations

import hashlib
import json
import os
import queue
import sqlite3
import threading
import uuid
from collections.abc import Callable, Sequence
from concurrent.futures import Future
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar, cast

Result = TypeVar("Result")
DatabaseOperation = Callable[[sqlite3.Connection], Any]

MIGRATIONS = (
    """
    CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        canonical_input_path TEXT NOT NULL UNIQUE,
        successful_output_path TEXT,
        successful_text TEXT,
        result_available INTEGER NOT NULL DEFAULT 0 CHECK (result_available IN (0, 1)),
        latest_job_id INTEGER,
        latest_status TEXT NOT NULL,
        latest_error TEXT,
        latest_warning TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE ocr_jobs (
        id INTEGER PRIMARY KEY,
        input_root TEXT NOT NULL,
        output_root TEXT NOT NULL,
        recursive INTEGER NOT NULL CHECK (recursive IN (0, 1)),
        conflict_policy TEXT NOT NULL CHECK (conflict_policy IN ('error', 'skip', 'overwrite')),
        status TEXT NOT NULL,
        total_files INTEGER,
        completed_files INTEGER NOT NULL DEFAULT 0,
        failed_files INTEGER NOT NULL DEFAULT 0,
        skipped_files INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
    );

    CREATE TABLE ocr_job_files (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES ocr_jobs(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        output_path TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        warning TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, source_path)
    );

    CREATE TABLE prompts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        schema_version INTEGER NOT NULL,
        structured_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE chat_interactions (
        interaction_id TEXT PRIMARY KEY,
        browser_instance_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_url TEXT NOT NULL,
        status TEXT NOT NULL,
        structured_instructions_json TEXT NOT NULL,
        rendered_instructions TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        prompt_bytes INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
    );

    CREATE TABLE interaction_documents (
        interaction_id TEXT NOT NULL REFERENCES chat_interactions(interaction_id) ON DELETE CASCADE,
        document_id INTEGER NOT NULL REFERENCES documents(id),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY(interaction_id, document_id),
        UNIQUE(interaction_id, ordinal)
    );

    CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        interaction_id TEXT NOT NULL REFERENCES chat_interactions(interaction_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(interaction_id, ordinal)
    );

    CREATE TABLE message_tag_values (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        name TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        trimmed_value TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        parent_value_id INTEGER REFERENCES message_tag_values(id) ON DELETE SET NULL,
        UNIQUE(message_id, ordinal)
    );

    CREATE TABLE message_warnings (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        tag_name TEXT,
        parent_value_id INTEGER REFERENCES message_tag_values(id) ON DELETE SET NULL,
        UNIQUE(message_id, ordinal)
    );

    CREATE TABLE app_preferences (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE INDEX messages_interaction_order ON messages(interaction_id, ordinal);
    CREATE INDEX tag_values_message_order ON message_tag_values(message_id, ordinal);
    CREATE INDEX warnings_message_order ON message_warnings(message_id, ordinal);
    """,
    """
    ALTER TABLE documents ADD COLUMN latest_output_path TEXT;
    """,
    """
    ALTER TABLE interaction_documents RENAME TO interaction_documents_legacy;
    ALTER TABLE documents RENAME TO documents_legacy;

    CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_input_path TEXT NOT NULL UNIQUE,
        successful_output_path TEXT,
        successful_text TEXT,
        result_available INTEGER NOT NULL DEFAULT 0 CHECK (result_available IN (0, 1)),
        latest_job_id INTEGER,
        latest_status TEXT NOT NULL,
        latest_error TEXT,
        latest_warning TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        latest_output_path TEXT
    );

    INSERT INTO documents(
        id, canonical_input_path, successful_output_path, successful_text,
        result_available, latest_job_id, latest_status, latest_error,
        latest_warning, created_at, updated_at, latest_output_path
    )
    SELECT
        id, canonical_input_path, successful_output_path, successful_text,
        result_available, latest_job_id, latest_status, latest_error,
        latest_warning, created_at, updated_at, latest_output_path
    FROM documents_legacy;

    CREATE TABLE interaction_documents (
        interaction_id TEXT NOT NULL REFERENCES chat_interactions(interaction_id) ON DELETE CASCADE,
        document_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY(interaction_id, document_id),
        UNIQUE(interaction_id, ordinal)
    );

    INSERT INTO interaction_documents(interaction_id, document_id, ordinal)
    SELECT interaction_id, document_id, ordinal
    FROM interaction_documents_legacy;

    DROP TABLE interaction_documents_legacy;
    DROP TABLE documents_legacy;
    """,
)

BLOCKING_OCR_JOB_STATUSES = frozenset(
    {
        "pending",
        "discovering",
        "planning",
        "starting-server",
        "running",
        "awaiting-overwrite",
        "overwrite-claimed",
    }
)
DELETABLE_INTERACTION_STATUSES = frozenset({"completed", "failed", "expired"})
MAX_BULK_DELETE_ITEMS = 1000


class DatabaseError(RuntimeError):
    pass


class DocumentDeletionBlockedError(DatabaseError):
    pass


class DocumentNotFoundError(DatabaseError):
    pass


class InteractionDeletionBlockedError(DatabaseError):
    pass


class InteractionNotFoundError(DatabaseError):
    pass


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


def canonical_path(value: str | Path) -> str:
    text = str(value)
    unc_prefix = "\\\\?\\UNC\\"
    extended_prefix = "\\\\?\\"
    if text.startswith(unc_prefix):
        text = f"\\\\{text[len(unc_prefix) :]}"
    elif text.startswith(extended_prefix):
        text = text[len(extended_prefix) :]
    return os.path.normcase(str(Path(text).expanduser().absolute()))


def last_row_id(cursor: sqlite3.Cursor) -> int:
    value = cursor.lastrowid
    if value is None:
        raise DatabaseError("Database did not return a row ID")
    return value


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.calls: queue.Queue[tuple[DatabaseOperation | None, Future[Any] | None]] = (
            queue.Queue()
        )
        self.ready: Future[None] = Future()
        self.thread = threading.Thread(
            target=self.run_owner_thread,
            name="doc2webchat-database",
            daemon=True,
        )
        self.closed = False
        self.thread.start()
        self.ready.result(timeout=10)

    def run_owner_thread(self) -> None:
        connection: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=5.0)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA busy_timeout = 5000")
            self.apply_migrations(connection)
            self.recover_interrupted_state(connection)
            self.ready.set_result(None)
            while True:
                operation, future = self.calls.get()
                if operation is None:
                    break
                if future is None or future.cancelled():
                    continue
                try:
                    future.set_result(operation(connection))
                except BaseException as error:
                    future.set_exception(error)
        except BaseException as error:
            if not self.ready.done():
                self.ready.set_exception(error)
        finally:
            if connection is not None:
                connection.close()

    def apply_migrations(self, connection: sqlite3.Connection) -> None:
        current = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if current > len(MIGRATIONS):
            raise DatabaseError("Database was created by a newer application version")
        for index, migration in enumerate(MIGRATIONS[current:], start=current + 1):
            connection.execute("BEGIN IMMEDIATE")
            try:
                for statement in migration.split(";"):
                    if statement.strip():
                        connection.execute(statement)
                connection.execute(f"PRAGMA user_version = {index}")
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def recover_interrupted_state(self, connection: sqlite3.Connection) -> None:
        now = timestamp()
        with connection:
            connection.execute(
                """
                UPDATE ocr_jobs
                SET status = 'awaiting-overwrite'
                WHERE status = 'overwrite-claimed'
                """
            )
            connection.execute(
                """
                UPDATE ocr_job_files
                SET stage = 'awaiting-overwrite', status = 'awaiting-overwrite',
                    updated_at = ?
                WHERE status = 'overwrite-claimed'
                """,
                (now,),
            )
            connection.execute(
                """
                UPDATE ocr_jobs
                SET status = 'interrupted', completed_at = ?
                WHERE status NOT IN (
                    'completed', 'completed-with-errors', 'failed', 'interrupted',
                    'awaiting-overwrite', 'overwrite-confirmed', 'overwrite-declined'
                )
                """,
                (now,),
            )
            connection.execute(
                """
                UPDATE ocr_job_files
                SET stage = 'interrupted', status = 'interrupted',
                    error = 'Application stopped before this file completed',
                    updated_at = ?
                WHERE status NOT IN (
                    'completed', 'failed', 'skipped', 'interrupted',
                    'awaiting-overwrite', 'overwrite-confirmed', 'overwrite-declined'
                )
                """,
                (now,),
            )
            connection.execute(
                """
                UPDATE chat_interactions
                SET status = 'expired', updated_at = ?, completed_at = ?
                WHERE status NOT IN ('completed', 'failed', 'expired')
                """,
                (now, now),
            )

    def call(self, operation: Callable[[sqlite3.Connection], Result]) -> Result:
        if self.closed:
            raise DatabaseError("Database is closed")
        future: Future[Result] = Future()
        self.calls.put((operation, cast(Future[Any], future)))
        return future.result()

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.calls.put((None, None))
        self.thread.join(timeout=10)
        if self.thread.is_alive():
            raise DatabaseError("Database thread did not stop")

    def scalar(self, statement: str, parameters: Sequence[Any] = ()) -> Any:
        return self.call(
            lambda connection: connection.execute(statement, parameters).fetchone()[0]
        )

    def create_ocr_job(
        self, input_root: str, output_root: str, recursive: bool, policy: str
    ) -> int:
        def operation(connection: sqlite3.Connection) -> int:
            with connection:
                cursor = connection.execute(
                    """
                    INSERT INTO ocr_jobs(
                        input_root, output_root, recursive, conflict_policy, status, created_at
                    ) VALUES (?, ?, ?, ?, 'pending', ?)
                    """,
                    (
                        canonical_path(input_root),
                        canonical_path(output_root),
                        int(recursive),
                        policy,
                        timestamp(),
                    ),
                )
            return last_row_id(cursor)

        return self.call(operation)

    def get_ocr_job(self, job_id: int) -> dict[str, Any]:
        def operation(connection: sqlite3.Connection) -> dict[str, Any]:
            row = connection.execute(
                "SELECT * FROM ocr_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                raise DatabaseError(f"OCR job {job_id} not found")
            return dict(row)

        return self.call(operation)

    def get_pending_overwrite_job(
        self, job_id: int | None = None
    ) -> dict[str, Any] | None:
        def operation(connection: sqlite3.Connection) -> dict[str, Any] | None:
            parameters: tuple[int, ...] = () if job_id is None else (job_id,)
            id_filter = "" if job_id is None else "AND id = ?"
            row = connection.execute(
                f"""
                SELECT * FROM ocr_jobs
                WHERE status = 'awaiting-overwrite' {id_filter}
                ORDER BY id DESC
                LIMIT 1
                """,
                parameters,
            ).fetchone()
            if row is None:
                return None
            conflicts = connection.execute(
                """
                SELECT id, source_path, output_path
                FROM ocr_job_files
                WHERE job_id = ? AND status = 'awaiting-overwrite'
                ORDER BY id
                """,
                (int(row["id"]),),
            ).fetchall()
            return {
                **dict(row),
                "conflicts": [
                    {
                        "id": int(conflict["id"]),
                        "sourcePath": str(conflict["source_path"]),
                        "outputPath": str(conflict["output_path"]),
                    }
                    for conflict in conflicts
                ],
            }

        return self.call(operation)

    def claim_pending_overwrite_job(self, job_id: int) -> dict[str, Any] | None:
        def operation(connection: sqlite3.Connection) -> dict[str, Any] | None:
            with connection:
                row = connection.execute(
                    """
                    SELECT * FROM ocr_jobs
                    WHERE id = ? AND status = 'awaiting-overwrite'
                    """,
                    (job_id,),
                ).fetchone()
                if row is None:
                    return None
                conflicts = connection.execute(
                    """
                    SELECT id, source_path, output_path
                    FROM ocr_job_files
                    WHERE job_id = ? AND status = 'awaiting-overwrite'
                    ORDER BY id
                    """,
                    (job_id,),
                ).fetchall()
                if not conflicts:
                    return None
                now = timestamp()
                cursor = connection.execute(
                    """
                    UPDATE ocr_jobs SET status = 'overwrite-claimed'
                    WHERE id = ? AND status = 'awaiting-overwrite'
                    """,
                    (job_id,),
                )
                if cursor.rowcount != 1:
                    return None
                connection.execute(
                    """
                    UPDATE ocr_job_files
                    SET stage = 'overwrite-claimed', status = 'overwrite-claimed',
                        updated_at = ?
                    WHERE job_id = ? AND status = 'awaiting-overwrite'
                    """,
                    (now, job_id),
                )
                return {
                    **dict(row),
                    "conflicts": [
                        {
                            "id": int(conflict["id"]),
                            "sourcePath": str(conflict["source_path"]),
                            "outputPath": str(conflict["output_path"]),
                        }
                        for conflict in conflicts
                    ],
                }

        return self.call(operation)

    def release_overwrite_claim(self, job_id: int) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            now = timestamp()
            with connection:
                connection.execute(
                    """
                    UPDATE ocr_jobs SET status = 'awaiting-overwrite'
                    WHERE id = ? AND status = 'overwrite-claimed'
                    """,
                    (job_id,),
                )
                connection.execute(
                    """
                    UPDATE ocr_job_files
                    SET stage = 'awaiting-overwrite', status = 'awaiting-overwrite',
                        updated_at = ?
                    WHERE job_id = ? AND status = 'overwrite-claimed'
                    """,
                    (now, job_id),
                )

        self.call(operation)

    def set_overwrite_confirmation_status(self, job_id: int, status: str) -> None:
        if status not in {"overwrite-confirmed", "overwrite-declined"}:
            raise ValueError("Invalid overwrite confirmation status")

        def operation(connection: sqlite3.Connection) -> None:
            now = timestamp()
            with connection:
                cursor = connection.execute(
                    """
                    UPDATE ocr_jobs
                    SET status = ?, completed_at = COALESCE(completed_at, ?)
                    WHERE id = ? AND status IN ('awaiting-overwrite', 'overwrite-claimed')
                    """,
                    (status, now, job_id),
                )
                if cursor.rowcount != 1:
                    raise DatabaseError(
                        f"OCR overwrite confirmation {job_id} is not pending"
                    )
                connection.execute(
                    """
                    UPDATE ocr_job_files
                    SET stage = ?, status = ?, updated_at = ?
                    WHERE job_id = ?
                      AND status IN ('awaiting-overwrite', 'overwrite-claimed')
                    """,
                    (status, status, now, job_id),
                )

        self.call(operation)

    def decline_pending_overwrite_jobs(self, except_job_id: int | None = None) -> int:
        def operation(connection: sqlite3.Connection) -> int:
            now = timestamp()
            parameters: tuple[int, ...] = (
                () if except_job_id is None else (except_job_id,)
            )
            id_filter = "" if except_job_id is None else "AND id <> ?"
            pending_rows = connection.execute(
                f"""
                SELECT id FROM ocr_jobs
                WHERE status = 'awaiting-overwrite' {id_filter}
                """,
                parameters,
            ).fetchall()
            pending_ids = [int(row["id"]) for row in pending_rows]
            if not pending_ids:
                return 0
            placeholders = ", ".join("?" for _ in pending_ids)
            with connection:
                connection.execute(
                    f"""
                    UPDATE ocr_job_files
                    SET stage = 'overwrite-declined', status = 'overwrite-declined',
                        updated_at = ?
                    WHERE job_id IN ({placeholders})
                      AND status = 'awaiting-overwrite'
                    """,
                    (now, *pending_ids),
                )
                connection.execute(
                    f"""
                    UPDATE ocr_jobs
                    SET status = 'overwrite-declined',
                        completed_at = COALESCE(completed_at, ?)
                    WHERE id IN ({placeholders})
                      AND status = 'awaiting-overwrite'
                    """,
                    (now, *pending_ids),
                )
            return len(pending_ids)

        return self.call(operation)

    def update_ocr_job(
        self,
        job_id: int,
        status: str,
        *,
        total_files: int | None = None,
        completed_files: int | None = None,
        failed_files: int | None = None,
        skipped_files: int | None = None,
        finished: bool = False,
    ) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            values: dict[str, Any] = {"status": status}
            if total_files is not None:
                values["total_files"] = total_files
            if completed_files is not None:
                values["completed_files"] = completed_files
            if failed_files is not None:
                values["failed_files"] = failed_files
            if skipped_files is not None:
                values["skipped_files"] = skipped_files
            if finished:
                values["completed_at"] = timestamp()
            assignments = ", ".join(f"{key} = ?" for key in values)
            parameters = list(values.values())
            if status == "running":
                assignments += ", started_at = COALESCE(started_at, ?)"
                parameters.append(timestamp())
            with connection:
                connection.execute(
                    f"UPDATE ocr_jobs SET {assignments} WHERE id = ?",
                    (*parameters, job_id),
                )

        self.call(operation)

    def create_ocr_job_file(
        self, job_id: int, source_path: str, output_path: str, status: str = "queued"
    ) -> int:
        def operation(connection: sqlite3.Connection) -> int:
            now = timestamp()
            with connection:
                cursor = connection.execute(
                    """
                    INSERT INTO ocr_job_files(
                        job_id, source_path, output_path, stage, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        canonical_path(source_path),
                        canonical_path(output_path),
                        status,
                        status,
                        now,
                        now,
                    ),
                )
            return last_row_id(cursor)

        return self.call(operation)

    def update_ocr_job_file(
        self,
        file_id: int,
        stage: str,
        status: str,
        *,
        error: str | None = None,
        warning: str | None = None,
    ) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            with connection:
                connection.execute(
                    """
                    UPDATE ocr_job_files
                    SET stage = ?, status = ?, error = ?, warning = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (stage, status, error, warning, timestamp(), file_id),
                )

        self.call(operation)

    def fail_unfinished_ocr_job_files(
        self, job_id: int, error: str
    ) -> list[dict[str, str]]:
        def operation(connection: sqlite3.Connection) -> list[dict[str, str]]:
            rows = connection.execute(
                """
                SELECT source_path, output_path FROM ocr_job_files
                WHERE job_id = ? AND status NOT IN ('completed', 'failed', 'skipped')
                ORDER BY id
                """,
                (job_id,),
            ).fetchall()
            with connection:
                connection.execute(
                    """
                    UPDATE ocr_job_files
                    SET stage = 'failed', status = 'failed', error = ?, updated_at = ?
                    WHERE job_id = ?
                      AND status NOT IN ('completed', 'failed', 'skipped')
                    """,
                    (error, timestamp(), job_id),
                )
            return [
                {
                    "sourcePath": str(row["source_path"]),
                    "outputPath": str(row["output_path"]),
                }
                for row in rows
            ]

        return self.call(operation)

    def record_document_success(
        self, input_path: str, output_path: str, text: str, job_id: int
    ) -> int:
        canonical_input = canonical_path(input_path)

        def operation(connection: sqlite3.Connection) -> int:
            now = timestamp()
            with connection:
                connection.execute(
                    """
                    INSERT INTO documents(
                        canonical_input_path, successful_output_path, successful_text,
                        result_available, latest_job_id, latest_status, created_at,
                        updated_at, latest_output_path
                    ) VALUES (?, ?, ?, 1, ?, 'completed', ?, ?, ?)
                    ON CONFLICT(canonical_input_path) DO UPDATE SET
                        successful_output_path = excluded.successful_output_path,
                        successful_text = excluded.successful_text,
                        result_available = 1,
                        latest_job_id = excluded.latest_job_id,
                        latest_status = 'completed',
                        latest_error = NULL,
                        latest_warning = NULL,
                        latest_output_path = excluded.latest_output_path,
                        updated_at = excluded.updated_at
                    """,
                    (
                        canonical_input,
                        canonical_path(output_path),
                        text,
                        job_id,
                        now,
                        now,
                        canonical_path(output_path),
                    ),
                )
                row = connection.execute(
                    "SELECT id FROM documents WHERE canonical_input_path = ?",
                    (canonical_input,),
                ).fetchone()
            if row is None:
                raise DatabaseError("Could not persist document")
            return int(row[0])

        return self.call(operation)

    def record_document_failure(
        self,
        input_path: str,
        status: str,
        error: str,
        job_id: int,
        *,
        output_path: str | None = None,
    ) -> int:
        canonical_input = canonical_path(input_path)

        def operation(connection: sqlite3.Connection) -> int:
            now = timestamp()
            with connection:
                connection.execute(
                    """
                    INSERT INTO documents(
                        canonical_input_path, result_available, latest_job_id,
                        latest_status, latest_error, created_at, updated_at,
                        latest_output_path
                    ) VALUES (?, 0, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(canonical_input_path) DO UPDATE SET
                        latest_job_id = excluded.latest_job_id,
                        latest_status = excluded.latest_status,
                        latest_error = excluded.latest_error,
                        latest_warning = NULL,
                        latest_output_path = excluded.latest_output_path,
                        updated_at = excluded.updated_at
                    """,
                    (
                        canonical_input,
                        job_id,
                        status,
                        error,
                        now,
                        now,
                        canonical_path(output_path)
                        if output_path is not None
                        else None,
                    ),
                )
                row = connection.execute(
                    "SELECT id FROM documents WHERE canonical_input_path = ?",
                    (canonical_input,),
                ).fetchone()
            if row is None:
                raise DatabaseError("Could not persist document failure")
            return int(row[0])

        return self.call(operation)

    def list_documents(self) -> list[dict[str, Any]]:
        def operation(connection: sqlite3.Connection) -> list[dict[str, Any]]:
            rows = connection.execute("SELECT * FROM documents ORDER BY id").fetchall()
            return [
                {
                    "id": int(row["id"]),
                    "inputPath": row["canonical_input_path"],
                    "outputPath": row["successful_output_path"],
                    "text": row["successful_text"],
                    "resultAvailable": bool(row["result_available"]),
                    "latestStatus": row["latest_status"],
                    "latestError": row["latest_error"],
                    "latestWarning": row["latest_warning"],
                    "latestOutputPath": row["latest_output_path"],
                    "updatedAt": row["updated_at"],
                }
                for row in rows
            ]

        return self.call(operation)

    def delete_document(self, document_id: int) -> None:
        self.delete_documents([document_id])

    def delete_documents(self, document_ids: list[int]) -> None:
        if (
            not document_ids
            or len(document_ids) > MAX_BULK_DELETE_ITEMS
            or len(set(document_ids)) != len(document_ids)
            or any(
                isinstance(document_id, bool)
                or not isinstance(document_id, int)
                or document_id < 1
                for document_id in document_ids
            )
        ):
            raise ValueError("documentIds must contain unique positive integers")

        def operation(connection: sqlite3.Connection) -> None:
            status_placeholders = ", ".join("?" for _ in BLOCKING_OCR_JOB_STATUSES)
            id_placeholders = ", ".join("?" for _ in document_ids)
            with connection:
                active_job = connection.execute(
                    f"""
                    SELECT 1 FROM ocr_jobs
                    WHERE status IN ({status_placeholders})
                    LIMIT 1
                    """,
                    tuple(sorted(BLOCKING_OCR_JOB_STATUSES)),
                ).fetchone()
                if active_job is not None:
                    raise DocumentDeletionBlockedError(
                        "Documents cannot be deleted while an OCR batch is active "
                        "or awaiting overwrite confirmation"
                    )
                existing_ids = {
                    int(row["id"])
                    for row in connection.execute(
                        f"SELECT id FROM documents WHERE id IN ({id_placeholders})",
                        tuple(document_ids),
                    ).fetchall()
                }
                missing_id = next(
                    (
                        document_id
                        for document_id in document_ids
                        if document_id not in existing_ids
                    ),
                    None,
                )
                if missing_id is not None:
                    raise DocumentNotFoundError(f"Document {missing_id} not found")
                cursor = connection.execute(
                    f"DELETE FROM documents WHERE id IN ({id_placeholders})",
                    tuple(document_ids),
                )
                if cursor.rowcount != len(document_ids):
                    raise DatabaseError("Documents changed during deletion")

        self.call(operation)

    def list_chat_documents(self) -> list[dict[str, Any]]:
        return self.call(
            lambda connection: [
                {"id": int(row["id"]), "text": str(row["successful_text"])}
                for row in connection.execute(
                    """
                    SELECT id, successful_text FROM documents
                    WHERE result_available = 1 AND successful_text IS NOT NULL
                    ORDER BY id
                    """
                ).fetchall()
            ]
        )

    def save_prompt(
        self, prompt_id: int | None, name: str, document: dict[str, Any]
    ) -> dict[str, Any]:
        encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":"))

        def operation(connection: sqlite3.Connection) -> dict[str, Any]:
            now = timestamp()
            try:
                with connection:
                    if prompt_id is None:
                        cursor = connection.execute(
                            """
                            INSERT INTO prompts(
                                name, schema_version, structured_json, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?)
                            """,
                            (name, int(document["version"]), encoded, now, now),
                        )
                        selected_id = last_row_id(cursor)
                    else:
                        cursor = connection.execute(
                            """
                            UPDATE prompts
                            SET name = ?, schema_version = ?, structured_json = ?, updated_at = ?
                            WHERE id = ?
                            """,
                            (name, int(document["version"]), encoded, now, prompt_id),
                        )
                        if cursor.rowcount != 1:
                            raise DatabaseError(f"Prompt {prompt_id} not found")
                        selected_id = prompt_id
            except sqlite3.IntegrityError as error:
                raise DatabaseError(f"Prompt name already exists: {name}") from error
            return self.load_prompt_row(connection, selected_id)

        return self.call(operation)

    def load_prompt_row(
        self, connection: sqlite3.Connection, prompt_id: int
    ) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM prompts WHERE id = ?", (prompt_id,)
        ).fetchone()
        if row is None:
            raise DatabaseError(f"Prompt {prompt_id} not found")
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "version": int(row["schema_version"]),
            "document": json.loads(row["structured_json"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def load_prompt(self, prompt_id: int) -> dict[str, Any]:
        return self.call(lambda connection: self.load_prompt_row(connection, prompt_id))

    def list_prompts(self) -> list[dict[str, Any]]:
        return self.call(
            lambda connection: [
                self.load_prompt_row(connection, int(row[0]))
                for row in connection.execute(
                    "SELECT id FROM prompts ORDER BY name COLLATE NOCASE, id"
                ).fetchall()
            ]
        )

    def rename_prompt(self, prompt_id: int, name: str) -> dict[str, Any]:
        def operation(connection: sqlite3.Connection) -> dict[str, Any]:
            try:
                with connection:
                    cursor = connection.execute(
                        "UPDATE prompts SET name = ?, updated_at = ? WHERE id = ?",
                        (name, timestamp(), prompt_id),
                    )
                    if cursor.rowcount != 1:
                        raise DatabaseError(f"Prompt {prompt_id} not found")
            except sqlite3.IntegrityError as error:
                raise DatabaseError(f"Prompt name already exists: {name}") from error
            return self.load_prompt_row(connection, prompt_id)

        return self.call(operation)

    def delete_prompt(self, prompt_id: int) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            with connection:
                cursor = connection.execute(
                    "DELETE FROM prompts WHERE id = ?", (prompt_id,)
                )
                if cursor.rowcount != 1:
                    raise DatabaseError(f"Prompt {prompt_id} not found")

        self.call(operation)

    def create_interaction(
        self,
        interaction_id: str,
        browser_instance_id: str,
        provider_id: str,
        provider_url: str,
        structured_instructions: dict[str, Any],
        rendered_instructions: str,
        prompt_sha256: str,
        prompt_bytes: int,
        document_ids: list[int],
    ) -> None:
        encoded = json.dumps(
            structured_instructions, ensure_ascii=False, separators=(",", ":")
        )

        def operation(connection: sqlite3.Connection) -> None:
            now = timestamp()
            with connection:
                connection.execute(
                    """
                    INSERT INTO chat_interactions(
                        interaction_id, browser_instance_id, provider_id, provider_url,
                        status, structured_instructions_json, rendered_instructions,
                        prompt_sha256, prompt_bytes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        interaction_id,
                        browser_instance_id,
                        provider_id,
                        provider_url,
                        encoded,
                        rendered_instructions,
                        prompt_sha256,
                        prompt_bytes,
                        now,
                        now,
                    ),
                )
                connection.executemany(
                    """
                    INSERT INTO interaction_documents(interaction_id, document_id, ordinal)
                    VALUES (?, ?, ?)
                    """,
                    [
                        (interaction_id, document_id, ordinal)
                        for ordinal, document_id in enumerate(document_ids)
                    ],
                )

        self.call(operation)

    def prepare_interaction(
        self,
        interaction_id: str,
        browser_instance_id: str,
        provider_id: str,
        provider_url: str,
        structured_instructions: dict[str, Any],
        rendered_instructions: str,
    ) -> dict[str, Any]:
        from doc2webchat.prompts import build_complete_prompt

        encoded = json.dumps(
            structured_instructions, ensure_ascii=False, separators=(",", ":")
        )

        def operation(connection: sqlite3.Connection) -> dict[str, Any]:
            connection.execute("BEGIN")
            with connection:
                rows = connection.execute(
                    """
                    SELECT id, successful_text AS text FROM documents
                    WHERE result_available = 1 AND successful_text IS NOT NULL
                    ORDER BY id
                    """
                ).fetchall()
                documents = [dict(row) for row in rows]
                complete_prompt, prompt_bytes = build_complete_prompt(
                    rendered_instructions, documents
                )
                prompt_hash = hashlib.sha256(
                    complete_prompt.encode("utf-8")
                ).hexdigest()
                now = timestamp()
                connection.execute(
                    """
                    INSERT INTO chat_interactions(
                        interaction_id, browser_instance_id, provider_id, provider_url,
                        status, structured_instructions_json, rendered_instructions,
                        prompt_sha256, prompt_bytes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        interaction_id,
                        browser_instance_id,
                        provider_id,
                        provider_url,
                        encoded,
                        rendered_instructions,
                        prompt_hash,
                        prompt_bytes,
                        now,
                        now,
                    ),
                )
                connection.executemany(
                    """
                    INSERT INTO interaction_documents(interaction_id, document_id, ordinal)
                    VALUES (?, ?, ?)
                    """,
                    [
                        (interaction_id, int(document["id"]), ordinal)
                        for ordinal, document in enumerate(documents)
                    ],
                )
                connection.execute(
                    """
                    INSERT INTO messages(interaction_id, ordinal, role, content, created_at)
                    VALUES (?, 0, 'user', ?, ?)
                    """,
                    (interaction_id, complete_prompt, now),
                )
                return {
                    "prompt": complete_prompt,
                    "promptBytes": prompt_bytes,
                    "promptSha256": prompt_hash,
                    "documentIds": [int(document["id"]) for document in documents],
                }

        return self.call(operation)

    def update_interaction(
        self,
        interaction_id: str,
        status: str,
        *,
        error_code: str | None = None,
        error_message: str | None = None,
        finished: bool = False,
    ) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            now = timestamp()
            with connection:
                cursor = connection.execute(
                    """
                    UPDATE chat_interactions
                    SET status = ?, error_code = ?, error_message = ?, updated_at = ?,
                        completed_at = CASE WHEN ? THEN ? ELSE completed_at END
                    WHERE interaction_id = ?
                    """,
                    (
                        status,
                        error_code,
                        error_message,
                        now,
                        int(finished),
                        now,
                        interaction_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise DatabaseError(f"Interaction {interaction_id} not found")

        self.call(operation)

    def transition_interaction(
        self,
        interaction_id: str,
        from_statuses: set[str],
        to_status: str,
        *,
        error_code: str | None = None,
        error_message: str | None = None,
        finished: bool = False,
    ) -> bool:
        if not from_statuses:
            return False

        def operation(connection: sqlite3.Connection) -> bool:
            now = timestamp()
            placeholders = ", ".join("?" for _ in from_statuses)
            with connection:
                cursor = connection.execute(
                    f"""
                    UPDATE chat_interactions
                    SET status = ?, error_code = ?, error_message = ?, updated_at = ?,
                        completed_at = CASE WHEN ? THEN ? ELSE completed_at END
                    WHERE interaction_id = ? AND status IN ({placeholders})
                    """,
                    (
                        to_status,
                        error_code,
                        error_message,
                        now,
                        int(finished),
                        now,
                        interaction_id,
                        *sorted(from_statuses),
                    ),
                )
            return cursor.rowcount == 1

        return self.call(operation)

    def get_interaction(self, interaction_id: str) -> dict[str, Any]:
        def operation(connection: sqlite3.Connection) -> dict[str, Any]:
            row = connection.execute(
                "SELECT * FROM chat_interactions WHERE interaction_id = ?",
                (interaction_id,),
            ).fetchone()
            if row is None:
                raise DatabaseError(f"Interaction {interaction_id} not found")
            return dict(row)

        return self.call(operation)

    def add_message(self, interaction_id: str, role: str, content: str) -> int:
        def operation(connection: sqlite3.Connection) -> int:
            with connection:
                ordinal = int(
                    connection.execute(
                        "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM messages WHERE interaction_id = ?",
                        (interaction_id,),
                    ).fetchone()[0]
                )
                cursor = connection.execute(
                    """
                    INSERT INTO messages(interaction_id, ordinal, role, content, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (interaction_id, ordinal, role, content, timestamp()),
                )
            return last_row_id(cursor)

        return self.call(operation)

    def get_assistant_message_id(self, interaction_id: str) -> int | None:
        def operation(connection: sqlite3.Connection) -> int | None:
            row = connection.execute(
                """
                SELECT id FROM messages
                WHERE interaction_id = ? AND role = 'assistant'
                ORDER BY ordinal LIMIT 1
                """,
                (interaction_id,),
            ).fetchone()
            return None if row is None else int(row[0])

        return self.call(operation)

    def complete_interaction_with_assistant(
        self,
        interaction_id: str,
        content: str,
        tag_values: list[dict[str, Any]],
        warnings: list[dict[str, Any]],
    ) -> dict[str, Any]:
        def operation(connection: sqlite3.Connection) -> dict[str, Any]:
            connection.execute("BEGIN IMMEDIATE")
            try:
                interaction = connection.execute(
                    "SELECT status FROM chat_interactions WHERE interaction_id = ?",
                    (interaction_id,),
                ).fetchone()
                if interaction is None:
                    raise DatabaseError(f"Interaction {interaction_id} not found")
                existing = connection.execute(
                    """
                    SELECT id FROM messages
                    WHERE interaction_id = ? AND role = 'assistant'
                    ORDER BY ordinal LIMIT 1
                    """,
                    (interaction_id,),
                ).fetchone()
                if existing is not None:
                    connection.commit()
                    return {"status": "duplicate", "messageId": int(existing[0])}
                if interaction["status"] != "importing":
                    connection.rollback()
                    return {"status": "out-of-order", "messageId": None}
                ordinal = int(
                    connection.execute(
                        """
                        SELECT COALESCE(MAX(ordinal), -1) + 1 FROM messages
                        WHERE interaction_id = ?
                        """,
                        (interaction_id,),
                    ).fetchone()[0]
                )
                cursor = connection.execute(
                    """
                    INSERT INTO messages(interaction_id, ordinal, role, content, created_at)
                    VALUES (?, ?, 'assistant', ?, ?)
                    """,
                    (interaction_id, ordinal, content, timestamp()),
                )
                message_id = last_row_id(cursor)
                value_ids: list[int] = []
                for value_ordinal, value in enumerate(tag_values):
                    parent_index = value.get("parentIndex")
                    parent_id = (
                        value_ids[int(parent_index)]
                        if parent_index is not None
                        else None
                    )
                    value_cursor = connection.execute(
                        """
                        INSERT INTO message_tag_values(
                            message_id, ordinal, name, raw_value, trimmed_value,
                            start_offset, end_offset, parent_value_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            message_id,
                            value_ordinal,
                            value["name"],
                            value["raw"],
                            value["trimmed"],
                            value["start"],
                            value["end"],
                            parent_id,
                        ),
                    )
                    value_ids.append(last_row_id(value_cursor))
                for warning_ordinal, warning in enumerate(warnings):
                    parent_index = warning.get("parentIndex")
                    parent_id = (
                        value_ids[int(parent_index)]
                        if parent_index is not None
                        else None
                    )
                    connection.execute(
                        """
                        INSERT INTO message_warnings(
                            message_id, ordinal, code, message, tag_name, parent_value_id
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            message_id,
                            warning_ordinal,
                            warning["code"],
                            warning["message"],
                            warning.get("tagName"),
                            parent_id,
                        ),
                    )
                now = timestamp()
                updated = connection.execute(
                    """
                    UPDATE chat_interactions
                    SET status = 'completed', updated_at = ?, completed_at = ?,
                        error_code = NULL, error_message = NULL
                    WHERE interaction_id = ? AND status = 'importing'
                    """,
                    (now, now, interaction_id),
                )
                if updated.rowcount != 1:
                    raise DatabaseError("Interaction changed during response import")
                connection.commit()
                return {"status": "accepted", "messageId": message_id}
            except BaseException:
                if connection.in_transaction:
                    connection.rollback()
                raise

        return self.call(operation)

    def replace_message_analysis(
        self,
        message_id: int,
        tag_values: list[dict[str, Any]],
        warnings: list[dict[str, Any]],
    ) -> None:
        def operation(connection: sqlite3.Connection) -> None:
            with connection:
                connection.execute(
                    "DELETE FROM message_warnings WHERE message_id = ?", (message_id,)
                )
                connection.execute(
                    "DELETE FROM message_tag_values WHERE message_id = ?", (message_id,)
                )
                value_ids: list[int] = []
                for ordinal, value in enumerate(tag_values):
                    parent_index = value.get("parentIndex")
                    parent_id = (
                        value_ids[int(parent_index)]
                        if parent_index is not None
                        else None
                    )
                    cursor = connection.execute(
                        """
                        INSERT INTO message_tag_values(
                            message_id, ordinal, name, raw_value, trimmed_value,
                            start_offset, end_offset, parent_value_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            message_id,
                            ordinal,
                            value["name"],
                            value["raw"],
                            value["trimmed"],
                            value["start"],
                            value["end"],
                            parent_id,
                        ),
                    )
                    value_ids.append(last_row_id(cursor))
                for ordinal, warning in enumerate(warnings):
                    parent_index = warning.get("parentIndex")
                    parent_id = (
                        value_ids[int(parent_index)]
                        if parent_index is not None
                        else None
                    )
                    connection.execute(
                        """
                        INSERT INTO message_warnings(
                            message_id, ordinal, code, message, tag_name, parent_value_id
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            message_id,
                            ordinal,
                            warning["code"],
                            warning["message"],
                            warning.get("tagName"),
                            parent_id,
                        ),
                    )

        self.call(operation)

    def list_history(self) -> list[dict[str, Any]]:
        def operation(connection: sqlite3.Connection) -> list[dict[str, Any]]:
            interaction_rows = connection.execute(
                "SELECT * FROM chat_interactions ORDER BY created_at, interaction_id"
            ).fetchall()
            history: list[dict[str, Any]] = []
            for interaction in interaction_rows:
                message_rows = connection.execute(
                    "SELECT * FROM messages WHERE interaction_id = ? ORDER BY ordinal",
                    (interaction["interaction_id"],),
                ).fetchall()
                messages: list[dict[str, Any]] = []
                for message in message_rows:
                    value_rows = connection.execute(
                        """
                        SELECT value.*, parent.ordinal AS parent_ordinal
                        FROM message_tag_values value
                        LEFT JOIN message_tag_values parent ON parent.id = value.parent_value_id
                        WHERE value.message_id = ? ORDER BY value.ordinal
                        """,
                        (message["id"],),
                    ).fetchall()
                    warning_rows = connection.execute(
                        """
                        SELECT warning.*, parent.ordinal AS parent_ordinal
                        FROM message_warnings warning
                        LEFT JOIN message_tag_values parent ON parent.id = warning.parent_value_id
                        WHERE warning.message_id = ? ORDER BY warning.ordinal
                        """,
                        (message["id"],),
                    ).fetchall()
                    messages.append(
                        {
                            "id": int(message["id"]),
                            "role": message["role"],
                            "content": message["content"],
                            "createdAt": message["created_at"],
                            "tagValues": [
                                {
                                    "name": row["name"],
                                    "raw": row["raw_value"],
                                    "trimmed": row["trimmed_value"],
                                    "start": int(row["start_offset"]),
                                    "end": int(row["end_offset"]),
                                    "parentIndex": row["parent_ordinal"],
                                }
                                for row in value_rows
                            ],
                            "warnings": [
                                {
                                    "code": row["code"],
                                    "message": row["message"],
                                    "tagName": row["tag_name"],
                                    "parentIndex": row["parent_ordinal"],
                                }
                                for row in warning_rows
                            ],
                        }
                    )
                document_ids = [
                    int(row[0])
                    for row in connection.execute(
                        """
                        SELECT document_id FROM interaction_documents
                        WHERE interaction_id = ? ORDER BY ordinal
                        """,
                        (interaction["interaction_id"],),
                    ).fetchall()
                ]
                history.append(
                    {
                        "interactionId": interaction["interaction_id"],
                        "browserInstanceId": interaction["browser_instance_id"],
                        "providerId": interaction["provider_id"],
                        "providerUrl": interaction["provider_url"],
                        "status": interaction["status"],
                        "instructions": json.loads(
                            interaction["structured_instructions_json"]
                        ),
                        "renderedInstructions": interaction["rendered_instructions"],
                        "promptBytes": int(interaction["prompt_bytes"]),
                        "documentIds": document_ids,
                        "messages": messages,
                        "createdAt": interaction["created_at"],
                        "updatedAt": interaction["updated_at"],
                    }
                )
            return history

        return self.call(operation)

    def delete_interaction(self, interaction_id: str) -> None:
        self.delete_interactions([interaction_id])

    def delete_interactions(self, interaction_ids: list[str]) -> None:
        if not interaction_ids or len(interaction_ids) > MAX_BULK_DELETE_ITEMS:
            raise ValueError("interactionIds must contain unique interaction IDs")
        try:
            normalized_ids = [
                str(uuid.UUID(interaction_id))
                if isinstance(interaction_id, str) and len(interaction_id) <= 36
                else ""
                for interaction_id in interaction_ids
            ]
        except ValueError as error:
            raise ValueError(
                "interactionIds must contain unique UUID interaction IDs"
            ) from error
        if "" in normalized_ids or len(set(normalized_ids)) != len(normalized_ids):
            raise ValueError("interactionIds must contain unique UUID interaction IDs")
        interaction_ids = normalized_ids

        def operation(connection: sqlite3.Connection) -> None:
            placeholders = ", ".join("?" for _ in interaction_ids)
            with connection:
                statuses = {
                    str(row["interaction_id"]): str(row["status"])
                    for row in connection.execute(
                        f"""
                        SELECT interaction_id, status FROM chat_interactions
                        WHERE interaction_id IN ({placeholders})
                        """,
                        tuple(interaction_ids),
                    ).fetchall()
                }
                missing_id = next(
                    (
                        interaction_id
                        for interaction_id in interaction_ids
                        if interaction_id not in statuses
                    ),
                    None,
                )
                if missing_id is not None:
                    raise InteractionNotFoundError(
                        f"Interaction {missing_id} not found"
                    )
                blocked_id = next(
                    (
                        interaction_id
                        for interaction_id in interaction_ids
                        if statuses[interaction_id]
                        not in DELETABLE_INTERACTION_STATUSES
                    ),
                    None,
                )
                if blocked_id is not None:
                    raise InteractionDeletionBlockedError(
                        "Only completed, failed, or expired interactions can be deleted"
                    )
                cursor = connection.execute(
                    f"""
                    DELETE FROM chat_interactions
                    WHERE interaction_id IN ({placeholders})
                    """,
                    tuple(interaction_ids),
                )
                if cursor.rowcount != len(interaction_ids):
                    raise DatabaseError("Interactions changed during deletion")

        self.call(operation)

    def set_preference(self, key: str, value: Any) -> None:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))

        def operation(connection: sqlite3.Connection) -> None:
            with connection:
                connection.execute(
                    """
                    INSERT INTO app_preferences(key, value_json, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET
                        value_json = excluded.value_json, updated_at = excluded.updated_at
                    """,
                    (key, encoded, timestamp()),
                )

        self.call(operation)

    def get_preferences(self) -> dict[str, Any]:
        return self.call(
            lambda connection: {
                str(row["key"]): json.loads(row["value_json"])
                for row in connection.execute(
                    "SELECT key, value_json FROM app_preferences ORDER BY key"
                ).fetchall()
            }
        )
