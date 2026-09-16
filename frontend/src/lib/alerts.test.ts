import { describe, it, expect } from "vitest";
import { alertText } from "./alerts";

const bracket = (iso: string) => `[${iso}]`;

describe("alertText", () => {
  it("describes the edge into WARNING with the time it was raised", () => {
    expect(
      alertText(
        {
          kind: "ENTERED_WARNING",
          timestamp: "2026-09-16T12:00:01.000Z",
          lastHotAt: null,
          laterReadingAt: null,
          readings: null,
        },
        bracket
      )
    ).toBe("Entered WARNING state at [2026-09-16T12:00:01.000Z]");
  });

  it("describes a temporary anomaly of one reading with its peaks", () => {
    expect(
      alertText(
        {
          kind: "TEMPORARY_ANOMALY",
          timestamp: "2026-09-16T12:00:01.000Z",
          lastHotAt: "2026-09-16T12:00:01.000Z",
          laterReadingAt: "2026-09-16T12:00:02.000Z",
          readings: [
            { key: "temperature", value: "95" },
            { key: "rpm", value: "3000" },
          ],
        },
        bracket
      )
    ).toBe(
      "Temporary WARNING at [2026-09-16T12:00:01.000Z] (temperature 95, rpm 3000), " +
        "over by [2026-09-16T12:00:02.000Z]"
    );
  });

  it("describes a temporary anomaly period without peaks", () => {
    expect(
      alertText(
        {
          kind: "TEMPORARY_ANOMALY",
          timestamp: "2026-09-16T12:00:01.000Z",
          lastHotAt: "2026-09-16T12:00:10.000Z",
          laterReadingAt: "2026-09-16T12:00:11.000Z",
          readings: [],
        },
        bracket
      )
    ).toBe(
      "Temporary WARNING from [2026-09-16T12:00:01.000Z] to [2026-09-16T12:00:10.000Z], " +
        "over by [2026-09-16T12:00:11.000Z]"
    );
  });
});
