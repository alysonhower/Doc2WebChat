from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Protocol, cast

from pypdf import PdfReader
from turboocr import AsyncClient, Client, RetryPolicy
from turboocr.errors import APIConnectionError, ProtocolError

from doc2webchat.database import Database, DatabaseError
from doc2webchat.errors import AppError
from doc2webchat.ocr_contract import (
    OcrDocumentStatus,
    OcrEventStage,
    OcrFileStage,
    OcrFileStatus,
    OcrJobStatus,
)

DEFAULT_BASE_URL = "http://localhost:8000"
DEFAULT_MAX_INFLIGHT = 1
DEFAULT_SERVER_TIMEOUT = 300
MAX_INFLIGHT_LIMIT = 32
MAX_OVERWRITE_CONFLICT_PATHS = 20
PDFA_PROFILE = "pdfa-4"
PDF_HEADER_LIMIT = 1024
SERVER_CONTAINER_NAME = "doc2webchat-turboocr"
SERVER_CONTAINER_LABEL = "doc2webchat.managed"
SERVER_CONTAINER_CONFIG_LABEL = "doc2webchat.managed.config"
SERVER_CONTAINER_CONFIG_VERSION = "cpu-single-pipeline-v1"
SERVER_CONTAINER_IMAGE = "ghcr.io/aiptimizer/turboocr-cpu:latest"
SERVER_CACHE_NAME = "doc2webchat-trt-cache"
SERVER_CACHE_TARGET = "/home/ocr/.cache/turbo-ocr"
SERVER_IMAGE_PULL_ATTEMPTS = 3
SERVER_IMAGE_PULL_TIMEOUT = 1800
SERVER_IMAGE_PULL_RETRY_DELAYS = (1.0, 2.0)
SERVER_PIPELINE_POOL_SIZE = 1
TRANSIENT_DOCKER_PULL_ERRORS = (
    "connection refused",
    "connection reset",
    "context deadline exceeded",
    "eof",
    "i/o timeout",
    "network is unreachable",
    "no such host",
    "server misbehaving",
    "service unavailable",
    "temporary failure",
    "tls handshake timeout",
    "too many requests",
)
SOURCE_SUFFIXES = frozenset(
    {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp", ".pdf"}
)
logger = logging.getLogger(__name__)


class AsyncSourceClient(Protocol):
    async def make_searchable_pdf(self, source: Path, *, profile: str) -> bytes: ...


class AsyncClientContext(Protocol):
    async def __aenter__(self) -> AsyncSourceClient: ...

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: Any,
    ) -> None: ...


class OutputPolicy(Enum):
    ERROR = "error"
    OVERWRITE = "overwrite"
    SKIP = "skip"


class ProcessingStatus(Enum):
    WRITTEN = "written"
    SKIPPED = "skipped"
    FAILED = "failed"


class DestinationKind(Enum):
    MISSING = "missing"
    REGULAR = "regular"
    SYMBOLIC_LINK = "symbolic-link"
    OTHER = "other"


class ServerReadiness(Enum):
    READY = "ready"
    STARTING = "starting"
    GATEWAY_UNAVAILABLE = "gateway-unavailable"
    UNAVAILABLE = "unavailable"


class ServerLifecycleError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProcessingTask:
    source_path: Path
    output_path: Path


@dataclass(frozen=True)
class ProcessingResult:
    source_path: Path
    output_path: Path
    status: ProcessingStatus
    error: BaseException | None = None


@dataclass(frozen=True)
class OutputPlan:
    tasks: list[ProcessingTask]
    skipped_results: list[ProcessingResult]


class OutputConflictError(ValueError):
    def __init__(self, conflicting_tasks: Sequence[ProcessingTask]) -> None:
        self.conflicting_tasks = tuple(conflicting_tasks)
        self.conflicting_outputs = tuple(
            task.output_path for task in self.conflicting_tasks
        )
        super().__init__(
            "Output preflight failed:\n"
            + "\n".join(
                f"- Output already exists: {task.output_path}"
                for task in self.conflicting_tasks
            )
        )


@dataclass(frozen=True)
class ProcessedDocument:
    task: ProcessingTask
    status: ProcessingStatus
    text: str | None


@dataclass(frozen=True)
class OcrJobRequest:
    input_path: Path
    output_path: Path
    recursive: bool
    policy: OutputPolicy
    approved_overwrites: frozenset[str] = frozenset()
    base_url: str = DEFAULT_BASE_URL
    server_timeout: int = DEFAULT_SERVER_TIMEOUT


@dataclass(frozen=True)
class ManagedContainer:
    running: bool
    status: str
    exit_code: int
    configuration_matches: bool = True


def add_extended_path_prefix(path: Path) -> Path:
    value = str(path)
    if sys.platform != "win32" or value.startswith("\\\\?\\"):
        return path
    if value.startswith("\\\\"):
        return Path(f"\\\\?\\UNC\\{value[2:]}")
    return Path(f"\\\\?\\{value}")


def to_extended_path(path: Path) -> Path:
    return add_extended_path_prefix(path.resolve())


def to_extended_destination_path(path: Path) -> Path:
    return add_extended_path_prefix(path.parent.resolve() / path.name)


