from __future__ import annotations

import contextlib
import ctypes
import importlib
import logging
import sys
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable
from ctypes import wintypes
from pathlib import Path
from typing import Any, Protocol, cast

import webview

from doc2webchat.database import (
    MAX_BULK_DELETE_ITEMS,
    Database,
    DatabaseError,
    DocumentDeletionBlockedError,
    DocumentNotFoundError,
    InteractionDeletionBlockedError,
    InteractionNotFoundError,
    canonical_path,
)
from doc2webchat.errors import AppError, failure, success
from doc2webchat.ocr import (
    MAX_OVERWRITE_CONFLICT_PATHS,
    OcrJobRequest,
    OcrManager,
    OutputPolicy,
    lexical_absolute_path,
    output_approval_key,
    reject_symbolic_path,
    to_normal_path,
)
from doc2webchat.ocr_contract import OcrJobStatus
from doc2webchat.prompts import (
    PromptBuildError,
    expected_children_from_prompt,
    parse_response,
    serialize_instructions,
    validate_structured_prompt,
)
from doc2webchat.providers import ProviderRegistry

logger = logging.getLogger(__name__)
MAX_EVENT_HISTORY = 10_000
MAX_POLL_MILLISECONDS = 30_000
CLIPBOARD_WAIT_SECONDS = 5


class WindowLike(Protocol):
    def create_file_dialog(self, *args: Any, **kwargs: Any) -> Any: ...


class DialogDispatcher(Protocol):
    def select_folder(self) -> Any: ...


class WindowsDialogDispatcher:
    def __init__(self, window: WindowLike) -> None:
        self.window = window

    def select_folder(self) -> Any:
        if sys.platform != "win32":
            raise AppError(
                "dialog-unavailable",
                "The native dialog dispatcher is unavailable on this platform",
            )
        gui = getattr(self.window, "gui", None)
        uid = getattr(self.window, "uid", None)
        browser_view = getattr(gui, "BrowserView", None)
        instance = (
            browser_view.instances.get(uid)
            if browser_view is not None and uid is not None
            else None
        )
        if instance is None:
            raise AppError("window-unavailable", "Desktop window is not ready")

        def show_dialog() -> None:
            result.append(
                self.window.create_file_dialog(
                    webview.FileDialog.FOLDER,
                    allow_multiple=False,
                )
            )

        result: list[Any] = []
        if bool(instance.InvokeRequired):
            system = importlib.import_module("System")
            instance.Invoke(system.Action(show_dialog))
        else:
            show_dialog()
        return result[0] if result else None


class BridgeLike(Protocol):
    def list_browsers(self) -> list[dict[str, Any]]: ...

    def dispatch_interaction(self, **kwargs: Any) -> dict[str, Any]: ...


class EventBridgeLike(BridgeLike, Protocol):
    def get_event(self, timeout: float | None = None) -> dict[str, Any]: ...

    def report_import_result(
        self, event: dict[str, Any], status: str, code: str | None = None
    ) -> None: ...


class ClipboardLike(Protocol):
    def sequence(self) -> int: ...

    def read_text(self) -> str: ...


class EventBuffer:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.events: deque[dict[str, Any]] = deque(maxlen=MAX_EVENT_HISTORY)
        self.next_sequence = 1

    def publish(self, event: dict[str, Any]) -> None:
        with self.condition:
            value = {
                **event,
                "sequence": self.next_sequence,
                "timestamp": int(time.time() * 1000),
            }
            self.next_sequence += 1
            self.events.append(value)
            self.condition.notify_all()

    def poll(self, after: int, timeout_milliseconds: int) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_milliseconds / 1000
        with self.condition:
            while not any(event["sequence"] > after for event in self.events):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(remaining)
            values = [event for event in self.events if event["sequence"] > after]
            return {
                "events": values,
                "nextSequence": values[-1]["sequence"] if values else after,
                "oldestAvailableSequence": (
                    self.events[0]["sequence"] if self.events else self.next_sequence
                ),
            }


