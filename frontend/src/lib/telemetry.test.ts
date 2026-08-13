import { describe, it, expect } from "vitest";
import { toChartPoints } from "./telemetry";

describe("toChartPoints", () => {
  it("flattens key/value pairs onto a single point per reading", () => {
    expect(
      toChartPoints([
        {
          timestamp: "2026-05-15T10:00:00.000Z",
          values: [
            { key: "temperature", value: "42.5" },
            { key: "rpm", value: "1200" },
          ],
        },
      ])
    ).toEqual([{ timestamp: "2026-05-15T10:00:00.000Z", temperature: 42.5, rpm: 1200 }]);
  });

  it("orders points chronologically, since the API returns newest first", () => {
    const points = toChartPoints([
      { timestamp: "2026-05-15T10:02:00.000Z", values: [] },
      { timestamp: "2026-05-15T10:00:00.000Z", values: [] },
      { timestamp: "2026-05-15T10:01:00.000Z", values: [] },
    ]);

    expect(points.map((p) => p.timestamp)).toEqual([
      "2026-05-15T10:00:00.000Z",
      "2026-05-15T10:01:00.000Z",
      "2026-05-15T10:02:00.000Z",
    ]);
  });

  it("keeps non-numeric readings as strings", () => {
    const [point] = toChartPoints([
      {
        timestamp: "2026-05-15T10:00:00.000Z",
        values: [{ key: "status", value: "RUNNING" }],
      },
    ]);

    expect(point.status).toBe("RUNNING");
  });

  it("returns an empty array for no entries", () => {
    expect(toChartPoints([])).toEqual([]);
  });
});
