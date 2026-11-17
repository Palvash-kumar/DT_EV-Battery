"""Validate incoming MQTT JSON against the charging-request JSON Schema."""

import json
import logging
from pathlib import Path

import jsonschema

log = logging.getLogger(__name__)

_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "shared"
    / "schemas"
    / "charging-request.schema.json"
)

with open(_SCHEMA_PATH) as f:
    _REQUEST_SCHEMA = json.load(f)

# Pre-compile for speed (reused on every message)
_VALIDATOR = jsonschema.Draft202012Validator(_REQUEST_SCHEMA)


class ValidationError(Exception):
    """Raised when a request fails schema or business-rule validation."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def validate(payload: dict) -> None:
    """Validate a parsed request dict. Raises ValidationError on failure."""

    # 1. JSON Schema validation
    errors = sorted(_VALIDATOR.iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        path = ".".join(str(p) for p in first.absolute_path) or "(root)"
        raise ValidationError(
            "SCHEMA_INVALID",
            f"Schema error at '{path}': {first.message}",
        )

    # 2. Business rules (schema can't express cross-field constraints)
    start = payload["charging"]["startSocPct"]
    target = payload["charging"]["targetSocPct"]
    if target <= start:
        raise ValidationError(
            "BUSINESS_RULE",
            f"targetSocPct ({target}) must be > startSocPct ({start}).",
        )
