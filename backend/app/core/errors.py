from __future__ import annotations

from fastapi import HTTPException


class ApiError(HTTPException):
    """Error with a stable machine-readable code: {"detail": {"code", "message"}}."""

    def __init__(self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None):
        super().__init__(status_code=status_code, detail={"code": code, "message": message}, headers=headers)


def not_found(what: str = "That item") -> ApiError:
    # Same response whether the object is missing or outside the caller's scope.
    return ApiError(404, "not_found", f"{what} doesn't exist or isn't available to you.")


def forbidden(message: str = "You don't have permission to do that.") -> ApiError:
    return ApiError(403, "forbidden", message)


def conflict(code: str, message: str) -> ApiError:
    return ApiError(409, code, message)


def bad_request(message: str, code: str = "invalid_request") -> ApiError:
    return ApiError(400, code, message)
