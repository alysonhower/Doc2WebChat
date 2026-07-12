from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from doc2webchat.errors import AppError


class ProviderDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    label: str = Field(min_length=1, max_length=100)
    adapter_key: str = Field(min_length=1, max_length=64)
    canonical_url: str
    allowed_url_prefixes: list[str] = Field(min_length=1)
    manifest_matches: list[str] = Field(min_length=1)
    detection: dict[str, Any]
    controls: dict[str, Any]
    dom_controls: list[str]

    @field_validator("canonical_url")
    @classmethod
    def validate_canonical_url(cls, value: str) -> str:
        validate_http_url(value)
        return value

    @field_validator("allowed_url_prefixes")
    @classmethod
    def validate_prefixes(cls, values: list[str]) -> list[str]:
        for value in values:
            validate_http_url(value)
        return values


class RegistryDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: int = Field(ge=1, le=1)
    providers: list[ProviderDefinition] = Field(min_length=1)


def validate_http_url(value: str) -> None:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("provider URL must be an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("provider URL must not include credentials")
    if parsed.fragment:
        raise ValueError("provider URL must not include a fragment")


class ProviderRegistry:
    def __init__(self, document: RegistryDocument, source_path: Path) -> None:
        providers = {provider.id: provider for provider in document.providers}
        if len(providers) != len(document.providers):
            raise AppError("invalid-provider-registry", "Provider IDs must be unique")
        self.document = document
        self.source_path = source_path
        self.providers = providers

    @classmethod
    def load(cls, path: Path) -> ProviderRegistry:
        try:
            content = json.loads(path.read_text(encoding="utf-8"))
            document = RegistryDocument.model_validate(content)
        except (OSError, json.JSONDecodeError, ValidationError) as error:
            raise AppError(
                "invalid-provider-registry",
                f"Could not load provider registry: {error}",
                file=str(path),
            ) from error
        return cls(document, path)

    @classmethod
    def load_default(cls) -> ProviderRegistry:
        repository_root = Path(__file__).resolve().parents[4]
        return cls.load(
            repository_root / "packages" / "shared" / "src" / "providers.json"
        )

    def get(self, provider_id: str) -> ProviderDefinition:
        try:
            return self.providers[provider_id]
        except KeyError as error:
            raise AppError(
                "unknown-provider",
                f"Unsupported provider: {provider_id}",
                field="providerId",
            ) from error

    def validate_url(self, provider_id: str, value: str | None) -> str:
        provider = self.get(provider_id)
        selected = provider.canonical_url if value is None else value
        try:
            validate_http_url(selected)
        except ValueError as error:
            raise AppError(
                "invalid-provider-url", str(error), field="providerUrl"
            ) from error
        if not any(
            url_matches_prefix(selected, prefix)
            for prefix in provider.allowed_url_prefixes
        ):
            raise AppError(
                "invalid-provider-url",
                "Provider URL is outside the provider's allowed locations",
                field="providerUrl",
            )
        return selected

    def public_definitions(self) -> list[dict[str, Any]]:
        return [
            {
                "id": provider.id,
                "label": provider.label,
                "adapterKey": provider.adapter_key,
                "canonicalUrl": provider.canonical_url,
                "allowedUrlPrefixes": provider.allowed_url_prefixes,
                "manifestMatches": provider.manifest_matches,
                "detection": provider.detection,
                "controls": provider.controls,
                "domControls": provider.dom_controls,
            }
            for provider in self.document.providers
        ]

    def validate_settings(
        self, provider_id: str, settings: dict[str, Any]
    ) -> dict[str, Any]:
        provider = self.get(provider_id)
        controls = provider.controls
        allowed = frozenset(
            {
                "model",
                "temperature",
                "thinking_budget",
                "reasoning_effort",
                "top_p",
                "system_instructions",
                "options",
            }
        )
        result: dict[str, Any] = {}
        for key, value in settings.items():
            if not isinstance(key, str):
                raise AppError("invalid-setting", "Setting names must be strings")
            if key == "reuse_last_tab":
                if not isinstance(value, bool):
                    raise AppError("invalid-setting", "reuse_last_tab must be boolean")
                result[key] = value
                continue
            model_reasoning_supported = key == "reasoning_effort" and bool(
                reasoning_efforts_for(controls, settings.get("model"))
            )
            if key not in allowed or (
                key not in controls and not model_reasoning_supported
            ):
                raise AppError(
                    "unsupported-setting",
                    f"Provider does not support setting: {key}",
                    field=key,
                )
            if key in {"temperature", "top_p"}:
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise AppError(
                        "invalid-setting", f"{key} must be a number", field=key
                    )
                if not math.isfinite(float(value)):
                    raise AppError(
                        "invalid-setting", f"{key} must be finite", field=key
                    )
                if controls.get(key) is not True:
                    raise AppError(
                        "unsupported-setting",
                        f"Provider does not support setting: {key}",
                        field=key,
                    )
                if key == "top_p" and not 0 <= float(value) <= 1:
                    raise AppError(
                        "invalid-setting", "top_p must be between 0 and 1", field=key
                    )
                result[key] = float(value)
            elif key == "thinking_budget":
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise AppError(
                        "invalid-setting",
                        "thinking_budget must be a non-negative integer",
                        field=key,
                    )
                if controls.get("thinking_budget") is not True:
                    raise AppError(
                        "unsupported-setting",
                        "Provider does not support setting: thinking_budget",
                        field=key,
                    )
                result[key] = value
            elif key == "options":
                if (
                    not isinstance(value, list)
                    or len(value) > 64
                    or any(
                        not isinstance(item, str) or not item or len(item) > 256
                        for item in value
                    )
                ):
                    raise AppError(
                        "invalid-setting",
                        "options must be a list of option names",
                        field=key,
                    )
                allowed_options = controls.get("options")
                if not isinstance(allowed_options, dict) or any(
                    item not in allowed_options for item in value
                ):
                    raise AppError(
                        "invalid-setting",
                        "options contains an unsupported option",
                        field=key,
                    )
                result[key] = value
            else:
                maximum = 32_768 if key == "system_instructions" else 1024
                if not isinstance(value, str) or not value or len(value) > maximum:
                    raise AppError(
                        "invalid-setting", f"{key} must be a bounded string", field=key
                    )
                if key == "model":
                    model_control = controls.get("model")
                    if not isinstance(model_control, dict):
                        raise AppError(
                            "unsupported-setting",
                            "Provider does not support setting: model",
                            field=key,
                        )
                    model_values = model_control.get("values")
                    if isinstance(model_values, dict) and value not in model_values:
                        raise AppError(
                            "invalid-setting",
                            "model is not in the provider registry",
                            field=key,
                        )
                elif key == "reasoning_effort":
                    allowed_efforts = reasoning_efforts_for(
                        controls, settings.get("model")
                    )
                    if value not in allowed_efforts:
                        raise AppError(
                            "invalid-setting",
                            "reasoning_effort is not supported for the selected model",
                            field=key,
                        )
                result[key] = value
        return result


def reasoning_efforts_for(controls: dict[str, Any], selected_model: Any) -> list[str]:
    reasoning_control = controls.get("reasoning_effort")
    if isinstance(reasoning_control, dict):
        values = reasoning_control.get("values")
        if isinstance(values, list) and all(isinstance(item, str) for item in values):
            return values
    model_control = controls.get("model")
    model_values = (
        model_control.get("values") if isinstance(model_control, dict) else None
    )
    selected_config = (
        model_values.get(selected_model)
        if isinstance(model_values, dict) and isinstance(selected_model, str)
        else None
    )
    values = (
        selected_config.get("reasoning_efforts")
        if isinstance(selected_config, dict)
        else None
    )
    if isinstance(values, list) and all(isinstance(item, str) for item in values):
        return values
    return []


def url_matches_prefix(candidate: str, prefix: str) -> bool:
    try:
        parsed = urlsplit(candidate)
        prefix_value = f"{prefix}1/" if prefix.endswith(":") else prefix
        allowed = urlsplit(prefix_value)
        parsed_port = parsed.port
        allowed_port = allowed.port
    except ValueError:
        return False
    if parsed.scheme != allowed.scheme or parsed.hostname != allowed.hostname:
        return False
    if (
        allowed_port is not None
        and not prefix.endswith(":")
        and parsed_port != allowed_port
    ):
        return False
    return parsed.path.startswith(allowed.path)
