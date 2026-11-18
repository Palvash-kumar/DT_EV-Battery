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

import config
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

def _request(**changes):
    req = _valid_request()
    for path, value in changes.items():
        block, key = path.split("__")
        req[block][key] = value
    return req


def _predict(**changes):
    return predictors.predict(_request(**changes))[0]["predictions"]


LEVEL2 = {"charging__chargerType": "Level 2", "charging__requestedRateKw": 7.2, "vehicle__model": "Chevy Bolt"}


class TestPredictor:
    def test_valid_prediction_returns_expected_keys(self):
        charging, health = predictors.predict(_valid_request())
        for key in ("durationHours", "energyKwh", "costUsd", "estimatedSohPct", "batteryWearPct", "wearFactor"):
            assert isinstance(charging["predictions"][key], float)
            assert charging["predictions"][key] > 0
        for key in ("durationVersion", "energyVersion", "costVersion", "wearVersion"):
            assert key in charging["model"]
        assert health["health"]["eolThresholdSohPct"] == 80.0
        assert health["health"]["rulCycles"] > 0

    def test_predictions_are_native_floats(self):
        """Ensure predictions are JSON-serializable (not numpy types)."""
        json.dumps(predictors.predict(_valid_request()))

    def test_results_match_shared_schemas(self):
        import jsonschema
        for req in (_valid_request(), _request(**LEVEL2)):
            charging, health = predictors.predict(req)
            for body, name in ((charging, "charging-result"), (health, "health-result")):
                schema = json.loads((schemas._SCHEMA_PATH.parent / f"{name}.schema.json").read_text())
                result = json.loads(main._build_result(str(uuid.uuid4()), "completed", body=body))
                jsonschema.Draft202012Validator(schema).validate(result)

    def test_level2_uses_trained_models_and_dc_uses_physics(self):
        l2 = predictors.predict(_request(**LEVEL2))[0]["model"]
        dc = predictors.predict(_valid_request())[0]["model"]
        assert l2["durationVersion"].startswith("palo-alto") and l2["costVersion"].startswith("palo-alto")
        assert dc["durationVersion"].startswith("physics") and dc["costVersion"].startswith("physics")

    def test_bigger_soc_window_takes_longer_and_costs_more(self):
        for base in ({}, LEVEL2):
            short = _predict(**base, charging__targetSocPct=50)
            long = _predict(**base, charging__targetSocPct=90)
            assert long["durationHours"] > short["durationHours"]
            assert long["energyKwh"] > short["energyKwh"]
            assert long["costUsd"] > short["costUsd"]

    def test_dc_fast_is_faster_than_level_2_and_level_1(self):
        dc = _predict(charging__chargerType="DC Fast Charger", charging__requestedRateKw=150)
        l2 = _predict(charging__chargerType="Level 2", charging__requestedRateKw=11)
        l1 = _predict(charging__chargerType="Level 1", charging__requestedRateKw=1.9)
        assert dc["durationHours"] < l2["durationHours"] < l1["durationHours"]

    def test_level2_duration_is_close_to_physics_with_real_world_overhead(self):
        pred = _predict(**LEVEL2, charging__startSocPct=20, charging__targetSocPct=80)
        ideal = pred["energyKwh"] / 7.2
        assert ideal <= pred["durationHours"] < ideal * 1.5

    def test_requested_rate_above_charger_limit_is_capped(self):
        charging, _ = predictors.predict(_request(charging__chargerType="Level 1", charging__requestedRateKw=50,
                                                  charging__startSocPct=20))
        assert charging["predictions"]["durationHours"] > 10
        assert any("exceeds the Level 1 limit" in w for w in charging["warnings"])

    def test_cold_battery_charges_slower(self):
        for base in ({}, LEVEL2):
            cold = _predict(**base, environment__temperatureC=-10)
            mild = _predict(**base, environment__temperatureC=25)
            assert cold["durationHours"] > mild["durationHours"]

    def test_older_vehicle_has_lower_soh_and_rul(self):
        old = predictors.predict(_request(vehicle__vehicleAgeYears=8))[1]["health"]
        new = predictors.predict(_request(vehicle__vehicleAgeYears=1))[1]["health"]
        assert old["sohPct"] < new["sohPct"]
        assert old["rulCycles"] < new["rulCycles"]

    def test_charging_into_taper_region_is_slower_per_percent(self):
        low = _predict(charging__startSocPct=20, charging__targetSocPct=40)
        high = _predict(charging__startSocPct=80, charging__targetSocPct=100)
        assert high["durationHours"] > low["durationHours"]

    def test_fast_charging_never_wears_less_than_level2(self):
        dc = _predict(charging__requestedRateKw=250, charging__startSocPct=10)
        l2 = _predict(**LEVEL2, charging__startSocPct=10)
        assert dc["wearFactor"] >= l2["wearFactor"] > 0

    def test_very_fast_charge_wears_more_than_gentle_charge(self):
        small_pack = {"vehicle__model": "Tesla Model 3", "vehicle__batteryCapacityKwh": 40,
                      "charging__requestedRateKw": 250, "charging__startSocPct": 10, "charging__targetSocPct": 50}
        fast = _predict(**small_pack)
        gentle = _predict(**{**small_pack, "charging__chargerType": "Level 2", "charging__requestedRateKw": 7.2})
        assert fast["wearFactor"] > gentle["wearFactor"]
        assert fast["batteryWearPct"] > gentle["batteryWearPct"]

    def test_deeper_charge_window_wears_more_per_session(self):
        shallow = _predict(**LEVEL2, charging__startSocPct=60, charging__targetSocPct=80)
        deep = _predict(**LEVEL2, charging__startSocPct=10, charging__targetSocPct=90)
        assert deep["wearFactor"] > shallow["wearFactor"]
        assert deep["batteryWearPct"] > shallow["batteryWearPct"]


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

        assert mock_pub.call_count == 2
        charging_call, health_call = mock_pub.call_args_list
        result = json.loads(charging_call.args[0])
        assert result["status"] == "completed"
        assert result["requestId"] == req["requestId"]
        assert "predictions" in result
        assert "topic" not in charging_call.kwargs  # default charging results topic
        health = json.loads(health_call.args[0])
        assert health_call.kwargs["topic"] == config.TOPIC_RESULTS_HEALTH
        assert health["requestId"] == req["requestId"]
        assert health["health"]["sohPct"] > 0

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

        # First call — processed (charging + health result)
        main._handle_request(json.dumps(req).encode())
        assert mock_pub.call_count == 2

        # Second call — same messageId, should be silently ignored
        main._handle_request(json.dumps(req).encode())
        assert mock_pub.call_count == 2  # nothing new published

    @patch("mqtt_client.publish_result")
    def test_duplicate_request_id_republishes_cached(self, mock_pub):
        main._seen_message_ids.clear()
        main._seen_request_ids.clear()

        req_id = str(uuid.uuid4())
        req1 = _valid_request(request_id=req_id, message_id=str(uuid.uuid4()))

        # First call (charging + health result)
        main._handle_request(json.dumps(req1).encode())
        assert mock_pub.call_count == 2
        first_result = json.loads(mock_pub.call_args_list[0].args[0])

        # Second call — new messageId, same requestId → only the cached charging result
        req2 = _valid_request(request_id=req_id, message_id=str(uuid.uuid4()))
        main._handle_request(json.dumps(req2).encode())
        assert mock_pub.call_count == 3
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
