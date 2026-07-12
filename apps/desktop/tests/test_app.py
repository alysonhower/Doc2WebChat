from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from doc2webchat import app


def test_bridge_bind_failure_happens_before_database_recovery(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ui_path = tmp_path / "index.html"
    ui_path.write_text("ready", encoding="utf-8")
    database_opened = False

    class FailingBridge:
        def __init__(self, registry: object) -> None:
            del registry

        def start(self) -> None:
            raise RuntimeError("port already owned")

    def open_database(path: Path) -> Any:
        nonlocal database_opened
        del path
        database_opened = True
        raise AssertionError("database must not open")

    monkeypatch.setattr(app, "bundled_ui_path", lambda: ui_path)
    monkeypatch.setattr(app.ProviderRegistry, "load_default", lambda: object())
    monkeypatch.setattr(app, "BridgeThread", FailingBridge)
    monkeypatch.setattr(app, "Database", open_database)

    with pytest.raises(RuntimeError, match="port already owned"):
        app.main()
    assert database_opened is False
