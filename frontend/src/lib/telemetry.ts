export interface TelemetryEntry {
  timestamp: string;
  values: { key: string; value: string }[];
}

export interface TelemetryPoint {
  timestamp: string;
  [key: string]: number | string | null;
}

/**
 * The API returns telemetry as string key/value pairs, newest first, but
 * Recharts wants one object per point in chronological order. Doing the
 * reshaping in a plain function keeps it testable without an Apollo mock.
 */
export function toChartPoints(entries: TelemetryEntry[]): TelemetryPoint[] {
  return entries
    .map((entry) => {
      const point: TelemetryPoint = { timestamp: entry.timestamp };
      entry.values.forEach(({ key, value }) => {
        const num = parseFloat(value);
        point[key] = isNaN(num) ? value : num;
      });
      return point;
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
