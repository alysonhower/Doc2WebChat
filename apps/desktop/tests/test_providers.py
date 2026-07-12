from __future__ import annotations

import math

import pytest

from doc2webchat.errors import AppError
from doc2webchat.providers import ProviderRegistry


@pytest.fixture(scope="module")
def registry() -> ProviderRegistry:
    return ProviderRegistry.load_default()


def test_default_registry_has_all_twenty_providers(
    registry: ProviderRegistry,
) -> None:
    assert len(registry.providers) == 20
    for provider in registry.document.providers:
        assert registry.validate_url(provider.id, provider.canonical_url) == (
            provider.canonical_url
        )


def test_url_validation_matches_origins_without_prefix_confusion(
    registry: ProviderRegistry,
) -> None:
    assert (
        registry.validate_url("open-webui", "http://localhost:4567/chat")
        == "http://localhost:4567/chat"
    )
    with pytest.raises(AppError, match="outside"):
        registry.validate_url("chatgpt", "https://chatgpt.com.evil.example/")


def test_settings_match_registry_and_browser_limits(
    registry: ProviderRegistry,
) -> None:
    assert (
        registry.validate_settings(
            "ai-studio",
            {"model": "gemini-3.5-flash", "reasoning_effort": "High"},
        )["reasoning_effort"]
        == "High"
    )
    with pytest.raises(AppError, match="model"):
        registry.validate_settings("ai-studio", {"model": "not-in-registry"})
    with pytest.raises(AppError, match="finite"):
        registry.validate_settings("ai-studio", {"temperature": math.inf})
    with pytest.raises(AppError, match="options"):
        registry.validate_settings(
            "chatgpt", {"options": [f"option-{index}" for index in range(65)]}
        )
