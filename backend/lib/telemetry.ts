/**
 * Pure telemetry helpers. I pulled these out of server.ts so they can be
 * unit tested without a database or a broker running.
 */

export interface KeyValue {
  key: string;
  value: string;
}

export type MachineState = "IDLE" | "RUNNING" | "WARNING" | "ERROR" | "OFFLINE";

export const MAX_VALUES_PER_PAYLOAD = 50;

export const LIMITS = {
  temperature: { min: -50, max: 2000 },
  rpm: { min: 0, max: 100000 },
};

/** Thresholds above which a machine is considered to be in WARNING. */
export const WARNING_THRESHOLDS = {
  temperature: 90,
  rpm: 5000,
};

/**
 * Telemetry arrives as [{ key, value }] with string values, because the
 * GraphQL schema keeps it generic enough to accept any sensor key.
 * Everything numeric therefore gets parsed and range checked here.
 *
 * It takes `unknown` and hands back a typed array because it also guards the
 * REST endpoint, where the payload has not been through GraphQL's input
 * validation. Returning the value rather than asserting keeps it usable from
 * callers that only have a parsed JSON body.
 */
export function validateTelemetryValues(values: unknown): KeyValue[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values must be a non-empty array");
  }
  if (values.length > MAX_VALUES_PER_PAYLOAD) {
    throw new Error(`values array exceeds maximum length of ${MAX_VALUES_PER_PAYLOAD}`);
  }

  const parsed: KeyValue[] = [];

  for (const entry of values) {
    const { key, value } = (entry ?? {}) as Partial<KeyValue>;

    if (typeof key !== "string" || key.trim() === "") {
      throw new Error("Each value must have a non-empty string key");
    }
    if (typeof value !== "string") {
      throw new Error(`Value for key "${key}" must be a string`);
    }

    if (key === "temperature") {
      const n = parseFloat(value);
      if (isNaN(n) || n < LIMITS.temperature.min || n > LIMITS.temperature.max) {
        throw new Error(`temperature out of range: ${value}`);
      }
    }

    if (key === "rpm") {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < LIMITS.rpm.min || n > LIMITS.rpm.max) {
        throw new Error(`rpm out of range: ${value}`);
      }
    }

    parsed.push({ key, value });
  }

  return parsed;
}

/** Turns the [{ key, value }] list into a plain object for easier lookups. */
export function toKeyValueMap(values: KeyValue[]): Record<string, string> {
  return Object.fromEntries(values.map(({ key, value }) => [key, value]));
}

/**
 * A device can report its own status; otherwise I infer it from the readings.
 * Keeping this pure means the alerting rules are testable in isolation.
 */
export function deriveStatus(readings: Record<string, string>): MachineState {
  const { status, temperature, rpm } = readings;
  if (status) return status.toUpperCase() as MachineState;

  const tooHot = parseFloat(temperature ?? "") > WARNING_THRESHOLDS.temperature;
  const tooFast = parseInt(rpm ?? "", 10) > WARNING_THRESHOLDS.rpm;

  return tooHot || tooFast ? "WARNING" : "RUNNING";
}

/**
 * Alerts are raised on the edge into WARNING, not on every reading above the
 * threshold - otherwise a hot machine would generate one alert per message.
 */
export function shouldRaiseAlert(
  previousStatus: MachineState,
  nextStatus: MachineState
): boolean {
  return nextStatus === "WARNING" && previousStatus !== "WARNING";
}

/** How far ahead of the server clock a machine's clock may run. */
export const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;

// An explicit offset is required. JavaScript reads a time without one in the
// server's own time zone, so the same payload would mean different instants on
// servers in different zones.
const ISO_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Parses recordedAt, the time the machine took the reading. */
export function parseRecordedAt(value: unknown): Date {
  if (typeof value !== "string" || !ISO_TIME_WITH_OFFSET.test(value)) {
    throw new Error(
      "recordedAt must be an ISO 8601 time with a UTC offset, for example 2026-09-16T13:47:20.375Z"
    );
  }
  const recordedAt = new Date(value);
  if (isNaN(recordedAt.getTime())) {
    throw new Error(`recordedAt is not a valid time: ${value}`);
  }
  return recordedAt;
}

/** True when the machine's clock is further ahead of the server than allowed. */
export function isClockAhead(recordedAt: Date, receivedAt: Date): boolean {
  return recordedAt.getTime() - receivedAt.getTime() > MAX_CLOCK_AHEAD_MS;
}

