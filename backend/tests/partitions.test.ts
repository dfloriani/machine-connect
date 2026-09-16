import test from "node:test";
import assert from "node:assert/strict";

import {
  partitionName,
  partitionDate,
  partitionSpec,
  partitionsToCreate,
  isInPartitionRange,
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

test("partitionsToCreate covers the retention window plus the requested days ahead", () => {
  const specs = partitionsToCreate(new Date("2026-08-13T12:00:00.000Z"), 2, 3);

  assert.deepEqual(
    specs.map((s) => s.name),
    [
      "telemetry_2026_08_11",
      "telemetry_2026_08_12",
      "telemetry_2026_08_13",
      "telemetry_2026_08_14",
      "telemetry_2026_08_15",
      "telemetry_2026_08_16",
    ]
  );
});

test("partitionsToCreate keeps every partition that expiredPartitions keeps", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const names = partitionsToCreate(now, 30, 3).map((s) => s.name);
  assert.deepEqual(expiredPartitions(names, now, 30), []);
});

test("isInPartitionRange accepts times from the retention cutoff", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  assert.equal(isInPartitionRange(new Date("2026-08-11T00:00:00.000Z"), now, 2, 3), true);
  assert.equal(isInPartitionRange(new Date("2026-08-10T23:59:59.999Z"), now, 2, 3), false);
});

test("isInPartitionRange stops one day before the newest partition", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  assert.equal(isInPartitionRange(new Date("2026-08-15T23:59:59.999Z"), now, 2, 3), true);
  assert.equal(isInPartitionRange(new Date("2026-08-16T00:00:00.000Z"), now, 2, 3), false);
});

test("isInPartitionRange only accepts days that the previous day's maintenance created", () => {
  const lastRun = new Date("2026-08-12T23:00:00.000Z");
  const now = new Date("2026-08-13T00:30:00.000Z");
  const created = new Set(partitionsToCreate(lastRun, 2, 3).map((s) => s.name));

  for (let hour = 0; hour < 24 * 7; hour++) {
    const recordedAt = new Date(Date.UTC(2026, 7, 9, hour));
    if (isInPartitionRange(recordedAt, now, 2, 3)) {
      assert.ok(created.has(partitionSpec(recordedAt).name), recordedAt.toISOString());
    }
  }
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
