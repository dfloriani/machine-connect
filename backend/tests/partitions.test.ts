import test from "node:test";
import assert from "node:assert/strict";

import {
  partitionName,
  partitionDate,
  partitionSpec,
  upcomingPartitions,
  expiredPartitions,
} from "../lib/partitions.js";

test("partitionSpec covers exactly one UTC day", () => {
  assert.deepEqual(partitionSpec(new Date("2026-08-13T17:42:00.000Z")), {
    name: "telemetry_2026_08_13",
    from: "2026-08-13",
    to: "2026-08-14",
  });
});

test("partitionSpec rolls over into the next month", () => {
  assert.deepEqual(partitionSpec(new Date("2026-08-31T23:59:59.000Z")), {
    name: "telemetry_2026_08_31",
    from: "2026-08-31",
    to: "2026-09-01",
  });
});

test("partition names round trip back to their day", () => {
  const day = new Date("2026-01-05T00:00:00.000Z");
  assert.equal(partitionDate(partitionName(day))?.getTime(), day.getTime());
});

test("partitionDate ignores tables that are not partitions", () => {
  assert.equal(partitionDate("machines"), null);
  assert.equal(partitionDate("telemetry_not_a_date"), null);
});

test("upcomingPartitions covers today plus the requested days ahead", () => {
  const specs = upcomingPartitions(new Date("2026-08-13T12:00:00.000Z"), 3);

  assert.deepEqual(
    specs.map((s) => s.name),
    [
      "telemetry_2026_08_13",
      "telemetry_2026_08_14",
      "telemetry_2026_08_15",
      "telemetry_2026_08_16",
    ]
  );
});

test("expiredPartitions drops only days past the retention window", () => {
  const now = new Date("2026-08-13T09:00:00.000Z");
  const names = [
    "telemetry_2026_07_13", // 31 days old
    "telemetry_2026_07_14", // exactly at the cutoff, kept
    "telemetry_2026_08_12",
    "telemetry_2026_08_13",
  ];

  assert.deepEqual(expiredPartitions(names, now, 30), ["telemetry_2026_07_13"]);
});

test("expiredPartitions leaves unrelated tables alone", () => {
  const now = new Date("2026-08-13T09:00:00.000Z");
  assert.deepEqual(expiredPartitions(["machines", "alerts"], now, 1), []);
});

test("a short retention window still keeps the current day", () => {
  const now = new Date("2026-08-13T09:00:00.000Z");
  const kept = expiredPartitions(["telemetry_2026_08_13"], now, 1);
  assert.deepEqual(kept, []);
});
