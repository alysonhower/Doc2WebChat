from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from doc2webchat.api import DesktopApi
from doc2webchat.bridge import BridgeThread
from doc2webchat.database import Database
from doc2webchat.providers import ProviderRegistry


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def instruction_document(text: str) -> dict[str, Any]:
    return {
        "version": 1,
        "root": {"version": 1, "nodes": [{"type": "text", "text": text}]},
        "definitions": {},
    }


def wait_for_browser(
    bridge: BridgeThread, timeout: float = 15, connected_after: int = 0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        browsers = bridge.list_browsers()
        if len(browsers) == 1 and int(browsers[0]["connectedAt"]) > connected_after:
            return browsers[0]
        time.sleep(0.05)
    raise RuntimeError("The unpacked extension did not connect to the Python bridge")


def matching_history(database: Database, interaction_id: str) -> dict[str, Any]:
    return next(
        item
        for item in database.list_history()
        if item["interactionId"] == interaction_id
    )


def main() -> None:
    work_directory = Path(os.environ["DOC2WEBCHAT_E2E_WORK_DIR"])
    work_directory.mkdir(parents=True, exist_ok=True)
    registry = ProviderRegistry.load_default()
    bridge = BridgeThread(registry)
    database: Database | None = None
    api: DesktopApi | None = None
    interaction_id: str | None = None
    bridge.start()
    try:
        database = Database(work_directory / "round-trip.sqlite3")
        database.record_document_success(
            str(work_directory / "source-document.pdf"),
            str(work_directory / "searchable-document.pdf"),
            "Line one & <source>\nUnicode: café Ω 😀",
            1,
        )
        api = DesktopApi(database, bridge, registry)
        emit({"status": "ready"})

        for line in sys.stdin:
            request = json.loads(line)
            command = request.get("command")
            try:
                if command == "wait-browser":
                    emit(
                        {
                            "ok": True,
                            "browser": wait_for_browser(
                                bridge,
                                connected_after=int(request.get("connectedAfter", 0)),
                            ),
                        }
                    )
                elif command == "start-interaction":
                    result = api.start_interaction(
                        {
                            "instructions": instruction_document(
                                str(request["instructions"])
                            ),
                            "providerId": "open-webui",
                            "providerUrl": "http://127.0.0.1:3000/",
                            "reuseTab": False,
                        }
                    )
                    if not result.get("ok"):
                        raise RuntimeError(json.dumps(result["error"]))
                    interaction_id = str(result["value"]["interactionId"])
                    history = matching_history(database, interaction_id)
                    emit(
                        {
                            "ok": True,
                            "interactionId": interaction_id,
                            "prompt": history["messages"][0]["content"],
                            "promptBytes": history["promptBytes"],
                        }
                    )
                elif command == "history":
                    if interaction_id is None:
                        raise RuntimeError("No interaction has been started")
                    emit(
                        {
                            "ok": True,
                            "history": matching_history(database, interaction_id),
                        }
                    )
                elif command == "close":
                    emit({"ok": True})
                    break
                else:
                    raise RuntimeError(f"Unknown command: {command}")
            except Exception as error:
                emit({"ok": False, "error": str(error)})
    finally:
        if api is not None:
            api.close()
        bridge.stop()
        if database is not None:
            database.close()


if __name__ == "__main__":
    main()
