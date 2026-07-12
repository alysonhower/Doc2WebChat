from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path

import pytest
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer
from pydantic import ValidationError

from doc2webchat.bridge import (
    MESSAGE_ADAPTER,
    BridgeService,
    BrowserConnection,
    serialize_control_frame,
)
from doc2webchat.errors import AppError
from doc2webchat.providers import ProviderRegistry


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
                        "detection": {"url_prefixes": ["http://localhost:3000/"]},
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
async def bridge_client(registry: ProviderRegistry) -> tuple[BridgeService, TestClient]:
    service = BridgeService(registry)
    client = TestClient(TestServer(service.application))
    await client.start_server()
    yield service, client
    await client.close()


async def connect_extension(service: BridgeService, client: TestClient):
    return await client.ws_connect(
        f"/bridge?token={service.session_token}&role=browser-extension",
        headers={"Origin": "chrome-extension://abcdefghijklmnop"},
    )


def test_outbound_control_frames_enforce_utf8_byte_limit() -> None:
    with pytest.raises(AppError, match="64 KiB"):
        serialize_control_frame({"action": "ping", "nonce": "é" * 32_768})


@pytest.mark.asyncio
async def test_keepalive_evicts_one_failed_socket_and_continues(
    registry: ProviderRegistry,
) -> None:
    class Socket:
        def __init__(self, fail: bool) -> None:
            self.fail = fail
            self.closed = False
            self.messages: list[str] = []

        async def send_str(self, value: str) -> None:
            if self.fail:
                raise ConnectionError("closed")
            self.messages.append(value)

        async def close(self, **kwargs: object) -> None:
            del kwargs
            self.closed = True

    service = BridgeService(registry)
    failed = Socket(True)
    healthy = Socket(False)
    first_id = str(uuid.uuid4())
    second_id = str(uuid.uuid4())
    service.browsers[first_id] = BrowserConnection(
        first_id,
        "1",
        "test",
        "chrome-extension://keepalive-test",
        "first-handoff-token-0123456789",
        failed,  # type: ignore[arg-type]
    )
    service.browsers[second_id] = BrowserConnection(
        second_id,
        "1",
        "test",
        "chrome-extension://keepalive-test",
        "second-handoff-token-0123456789",
        healthy,  # type: ignore[arg-type]
    )

    await service.keepalive_once(time.time())

    assert first_id not in service.browsers
    assert failed.closed is True
    assert second_id in service.browsers
    assert '"action":"ping"' in healthy.messages[0]
    assert (await service.next_event(timeout=1))["action"] == "browser-disconnected"


@pytest.mark.asyncio
async def test_keepalive_accepts_a_pong_from_the_previous_interval(
    bridge_client: tuple[BridgeService, TestClient],
) -> None:
    service, client = bridge_client
    browser_id = str(uuid.uuid4())
    socket = await connect_extension(service, client)
    await socket.send_json(
        {
            "action": "register-browser",
            "browser_instance_id": browser_id,
            "version": "1",
            "user_agent": "test",
        }
    )
    await socket.receive_json()
    await service.next_event(timeout=1)

    first_tick = time.time()
    await service.keepalive_once(first_tick)
    first_ping = await socket.receive_json()
    await service.keepalive_once(first_tick + 20)
    second_ping = await socket.receive_json()
    assert first_ping["nonce"] != second_ping["nonce"]
    assert first_ping["nonce"] in service.browsers[browser_id].pending_nonces

    await socket.send_json(
        {
            "action": "pong",
            "browser_instance_id": browser_id,
            "nonce": first_ping["nonce"],
        }
    )
    for _ in range(10):
        if first_ping["nonce"] not in service.browsers[browser_id].pending_nonces:
            break
        await asyncio.sleep(0)
    assert first_ping["nonce"] not in service.browsers[browser_id].pending_nonces
    assert browser_id in service.browsers


