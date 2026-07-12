from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, cast
from urllib.parse import urlsplit

from aiohttp import WSCloseCode, WSMsgType, web
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from doc2webchat.errors import AppError
from doc2webchat.providers import ProviderRegistry

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 55155
PROTOCOL_VERSION = 1
MAX_CONTROL_FRAME_BYTES = 64 * 1024
HANDOFF_TTL_SECONDS = 10 * 60
KEEPALIVE_SECONDS = 20
STALE_BROWSER_SECONDS = 60
EXTENSION_SCHEMES = frozenset({"chrome-extension", "moz-extension"})
BROWSER_INSTANCE_HEADER = "X-Doc2WebChat-Browser-Instance-Id"
HANDOFF_TOKEN_HEADER = "X-Doc2WebChat-Handoff-Token"


class MessageModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RegisterBrowser(MessageModel):
    action: Literal["register-browser"]
    browser_instance_id: str = Field(min_length=36, max_length=36)
    version: str = Field(min_length=1, max_length=100)
    user_agent: str = Field(min_length=1, max_length=1024)


class Pong(MessageModel):
    action: Literal["pong"]
    browser_instance_id: str = Field(min_length=36, max_length=36)
    nonce: str = Field(min_length=16, max_length=100)


class InteractionEvent(MessageModel):
    interaction_id: str = Field(min_length=36, max_length=36)
    browser_instance_id: str = Field(min_length=36, max_length=36)
    provider_id: str = Field(min_length=1, max_length=64)
    provider_url: str = Field(min_length=1, max_length=4096)


class TabEvent(InteractionEvent):
    action: Literal[
        "prefill-completed",
        "response-finished",
        "import-started",
        "import-response",
    ]
    tab_id: int = Field(ge=0)


class FailureEvent(InteractionEvent):
    action: Literal["prefill-failed", "import-failed"]
    code: str = Field(min_length=1, max_length=100)
    message: str | None = Field(default=None, max_length=2048)
    tab_id: int | None = Field(default=None, ge=0)


IncomingMessage = RegisterBrowser | Pong | TabEvent | FailureEvent
MESSAGE_ADAPTER = TypeAdapter(IncomingMessage)


@dataclass(frozen=True)
class Handoff:
    handoff_id: str
    interaction_id: str
    browser_instance_id: str
    extension_origin: str
    handoff_token: str
    provider_id: str
    provider_url: str
    prompt: str
    settings: dict[str, Any]
    expires_at: float

    @property
    def expires_at_milliseconds(self) -> int:
        return int(self.expires_at * 1000)

    def initialization_payload(self) -> dict[str, Any]:
        return {
            "action": "initialize-interaction",
            "interaction_id": self.interaction_id,
            "browser_instance_id": self.browser_instance_id,
            "provider_id": self.provider_id,
            "provider_url": self.provider_url,
            "handoff_id": self.handoff_id,
            "expires_at": self.expires_at_milliseconds,
            "settings": self.settings,
        }

    def response_payload(self) -> dict[str, Any]:
        return {**self.initialization_payload(), "prompt": self.prompt}


class HandoffStore:
    def __init__(self, ttl_seconds: int = HANDOFF_TTL_SECONDS) -> None:
        self.ttl_seconds = ttl_seconds
        self.values: dict[str, Handoff] = {}

    def create(
        self,
        interaction_id: str,
        browser_instance_id: str,
        extension_origin: str,
        handoff_token: str,
        provider_id: str,
        provider_url: str,
        prompt: str,
        settings: dict[str, Any],
        *,
        now: float | None = None,
        store: bool = True,
    ) -> Handoff:
        created_at = time.time() if now is None else now
        handoff = Handoff(
            secrets.token_urlsafe(32),
            interaction_id,
            browser_instance_id,
            extension_origin,
            handoff_token,
            provider_id,
            provider_url,
            prompt,
            dict(settings),
            created_at + self.ttl_seconds,
        )
        if store:
            self.values[handoff.handoff_id] = handoff
        return handoff

    def put(self, handoff: Handoff) -> None:
        self.values[handoff.handoff_id] = handoff

    def get(self, handoff_id: str, *, now: float | None = None) -> Handoff | None:
        current = time.time() if now is None else now
        self.sweep(current)
        handoff = self.values.get(handoff_id)
        if handoff is None or handoff.expires_at <= current:
            return None
        return handoff

    def delete(self, handoff_id: str) -> None:
        self.values.pop(handoff_id, None)

    def sweep(self, now: float | None = None) -> None:
        current = time.time() if now is None else now
        for handoff_id, handoff in list(self.values.items()):
            if handoff.expires_at <= current:
                del self.values[handoff_id]