/**
 * A reading changes the machine row only when it is at least as new as the
 * newest reading applied so far, so readings that finish out of order cannot
 * put an older state back. A reading from a clock that is ahead is not applied
 * either: it would make every correct reading after it look older, and the
 * machine row would stop changing.
 */
export function shouldApplyReading(
  lastRecordedAt: Date | null,
  recordedAt: Date,
  receivedAt: Date
): boolean {
  if (isClockAhead(recordedAt, receivedAt)) return false;
  return lastRecordedAt === null || recordedAt.getTime() >= lastRecordedAt.getTime();
}

/**
 * A reading that is not applied because a newer one was, and that gives
 * WARNING while the machine is no longer in WARNING, describes a state that
 * has already ended. It is recorded as an INFO alert rather than as a WARNING
 * alert.
 * If the machine is still in WARNING, the WARNING alert already covers it.
 */
export function isTemporaryAnomaly(
  readingStatus: MachineState,
  currentStatus: MachineState
): boolean {
  return readingStatus === "WARNING" && currentStatus !== "WARNING";
}

/**
 * A stored reading next to a late hot reading, by machine time. alertId is the
 * TEMPORARY_ANOMALY alert whose period covers it, or null.
 */
export interface Neighbour {
  hot: boolean;
  alertId: string | null;
}

export type AnomalyAction =
  | { type: "insert" }
  | { type: "extendEnd"; alertId: string; otherAlertId: string | null }
  | { type: "extendStart"; alertId: string }
  | { type: "inside"; alertId: string }
  | { type: "none" };

/**
 * What a late hot reading does to the TEMPORARY_ANOMALY alerts, from its
 * previous and next stored readings. A hot neighbour that no such alert covers
 * was stored while the machine was in WARNING, so its period already has a
 * WARNING alert. Two different alerts on both sides cannot happen under the
 * machine row lock; otherAlertId reports it and only the earlier alert grows.
 */
export function temporaryAnomalyAction(
  previous: Neighbour | null,
  next: Neighbour | null
): AnomalyAction {
  if ((previous?.hot && !previous.alertId) || (next?.hot && !next.alertId)) {
    return { type: "none" };
  }
  const before = previous?.hot ? previous.alertId : null;
  const after = next?.hot ? next.alertId : null;
  if (before && after && before === after) return { type: "inside", alertId: before };
  if (before) return { type: "extendEnd", alertId: before, otherAlertId: after };
  if (after) return { type: "extendStart", alertId: after };
  return { type: "insert" };
}

const PEAK_KEYS = ["temperature", "rpm"] as const;

/** The highest temperature and rpm of a period after adding one reading. */
export function peakReadings(current: KeyValue[], reading: KeyValue[]): KeyValue[] {
  const peaks = toKeyValueMap(current);
  const values = toKeyValueMap(reading);
  return PEAK_KEYS.flatMap((key) => {
    const candidates = [peaks[key], values[key]].filter((v) => v !== undefined);
    if (candidates.length === 0) return [];
    const highest = candidates.reduce((a, b) => (parseFloat(b) > parseFloat(a) ? b : a));
    return [{ key, value: highest }];
  });
}

/** True when a peak value is higher after the change than before. */
export function isPeakRaised(before: KeyValue[], after: KeyValue[]): boolean {
  const old = toKeyValueMap(before);
  return after.some(
    ({ key, value }) => old[key] === undefined || parseFloat(value) > parseFloat(old[key])
  );
}

/**
 * The alert text for a temporary anomaly: the hot period, its peak
 * temperature and rpm, and the time of the first reading after it that was
 * not hot. Times are ISO 8601 in UTC.
 */
export function temporaryAnomalyMessage(
  machineId: string,
  startedAt: Date,
  lastHotAt: Date,
  peaks: KeyValue[],
  laterReadingAt: Date
): string {
  const period =
    startedAt.getTime() === lastHotAt.getTime()
      ? `at ${startedAt.toISOString()}`
      : `from ${startedAt.toISOString()} to ${lastHotAt.toISOString()}`;
  const values = peaks.map(({ key, value }) => `${key} ${value}`).join(", ");
  return (
    `Machine ${machineId} was temporarily in WARNING ${period}` +
    `${values ? ` (${values})` : ""}, over by ${laterReadingAt.toISOString()}`
  );
}