@pytest.mark.asyncio
async def test_initialize_cleans_handoff_after_transport_runtime_error(
    registry: ProviderRegistry,
) -> None:
    class ClosingSocket:
        closed = False

        async def send_str(self, value: str) -> None:
            del value
            raise RuntimeError("closing transport")

    service = BridgeService(registry)
    browser_id = str(uuid.uuid4())
    interaction_id = str(uuid.uuid4())
    service.browsers[browser_id] = BrowserConnection(
        browser_id,
        "1",
        "test",
        "chrome-extension://keepalive-test",
        "handoff-token-0123456789",
        ClosingSocket(),  # type: ignore[arg-type]
    )

    with pytest.raises(AppError, match="disconnected"):
        await service.initialize_interaction(
            interaction_id,
            browser_id,
            "open-webui",
            "http://localhost:3000/",
            "prompt",
            {},
        )
    assert interaction_id not in service.interactions
    assert service.handoffs.values == {}


@pytest.mark.parametrize("tab_id", ["7", True])
def test_incoming_control_messages_reject_coerced_field_types(tab_id: object) -> None:
    with pytest.raises(ValidationError):
        MESSAGE_ADAPTER.validate_python(
            {
                "action": "prefill-completed",
                "interaction_id": str(uuid.uuid4()),
                "browser_instance_id": str(uuid.uuid4()),
                "provider_id": "open-webui",
                "provider_url": "http://localhost:3000/",
                "tab_id": tab_id,
            }
        )


@pytest.mark.asyncio
async def test_health_has_identity_token_no_store_and_no_cors(
    bridge_client: tuple[BridgeService, TestClient],
) -> None:
    service, client = bridge_client
    response = await client.get("/health")
    body = await response.json()
    assert body == {
        "service": "doc2webchat",
        "protocol_version": 1,
        "session_token": service.session_token,
    }
    assert response.headers["Cache-Control"] == "no-store"
    assert "Access-Control-Allow-Origin" not in response.headers

    extension_response = await client.get(
        "/health", headers={"Origin": "chrome-extension://abcdefghijklmnop"}
    )
    assert (
        extension_response.headers["Access-Control-Allow-Origin"]
        == "chrome-extension://abcdefghijklmnop"
    )
    assert extension_response.headers["Vary"] == "Origin"


@pytest.mark.asyncio
async def test_bridge_rejects_invalid_origin_role_and_token(
    bridge_client: tuple[BridgeService, TestClient],
) -> None:
    service, client = bridge_client
    for path, origin in [
        (
            f"/bridge?token={service.session_token}&role=browser-extension",
            "https://evil.test",
        ),
        (f"/bridge?token={service.session_token}&role=wrong", "chrome-extension://ok"),
        ("/bridge?token=wrong&role=browser-extension", "chrome-extension://ok"),
    ]:
        response = await client.get(path, headers={"Origin": origin})
        assert response.status in {401, 403}


