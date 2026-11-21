import { describe, expect, it } from "vitest";
import { formatLapTime, formatDelta, speedColor } from "@/lib/telemetry-sessions";

describe("formatLapTime", () => {
  it("formats milliseconds as M:SS.mmm", () => {
    expect(formatLapTime(64320)).toBe("1:04.320");
    expect(formatLapTime(74890)).toBe("1:14.890");
    expect(formatLapTime(78410)).toBe("1:18.410");
    expect(formatLapTime(0)).toBe("0:00.000");
  });
});

describe("formatDelta", () => {
  it("formats positive delta with + sign", () => {
    expect(formatDelta(1240)).toBe("+1.240s");
    expect(formatDelta(530)).toBe("+0.530s");
  });
  it("formats zero delta", () => {
    expect(formatDelta(0)).toBe("+0.000s");
  });
  it("formats negative delta with − sign", () => {
    expect(formatDelta(-500)).toBe("−0.500s");
  });
});

describe("speedColor", () => {
  it("returns a colour string", () => {
    const c = speedColor(100, 200);
    expect(c).toMatch(/^(rgb|#)/);
  });
  it("handles zero maxSpeed without throwing", () => {
    expect(() => speedColor(0, 0)).not.toThrow();
  });
});