class NativeClipboard:
    @staticmethod
    def windows_functions() -> tuple[Any, Any]:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.GetClipboardSequenceNumber.argtypes = []
        user32.GetClipboardSequenceNumber.restype = wintypes.DWORD
        user32.OpenClipboard.argtypes = [wintypes.HWND]
        user32.OpenClipboard.restype = wintypes.BOOL
        user32.CloseClipboard.argtypes = []
        user32.CloseClipboard.restype = wintypes.BOOL
        user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
        user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
        user32.GetClipboardData.argtypes = [wintypes.UINT]
        user32.GetClipboardData.restype = wintypes.HANDLE
        kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
        kernel32.GlobalLock.restype = wintypes.LPVOID
        kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
        kernel32.GlobalUnlock.restype = wintypes.BOOL
        return user32, kernel32

    def sequence(self) -> int:
        if sys.platform != "win32":
            return hash(self.read_text())
        user32, _ = self.windows_functions()
        return int(user32.GetClipboardSequenceNumber())

    def read_text(self) -> str:
        if sys.platform != "win32":
            import tkinter

            try:
                root = tkinter.Tk()
                root.withdraw()
                try:
                    return str(root.clipboard_get())
                finally:
                    root.destroy()
            except tkinter.TclError as error:
                raise AppError(
                    "clipboard-unavailable", "Could not read the clipboard"
                ) from error
        user32, kernel32 = self.windows_functions()
        if not user32.IsClipboardFormatAvailable(13):
            return ""
        if not user32.OpenClipboard(None):
            raise AppError("clipboard-unavailable", "Could not open the clipboard")
        try:
            handle = user32.GetClipboardData(13)
            if not handle:
                return ""
            pointer = kernel32.GlobalLock(handle)
            if not pointer:
                raise AppError("clipboard-unavailable", "Could not read the clipboard")
            try:
                return ctypes.wstring_at(pointer)
            finally:
                kernel32.GlobalUnlock(handle)
        finally:
            user32.CloseClipboard()


def require_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AppError("invalid-request", "Request must be an object")
    return value


def require_string(request: dict[str, Any], key: str, *, maximum: int = 4096) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise AppError(
            "invalid-request", f"{key} must be a non-empty string", field=key
        )
    return value.strip()


def require_integer(request: dict[str, Any], key: str) -> int:
    value = request.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise AppError(
            "invalid-request", f"{key} must be a positive integer", field=key
        )
    return value


def require_uuid(request: dict[str, Any], key: str) -> str:
    value = require_string(request, key, maximum=36)
    try:
        return str(uuid.UUID(value))
    except ValueError as error:
        raise AppError("invalid-request", f"{key} must be a UUID", field=key) from error


def require_integer_array(request: dict[str, Any], key: str) -> list[int]:
    value = request.get(key)
    if not isinstance(value, list) or not value or len(value) > MAX_BULK_DELETE_ITEMS:
        raise AppError(
            "invalid-request",
            f"{key} must be a non-empty array of at most {MAX_BULK_DELETE_ITEMS} items",
            field=key,
        )
    if any(
        isinstance(item, bool) or not isinstance(item, int) or item < 1
        for item in value
    ):
        raise AppError(
            "invalid-request", f"{key} must contain positive integers", field=key
        )
    if len(set(value)) != len(value):
        raise AppError(
            "invalid-request", f"{key} must contain unique values", field=key
        )
    return value


def require_uuid_array(request: dict[str, Any], key: str) -> list[str]:
    value = request.get(key)
    if not isinstance(value, list) or not value or len(value) > MAX_BULK_DELETE_ITEMS:
        raise AppError(
            "invalid-request",
            f"{key} must be a non-empty array of at most {MAX_BULK_DELETE_ITEMS} items",
            field=key,
        )
    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str) or len(item) > 36:
            raise AppError(
                "invalid-request", f"{key} must contain UUID strings", field=key
            )
        try:
            normalized.append(str(uuid.UUID(item)))
        except ValueError as error:
            raise AppError(
                "invalid-request", f"{key} must contain UUID strings", field=key
            ) from error
    if len(set(normalized)) != len(normalized):
        raise AppError(
            "invalid-request", f"{key} must contain unique values", field=key
        )
    return normalized