@pytest.mark.asyncio
async def test_register_handoff_prefill_lease_and_identity_validation(
    bridge_client: tuple[BridgeService, TestClient],
) -> None:
    service, client = bridge_client
    browser_id = str(uuid.uuid4())
    interaction_id = str(uuid.uuid4())
    socket = await connect_extension(service, client)
    await socket.send_json(
        {
            "action": "register-browser",
            "browser_instance_id": browser_id,
            "version": "1.0.0",
            "user_agent": "test",
        }
    )
    registered = await socket.receive_json()
    assert registered["action"] == "browser-registered"
    handoff_token = registered["handoff_token"]
    assert (await service.next_event(timeout=1))["action"] == "browser-connected"

    dispatch = await service.initialize_interaction(
        interaction_id=interaction_id,
        browser_instance_id=browser_id,
        provider_id="open-webui",
        provider_url="http://localhost:3000/chat",
        prompt="full secret prompt",
        settings={"temperature": 0.5},
    )
    initialized = await socket.receive_json()
    assert initialized["handoff_id"] == dispatch["handoff_id"]
    assert "prompt" not in initialized

    origin = "chrome-extension://abcdefghijklmnop"
    preflight = await client.options(
        f"/handoff/{dispatch['handoff_id']}",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": (
                "authorization, x-doc2webchat-browser-instance-id, "
                "x-doc2webchat-handoff-token"
            ),
        },
    )
    assert preflight.status == 204
    assert preflight.headers["Access-Control-Allow-Origin"] == origin
    assert set(
        value.strip()
        for value in preflight.headers["Access-Control-Allow-Headers"].split(",")
    ) == {
        "Authorization",
        "X-Doc2WebChat-Browser-Instance-Id",
        "X-Doc2WebChat-Handoff-Token",
    }
    assert "*" not in str(preflight.headers)
    headers = {
        "Authorization": f"Bearer {service.session_token}",
        "X-Doc2WebChat-Browser-Instance-Id": browser_id,
        "X-Doc2WebChat-Handoff-Token": handoff_token,
    }
    missing_credential = await client.get(
        f"/handoff/{dispatch['handoff_id']}",
        headers={"Authorization": f"Bearer {service.session_token}"},
    )
    assert missing_credential.status == 403
    wrong_credential = await client.get(
        f"/handoff/{dispatch['handoff_id']}",
        headers={**headers, "X-Doc2WebChat-Handoff-Token": "wrong-token-value"},
    )
    assert wrong_credential.status == 403
    other_browser_id = str(uuid.uuid4())
    other_socket = await connect_extension(service, client)
    await other_socket.send_json(
        {
            "action": "register-browser",
            "browser_instance_id": other_browser_id,
            "version": "1.0.0",
            "user_agent": "other test browser",
        }
    )
    other_registration = await other_socket.receive_json()
    assert (await service.next_event(timeout=1))["action"] == "browser-connected"
    wrong_browser = await client.get(
        f"/handoff/{dispatch['handoff_id']}",
        headers={
            "Authorization": f"Bearer {service.session_token}",
            "X-Doc2WebChat-Browser-Instance-Id": other_browser_id,
            "X-Doc2WebChat-Handoff-Token": other_registration["handoff_token"],
        },
    )
    assert wrong_browser.status == 403
    await other_socket.close()
    assert (await service.next_event(timeout=1))["action"] == "browser-disconnected"
    first = await client.get(f"/handoff/{dispatch['handoff_id']}", headers=headers)
    second = await client.get(
        f"/handoff/{dispatch['handoff_id']}",
        headers={**headers, "Origin": origin},
    )
    assert (await first.json())["prompt"] == "full secret prompt"
    assert (await second.json())["prompt"] == "full secret prompt"
    assert "Access-Control-Allow-Origin" not in first.headers
    assert second.headers["Access-Control-Allow-Origin"] == origin
    wrong_origin = await client.get(
        f"/handoff/{dispatch['handoff_id']}",
        headers={**headers, "Origin": "chrome-extension://another-extension"},
    )
    assert wrong_origin.status == 403

    await socket.send_json(
        {
            "action": "prefill-completed",
            "interaction_id": interaction_id,
            "browser_instance_id": browser_id,
            "provider_id": "open-webui",
            "provider_url": "http://localhost:3000/chat",
            "tab_id": 1,
        }
    )
    event = await service.next_event(timeout=1)
    assert event["action"] == "prefill-completed"
    expired = await client.get(f"/handoff/{dispatch['handoff_id']}", headers=headers)
    assert expired.status == 404
    await socket.close()
    assert (await service.next_event(timeout=1))["action"] == "browser-disconnected"


