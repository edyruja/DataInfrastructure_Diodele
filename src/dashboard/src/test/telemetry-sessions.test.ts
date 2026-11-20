import { describe, expect, it } from "vitest";
import { selectSession, sessionMetrics, visibleLaps } from "@/lib/telemetry-sessions";

describe("Session selection", () => {
  it("uses the selected session for metrics and laps", () => {
    const dry = selectSession("01");
    const wet = selectSession("02");
    expect(sessionMetrics(dry).bestTime).toBe("1:04.320");
    expect(sessionMetrics(wet)).toEqual({ bestTime: "1:14.890", bestLap: "L4", maxSpeed: 178.6, maxLateral: 1.06, maxBraking: -1.14 });
    expect(visibleLaps(wet, false)).toHaveLength(5);
    expect(visibleLaps(wet, false)[3]?.[1]).toBe("1:14.890");
  });

  it("applies the valid-only filter to each selected session", () => {
    expect(visibleLaps(selectSession("01"), true)).toHaveLength(5);
    expect(visibleLaps(selectSession("02"), true)).toHaveLength(4);
    expect(visibleLaps(selectSession("03"), true).map((lap) => lap[0])).toEqual(["L2", "L3", "L4", "L6"]);
  });
});