def remove_extended_path_prefix(path: Path) -> Path:
    value = str(path)
    unc_prefix = "\\\\?\\UNC\\"
    extended_prefix = "\\\\?\\"
    if value.startswith(unc_prefix):
        value = f"\\\\{value[len(unc_prefix) :]}"
    elif value.startswith(extended_prefix):
        value = value[len(extended_prefix) :]
    return Path(value)


def lexical_absolute_path(path: Path) -> Path:
    return remove_extended_path_prefix(path).expanduser().absolute()


def to_normal_path(path: Path) -> Path:
    return remove_extended_path_prefix(path).resolve()


def path_key(path: Path) -> str:
    return os.path.normcase(os.path.normpath(str(path)))


def output_approval_key(path: Path) -> str:
    return path_key(lexical_absolute_path(path))


def path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def reject_symbolic_path(path: Path, description: str) -> None:
    candidate = remove_extended_path_prefix(path).expanduser().absolute()
    while True:
        try:
            mode = add_extended_path_prefix(candidate).lstat().st_mode
        except FileNotFoundError:
            mode = 0
        if stat.S_ISLNK(mode):
            raise ValueError(f"{description} is a symbolic link: {candidate}")
        if candidate.parent == candidate:
            return
        candidate = candidate.parent


def discover_sources(
    input_dir: Path, output_dir: Path | None = None, recursive: bool = False
) -> list[Path]:
    reject_symbolic_path(input_dir, "Input path")
    readable_input = to_extended_path(input_dir)
    if not readable_input.is_dir():
        raise NotADirectoryError(f"Input directory not found: {input_dir}")
    skipped_output: Path | None = None
    if output_dir is not None and recursive:
        writable_output = to_extended_path(output_dir)
        if writable_output != readable_input and path_is_relative_to(
            writable_output, readable_input
        ):
            skipped_output = writable_output
    candidates = readable_input.rglob("*") if recursive else readable_input.iterdir()
    sources: list[Path] = []
    for path in candidates:
        if path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(mode):
            raise ValueError(f"Source path is a symbolic link: {path}")
        if not stat.S_ISREG(mode):
            continue
        if skipped_output is not None and path_is_relative_to(path, skipped_output):
            continue
        sources.append(lexical_absolute_path(path))
    return sorted(sources, key=path_key)


def ensure_output_dir(output_dir: Path) -> Path:
    reject_symbolic_path(output_dir, "Output path")
    writable_output = to_extended_path(output_dir)
    writable_output.mkdir(parents=True, exist_ok=True)
    if not writable_output.is_dir():
        raise NotADirectoryError(f"Output directory is not a directory: {output_dir}")
    return writable_output


def build_output_path(
    source_path: Path, input_dir: Path, output_dir: Path, recursive: bool
) -> Path:
    if recursive:
        relative = source_path.relative_to(input_dir)
        return output_dir / relative.with_suffix(".pdf")
    return output_dir / source_path.with_suffix(".pdf").name


def classify_destination(path: Path) -> DestinationKind:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return DestinationKind.MISSING
    if stat.S_ISLNK(mode):
        return DestinationKind.SYMBOLIC_LINK
    if stat.S_ISREG(mode):
        return DestinationKind.REGULAR
    return DestinationKind.OTHER


def unsafe_destination_message(kind: DestinationKind, output_path: Path) -> str | None:
    if kind is DestinationKind.SYMBOLIC_LINK:
        return f"Output path is a symbolic link: {output_path}"
    if kind is DestinationKind.OTHER:
        return f"Output path is not a regular file: {output_path}"
    return None


def build_output_plan(
    sources: Sequence[Path],
    input_dir: Path,
    output_dir: Path,
    recursive: bool,
    policy: OutputPolicy,
    approved_overwrites: frozenset[str] = frozenset(),
) -> OutputPlan:
    reject_symbolic_path(output_dir, "Output path")
    normal_input_dir = to_normal_path(input_dir)
    normal_output_dir = to_normal_path(output_dir)
    normal_sources = [lexical_absolute_path(source) for source in sources]
    all_tasks = [
        ProcessingTask(
            source,
            build_output_path(source, normal_input_dir, normal_output_dir, recursive),
        )
        for source in normal_sources
    ]
    grouped: dict[str, list[ProcessingTask]] = {}
    for task in all_tasks:
        destination = to_extended_destination_path(task.output_path)
        grouped.setdefault(path_key(destination), []).append(task)
    duplicate_keys = {key for key, tasks in grouped.items() if len(tasks) > 1}
    errors = [
        "Multiple sources map to "
        + f"{tasks[0].output_path}: "
        + ", ".join(str(task.source_path) for task in tasks)
        for key, tasks in grouped.items()
        if key in duplicate_keys
    ]
    existing_output_tasks: list[ProcessingTask] = []
    unapproved_conflicts: list[ProcessingTask] = []
    source_keys = {path_key(to_extended_path(source)) for source in normal_sources}
    tasks: list[ProcessingTask] = []
    skipped: list[ProcessingResult] = []
    for task in all_tasks:
        destination = to_extended_destination_path(task.output_path)
        destination_key = path_key(destination)
        if destination_key in source_keys:
            errors.append(f"Refusing to overwrite input file: {task.output_path}")
            continue
        if destination_key in duplicate_keys:
            continue
        message = unsafe_destination_message(
            classify_destination(destination), task.output_path
        )
        if message is not None:
            errors.append(message)
            continue
        if destination.exists():
            if policy is OutputPolicy.ERROR:
                existing_output_tasks.append(task)
                if output_approval_key(task.output_path) not in approved_overwrites:
                    unapproved_conflicts.append(task)
                    errors.append(f"Output already exists: {task.output_path}")
                    continue
            if policy is OutputPolicy.SKIP:
                skipped.append(
                    ProcessingResult(
                        task.source_path, task.output_path, ProcessingStatus.SKIPPED
                    )
                )
                continue
        tasks.append(task)
    if errors:
        if len(errors) == len(unapproved_conflicts):
            raise OutputConflictError(existing_output_tasks)
        raise ValueError(
            "Output preflight failed:\n" + "\n".join(f"- {item}" for item in errors)
        )
    return OutputPlan(tasks, skipped)


