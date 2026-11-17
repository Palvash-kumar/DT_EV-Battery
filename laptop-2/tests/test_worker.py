"""Unit tests for the ML inference worker.

Covers: valid request, invalid JSON, missing fields, business rule violation,
duplicate messageId, duplicate requestId, and model-unavailable scenario.

Run:
  cd laptop-2 && source .venv/bin/activate && python -m pytest tests/test_worker.py -v
  or: python tests/test_worker.py
"""

import json
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure ml_service directory is in sys.path before importing service modules
_ml_service_dir = Path(__file__).resolve().parent.parent / "ml_service"
if str(_ml_service_dir) not in sys.path:
    sys.path.insert(0, str(_ml_service_dir))

import main
import mqtt_client
import predictors
import schemas

# ── Fixtures ──────────────────────────────────────────────────────────────────

def _valid_request(request_id=None, message_id=None):
    """Return a valid charging request dict matching the schema."""
    return {
        "schemaVersion": "1.0",
        "messageId": message_id or str(uuid.uuid4()),
        "requestId": request_id or str(uuid.uuid4()),
        "sentAt": "2026-11-17T10:15:30.000Z",
        "stationId": "STATION-001",
        "vehicle": {
            "model": "Tesla Model 3",
            "batteryCapacityKwh": 75,
            "vehicleAgeYears": 3,
        },
        "charging": {
            "startSocPct": 25,
            "targetSocPct": 80,
            "chargerType": "DC Fast Charger",
            "requestedRateKw": 50,
        },
        "environment": {
            "temperatureC": 30,
            "source": "simulation",
        },
    }


# ── Schema validation tests ──────────────────────────────────────────────────

class TestSchemaValidation:
    def test_valid_request_passes(self):
        schemas.validate(_valid_request())  # should not raise

    def test_missing_vehicle_model_fails(self):
        req = _valid_request()
        del req["vehicle"]["model"]
        with pytest.raises(schemas.ValidationError) as exc_info:
            schemas.validate(req)
        assert exc_info.value.code == "SCHEMA_INVALID"

    def test_missing_charging_block_fails(self):
        req = _valid_request()
        del req["charging"]
        with pytest.raises(schemas.ValidationError) as exc_info:
            schemas.validate(req)
        assert exc_info.value.code == "SCHEMA_INVALID"

    def test_target_soc_less_than_start_fails(self):
        req = _valid_request()
        req["charging"]["startSocPct"] = 80
        req["charging"]["targetSocPct"] = 20
        with pytest.raises(schemas.ValidationError) as exc_info:
            schemas.validate(req)
        assert exc_info.value.code == "BUSINESS_RULE"

    def test_target_soc_equal_to_start_fails(self):
        req = _valid_request()
        req["charging"]["startSocPct"] = 50
        req["charging"]["targetSocPct"] = 50
        with pytest.raises(schemas.ValidationError) as exc_info:
            schemas.validate(req)
        assert exc_info.value.code == "BUSINESS_RULE"

    def test_invalid_vehicle_model_fails(self):
        req = _valid_request()
        req["vehicle"]["model"] = "Toyota Prius"
        with pytest.raises(schemas.ValidationError):
            schemas.validate(req)

    def test_invalid_charger_type_fails(self):
        req = _valid_request()
        req["charging"]["chargerType"] = "SuperCharger"
        with pytest.raises(schemas.ValidationError):
            schemas.validate(req)


# ── Predictor tests ───────────────────────────────────────────────────────────

class TestPredictor:
    def test_valid_prediction_returns_expected_keys(self):
        req = _valid_request()
        result = predictors.predict(req)

        assert "predictions" in result
        assert "durationHours" in result["predictions"]
        assert "energyKwh" in result["predictions"]
        assert isinstance(result["predictions"]["durationHours"], float)
        assert isinstance(result["predictions"]["energyKwh"], float)
        assert "model" in result
        assert "durationVersion" in result["model"]
        assert "energyVersion" in result["model"]
        assert "warnings" in result

    def test_predictions_are_native_floats(self):
        """Ensure predictions are JSON-serializable (not numpy types)."""
        result = predictors.predict(_valid_request())
        # json.dumps will raise TypeError if numpy types leak through
        json.dumps(result)