@dataclass
class BrowserConnection:
    browser_instance_id: str
    version: str
    user_agent: str
    extension_origin: str
    handoff_token: str
    socket: web.WebSocketResponse
    connected_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    pending_nonces: dict[str, float] = field(default_factory=dict)

    def public_value(self) -> dict[str, Any]:
        return {
            "browserInstanceId": self.browser_instance_id,
            "version": self.version,
            "userAgent": self.user_agent,
            "connectedAt": int(self.connected_at * 1000),
            "lastSeen": int(self.last_seen * 1000),
        }


@dataclass(frozen=True)
class InteractionOwner:
    browser_instance_id: str
    extension_origin: str
    handoff_token: str
    provider_id: str
    provider_url: str
    handoff_id: str


def validate_uuid4(value: str, field_name: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except ValueError as error:
        raise AppError(
            "invalid-protocol-message", f"{field_name} must be a UUID"
        ) from error
    if parsed.version != 4 or str(parsed) != value.lower():
        raise AppError(
            "invalid-protocol-message", f"{field_name} must be a canonical UUIDv4"
        )
    return str(parsed)


def validate_loopback_host(request: web.Request) -> None:
    parsed = urlsplit(f"//{request.host}")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise web.HTTPForbidden(text="loopback host required")


def validate_extension_origin(origin: str | None) -> None:
    if origin is None:
        raise web.HTTPForbidden(text="extension origin required")
    parsed = urlsplit(origin)
    if (
        parsed.scheme not in EXTENSION_SCHEMES
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise web.HTTPForbidden(text="invalid extension origin")


def extension_cors_headers(origin: str) -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
    }


def serialize_control_frame(payload: dict[str, Any]) -> str:
    serialized = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    if len(serialized.encode("utf-8")) > MAX_CONTROL_FRAME_BYTES:
        raise AppError(
            "control-frame-too-large", "Control message exceeds the 64 KiB limit"
        )
    return serialized


async def send_control_frame(
    socket: web.WebSocketResponse, payload: dict[str, Any]
) -> None:
    await socket.send_str(serialize_control_frame(payload))


class BridgeService:
    def __init__(self, registry: ProviderRegistry) -> None:
        self.registry = registry
        self.session_token = secrets.token_urlsafe(32)
        self.handoffs = HandoffStore()
        self.browsers: dict[str, BrowserConnection] = {}
        self.browser_credentials: dict[str, tuple[str, str]] = {}
        self.interactions: dict[str, InteractionOwner] = {}
        self.seen_events: set[tuple[str, str, str]] = set()
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.keepalive_task: asyncio.Task[None] | None = None
        self.application = web.Application(client_max_size=MAX_CONTROL_FRAME_BYTES)
        self.application.add_routes(
            [
                web.get("/health", self.health),
                web.get("/bridge", self.bridge),
                web.get("/handoff/{handoff_id}", self.handoff),
                web.options("/handoff/{handoff_id}", self.handoff_options),
            ]
        )
        self.application.on_startup.append(self.startup)
        self.application.on_cleanup.append(self.cleanup)

    async def startup(self, application: web.Application) -> None:
        del application
        self.keepalive_task = asyncio.create_task(self.keepalive_loop())

    async def cleanup(self, application: web.Application) -> None:
        del application
        if self.keepalive_task is not None:
            self.keepalive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.keepalive_task
        for browser in list(self.browsers.values()):
            await browser.socket.close(code=WSCloseCode.GOING_AWAY)

    async def health(self, request: web.Request) -> web.Response:
        validate_loopback_host(request)
        headers = {"Cache-Control": "no-store"}
        origin = request.headers.get("Origin")
        if origin is not None:
            validate_extension_origin(origin)
            headers.update(extension_cors_headers(origin))
        return web.json_response(
            {
                "service": "doc2webchat",
                "protocol_version": PROTOCOL_VERSION,
                "session_token": self.session_token,
            },
            headers=headers,
        )

    async def handoff(self, request: web.Request) -> web.Response:
        validate_loopback_host(request)
        if request.headers.get("Authorization") != f"Bearer {self.session_token}":
            raise web.HTTPUnauthorized(text="invalid bearer token")
        selected = self.handoffs.get(request.match_info["handoff_id"])
        if selected is None:
            raise web.HTTPNotFound(text="handoff not found or expired")
        browser_id = request.headers.get(BROWSER_INSTANCE_HEADER, "")
        try:
            validate_uuid4(browser_id, "browser_instance_id")
        except AppError as error:
            raise web.HTTPForbidden(text="invalid browser identity") from error
        handoff_token = request.headers.get(HANDOFF_TOKEN_HEADER, "")
        browser = self.browsers.get(browser_id)
        if (
            browser_id != selected.browser_instance_id
            or browser is None
            or browser.socket.closed
            or browser.extension_origin != selected.extension_origin
            or not secrets.compare_digest(browser.handoff_token, selected.handoff_token)
            or not secrets.compare_digest(handoff_token, selected.handoff_token)
        ):
            raise web.HTTPForbidden(text="browser does not own this handoff")
        origin = request.headers.get("Origin")
        if origin is not None:
            validate_extension_origin(origin)
            if origin != browser.extension_origin:
                raise web.HTTPForbidden(
                    text="handoff origin does not own this interaction"
                )
        response_headers = {"Cache-Control": "no-store"}
        if origin is not None:
            response_headers.update(extension_cors_headers(origin))
        return web.json_response(
            selected.response_payload(),
            headers=response_headers,
        )

    async def handoff_options(self, request: web.Request) -> web.Response:
        validate_loopback_host(request)
        origin = request.headers.get("Origin")
        validate_extension_origin(origin)
        if request.headers.get("Access-Control-Request-Method", "").upper() != "GET":
            raise web.HTTPForbidden(text="invalid preflight method")
        requested_headers = {
            value.strip().lower()
            for value in request.headers.get(
                "Access-Control-Request-Headers", ""
            ).split(",")
            if value.strip()
        }
        allowed_headers = {
            "authorization": "Authorization",
            BROWSER_INSTANCE_HEADER.lower(): BROWSER_INSTANCE_HEADER,
            HANDOFF_TOKEN_HEADER.lower(): HANDOFF_TOKEN_HEADER,
            "cache-control": "Cache-Control",
            "pragma": "Pragma",
        }
        if "authorization" not in requested_headers or not requested_headers <= set(
            allowed_headers
        ):
            raise web.HTTPForbidden(text="invalid preflight headers")
        response_headers = ", ".join(
            allowed_headers[name]
            for name in allowed_headers
            if name in requested_headers
        )
        return web.Response(
            status=204,
            headers={
                "Cache-Control": "no-store",
                **extension_cors_headers(cast(str, origin)),
                "Access-Control-Allow-Methods": "GET",
                "Access-Control-Allow-Headers": response_headers,
            },
        )

    async def bridge(self, request: web.Request) -> web.StreamResponse:
        validate_loopback_host(request)
        if not secrets.compare_digest(
            request.query.get("token", ""), self.session_token
        ):
            raise web.HTTPUnauthorized(text="invalid session token")
        if request.query.get("role") != "browser-extension":
            raise web.HTTPForbidden(text="invalid bridge role")
        validate_extension_origin(request.headers.get("Origin"))
        extension_origin = cast(str, request.headers.get("Origin"))
        socket = web.WebSocketResponse(
            max_msg_size=MAX_CONTROL_FRAME_BYTES,
            compress=False,
            heartbeat=None,
        )
        await socket.prepare(request)
        browser_id: str | None = None
        try:
            async for frame in socket:
                if frame.type is not WSMsgType.TEXT:
                    await socket.close(
                        code=WSCloseCode.UNSUPPORTED_DATA,
                        message=b"text frames only",
                    )
                    break
                if len(frame.data.encode("utf-8")) > MAX_CONTROL_FRAME_BYTES:
                    await socket.close(code=WSCloseCode.MESSAGE_TOO_BIG)
                    break
                try:
                    content = json.loads(frame.data)
                    message = MESSAGE_ADAPTER.validate_python(content)
                    browser_id = await self.handle_message(
                        socket, browser_id, message, extension_origin
                    )
                except json.JSONDecodeError, ValidationError, AppError:
                    await socket.close(
                        code=WSCloseCode.POLICY_VIOLATION,
                        message=b"invalid protocol message",
                    )
                    break
        finally:
            if browser_id is not None:
                selected = self.browsers.get(browser_id)
                if selected is not None and selected.socket is socket:
                    del self.browsers[browser_id]
                    await self.emit_browser_event("browser-disconnected", selected)
        return socket

    async def handle_message(
        self,
        socket: web.WebSocketResponse,
        registered_browser_id: str | None,
        message: IncomingMessage,
        extension_origin: str,
    ) -> str:
        if isinstance(message, RegisterBrowser):
            if registered_browser_id is not None:
                raise AppError("invalid-protocol-message", "browser already registered")
            browser_id = validate_uuid4(
                message.browser_instance_id, "browser_instance_id"
            )
            previous = self.browsers.get(browser_id)
            credential = self.browser_credentials.get(browser_id)
            if credential is not None and credential[0] != extension_origin:
                raise AppError(
                    "invalid-protocol-message",
                    "browser identity belongs to another extension origin",
                )
            handoff_token = (
                credential[1] if credential is not None else secrets.token_urlsafe(32)
            )
            self.browser_credentials[browser_id] = (extension_origin, handoff_token)
            current = BrowserConnection(
                browser_id,
                message.version,
                message.user_agent,
                extension_origin,
                handoff_token,
                socket,
            )
            self.browsers[browser_id] = current
            if previous is not None and previous.socket is not socket:
                await previous.socket.close(code=WSCloseCode.GOING_AWAY)
            await send_control_frame(
                socket,
                {
                    "action": "browser-registered",
                    "browser_instance_id": browser_id,
                    "handoff_token": handoff_token,
                },
            )
            await self.emit_browser_event(
                "browser-updated" if previous is not None else "browser-connected",
                current,
            )
            return browser_id
        if registered_browser_id is None:
            raise AppError("invalid-protocol-message", "register-browser must be first")
        if message.browser_instance_id != registered_browser_id:
            raise AppError("invalid-protocol-message", "browser ownership mismatch")
        browser = self.browsers.get(registered_browser_id)
        if browser is None or browser.socket is not socket:
            raise AppError(
                "invalid-protocol-message", "browser is no longer registered"
            )
        if browser.extension_origin != extension_origin:
            raise AppError("invalid-protocol-message", "extension origin changed")
        browser.last_seen = time.time()
        if isinstance(message, Pong):
            if message.nonce not in browser.pending_nonces:
                raise AppError("invalid-protocol-message", "unexpected pong nonce")
            browser.pending_nonces.pop(message.nonce, None)
            return registered_browser_id
        payload = message.model_dump()
        self.validate_interaction_event(payload)
        event_key = (
            payload["interaction_id"],
            payload["browser_instance_id"],
            payload["action"],
        )
        payload["duplicate"] = event_key in self.seen_events
        self.seen_events.add(event_key)
        if payload["action"] == "prefill-completed" and not payload["duplicate"]:
            owner = self.interactions[payload["interaction_id"]]
            self.handoffs.delete(owner.handoff_id)
        await self.events.put(payload)
        if payload["action"] == "import-failed" and not payload["duplicate"]:
            self.clear_import_event_cycle(
                payload["interaction_id"], payload["browser_instance_id"]
            )
        return registered_browser_id

    def clear_import_event_cycle(
        self, interaction_id: str, browser_instance_id: str
    ) -> None:
        for action in ("import-started", "import-response", "import-failed"):
            self.seen_events.discard((interaction_id, browser_instance_id, action))

    def validate_interaction_event(self, payload: dict[str, Any]) -> None:
        interaction_id = validate_uuid4(payload["interaction_id"], "interaction_id")
        validate_uuid4(payload["browser_instance_id"], "browser_instance_id")
        owner = self.interactions.get(interaction_id)
        if owner is None:
            raise AppError("invalid-protocol-message", "unknown interaction")
        actual = (
            payload["browser_instance_id"],
            payload["provider_id"],
            payload["provider_url"],
        )
        expected = (owner.browser_instance_id, owner.provider_id, owner.provider_url)
        if actual != expected:
            raise AppError("invalid-protocol-message", "interaction ownership mismatch")
        browser = self.browsers.get(payload["browser_instance_id"])
        if (
            browser is None
            or browser.extension_origin != owner.extension_origin
            or not secrets.compare_digest(browser.handoff_token, owner.handoff_token)
        ):
            raise AppError("invalid-protocol-message", "extension origin mismatch")
        self.registry.validate_url(payload["provider_id"], payload["provider_url"])

    async def initialize_interaction(
        self,
        interaction_id: str,
        browser_instance_id: str,
        provider_id: str,
        provider_url: str,
        prompt: str,
        settings: dict[str, Any],
    ) -> dict[str, Any]:
        interaction_id = validate_uuid4(interaction_id, "interaction_id")
        browser_instance_id = validate_uuid4(browser_instance_id, "browser_instance_id")
        browser = self.browsers.get(browser_instance_id)
        if browser is None or browser.socket.closed:
            raise AppError("browser-unavailable", "Selected browser is not connected")
        provider_url = self.registry.validate_url(provider_id, provider_url)
        validated_settings = self.registry.validate_settings(provider_id, settings)
        if interaction_id in self.interactions:
            raise AppError("duplicate-interaction", "Interaction already exists")
        handoff = self.handoffs.create(
            interaction_id,
            browser_instance_id,
            browser.extension_origin,
            browser.handoff_token,
            provider_id,
            provider_url,
            prompt,
            validated_settings,
            store=False,
        )
        initialization_payload = handoff.initialization_payload()
        serialize_control_frame(initialization_payload)
        self.handoffs.put(handoff)
        self.interactions[interaction_id] = InteractionOwner(
            browser_instance_id,
            browser.extension_origin,
            browser.handoff_token,
            provider_id,
            provider_url,
            handoff.handoff_id,
        )
        try:
            await send_control_frame(browser.socket, initialization_payload)
        except ConnectionError, OSError, RuntimeError:
            self.interactions.pop(interaction_id, None)
            self.handoffs.delete(handoff.handoff_id)
            raise AppError(
                "browser-unavailable", "Selected browser disconnected"
            ) from None
        return {
            "handoff_id": handoff.handoff_id,
            "expires_at": handoff.expires_at_milliseconds,
        }

    async def send_import_result(
        self, event: dict[str, Any], status: str, code: str | None = None
    ) -> None:
        if status not in {"ready", "accepted", "duplicate", "failed"}:
            raise ValueError("invalid import result status")
        try:
            self.validate_interaction_event(event)
            browser = self.browsers.get(event["browser_instance_id"])
            if browser is None:
                raise AppError(
                    "browser-unavailable", "Selected browser is not connected"
                )
            payload = {
                "action": "import-result",
                "interaction_id": event["interaction_id"],
                "browser_instance_id": event["browser_instance_id"],
                "provider_id": event["provider_id"],
                "provider_url": event["provider_url"],
                "status": status,
            }
            if code is not None:
                payload["code"] = code
            await send_control_frame(browser.socket, payload)
        finally:
            interaction_id = event.get("interaction_id")
            browser_instance_id = event.get("browser_instance_id")
            if (
                status == "failed"
                and isinstance(interaction_id, str)
                and isinstance(browser_instance_id, str)
            ):
                self.clear_import_event_cycle(interaction_id, browser_instance_id)

    async def next_event(self, timeout: float | None = None) -> dict[str, Any]:
        if timeout is None:
            return await self.events.get()
        return await asyncio.wait_for(self.events.get(), timeout)

    async def list_browser_values(self) -> list[dict[str, Any]]:
        return [
            browser.public_value()
            for browser in sorted(
                self.browsers.values(), key=lambda item: item.browser_instance_id
            )
            if not browser.socket.closed
        ]

    async def emit_browser_event(self, action: str, browser: BrowserConnection) -> None:
        await self.events.put(
            {"type": "browser", "action": action, "browser": browser.public_value()}
        )

    async def keepalive_loop(self) -> None:
        while True:
            await asyncio.sleep(KEEPALIVE_SECONDS)
            await self.keepalive_once(time.time())

    async def keepalive_once(self, now: float) -> None:
        self.handoffs.sweep(now)
        for browser_id, browser in list(self.browsers.items()):
            try:
                if (
                    browser.socket.closed
                    or now - browser.last_seen > STALE_BROWSER_SECONDS
                ):
                    await browser.socket.close(code=WSCloseCode.GOING_AWAY)
                    if self.browsers.get(browser_id) is browser:
                        del self.browsers[browser_id]
                        await self.emit_browser_event("browser-disconnected", browser)
                    continue
                nonce = secrets.token_urlsafe(18)
                browser.pending_nonces = {
                    value: sent_at
                    for value, sent_at in browser.pending_nonces.items()
                    if now - sent_at <= STALE_BROWSER_SECONDS
                }
                browser.pending_nonces[nonce] = now
                while len(browser.pending_nonces) > 3:
                    oldest = min(
                        browser.pending_nonces,
                        key=browser.pending_nonces.__getitem__,
                    )
                    del browser.pending_nonces[oldest]
                await send_control_frame(
                    browser.socket, {"action": "ping", "nonce": nonce}
                )
            except ConnectionError, OSError, RuntimeError:
                with contextlib.suppress(Exception):
                    await browser.socket.close(code=WSCloseCode.GOING_AWAY)
                if self.browsers.get(browser_id) is browser:
                    del self.browsers[browser_id]
                    await self.emit_browser_event("browser-disconnected", browser)


class BridgeThread:
    def __init__(
        self,
        registry: ProviderRegistry,
        host: str = BRIDGE_HOST,
        port: int = BRIDGE_PORT,
    ) -> None:
        self.service = BridgeService(registry)
        self.host = host
        self.port = port
        self.loop: asyncio.AbstractEventLoop | None = None
        self.runner: web.AppRunner | None = None
        self.ready = threading.Event()
        self.start_error: BaseException | None = None
        self.thread = threading.Thread(
            target=self.run,
            name="doc2webchat-bridge",
            daemon=True,
        )

    def start(self) -> None:
        self.thread.start()
        if not self.ready.wait(timeout=10):
            raise RuntimeError("Bridge did not start")
        if self.start_error is not None:
            raise RuntimeError(
                f"Bridge could not start: {self.start_error}"
            ) from self.start_error

    def run(self) -> None:
        loop = asyncio.new_event_loop()
        self.loop = loop
        asyncio.set_event_loop(loop)
        try:
            self.runner = web.AppRunner(self.service.application, access_log=None)
            loop.run_until_complete(self.runner.setup())
            site = web.TCPSite(self.runner, self.host, self.port)
            loop.run_until_complete(site.start())
        except BaseException as error:
            self.start_error = error
            self.ready.set()
            loop.run_until_complete(self.shutdown())
            loop.close()
            return
        self.ready.set()
        loop.run_forever()
        loop.run_until_complete(self.shutdown())
        loop.close()

    async def shutdown(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()

    def submit(self, coroutine: Any) -> Any:
        if self.loop is None or not self.thread.is_alive():
            raise AppError("bridge-unavailable", "Browser bridge is not running")
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        return future.result(timeout=15)

    def dispatch_interaction(self, **kwargs: Any) -> dict[str, Any]:
        return self.submit(self.service.initialize_interaction(**kwargs))

    def list_browsers(self) -> list[dict[str, Any]]:
        return self.submit(self.service.list_browser_values())

    def get_event(self, timeout: float | None = None) -> dict[str, Any]:
        return self.submit(self.service.next_event(timeout))

    def report_import_result(
        self, event: dict[str, Any], status: str, code: str | None = None
    ) -> None:
        self.submit(self.service.send_import_result(event, status, code))

    def stop(self) -> None:
        if self.loop is None or not self.thread.is_alive():
            return
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=15)
        if self.thread.is_alive():
            raise RuntimeError("Bridge thread did not stop")
