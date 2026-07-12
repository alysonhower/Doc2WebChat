from __future__ import annotations

from typing import Any


class AppError(RuntimeError):
    """A narrow error safe to expose to the local UI."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        field: str | None = None,
        file: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field
        self.file = file

    def as_dict(self) -> dict[str, str]:
        value = {"code": self.code, "message": self.message}
        if self.field is not None:
            value["field"] = self.field
        if self.file is not None:
            value["file"] = self.file
        return value


def success(value: Any) -> dict[str, Any]:
    return {"ok": True, "value": value}


def failure(error: AppError) -> dict[str, Any]:
    return {"ok": False, "error": error.as_dict()}
