import test from "node:test";
import assert from "node:assert/strict";

import {
  validateTelemetryValues,
  toKeyValueMap,
  deriveStatus,
  shouldRaiseAlert,
  MAX_VALUES_PER_PAYLOAD,
} from "../lib/telemetry.js";

test("validateTelemetryValues accepts a well formed payload", () => {
  assert.doesNotThrow(() =>
    validateTelemetryValues([
      { key: "temperature", value: "42.5" },
      { key: "rpm", value: "1200" },
      { key: "spindle_load", value: "0.62" },
    ])
  );
});

test("validateTelemetryValues rejects empty or non-array payloads", () => {
  assert.throws(() => validateTelemetryValues([]), /non-empty array/);
  assert.throws(() => validateTelemetryValues(null), /non-empty array/);
  assert.throws(() => validateTelemetryValues("temperature=42"), /non-empty array/);
});

test("validateTelemetryValues caps the payload size", () => {
  const values = Array.from({ length: MAX_VALUES_PER_PAYLOAD + 1 }, (_, i) => ({
    key: `sensor_${i}`,
    value: "1",
  }));
  assert.throws(() => validateTelemetryValues(values), /maximum length/);
});

test("validateTelemetryValues requires string keys and values", () => {
  assert.throws(
    () => validateTelemetryValues([{ key: "", value: "1" }]),
    /non-empty string key/
  );
  assert.throws(
    () => validateTelemetryValues([{ key: "rpm", value: 1200 }]),
    /must be a string/
  );
});

test("validateTelemetryValues range checks known sensors", () => {
  assert.throws(
    () => validateTelemetryValues([{ key: "temperature", value: "5000" }]),
    /temperature out of range/
  );
  assert.throws(
    () => validateTelemetryValues([{ key: "temperature", value: "hot" }]),
    /temperature out of range/
  );
  assert.throws(
    () => validateTelemetryValues([{ key: "rpm", value: "-1" }]),
    /rpm out of range/
  );
});

test("validateTelemetryValues leaves unknown sensors alone", () => {
  assert.doesNotThrow(() =>
    validateTelemetryValues([{ key: "coolant_level", value: "whatever" }])
  );
});

test("toKeyValueMap flattens the key/value list", () => {
  assert.deepEqual(
    toKeyValueMap([
      { key: "temperature", value: "42" },
      { key: "rpm", value: "900" },
    ]),
    { temperature: "42", rpm: "900" }
  );
});

test("deriveStatus prefers a status reported by the machine", () => {
  assert.equal(deriveStatus({ status: "offline", temperature: "200" }), "OFFLINE");
});

test("deriveStatus flags readings above the thresholds", () => {
  assert.equal(deriveStatus({ temperature: "95" }), "WARNING");
  assert.equal(deriveStatus({ rpm: "6000" }), "WARNING");
  assert.equal(deriveStatus({ temperature: "60", rpm: "1200" }), "RUNNING");
});

test("deriveStatus treats missing readings as RUNNING", () => {
  assert.equal(deriveStatus({}), "RUNNING");
});

test("shouldRaiseAlert only fires on the edge into WARNING", () => {
  assert.equal(shouldRaiseAlert("RUNNING", "WARNING"), true);
  assert.equal(shouldRaiseAlert("IDLE", "WARNING"), true);
  assert.equal(shouldRaiseAlert("WARNING", "WARNING"), false);
  assert.equal(shouldRaiseAlert("WARNING", "RUNNING"), false);
});