@pytest.mark.asyncio
async def test_frame_limit_binary_replay_and_expiry(
    bridge_client: tuple[BridgeService, TestClient],
) -> None:
    service, client = bridge_client
    browser_id = str(uuid.uuid4())
    socket = await connect_extension(service, client)
    await socket.send_json(
        {
            "action": "register-browser",
            "browser_instance_id": browser_id,
            "version": "1",
            "user_agent": "test",
        }
    )
    await socket.receive_json()
    await socket.send_bytes(b"binary")
    assert (await socket.receive()).type in {WSMsgType.CLOSE, WSMsgType.CLOSED}

    handoff = service.handoffs.create(
        interaction_id=str(uuid.uuid4()),
        browser_instance_id=browser_id,
        extension_origin="moz-extension://00000000-0000-4000-8000-000000000000",
        handoff_token="expired-handoff-token-0123456789",
        provider_id="open-webui",
        provider_url="http://localhost:3000/",
        prompt="secret",
        settings={},
        now=time.time() - 601,
    )
    headers = {
        "Authorization": f"Bearer {service.session_token}",
        "Origin": "moz-extension://00000000-0000-4000-8000-000000000000",
    }
    response = await client.get(f"/handoff/{handoff.handoff_id}", headers=headers)
    assert response.status == 404


@pytest.mark.asyncio
async def test_import_response_is_idempotent_and_correlated(
    bridge_client: tuple[BridgeService, TestClient],
) -> None:
    service, client = bridge_client
    browser_id = str(uuid.uuid4())
    interaction_id = str(uuid.uuid4())
    socket = await connect_extension(service, client)
    await socket.send_json(
        {
            "action": "register-browser",
            "browser_instance_id": browser_id,
            "version": "1",
            "user_agent": "test",
        }
    )
    await socket.receive_json()
    assert (await service.next_event(timeout=1))["action"] == "browser-connected"
    await service.initialize_interaction(
        interaction_id,
        browser_id,
        "open-webui",
        "http://localhost:3000/",
        "prompt",
        {},
    )
    await socket.receive_json()
    payload = {
        "action": "import-response",
        "interaction_id": interaction_id,
        "browser_instance_id": browser_id,
        "provider_id": "open-webui",
        "provider_url": "http://localhost:3000/",
        "tab_id": 2,
    }
    await socket.send_json(payload)
    assert (await service.next_event(timeout=1))["action"] == "import-response"
    await service.send_import_result(payload, "ready")
    assert (await socket.receive_json())["status"] == "ready"
    await service.send_import_result(payload, "accepted")
    assert (await socket.receive_json())["status"] == "accepted"
    await socket.send_json(payload)
    assert (await service.next_event(timeout=1))["duplicate"] is True


@pytest.mark.asyncio
async def test_failed_import_ack_clears_replay_cycle_across_reconnect(
    bridge_client: tuple[BridgeService, TestClient],
) -> None:
    service, client = bridge_client
    browser_id = str(uuid.uuid4())
    interaction_id = str(uuid.uuid4())
    socket = await connect_extension(service, client)
    registration = {
        "action": "register-browser",
        "browser_instance_id": browser_id,
        "version": "1",
        "user_agent": "test",
    }
    await socket.send_json(registration)
    await socket.receive_json()
    await service.next_event(timeout=1)
    await service.initialize_interaction(
        interaction_id,
        browser_id,
        "open-webui",
        "http://localhost:3000/",
        "prompt",
        {},
    )
    await socket.receive_json()
    event = {
        "action": "import-response",
        "interaction_id": interaction_id,
        "browser_instance_id": browser_id,
        "provider_id": "open-webui",
        "provider_url": "http://localhost:3000/",
        "tab_id": 2,
    }
    for action in ("import-started", "import-response"):
        await socket.send_json({**event, "action": action})
        received = await service.next_event(timeout=1)
        assert received["duplicate"] is False

    await socket.close()
    assert (await service.next_event(timeout=1))["action"] == "browser-disconnected"
    with pytest.raises(AppError):
        await service.send_import_result(event, "failed", "clipboard-stale")

    reconnected = await connect_extension(service, client)
    await reconnected.send_json(registration)
    await reconnected.receive_json()
    assert (await service.next_event(timeout=1))["action"] == "browser-connected"
    await reconnected.send_json({**event, "action": "import-started"})
    retried = await service.next_event(timeout=1)
    assert retried["action"] == "import-started"
    assert retried["duplicate"] is False
