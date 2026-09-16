import test from "node:test";
import assert from "node:assert/strict";

import {
  validateTelemetryValues,
  toKeyValueMap,
  deriveStatus,
  shouldRaiseAlert,
  parseRecordedAt,
  isClockAhead,
  shouldApplyReading,
  isTemporaryAnomaly,
  temporaryAnomalyAction,
  peakReadings,
  isPeakRaised,
  temporaryAnomalyMessage,
  MAX_VALUES_PER_PAYLOAD,
  MAX_CLOCK_AHEAD_MS,
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

const at = (iso: string) => new Date(iso);

test("parseRecordedAt accepts a time with a UTC offset", () => {
  assert.equal(
    parseRecordedAt("2026-09-16T11:59:30.250Z").toISOString(),
    "2026-09-16T11:59:30.250Z"
  );
  assert.equal(
    parseRecordedAt("2026-09-16T20:59:30+09:00").toISOString(),
    "2026-09-16T11:59:30.000Z"
  );
});

test("parseRecordedAt rejects a time without an offset or that is not a string", () => {
  assert.throws(() => parseRecordedAt("2026-09-16T11:59:30"), /UTC offset/);
  assert.throws(() => parseRecordedAt("2026-09-16"), /UTC offset/);
  assert.throws(() => parseRecordedAt(1789387170000), /UTC offset/);
  assert.throws(() => parseRecordedAt(undefined), /UTC offset/);
  assert.throws(() => parseRecordedAt("2026-13-01T00:00:00Z"), /not a valid time/);
});

test("isClockAhead allows a small clock error", () => {
  const receivedAt = at("2026-09-16T12:00:00.000Z");
  const limit = new Date(receivedAt.getTime() + MAX_CLOCK_AHEAD_MS);
  assert.equal(isClockAhead(limit, receivedAt), false);
  assert.equal(isClockAhead(new Date(limit.getTime() + 1), receivedAt), true);
  assert.equal(isClockAhead(at("2026-09-14T12:00:00Z"), receivedAt), false);
});

test("shouldApplyReading applies the first reading and newer ones only", () => {
  const receivedAt = at("2026-09-16T12:00:10Z");
  const last = at("2026-09-16T12:00:02Z");
  assert.equal(shouldApplyReading(null, at("2026-09-16T12:00:01Z"), receivedAt), true);
  assert.equal(shouldApplyReading(last, at("2026-09-16T12:00:03Z"), receivedAt), true);
  assert.equal(shouldApplyReading(last, at("2026-09-16T12:00:02Z"), receivedAt), true);
  assert.equal(shouldApplyReading(last, at("2026-09-16T12:00:01Z"), receivedAt), false);
});

test("shouldApplyReading does not apply a reading from a clock that is ahead", () => {
  const receivedAt = at("2026-09-16T12:00:00Z");
  assert.equal(shouldApplyReading(null, at("2026-09-18T12:00:00Z"), receivedAt), false);
});

test("isTemporaryAnomaly is true only for a WARNING that has already ended", () => {
  assert.equal(isTemporaryAnomaly("WARNING", "RUNNING"), true);
  assert.equal(isTemporaryAnomaly("WARNING", "WARNING"), false);
  assert.equal(isTemporaryAnomaly("RUNNING", "RUNNING"), false);
  assert.equal(isTemporaryAnomaly("RUNNING", "WARNING"), false);
});

const hotIn = (alertId: string | null) => ({ hot: true, alertId });
const normal = { hot: false, alertId: null };

test("temporaryAnomalyAction starts an alert when no neighbour is hot", () => {
  assert.deepEqual(temporaryAnomalyAction(null, normal), { type: "insert" });
  assert.deepEqual(temporaryAnomalyAction(normal, normal), { type: "insert" });
});

test("temporaryAnomalyAction extends the alert of a hot neighbour", () => {
  assert.deepEqual(temporaryAnomalyAction(hotIn("A"), normal), {
    type: "extendEnd",
    alertId: "A",
    otherAlertId: null,
  });
  assert.deepEqual(temporaryAnomalyAction(null, hotIn("B")), {
    type: "extendStart",
    alertId: "B",
  });
  assert.deepEqual(temporaryAnomalyAction(hotIn("A"), hotIn("A")), {
    type: "inside",
    alertId: "A",
  });
});

test("temporaryAnomalyAction reports two different alerts and extends the earlier one", () => {
  assert.deepEqual(temporaryAnomalyAction(hotIn("A"), hotIn("B")), {
    type: "extendEnd",
    alertId: "A",
    otherAlertId: "B",
  });
});

test("temporaryAnomalyAction raises nothing next to a hot reading from a WARNING period", () => {
  assert.deepEqual(temporaryAnomalyAction(hotIn(null), normal), { type: "none" });
  assert.deepEqual(temporaryAnomalyAction(normal, hotIn(null)), { type: "none" });
  assert.deepEqual(temporaryAnomalyAction(hotIn("A"), hotIn(null)), { type: "none" });
});

test("peakReadings keeps the highest temperature and rpm only", () => {
  assert.deepEqual(
    peakReadings(
      [
        { key: "temperature", value: "95" },
        { key: "rpm", value: "3000" },
      ],
      [
        { key: "temperature", value: "97.5" },
        { key: "rpm", value: "2000" },
        { key: "spindle_load", value: "0.6" },
      ]
    ),
    [
      { key: "temperature", value: "97.5" },
      { key: "rpm", value: "3000" },
    ]
  );
  assert.deepEqual(peakReadings([], [{ key: "status", value: "warning" }]), []);
});

test("isPeakRaised is true only when a peak value goes up", () => {
  const before = [{ key: "temperature", value: "95" }];
  assert.equal(isPeakRaised(before, [{ key: "temperature", value: "95" }]), false);
  assert.equal(isPeakRaised(before, [{ key: "temperature", value: "96" }]), true);
  assert.equal(
    isPeakRaised(before, [
      { key: "temperature", value: "95" },
      { key: "rpm", value: "6000" },
    ]),
    true
  );
});

test("temporaryAnomalyMessage describes one reading or a period", () => {
  const peaks = [
    { key: "temperature", value: "97" },
    { key: "rpm", value: "3000" },
  ];
  assert.equal(
    temporaryAnomalyMessage(
      "M-001",
      at("2026-09-16T12:00:01Z"),
      at("2026-09-16T12:00:01Z"),
      peaks,
      at("2026-09-16T12:00:02Z")
    ),
    "Machine M-001 was temporarily in WARNING at 2026-09-16T12:00:01.000Z " +
      "(temperature 97, rpm 3000), over by 2026-09-16T12:00:02.000Z"
  );
  assert.equal(
    temporaryAnomalyMessage(
      "M-001",
      at("2026-09-16T12:00:01Z"),
      at("2026-09-16T12:00:10Z"),
      [],
      at("2026-09-16T12:00:11Z")
    ),
    "Machine M-001 was temporarily in WARNING from 2026-09-16T12:00:01.000Z " +
      "to 2026-09-16T12:00:10.000Z, over by 2026-09-16T12:00:11.000Z"
  );
});