class DesktopApi:
    def __init__(
        self,
        database: Database,
        bridge: BridgeLike,
        registry: ProviderRegistry,
        *,
        clipboard: ClipboardLike | None = None,
        ocr_manager: OcrManager | None = None,
    ) -> None:
        self.database = database
        self.bridge = bridge
        self.registry = registry
        self.window: WindowLike | None = None
        self.dialog_dispatcher: DialogDispatcher | None = None
        self.event_buffer = EventBuffer()
        self.ocr_manager = ocr_manager or OcrManager(
            database, self.event_buffer.publish
        )
        self.clipboard = clipboard or NativeClipboard()
        self.clipboard_sequences: dict[str, int] = {}
        self.clipboard_owner: str | None = None
        self.clipboard_lock = threading.Lock()
        self.stop_events = threading.Event()
        self.event_thread: threading.Thread | None = None
        if hasattr(bridge, "get_event") and hasattr(bridge, "report_import_result"):
            self.event_thread = threading.Thread(
                target=self.consume_bridge_events,
                name="doc2webchat-events",
                daemon=True,
            )
            self.event_thread.start()

    def attach_window(
        self, window: WindowLike, dialog_dispatcher: DialogDispatcher
    ) -> None:
        self.window = window
        self.dialog_dispatcher = dialog_dispatcher

    def safely(self, operation: Callable[[], Any]) -> dict[str, Any]:
        try:
            return success(operation())
        except AppError as error:
            return failure(error)
        except DatabaseError as error:
            return failure(AppError("database-error", str(error)))
        except PromptBuildError as error:
            return failure(AppError("invalid-instructions", str(error)))
        except (KeyError, TypeError, ValueError) as error:
            return failure(AppError("invalid-request", str(error)))
        except (OSError, RuntimeError) as error:
            logger.exception("Desktop operation failed")
            return failure(AppError("operation-failed", str(error)[:512]))
        except Exception:
            logger.exception("Unexpected desktop operation failure")
            return failure(
                AppError("internal-error", "The operation could not be completed")
            )

    def get_bootstrap_state(self) -> dict[str, Any]:
        return self.safely(self.build_bootstrap_state)

    def build_bootstrap_state(self) -> dict[str, Any]:
        active_job: dict[str, Any] | None = None
        if self.ocr_manager.active_job_id is not None:
            row = self.database.get_ocr_job(self.ocr_manager.active_job_id)
            active_job = {
                "jobId": int(row["id"]),
                "status": row["status"],
                "total": row["total_files"],
                "completed": int(row["completed_files"]),
                "failed": int(row["failed_files"]),
                "skipped": int(row["skipped_files"]),
            }
        else:
            pending = self.database.get_pending_overwrite_job()
            if pending is not None:
                conflicts = pending["conflicts"]
                active_job = {
                    "jobId": int(pending["id"]),
                    "status": "awaiting-overwrite",
                    "total": pending["total_files"],
                    "completed": int(pending["completed_files"]),
                    "failed": int(pending["failed_files"]),
                    "skipped": int(pending["skipped_files"]),
                    "overwriteConfirmationJobId": int(pending["id"]),
                    "inputPath": str(pending["input_root"]),
                    "outputPath": str(pending["output_root"]),
                    "recursive": bool(pending["recursive"]),
                    "conflictCount": len(conflicts),
                    "conflictingOutputs": [
                        str(conflict["outputPath"])
                        for conflict in conflicts[:MAX_OVERWRITE_CONFLICT_PATHS]
                    ],
                }
        return {
            "documents": self.database.list_documents(),
            "prompts": self.database.list_prompts(),
            "browsers": self.bridge.list_browsers(),
            "history": self.database.list_history(),
            "preferences": self.database.get_preferences(),
            "providers": self.registry.public_definitions(),
            "activeJob": active_job,
        }

    def select_directory(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, str | None]:
            request = require_request(value)
            purpose = request.get("purpose")
            if purpose not in {"input", "output"}:
                raise AppError(
                    "invalid-request",
                    "purpose must be input or output",
                    field="purpose",
                )
            if self.dialog_dispatcher is None:
                raise AppError("window-unavailable", "Desktop window is not ready")
            selected = self.dialog_dispatcher.select_folder()
            if not selected:
                return {"path": None}
            path = selected if isinstance(selected, str) else selected[0]
            lexical_path = lexical_absolute_path(Path(path))
            reject_symbolic_path(lexical_path, f"Selected {purpose} path")
            return {"path": str(to_normal_path(lexical_path))}

        return self.safely(operation)

    def start_ocr_job(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, int]:
            request = require_request(value)
            lexical_input = lexical_absolute_path(
                Path(require_string(request, "inputPath"))
            )
            lexical_output = lexical_absolute_path(
                Path(require_string(request, "outputPath"))
            )
            reject_symbolic_path(lexical_input, "Input path")
            reject_symbolic_path(lexical_output, "Output path")
            input_path = to_normal_path(lexical_input)
            output_path = to_normal_path(lexical_output)
            recursive = request.get("recursive", False)
            if not isinstance(recursive, bool):
                raise AppError(
                    "invalid-request", "recursive must be boolean", field="recursive"
                )
            policy_value = request.get("conflictPolicy", "error")
            try:
                policy = OutputPolicy(policy_value)
            except ValueError as error:
                raise AppError(
                    "invalid-request",
                    "conflictPolicy must be error, skip, or overwrite",
                    field="conflictPolicy",
                ) from error
            confirmation_value = request.get("overwriteConfirmationJobId")
            confirmation_id = (
                None
                if confirmation_value is None
                else require_integer(request, "overwriteConfirmationJobId")
            )
            approved_overwrites: frozenset[str] = frozenset()
            if confirmation_id is not None:
                if policy is not OutputPolicy.ERROR:
                    raise AppError(
                        "invalid-overwrite-confirmation",
                        "An overwrite confirmation requires conflictPolicy error",
                        field="conflictPolicy",
                    )
                pending = self.database.get_pending_overwrite_job(confirmation_id)
                if pending is None:
                    raise AppError(
                        "invalid-overwrite-confirmation",
                        "The overwrite confirmation is no longer pending",
                        field="overwriteConfirmationJobId",
                    )
                if (
                    str(pending["input_root"]) != canonical_path(input_path)
                    or str(pending["output_root"]) != canonical_path(output_path)
                    or bool(pending["recursive"]) != recursive
                ):
                    raise AppError(
                        "invalid-overwrite-confirmation",
                        "The overwrite confirmation does not match this OCR request",
                        field="overwriteConfirmationJobId",
                    )
                claimed = self.database.claim_pending_overwrite_job(confirmation_id)
                if claimed is None:
                    raise AppError(
                        "invalid-overwrite-confirmation",
                        "The overwrite confirmation was already consumed",
                        field="overwriteConfirmationJobId",
                    )
                conflicts = claimed["conflicts"]
                if not conflicts:
                    self.database.release_overwrite_claim(confirmation_id)
                    raise AppError(
                        "invalid-overwrite-confirmation",
                        "The overwrite confirmation has no persisted conflicts",
                        field="overwriteConfirmationJobId",
                    )
                approved_overwrites = frozenset(
                    output_approval_key(Path(str(conflict["outputPath"])))
                    for conflict in conflicts
                )
            try:
                job_id = self.ocr_manager.start_job(
                    OcrJobRequest(
                        input_path,
                        output_path,
                        recursive,
                        policy,
                        approved_overwrites,
                    )
                )
            except Exception:
                if confirmation_id is not None:
                    self.database.release_overwrite_claim(confirmation_id)
                raise
            if confirmation_id is not None:
                self.database.set_overwrite_confirmation_status(
                    confirmation_id, OcrJobStatus.OVERWRITE_CONFIRMED
                )
            self.database.decline_pending_overwrite_jobs(except_job_id=job_id)
            return {"jobId": job_id}

        return self.safely(operation)

    def poll_events(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            request = require_request(value)
            after = request.get("after", 0)
            timeout = request.get("timeoutMs", 0)
            if isinstance(after, bool) or not isinstance(after, int) or after < 0:
                raise AppError(
                    "invalid-request", "after must be a non-negative integer"
                )
            if (
                isinstance(timeout, bool)
                or not isinstance(timeout, int)
                or not 0 <= timeout <= MAX_POLL_MILLISECONDS
            ):
                raise AppError(
                    "invalid-request", "timeoutMs must be between 0 and 30000"
                )
            return self.event_buffer.poll(after, timeout)

        return self.safely(operation)

    def list_documents(self) -> dict[str, Any]:
        return self.safely(self.database.list_documents)

    def delete_document(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, int]:
            request = require_request(value)
            document_id = require_integer(request, "documentId")
            if self.ocr_manager.active_job_id is not None:
                raise AppError(
                    "document-deletion-blocked",
                    "Documents cannot be deleted while an OCR batch is active or awaiting "
                    "overwrite confirmation",
                )
            try:
                self.database.delete_document(document_id)
            except DocumentDeletionBlockedError as error:
                raise AppError("document-deletion-blocked", str(error)) from error
            except DocumentNotFoundError as error:
                raise AppError(
                    "document-not-found", str(error), field="documentId"
                ) from error
            return {"documentId": document_id}

        return self.safely(operation)

    def delete_documents(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, list[int]]:
            request = require_request(value)
            document_ids = require_integer_array(request, "documentIds")
            if self.ocr_manager.active_job_id is not None:
                raise AppError(
                    "document-deletion-blocked",
                    "Documents cannot be deleted while an OCR batch is active or awaiting "
                    "overwrite confirmation",
                )
            try:
                self.database.delete_documents(document_ids)
            except DocumentDeletionBlockedError as error:
                raise AppError("document-deletion-blocked", str(error)) from error
            except DocumentNotFoundError as error:
                raise AppError(
                    "document-not-found", str(error), field="documentIds"
                ) from error
            return {"documentIds": document_ids}

        return self.safely(operation)

    def list_prompts(self) -> dict[str, Any]:
        return self.safely(self.database.list_prompts)

    def load_prompt(self, value: Any) -> dict[str, Any]:
        return self.safely(
            lambda: {
                "prompt": self.database.load_prompt(
                    require_integer(require_request(value), "promptId")
                )
            }
        )

    def save_prompt(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            request = require_request(value)
            prompt_id_value = request.get("promptId")
            prompt_id = (
                None
                if prompt_id_value is None
                else require_integer(request, "promptId")
            )
            name = require_string(request, "name", maximum=200)
            document = validate_structured_prompt(request.get("document"))
            return {"prompt": self.database.save_prompt(prompt_id, name, document)}

        return self.safely(operation)

    def rename_prompt(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            request = require_request(value)
            return {
                "prompt": self.database.rename_prompt(
                    require_integer(request, "promptId"),
                    require_string(request, "name", maximum=200),
                )
            }

        return self.safely(operation)

    def delete_prompt(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, int]:
            request = require_request(value)
            prompt_id = require_integer(request, "promptId")
            self.database.delete_prompt(prompt_id)
            return {"promptId": prompt_id}

        return self.safely(operation)

    def start_interaction(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            request = require_request(value)
            instructions = validate_structured_prompt(request.get("instructions"))
            rendered = serialize_instructions(instructions)
            provider_id = require_string(request, "providerId", maximum=64)
            provider_url_value = request.get("providerUrl")
            if provider_url_value is not None and not isinstance(
                provider_url_value, str
            ):
                raise AppError(
                    "invalid-request",
                    "providerUrl must be a string",
                    field="providerUrl",
                )
            provider_url = self.registry.validate_url(provider_id, provider_url_value)
            browsers = self.bridge.list_browsers()
            browser_id = self.select_browser(request, browsers)
            settings = self.translate_settings(request)
            interaction_id = str(uuid.uuid4())
            prepared = self.database.prepare_interaction(
                interaction_id,
                browser_id,
                provider_id,
                provider_url,
                instructions,
                rendered,
            )
            if not self.database.transition_interaction(
                interaction_id, {"created"}, "dispatched"
            ):
                raise DatabaseError(
                    f"Interaction {interaction_id} could not be dispatched"
                )
            try:
                self.bridge.dispatch_interaction(
                    interaction_id=interaction_id,
                    browser_instance_id=browser_id,
                    provider_id=provider_id,
                    provider_url=provider_url,
                    prompt=prepared["prompt"],
                    settings=settings,
                )
            except Exception as error:
                self.database.transition_interaction(
                    interaction_id,
                    {"dispatched"},
                    "failed",
                    error_code=getattr(error, "code", "dispatch-failed"),
                    error_message=str(error)[:512],
                    finished=True,
                )
                raise
            preferences = self.database.get_preferences()
            provider_settings_value = preferences.get("providerSettings", {})
            provider_settings = (
                dict(provider_settings_value)
                if isinstance(provider_settings_value, dict)
                else {}
            )
            provider_settings[provider_id] = settings
            provider_urls_value = preferences.get("providerUrls", {})
            provider_urls = (
                dict(provider_urls_value)
                if isinstance(provider_urls_value, dict)
                else {}
            )
            provider_urls[provider_id] = provider_url
            self.database.set_preference("selectedProviderId", provider_id)
            self.database.set_preference("selectedBrowserInstanceId", browser_id)
            self.database.set_preference("providerSettings", provider_settings)
            self.database.set_preference("providerUrls", provider_urls)
            self.database.set_preference("reuseTab", settings["reuse_last_tab"])
            return {
                "interactionId": interaction_id,
                "status": "dispatched",
                "promptBytes": prepared["promptBytes"],
            }

        return self.safely(operation)

    def select_browser(
        self, request: dict[str, Any], browsers: list[dict[str, Any]]
    ) -> str:
        if not browsers:
            raise AppError("browser-unavailable", "No browser extension is connected")
        available = {str(browser["browserInstanceId"]): browser for browser in browsers}
        requested = request.get("browserInstanceId")
        if requested is not None:
            if not isinstance(requested, str) or requested not in available:
                raise AppError(
                    "browser-unavailable", "Selected browser is not connected"
                )
            return requested
        if len(available) == 1:
            return next(iter(available))
        preferred = self.database.get_preferences().get("selectedBrowserInstanceId")
        if isinstance(preferred, str) and preferred in available:
            return preferred
        raise AppError(
            "browser-selection-required",
            "Choose which connected browser to use",
            field="browserInstanceId",
        )

    def translate_settings(self, request: dict[str, Any]) -> dict[str, Any]:
        raw_settings = request.get("settings", {})
        if not isinstance(raw_settings, dict):
            raise AppError("invalid-request", "settings must be an object")
        key_map = {
            "model": "model",
            "temperature": "temperature",
            "thinkingBudget": "thinking_budget",
            "thinking_budget": "thinking_budget",
            "reasoningEffort": "reasoning_effort",
            "reasoning_effort": "reasoning_effort",
            "topP": "top_p",
            "top_p": "top_p",
            "systemInstructions": "system_instructions",
            "system_instructions": "system_instructions",
            "options": "options",
        }
        translated: dict[str, Any] = {}
        for key, setting in raw_settings.items():
            selected_key = key_map.get(key)
            if selected_key is None:
                raise AppError(
                    "invalid-request", f"Unknown provider setting: {key}", field=key
                )
            translated[selected_key] = setting
        reuse = request.get("reuseTab", True)
        if not isinstance(reuse, bool):
            raise AppError("invalid-request", "reuseTab must be boolean")
        translated["reuse_last_tab"] = reuse
        provider_id = require_string(request, "providerId", maximum=64)
        return self.registry.validate_settings(provider_id, translated)

    def list_browsers(self) -> dict[str, Any]:
        return self.safely(self.bridge.list_browsers)

    def list_history(self) -> dict[str, Any]:
        return self.safely(self.database.list_history)

    def delete_interaction(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, str]:
            request = require_request(value)
            interaction_id = require_uuid(request, "interactionId")
            try:
                self.database.delete_interaction(interaction_id)
            except InteractionDeletionBlockedError as error:
                raise AppError(
                    "interaction-deletion-blocked",
                    str(error),
                    field="interactionId",
                ) from error
            except InteractionNotFoundError as error:
                raise AppError(
                    "interaction-not-found", str(error), field="interactionId"
                ) from error
            return {"interactionId": interaction_id}

        return self.safely(operation)

    def delete_interactions(self, value: Any) -> dict[str, Any]:
        def operation() -> dict[str, list[str]]:
            request = require_request(value)
            interaction_ids = require_uuid_array(request, "interactionIds")
            try:
                self.database.delete_interactions(interaction_ids)
            except InteractionDeletionBlockedError as error:
                raise AppError(
                    "interaction-deletion-blocked",
                    str(error),
                    field="interactionIds",
                ) from error
            except InteractionNotFoundError as error:
                raise AppError(
                    "interaction-not-found", str(error), field="interactionIds"
                ) from error
            return {"interactionIds": interaction_ids}

        return self.safely(operation)

    def consume_bridge_events(self) -> None:
        bridge = self.bridge
        if not hasattr(bridge, "get_event") or not hasattr(
            bridge, "report_import_result"
        ):
            return
        event_bridge = cast(EventBridgeLike, bridge)
        while not self.stop_events.is_set():
            try:
                event = event_bridge.get_event(timeout=1)
            except TimeoutError:
                continue
            except AppError:
                if not self.stop_events.is_set():
                    logger.exception("Bridge event stream failed")
                return
            try:
                self.handle_bridge_event(event, event_bridge)
            except Exception:
                logger.exception(
                    "Could not process bridge event action=%s interaction=%s",
                    event.get("action"),
                    event.get("interaction_id"),
                )

    def handle_bridge_event(
        self, event: dict[str, Any], bridge: EventBridgeLike
    ) -> None:
        if event.get("type") == "browser":
            self.event_buffer.publish(event)
            return
        action = event["action"]
        interaction_id = event["interaction_id"]
        if event.get("duplicate"):
            if action == "import-started":
                interaction = self.database.get_interaction(interaction_id)
                if interaction["status"] == "completed" or (
                    self.database.get_assistant_message_id(interaction_id) is not None
                ):
                    bridge.report_import_result(event, "duplicate")
                elif (
                    interaction["status"] == "importing"
                    and interaction_id in self.clipboard_sequences
                    and self.clipboard_owner == interaction_id
                ):
                    bridge.report_import_result(event, "ready")
            elif action == "import-response":
                bridge.report_import_result(event, "duplicate")
            return
        handled = False
        if action == "prefill-completed":
            handled = self.database.transition_interaction(
                interaction_id, {"dispatched"}, "prefilled"
            )
        elif action == "prefill-failed":
            handled = self.database.transition_interaction(
                interaction_id,
                {"dispatched"},
                "failed",
                error_code=event["code"],
                error_message=event.get("message"),
                finished=True,
            )
        elif action == "response-finished":
            handled = self.database.transition_interaction(
                interaction_id, {"prefilled"}, "awaiting-import"
            )
        elif action == "import-started":
            interaction = self.database.get_interaction(interaction_id)
            if (
                interaction["status"] == "completed"
                or self.database.get_assistant_message_id(interaction_id) is not None
            ):
                bridge.report_import_result(event, "duplicate")
                return
            if not self.acquire_clipboard_lease(interaction_id):
                bridge.report_import_result(event, "failed", "clipboard-busy")
                return
            handled = self.database.transition_interaction(
                interaction_id, {"awaiting-import"}, "importing"
            )
            if handled:
                try:
                    self.clipboard_sequences[interaction_id] = self.clipboard.sequence()
                    bridge.report_import_result(event, "ready")
                except Exception as error:
                    self.clipboard_sequences.pop(interaction_id, None)
                    self.database.transition_interaction(
                        interaction_id,
                        {"importing"},
                        "awaiting-import",
                        error_code="clipboard-unavailable",
                        error_message=str(error)[:512],
                    )
                    with contextlib.suppress(Exception):
                        bridge.report_import_result(
                            event, "failed", "clipboard-unavailable"
                        )
                    self.release_clipboard_lease(interaction_id)
                    return
            else:
                self.release_clipboard_lease(interaction_id)
        elif action == "import-failed":
            handled = self.database.transition_interaction(
                interaction_id,
                {"importing"},
                "awaiting-import",
                error_code=event["code"],
                error_message=event.get("message"),
            )
            if handled:
                self.clipboard_sequences.pop(interaction_id, None)
                self.release_clipboard_lease(interaction_id)
        elif action == "import-response":
            try:
                handled = self.import_response(event, bridge)
            except Exception as error:
                self.clipboard_sequences.pop(interaction_id, None)
                if self.database.get_assistant_message_id(interaction_id) is None:
                    self.database.transition_interaction(
                        interaction_id,
                        {"importing"},
                        "awaiting-import",
                        error_code="import-processing-failed",
                        error_message=str(error)[:512],
                    )
                with contextlib.suppress(Exception):
                    bridge.report_import_result(
                        event, "failed", "import-processing-failed"
                    )
                logger.exception(
                    "Import processing failed interaction=%s", interaction_id
                )
                handled = True
            finally:
                self.release_clipboard_lease(interaction_id)
        if not handled:
            return
        self.event_buffer.publish({"type": "bridge", **event})

    def acquire_clipboard_lease(self, interaction_id: str) -> bool:
        with self.clipboard_lock:
            if self.clipboard_owner not in {None, interaction_id}:
                return False
            self.clipboard_owner = interaction_id
            return True

    def release_clipboard_lease(self, interaction_id: str) -> None:
        with self.clipboard_lock:
            if self.clipboard_owner == interaction_id:
                self.clipboard_owner = None

    def import_response(self, event: dict[str, Any], bridge: EventBridgeLike) -> bool:
        interaction_id = event["interaction_id"]
        if self.database.get_assistant_message_id(interaction_id) is not None:
            bridge.report_import_result(event, "duplicate")
            return False
        interaction = self.database.get_interaction(interaction_id)
        if interaction["status"] != "importing":
            bridge.report_import_result(event, "failed", "import-out-of-order")
            return False
        previous_sequence = self.clipboard_sequences.pop(interaction_id, None)
        if previous_sequence is None:
            self.database.transition_interaction(
                interaction_id,
                {"importing"},
                "awaiting-import",
                error_code="clipboard-start-missing",
                error_message="Clipboard import did not start correctly",
            )
            bridge.report_import_result(event, "failed", "clipboard-start-missing")
            return True
        deadline = time.monotonic() + CLIPBOARD_WAIT_SECONDS
        response = ""
        while time.monotonic() < deadline:
            try:
                if self.clipboard.sequence() != previous_sequence:
                    response = self.clipboard.read_text()
                    if response:
                        break
            except AppError as error:
                if error.code != "clipboard-unavailable":
                    raise
            time.sleep(0.05)
        if not response:
            self.database.transition_interaction(
                interaction_id,
                {"importing"},
                "awaiting-import",
                error_code="clipboard-stale",
                error_message="Native Copy did not produce a new text response",
            )
            bridge.report_import_result(event, "failed", "clipboard-stale")
            return True
        instructions = interaction["structured_instructions_json"]
        import json

        structured = json.loads(instructions)
        parsed = parse_response(response, expected_children_from_prompt(structured))
        completion = self.database.complete_interaction_with_assistant(
            interaction_id,
            response,
            [value.as_dict() for value in parsed.values],
            [warning.as_dict() for warning in parsed.warnings],
        )
        if completion["status"] == "duplicate":
            bridge.report_import_result(event, "duplicate")
            return False
        if completion["status"] != "accepted":
            bridge.report_import_result(event, "failed", "import-out-of-order")
            return False
        message_id = int(completion["messageId"])
        self.event_buffer.publish(
            {
                "type": "chat",
                "action": "assistant-imported",
                "interactionId": interaction_id,
                "messageId": message_id,
            }
        )
        bridge.report_import_result(event, "accepted")
        return True

    def close(self) -> None:
        self.stop_events.set()
        if self.event_thread is not None:
            self.event_thread.join(timeout=2)
        self.ocr_manager.close()


class WebviewApi:
    """The complete and intentionally narrow JavaScript bridge surface."""

    __slots__ = ("_backend",)

    def __init__(self, backend: DesktopApi) -> None:
        # pywebview recursively exposes every public attribute on a js_api object.
        # Keep the backend private so native window objects are never reflected.
        self._backend = backend

    def get_bootstrap_state(self) -> dict[str, Any]:
        return self._backend.get_bootstrap_state()

    def select_directory(self, request: Any) -> dict[str, Any]:
        return self._backend.select_directory(request)

    def start_ocr_job(self, request: Any) -> dict[str, Any]:
        return self._backend.start_ocr_job(request)

    def poll_events(self, request: Any) -> dict[str, Any]:
        return self._backend.poll_events(request)

    def list_documents(self) -> dict[str, Any]:
        return self._backend.list_documents()

    def delete_document(self, request: Any) -> dict[str, Any]:
        return self._backend.delete_document(request)

    def delete_documents(self, request: Any) -> dict[str, Any]:
        return self._backend.delete_documents(request)

    def list_prompts(self) -> dict[str, Any]:
        return self._backend.list_prompts()

    def load_prompt(self, request: Any) -> dict[str, Any]:
        return self._backend.load_prompt(request)

    def save_prompt(self, request: Any) -> dict[str, Any]:
        return self._backend.save_prompt(request)

    def rename_prompt(self, request: Any) -> dict[str, Any]:
        return self._backend.rename_prompt(request)

    def delete_prompt(self, request: Any) -> dict[str, Any]:
        return self._backend.delete_prompt(request)

    def start_interaction(self, request: Any) -> dict[str, Any]:
        return self._backend.start_interaction(request)

    def list_browsers(self) -> dict[str, Any]:
        return self._backend.list_browsers()

    def list_history(self) -> dict[str, Any]:
        return self._backend.list_history()

    def delete_interaction(self, request: Any) -> dict[str, Any]:
        return self._backend.delete_interaction(request)

    def delete_interactions(self, request: Any) -> dict[str, Any]:
        return self._backend.delete_interactions(request)
