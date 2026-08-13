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