# ── Main handler tests ────────────────────────────────────────────────────────

class TestHandleRequest:
    """Test _handle_request by mocking mqtt_client.publish_result."""

    @patch("mqtt_client.publish_result")
    def test_valid_request_publishes_completed(self, mock_pub):
        # Clear dedup state
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        req = _valid_request()
        main._handle_request(json.dumps(req).encode())

        mock_pub.assert_called_once()
        result = json.loads(mock_pub.call_args[0][0])
        assert result["status"] == "completed"
        assert result["requestId"] == req["requestId"]
        assert "predictions" in result

    @patch("mqtt_client.publish_result")
    def test_invalid_json_publishes_error(self, mock_pub):
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        main._handle_request(b"not json at all {{{")

        mock_pub.assert_called_once()
        result = json.loads(mock_pub.call_args[0][0])
        assert result["status"] == "error"
        assert result["error"]["code"] == "INVALID_JSON"

    @patch("mqtt_client.publish_result")
    def test_missing_fields_publishes_invalid_request(self, mock_pub):
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        req = _valid_request()
        del req["vehicle"]
        main._handle_request(json.dumps(req).encode())

        mock_pub.assert_called_once()
        result = json.loads(mock_pub.call_args[0][0])
        assert result["status"] == "invalid_request"
        assert result["error"]["code"] == "SCHEMA_INVALID"

    @patch("mqtt_client.publish_result")
    def test_duplicate_message_id_ignored(self, mock_pub):
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        msg_id = str(uuid.uuid4())
        req = _valid_request(message_id=msg_id)

        # First call — processed
        main._handle_request(json.dumps(req).encode())
        assert mock_pub.call_count == 1

        # Second call — same messageId, should be silently ignored
        main._handle_request(json.dumps(req).encode())
        assert mock_pub.call_count == 1  # no second publish

    @patch("mqtt_client.publish_result")
    def test_duplicate_request_id_republishes_cached(self, mock_pub):
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        req_id = str(uuid.uuid4())
        req1 = _valid_request(request_id=req_id, message_id=str(uuid.uuid4()))

        # First call
        main._handle_request(json.dumps(req1).encode())
        assert mock_pub.call_count == 1
        first_result = json.loads(mock_pub.call_args[0][0])

        # Second call — new messageId, same requestId → cached result
        req2 = _valid_request(request_id=req_id, message_id=str(uuid.uuid4()))
        main._handle_request(json.dumps(req2).encode())
        assert mock_pub.call_count == 2
        second_result = json.loads(mock_pub.call_args[0][0])

        assert first_result["predictions"] == second_result["predictions"]

    @patch("mqtt_client.publish_result")
    def test_business_rule_violation_publishes_error(self, mock_pub):
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        req = _valid_request()
        req["charging"]["startSocPct"] = 80
        req["charging"]["targetSocPct"] = 20
        main._handle_request(json.dumps(req).encode())

        mock_pub.assert_called_once()
        result = json.loads(mock_pub.call_args[0][0])
        assert result["status"] == "invalid_request"
        assert result["error"]["code"] == "BUSINESS_RULE"

    @patch("predictors.predict", side_effect=RuntimeError("model exploded"))
    @patch("mqtt_client.publish_result")
    def test_model_failure_publishes_safe_error(self, mock_pub, _mock_pred):
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        req = _valid_request()
        main._handle_request(json.dumps(req).encode())

        mock_pub.assert_called_once()
        result = json.loads(mock_pub.call_args[0][0])
        assert result["status"] == "error"
        assert result["error"]["code"] == "INTERNAL_ERROR"
        # Must NOT leak stack trace
        assert "exploded" not in result["error"]["message"]


if __name__ == "__main__":
    pytest.main(["-v", __file__])