def validate_pdf_content(content: bytes) -> None:
    header = content.find(b"%PDF-", 0, PDF_HEADER_LIMIT + 4)
    if header < 0 or header >= PDF_HEADER_LIMIT:
        raise ValueError("Invalid PDF: header not found within the first 1024 bytes")
    if not content.rstrip().endswith(b"%%EOF"):
        raise ValueError("Invalid PDF: end marker not found")


def reject_unsafe_destination(kind: DestinationKind, output_path: Path) -> None:
    message = unsafe_destination_message(kind, output_path)
    if message is not None:
        raise OSError(message)


def existing_output_status(
    kind: DestinationKind, output_path: Path, policy: OutputPolicy
) -> ProcessingStatus | None:
    reject_unsafe_destination(kind, output_path)
    if kind is not DestinationKind.REGULAR:
        return None
    if policy is OutputPolicy.SKIP:
        return ProcessingStatus.SKIPPED
    if policy is OutputPolicy.ERROR:
        raise FileExistsError(f"Output already exists: {output_path}")
    return None


def publish_without_overwrite(temporary_path: Path, output_path: Path) -> None:
    if sys.platform == "win32":
        os.rename(temporary_path, output_path)
        return
    os.link(temporary_path, output_path)
    temporary_path.unlink()


def write_pdf_atomically(
    content: bytes, output_path: Path, policy: OutputPolicy
) -> ProcessingStatus:
    validate_pdf_content(content)
    reject_symbolic_path(output_path.parent, "Output path")
    writable_output = to_extended_destination_path(output_path)
    writable_output.parent.mkdir(parents=True, exist_ok=True)
    initial_status = existing_output_status(
        classify_destination(writable_output), output_path, policy
    )
    if initial_status is not None:
        return initial_status
    temporary_path: Path | None = None
    try:
        with NamedTemporaryFile(
            mode="wb",
            dir=writable_output.parent,
            prefix=".ocr-",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = add_extended_path_prefix(Path(temporary_file.name))
            written = temporary_file.write(content)
            if written != len(content):
                raise OSError(f"Could not write complete PDF/A-4 file: {output_path}")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        if temporary_path.stat().st_size != len(content):
            raise OSError(f"Could not write complete PDF/A-4 file: {output_path}")
        destination_kind = classify_destination(writable_output)
        reject_unsafe_destination(destination_kind, output_path)
        if policy is OutputPolicy.OVERWRITE:
            os.replace(temporary_path, writable_output)
            temporary_path = None
            return ProcessingStatus.WRITTEN
        current_status = existing_output_status(destination_kind, output_path, policy)
        if current_status is not None:
            return current_status
        try:
            publish_without_overwrite(temporary_path, writable_output)
            temporary_path = None
        except FileExistsError as error:
            raced_kind = classify_destination(writable_output)
            reject_unsafe_destination(raced_kind, output_path)
            if policy is OutputPolicy.SKIP and raced_kind is DestinationKind.REGULAR:
                return ProcessingStatus.SKIPPED
            raise FileExistsError(f"Output already exists: {output_path}") from error
        return ProcessingStatus.WRITTEN
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def extract_pdf_text(output_path: Path) -> str:
    reader = PdfReader(to_extended_path(output_path))
    page_texts = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(value for value in page_texts if value)


async def process_task(
    client: AsyncSourceClient,
    task: ProcessingTask,
    policy: OutputPolicy,
    on_stage: Callable[[OcrFileStage], None],
) -> ProcessedDocument:
    reject_symbolic_path(task.source_path, "Source path")
    readable_source = to_extended_path(task.source_path)
    writable_output = to_extended_destination_path(task.output_path)
    if path_key(readable_source) == path_key(writable_output):
        raise ValueError(f"Refusing to overwrite input file: {task.source_path}")
    try:
        source_mode = readable_source.lstat().st_mode
    except FileNotFoundError as error:
        raise FileNotFoundError(
            f"Source file disappeared: {task.source_path}"
        ) from error
    if stat.S_ISLNK(source_mode):
        raise ValueError(f"Source path is a symbolic link: {task.source_path}")
    if not stat.S_ISREG(source_mode):
        raise ValueError(f"Source path is not a regular file: {task.source_path}")
    on_stage(OcrFileStage.OCR_PROCESSING)
    content = await client.make_searchable_pdf(readable_source, profile=PDFA_PROFILE)
    on_stage(OcrFileStage.WRITING)
    status = write_pdf_atomically(content, task.output_path, policy)
    if status is ProcessingStatus.SKIPPED:
        return ProcessedDocument(task, status, None)
    on_stage(OcrFileStage.EXTRACTING)
    reject_symbolic_path(task.output_path, "Output path")
    published_output = to_extended_destination_path(task.output_path)
    if classify_destination(published_output) is not DestinationKind.REGULAR:
        raise OSError(f"Published output is not a regular file: {task.output_path}")
    text = extract_pdf_text(task.output_path)
    return ProcessedDocument(task, status, text)


def run_command(
    arguments: list[str], timeout: float
) -> subprocess.CompletedProcess[str]:
    if timeout <= 0:
        raise ServerLifecycleError("Command timed out before starting")
    try:
        return subprocess.run(
            arguments,
            capture_output=True,
            shell=False,
            check=False,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise ServerLifecycleError(
            "Docker was not found. Install Docker Desktop and ensure its CLI is on PATH."
        ) from error
    except subprocess.TimeoutExpired as error:
        raise ServerLifecycleError(
            f"Command timed out: {' '.join(arguments)}"
        ) from error


def require_success(
    result: subprocess.CompletedProcess[str], action: str
) -> subprocess.CompletedProcess[str]:
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        suffix = f": {detail}" if detail else ""
        raise ServerLifecycleError(f"{action} failed{suffix}")
    return result


def command_error_detail(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stderr or result.stdout).strip()


def is_transient_pull_failure(result: subprocess.CompletedProcess[str]) -> bool:
    detail = command_error_detail(result).lower()
    return any(marker in detail for marker in TRANSIENT_DOCKER_PULL_ERRORS)


def ensure_managed_image(deadline: float) -> None:
    inspect_result = run_command(
        ["docker", "image", "inspect", SERVER_CONTAINER_IMAGE],
        deadline - time.monotonic(),
    )
    if inspect_result.returncode == 0:
        return
    inspect_detail = command_error_detail(inspect_result).lower()
    if "no such image" not in inspect_detail and "no such object" not in inspect_detail:
        require_success(inspect_result, "Inspecting managed TurboOCR image")

    for attempt in range(1, SERVER_IMAGE_PULL_ATTEMPTS + 1):
        pull_result = run_command(
            ["docker", "pull", SERVER_CONTAINER_IMAGE],
            deadline - time.monotonic(),
        )
        if pull_result.returncode == 0:
            return
        action = "Pulling managed TurboOCR image"
        if attempt > 1:
            action = f"{action} after {attempt} attempts"
        if attempt == SERVER_IMAGE_PULL_ATTEMPTS or not is_transient_pull_failure(
            pull_result
        ):
            require_success(pull_result, action)
        delay = SERVER_IMAGE_PULL_RETRY_DELAYS[attempt - 1]
        if deadline - time.monotonic() <= delay:
            require_success(pull_result, action)
        time.sleep(delay)


def create_managed_container(timeout: float) -> None:
    ensure_managed_image(time.monotonic() + SERVER_IMAGE_PULL_TIMEOUT)
    deadline = time.monotonic() + timeout
    command = [
        "docker",
        "run",
        "--detach",
        "--name",
        SERVER_CONTAINER_NAME,
        "--label",
        f"{SERVER_CONTAINER_LABEL}=true",
        "--label",
        f"{SERVER_CONTAINER_CONFIG_LABEL}={SERVER_CONTAINER_CONFIG_VERSION}",
        "--env",
        f"PIPELINE_POOL_SIZE={SERVER_PIPELINE_POOL_SIZE}",
        "--publish",
        "127.0.0.1:8000:8000",
        "--publish",
        "127.0.0.1:50051:50051",
        "--volume",
        f"{SERVER_CACHE_NAME}:{SERVER_CACHE_TARGET}",
        "--pull",
        "never",
        SERVER_CONTAINER_IMAGE,
    ]
    require_success(
        run_command(command, deadline - time.monotonic()),
        "Starting managed TurboOCR container",
    )


def require_mapping(value: object, description: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ServerLifecycleError(f"Docker returned invalid {description}")
    return cast(dict[str, object], value)


def require_list(value: object, description: str) -> list[object]:
    if not isinstance(value, list):
        raise ServerLifecycleError(f"Docker returned invalid {description}")
    return cast(list[object], value)


def validate_port_binding(
    bindings: dict[str, object], container_port: str, host_port: str
) -> None:
    values = require_list(bindings.get(container_port), f"binding for {container_port}")
    if len(values) != 1:
        raise ServerLifecycleError("Managed container has unexpected port bindings")
    binding = require_mapping(values[0], f"binding for {container_port}")
    if binding.get("HostPort") != host_port or binding.get("HostIp") not in {
        "127.0.0.1",
        "::1",
    }:
        raise ServerLifecycleError("Managed container ports must be loopback-only")


def parse_managed_container(value: object) -> ManagedContainer:
    container = require_mapping(value, "container configuration")
    if container.get("Name") != f"/{SERVER_CONTAINER_NAME}":
        raise ServerLifecycleError("Managed container has an unexpected name")
    config = require_mapping(container.get("Config"), "container config")
    labels = require_mapping(config.get("Labels"), "container labels")
    if config.get("Image") != SERVER_CONTAINER_IMAGE:
        raise ServerLifecycleError(
            "Managed container image conflicts with required image"
        )
    if labels.get(SERVER_CONTAINER_LABEL) != "true":
        raise ServerLifecycleError("Container name belongs to an unmanaged container")
    environment = require_list(config.get("Env"), "container environment")
    if any(not isinstance(value, str) for value in environment):
        raise ServerLifecycleError("Managed container environment is invalid")
    configuration_matches = (
        labels.get(SERVER_CONTAINER_CONFIG_LABEL) == SERVER_CONTAINER_CONFIG_VERSION
        and f"PIPELINE_POOL_SIZE={SERVER_PIPELINE_POOL_SIZE}" in environment
    )
    host_config = require_mapping(container.get("HostConfig"), "host config")
    bindings = require_mapping(host_config.get("PortBindings"), "port bindings")
    if set(bindings) != {"8000/tcp", "50051/tcp"}:
        raise ServerLifecycleError("Managed container has unexpected published ports")
    validate_port_binding(bindings, "8000/tcp", "8000")
    validate_port_binding(bindings, "50051/tcp", "50051")
    mounts = require_list(container.get("Mounts"), "container mounts")
    expected_mount = any(
        isinstance(mount, dict)
        and mount.get("Type") == "volume"
        and mount.get("Name") == SERVER_CACHE_NAME
        and mount.get("Destination") == SERVER_CACHE_TARGET
        for mount in mounts
    )
    if not expected_mount or len(mounts) != 1:
        raise ServerLifecycleError("Managed container cache volume is invalid")
    state = require_mapping(container.get("State"), "container state")
    running = state.get("Running")
    status = state.get("Status")
    exit_code = state.get("ExitCode")
    if (
        not isinstance(running, bool)
        or not isinstance(status, str)
        or not isinstance(exit_code, int)
    ):
        raise ServerLifecycleError("Managed container state is invalid")
    return ManagedContainer(running, status, exit_code, configuration_matches)


def inspect_managed_container(timeout: float) -> ManagedContainer | None:
    result = run_command(
        ["docker", "container", "inspect", SERVER_CONTAINER_NAME], timeout
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).lower()
        if "no such container" in detail or "no such object" in detail:
            return None
        raise ServerLifecycleError("Could not inspect managed TurboOCR container")
    try:
        values = require_list(json.loads(result.stdout), "container inspection result")
    except json.JSONDecodeError as error:
        raise ServerLifecycleError("Docker returned invalid container JSON") from error
    if len(values) != 1:
        raise ServerLifecycleError("Docker returned an unexpected container count")
    return parse_managed_container(values[0])


def container_log_tail(timeout: float = 5) -> str:
    try:
        result = run_command(
            ["docker", "logs", "--tail", "50", SERVER_CONTAINER_NAME], timeout
        )
    except ServerLifecycleError:
        return ""
    if result.returncode != 0:
        return ""
    combined = "\n".join(value for value in (result.stdout, result.stderr) if value)
    return combined[-4096:].strip()


def stopped_container_error(container: ManagedContainer) -> ServerLifecycleError:
    detail = (
        "Managed TurboOCR container stopped while starting "
        f"(status {container.status}, exit code {container.exit_code})"
    )
    logs = container_log_tail()
    if logs:
        detail = f"{detail}\nContainer logs:\n{logs}"
    return ServerLifecycleError(detail)


def probe_server_readiness(base_url: str, timeout: float) -> ServerReadiness:
    try:
        with Client(
            base_url=base_url,
            timeout=timeout,
            retry=RetryPolicy(attempts=1),
        ) as client:
            health = client.health(ready=True)
    except ProtocolError as error:
        raise ServerLifecycleError(
            "TurboOCR returned an invalid health response"
        ) from error
    except APIConnectionError:
        return ServerReadiness.UNAVAILABLE
    if health.ok and health.status_code == 200:
        return ServerReadiness.READY
    if health.status_code == 503:
        return ServerReadiness.STARTING
    if health.status_code == 502:
        return ServerReadiness.GATEWAY_UNAVAILABLE
    raise ServerLifecycleError(
        f"TurboOCR readiness check returned HTTP {health.status_code}"
    )


def ensure_docker(timeout: float) -> None:
    result = run_command(["docker", "info", "--format", "{{.OSType}}"], timeout)
    if result.returncode == 0:
        if result.stdout.strip().lower() != "linux":
            raise ServerLifecycleError("TurboOCR requires a Linux Docker engine")
        return
    if sys.platform != "win32":
        require_success(result, "Connecting to Docker")
    require_success(
        run_command(["docker", "desktop", "start"], timeout),
        "Starting Docker Desktop",
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = run_command(
            ["docker", "info", "--format", "{{.OSType}}"],
            max(1, deadline - time.monotonic()),
        )
        if result.returncode == 0:
            if result.stdout.strip().lower() != "linux":
                raise ServerLifecycleError("TurboOCR requires a Linux Docker engine")
            return
        time.sleep(1)
    raise ServerLifecycleError("Docker Desktop did not become ready")


def ensure_server_ready(base_url: str, timeout: int) -> None:
    normalized = base_url.rstrip("/")
    deadline = time.monotonic() + timeout
    initial = probe_server_readiness(normalized, min(2, timeout))
    managed = False
    container: ManagedContainer | None = None
    if initial is ServerReadiness.READY:
        return
    if initial is ServerReadiness.GATEWAY_UNAVAILABLE:
        raise ServerLifecycleError(
            f"TurboOCR readiness check at {normalized} returned HTTP 502"
        )
    if initial is ServerReadiness.UNAVAILABLE:
        if normalized != DEFAULT_BASE_URL:
            raise ServerLifecycleError(
                f"TurboOCR server at {normalized} is unavailable; managed startup is local only"
            )
        ensure_docker(max(1, deadline - time.monotonic()))
        container = inspect_managed_container(max(1, deadline - time.monotonic()))
    elif initial is ServerReadiness.STARTING and normalized == DEFAULT_BASE_URL:
        try:
            container = inspect_managed_container(max(1, deadline - time.monotonic()))
        except ServerLifecycleError as error:
            if str(error) not in {
                "Could not inspect managed TurboOCR container",
                "Docker was not found. Install Docker Desktop and ensure its CLI is on PATH.",
            }:
                raise
    if initial is ServerReadiness.UNAVAILABLE or container is not None:
        if container is None:
            create_managed_container(timeout)
            deadline = time.monotonic() + timeout
        elif not container.configuration_matches:
            require_success(
                run_command(
                    ["docker", "rm", "--force", SERVER_CONTAINER_NAME],
                    max(1, deadline - time.monotonic()),
                ),
                "Replacing outdated managed TurboOCR container",
            )
            create_managed_container(timeout)
            deadline = time.monotonic() + timeout
        elif not container.running:
            if container.status not in {"created", "exited"}:
                raise ServerLifecycleError(
                    f"Managed TurboOCR container cannot start from {container.status}"
                )
            require_success(
                run_command(
                    ["docker", "start", SERVER_CONTAINER_NAME],
                    max(1, deadline - time.monotonic()),
                ),
                "Restarting managed TurboOCR container",
            )
        managed = True
    while time.monotonic() < deadline:
        if managed:
            container = inspect_managed_container(max(1, deadline - time.monotonic()))
            if container is None:
                raise ServerLifecycleError(
                    "Managed TurboOCR container disappeared while starting"
                )
            if not container.running:
                raise stopped_container_error(container)
        time.sleep(min(1, max(0, deadline - time.monotonic())))
        readiness = probe_server_readiness(
            normalized, min(2, max(0.1, deadline - time.monotonic()))
        )
        if readiness is ServerReadiness.READY:
            return
        if readiness is ServerReadiness.GATEWAY_UNAVAILABLE and not managed:
            raise ServerLifecycleError("TurboOCR gateway is unavailable")
    raise ServerLifecycleError(
        f"TurboOCR server did not become ready within {timeout} seconds"
    )


class OcrManager:
    def __init__(
        self,
        database: Database,
        emit: Callable[[dict[str, Any]], None],
        *,
        client_factory: Callable[..., Any] = AsyncClient,
        ensure_ready: Callable[[str, int], None] = ensure_server_ready,
        max_inflight: int = DEFAULT_MAX_INFLIGHT,
    ) -> None:
        self.database = database
        self.emit = emit
        self.client_factory = client_factory
        self.ensure_ready = ensure_ready
        self.max_inflight = min(max(1, max_inflight), MAX_INFLIGHT_LIMIT)
        self.active_lock = threading.Lock()
        self.active_thread: threading.Thread | None = None
        self.active_job_id: int | None = None

    def start_job(self, request: OcrJobRequest) -> int:
        with self.active_lock:
            if self.active_job_id is not None:
                raise AppError("ocr-job-active", "Only one OCR batch can run at a time")
            job_id = self.database.create_ocr_job(
                str(request.input_path),
                str(request.output_path),
                request.recursive,
                request.policy.value,
            )
            thread = threading.Thread(
                target=self.run_job_thread,
                args=(job_id, request),
                name=f"doc2webchat-ocr-{job_id}",
                daemon=True,
            )
            self.active_thread = thread
            self.active_job_id = job_id
            thread.start()
            return job_id

    def run_job_thread(self, job_id: int, request: OcrJobRequest) -> None:
        deferred_event: dict[str, Any] | None = None
        try:
            deferred_event = asyncio.run(
                self.run_job(job_id, request, defer_overwrite_event=True)
            )
        except Exception:
            logger.exception("Unhandled OCR job thread failure")
        finally:
            with self.active_lock:
                if self.active_job_id == job_id:
                    self.active_job_id = None
                if self.active_thread is threading.current_thread():
                    self.active_thread = None
        if deferred_event is not None:
            try:
                self.emit_ocr_event(deferred_event)
            except Exception:
                logger.exception("Could not emit deferred OCR overwrite confirmation")

    def emit_ocr_event(self, event: dict[str, Any]) -> None:
        if event.get("type") != "ocr":
            raise TypeError("OCR event type must be 'ocr'")
        try:
            stage = OcrEventStage(event.get("stage"))
        except (TypeError, ValueError) as error:
            raise TypeError("OCR event stage must be an OcrEventStage") from error
        if stage is OcrEventStage.JOB_FINISHED:
            try:
                status = OcrJobStatus(event.get("status"))
            except (TypeError, ValueError) as error:
                raise TypeError("Finished OCR event status is invalid") from error
            if status not in {
                OcrJobStatus.COMPLETED,
                OcrJobStatus.COMPLETED_WITH_ERRORS,
            }:
                raise TypeError("Finished OCR event status is invalid")
        self.emit(event)

    def job_event(self, job_id: int, stage: OcrEventStage, **values: Any) -> None:
        if not isinstance(stage, OcrEventStage):
            raise TypeError("OCR event stage must be an OcrEventStage")
        self.emit_ocr_event(
            {"type": "ocr", "jobId": job_id, "stage": stage.value, **values}
        )

    async def run_job(
        self,
        job_id: int,
        request: OcrJobRequest,
        *,
        defer_overwrite_event: bool = False,
    ) -> dict[str, Any] | None:
        try:
            self.database.update_ocr_job(job_id, OcrJobStatus.DISCOVERING)
            self.job_event(job_id, OcrEventStage.DISCOVERY, determinate=False)
            ensure_output_dir(request.output_path)
            sources = discover_sources(
                request.input_path, request.output_path, request.recursive
            )
            self.database.update_ocr_job(job_id, OcrJobStatus.PLANNING)
            self.job_event(job_id, OcrEventStage.PLAN_VALIDATION, determinate=False)
            try:
                plan = build_output_plan(
                    sources,
                    request.input_path.resolve(),
                    request.output_path,
                    request.recursive,
                    request.policy,
                    request.approved_overwrites,
                )
            except OutputConflictError as conflict:
                for task in conflict.conflicting_tasks:
                    self.database.create_ocr_job_file(
                        job_id,
                        str(task.source_path),
                        str(task.output_path),
                        OcrFileStage.AWAITING_OVERWRITE,
                    )
                self.database.update_ocr_job(
                    job_id,
                    OcrJobStatus.AWAITING_OVERWRITE,
                    total_files=len(sources),
                    finished=True,
                )
                event = {
                    "type": "ocr",
                    "jobId": job_id,
                    "stage": OcrEventStage.OVERWRITE_CONFIRMATION_REQUIRED.value,
                    "overwriteConfirmationJobId": job_id,
                    "inputPath": str(request.input_path),
                    "outputPath": str(request.output_path),
                    "recursive": request.recursive,
                    "conflictCount": len(conflict.conflicting_tasks),
                    "conflictingOutputs": [
                        str(path)
                        for path in conflict.conflicting_outputs[
                            :MAX_OVERWRITE_CONFLICT_PATHS
                        ]
                    ],
                }
                if defer_overwrite_event:
                    return event
                self.emit_ocr_event(event)
                return None
            total = len(plan.tasks) + len(plan.skipped_results)
            self.database.update_ocr_job(
                job_id, OcrJobStatus.PLANNING, total_files=total
            )
            completed = 0
            failed = 0
            skipped = 0
            for result in plan.skipped_results:
                file_id = self.database.create_ocr_job_file(
                    job_id,
                    str(result.source_path),
                    str(result.output_path),
                    OcrFileStage.SKIPPED,
                )
                self.database.update_ocr_job_file(
                    file_id, OcrFileStage.SKIPPED, OcrFileStatus.SKIPPED
                )
                skipped += 1
                completed += 1
                self.job_event(
                    job_id,
                    OcrEventStage.SKIPPED,
                    file=str(result.source_path),
                    completed=completed,
                    total=total,
                )
            self.database.update_ocr_job(
                job_id,
                OcrJobStatus.PLANNING,
                completed_files=completed,
                skipped_files=skipped,
            )
            task_files = [
                (
                    self.database.create_ocr_job_file(
                        job_id, str(task.source_path), str(task.output_path)
                    ),
                    task,
                )
                for task in plan.tasks
            ]
            for _, task in task_files:
                self.job_event(
                    job_id,
                    OcrEventStage.QUEUED,
                    file=str(task.source_path),
                    total=total,
                )
            if not plan.tasks:
                self.database.update_ocr_job(
                    job_id,
                    OcrJobStatus.COMPLETED,
                    completed_files=completed,
                    skipped_files=skipped,
                    finished=True,
                )
                self.job_event(
                    job_id,
                    OcrEventStage.JOB_FINISHED,
                    status=OcrJobStatus.COMPLETED.value,
                    completed=completed,
                    failed=failed,
                    skipped=skipped,
                    total=total,
                )
                return
            self.database.update_ocr_job(job_id, OcrJobStatus.STARTING_SERVER)
            self.job_event(job_id, OcrEventStage.SERVER_STARTUP, determinate=False)
            await asyncio.to_thread(
                self.ensure_ready, request.base_url, request.server_timeout
            )
            self.database.update_ocr_job(job_id, OcrJobStatus.RUNNING)
            semaphore = asyncio.Semaphore(self.max_inflight)
            async with self.client_factory(base_url=request.base_url) as client:

                async def execute(
                    file_id: int, task: ProcessingTask
                ) -> tuple[
                    int,
                    ProcessingTask,
                    OcrFileStage,
                    ProcessedDocument | None,
                    Exception | None,
                ]:
                    async with semaphore:
                        current_stage = OcrFileStage.QUEUED

                        def record_stage(stage: OcrFileStage) -> None:
                            nonlocal current_stage
                            current_stage = stage
                            self.handle_file_stage(job_id, file_id, task, stage)

                        try:
                            result = await process_task(
                                client,
                                task,
                                (
                                    OutputPolicy.OVERWRITE
                                    if request.policy is OutputPolicy.ERROR
                                    and output_approval_key(task.output_path)
                                    in request.approved_overwrites
                                    else request.policy
                                ),
                                record_stage,
                            )
                            return file_id, task, current_stage, result, None
                        except Exception as error:
                            return file_id, task, current_stage, None, error

                pending = [
                    asyncio.create_task(execute(file_id, task))
                    for file_id, task in task_files
                ]
                for future in asyncio.as_completed(pending):
                    file_id, task, failure_stage, result, error = await future
                    completed += 1
                    if error is not None:
                        failed += 1
                        message = str(error)[:2048]
                        failure_status = {
                            OcrFileStage.OCR_PROCESSING: OcrDocumentStatus.OCR_FAILED,
                            OcrFileStage.WRITING: OcrDocumentStatus.WRITE_FAILED,
                            OcrFileStage.EXTRACTING: OcrDocumentStatus.EXTRACT_FAILED,
                        }.get(failure_stage, OcrDocumentStatus.PROCESSING_FAILED)
                        self.database.update_ocr_job_file(
                            file_id,
                            failure_stage,
                            OcrFileStatus.FAILED,
                            error=message,
                        )
                        self.database.record_document_failure(
                            str(task.source_path),
                            failure_status,
                            message,
                            job_id,
                            output_path=str(task.output_path),
                        )
                        self.job_event(
                            job_id,
                            OcrEventStage.FAILED,
                            file=str(task.source_path),
                            failedStage=failure_stage.value,
                            error=message,
                        )
                    elif result is None:
                        raise RuntimeError("OCR task returned no result")
                    elif result.status is ProcessingStatus.SKIPPED:
                        skipped += 1
                        self.database.update_ocr_job_file(
                            file_id, OcrFileStage.SKIPPED, OcrFileStatus.SKIPPED
                        )
                        self.job_event(
                            job_id,
                            OcrEventStage.SKIPPED,
                            file=str(task.source_path),
                        )
                    elif not result.text or not result.text.strip():
                        failed += 1
                        message = "No searchable text could be extracted from the published PDF"
                        self.database.update_ocr_job_file(
                            file_id,
                            OcrFileStage.EXTRACTING,
                            OcrFileStatus.FAILED,
                            error=message,
                        )
                        self.database.record_document_failure(
                            str(task.source_path),
                            OcrDocumentStatus.EXTRACT_FAILED,
                            message,
                            job_id,
                            output_path=str(task.output_path),
                        )
                        self.job_event(
                            job_id,
                            OcrEventStage.FAILED,
                            file=str(task.source_path),
                            error=message,
                        )
                    else:
                        self.handle_file_stage(
                            job_id, file_id, task, OcrFileStage.PERSISTING
                        )
                        self.database.record_document_success(
                            str(task.source_path),
                            str(task.output_path),
                            result.text,
                            job_id,
                        )
                        self.database.update_ocr_job_file(
                            file_id,
                            OcrFileStage.COMPLETED,
                            OcrFileStatus.COMPLETED,
                        )
                        self.job_event(
                            job_id,
                            OcrEventStage.COMPLETED,
                            file=str(task.source_path),
                        )
                    self.database.update_ocr_job(
                        job_id,
                        OcrJobStatus.RUNNING,
                        completed_files=completed,
                        failed_files=failed,
                        skipped_files=skipped,
                    )
                    self.job_event(
                        job_id,
                        OcrEventStage.PROGRESS,
                        determinate=True,
                        completed=completed,
                        failed=failed,
                        skipped=skipped,
                        total=total,
                    )
            final_status = (
                OcrJobStatus.COMPLETED_WITH_ERRORS if failed else OcrJobStatus.COMPLETED
            )
            self.database.update_ocr_job(
                job_id,
                final_status,
                completed_files=completed,
                failed_files=failed,
                skipped_files=skipped,
                finished=True,
            )
            self.job_event(
                job_id,
                OcrEventStage.JOB_FINISHED,
                status=final_status.value,
                completed=completed,
                failed=failed,
                skipped=skipped,
                total=total,
            )
        except Exception as error:
            logger.exception("OCR batch failed")
            self.fail_job(job_id, error)
        return None

    def fail_job(self, job_id: int, error: Exception) -> None:
        message = str(error)[:2048] or type(error).__name__
        unfinished = self.database.fail_unfinished_ocr_job_files(job_id, message)
        job = self.database.get_ocr_job(job_id)
        self.database.update_ocr_job(
            job_id,
            OcrJobStatus.FAILED,
            completed_files=int(job["completed_files"]),
            failed_files=int(job["failed_files"]) + len(unfinished),
            finished=True,
        )
        for item in unfinished:
            try:
                self.database.record_document_failure(
                    item["sourcePath"],
                    OcrDocumentStatus.BATCH_FAILED,
                    message,
                    job_id,
                    output_path=item["outputPath"],
                )
            except DatabaseError:
                logger.exception("Could not persist failed OCR document")
        self.job_event(job_id, OcrEventStage.JOB_FAILED, error=message)

    def handle_file_stage(
        self, job_id: int, file_id: int, task: ProcessingTask, stage: OcrFileStage
    ) -> None:
        self.database.update_ocr_job_file(file_id, stage, OcrFileStatus.RUNNING)
        self.job_event(job_id, OcrEventStage(stage.value), file=str(task.source_path))

    def close(self) -> None:
        thread = self.active_thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)
