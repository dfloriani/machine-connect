import type { Alert } from "../types";

/** Formats an ISO time from the API in the viewer's local time zone. */
export function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

/**
 * The API sends an alert as data: a kind and ISO times. The text is built here,
 * so alert times are formatted in the viewer's time zone, like every other
 * time on the dashboard. formatTime is a parameter so tests do not depend on
 * the time zone of the machine that runs them.
 */
export function alertText(
  alert: Pick<Alert, "kind" | "timestamp" | "lastHotAt" | "laterReadingAt" | "readings">,
  formatTime: (iso: string) => string = formatLocalTime
): string {
  switch (alert.kind) {
    case "ENTERED_WARNING":
      return `Entered WARNING state at ${formatTime(alert.timestamp)}`;
    case "TEMPORARY_ANOMALY": {
      const period =
        alert.lastHotAt && alert.lastHotAt !== alert.timestamp
          ? `from ${formatTime(alert.timestamp)} to ${formatTime(alert.lastHotAt)}`
          : `at ${formatTime(alert.timestamp)}`;
      const values = (alert.readings ?? [])
        .map(({ key, value }) => `${key} ${value}`)
        .join(", ");
      const over = alert.laterReadingAt
        ? `, over by ${formatTime(alert.laterReadingAt)}`
        : "";
      return `Temporary WARNING ${period}${values ? ` (${values})` : ""}${over}`;
    }
  }
}
