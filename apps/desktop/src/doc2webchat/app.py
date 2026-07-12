from __future__ import annotations

import logging
from pathlib import Path

import webview
from platformdirs import user_data_path

from doc2webchat.api import DesktopApi, WebviewApi, WindowsDialogDispatcher
from doc2webchat.bridge import BridgeThread
from doc2webchat.database import Database
from doc2webchat.providers import ProviderRegistry


def application_data_directory() -> Path:
    return user_data_path("Doc2WebChat", appauthor=False, ensure_exists=True)


def bundled_ui_path() -> Path:
    return Path(__file__).resolve().parent / "ui" / "index.html"


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    ui_path = bundled_ui_path()
    if not ui_path.is_file():
        raise RuntimeError(
            f"Desktop UI is not built: {ui_path}. Build the desktop frontend first."
        )
    registry = ProviderRegistry.load_default()
    bridge = BridgeThread(registry)
    bridge.start()
    try:
        database = Database(application_data_directory() / "doc2webchat.sqlite3")
    except Exception:
        bridge.stop()
        raise
    api = DesktopApi(database, bridge, registry)
    window = webview.create_window(
        "Doc2WebChat",
        ui_path.as_uri(),
        js_api=WebviewApi(api),
        min_size=(980, 680),
    )
    if window is None:
        api.close()
        bridge.stop()
        database.close()
        raise RuntimeError("pywebview did not create the desktop window")
    api.attach_window(window, WindowsDialogDispatcher(window))
    try:
        webview.start()
    finally:
        api.close()
        bridge.stop()
        database.close()


if __name__ == "__main__":
    main()
