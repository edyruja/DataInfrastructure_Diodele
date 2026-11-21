import { describe, expect, it } from "vitest";
import {
  formatLapTime,
  formatDelta,
  speedColor,
  formatSessionDateTime,
  computeTrackBounds,
  projectPoints,
  snapPointToPolyline,
  interpolateTelemetryPoint,
} from "@/lib/telemetry-sessions";

describe("interpolateTelemetryPoint", () => {
  const points = [
    {
      lap_id: "l1",
      lap_number: 1,
      lap_offset_ms: 0,
      lat: 46.78,
      lon: 23.61,
      speed_kmh: 50,
      bearing: 0,
      g_lat: 0.1,
      g_lon: 0.2,
      is_corner_apex: 0 as const,
    },
    {
      lap_id: "l1",
      lap_number: 1,
      lap_offset_ms: 100,
      lat: 46.782,
      lon: 23.612,
      speed_kmh: 60,
      bearing: 0,
      g_lat: 0.3,
      g_lon: -0.1,
      is_corner_apex: 1 as const,
    },
  ];

  it("interpolates exactly at 50ms (midpoint)", () => {
    const res = interpolateTelemetryPoint(points, 50);
    expect(res).not.toBeNull();
    expect(res!.speed_kmh).toBeCloseTo(55, 1);
    expect(res!.g_lat).toBeCloseTo(0.2, 2);
    expect(res!.g_lon).toBeCloseTo(0.05, 2);
    expect(res!.lat).toBeCloseTo(46.781, 4);
    expect(res!.lon).toBeCloseTo(23.611, 4);
    expect(res!.alpha).toBeCloseTo(0.5, 2);
  });

  it("handles boundary before start and after end", () => {
    const before = interpolateTelemetryPoint(points, -10);
    expect(before!.speed_kmh).toBe(50);
    const after = interpolateTelemetryPoint(points, 200);
    expect(after!.speed_kmh).toBe(60);
  });
});

describe("snapPointToPolyline", () => {
  it("snaps a point slightly off a track segment onto the segment", () => {
    const track = [
      { x: 10, y: 10 },
      { x: 100, y: 10 },
      { x: 100, y: 100 },
    ];
    // A point at (50, 15) is 5px below the segment from (10, 10) to (100, 10)
    const res = snapPointToPolyline({ x: 50, y: 15 }, track, 20);
    expect(res.x).toBeCloseTo(50, 1);
    expect(res.y).toBeCloseTo(10, 1);
    expect(res.distance).toBeCloseTo(5, 1);
  });

  it("clamps point when beyond corridor threshold", () => {
    const track = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    // Point at (50, 50) is 50px away, with corridor 20px
    const res = snapPointToPolyline({ x: 50, y: 50 }, track, 20);
    expect(res.y).toBeCloseTo(20, 1); // clamped to corridor distance 20
    expect(res.x).toBeCloseTo(50, 1);
  });
});

describe("computeTrackBounds and projectPoints", () => {
  it("computes bounds and projects points within SVG dimensions", () => {
    const points = [
      {
        lap_id: "l1",
        lap_number: 1,
        lap_offset_ms: 0,
        lat: 46.78,
        lon: 23.61,
        speed_kmh: 50,
        bearing: 0,
        g_lat: 0,
        g_lon: 0,
        is_corner_apex: 0 as const,
      },
      {
        lap_id: "l1",
        lap_number: 1,
        lap_offset_ms: 1000,
        lat: 46.785,
        lon: 23.615,
        speed_kmh: 60,
        bearing: 0,
        g_lat: 0,
        g_lon: 0,
        is_corner_apex: 1 as const,
      },
    ];
    const bounds = computeTrackBounds(points);
    expect(bounds).not.toBeNull();
    const proj = projectPoints(points, 400, 220, 20, bounds);
    expect(proj.length).toBe(2);
    const p0 = proj[0]!;
    expect(p0.x).toBeGreaterThanOrEqual(15);
    expect(p0.x).toBeLessThanOrEqual(385);
    expect(p0.y).toBeGreaterThanOrEqual(15);
    expect(p0.y).toBeLessThanOrEqual(205);
  });
});

describe("formatSessionDateTime", () => {
  it("formats ISO string safely", () => {
    const formatted = formatSessionDateTime("2026-11-21T00:50:33.175Z");
    expect(formatted).toBeTruthy();
    expect(typeof formatted).toBe("string");
  });
  it("returns fallback for invalid string", () => {
    expect(formatSessionDateTime("invalid-date")).toBe("invalid-date");
  });
});

describe("formatLapTime", () => {
  it("formats milliseconds as M:SS.mmm (3 decimals for milliseconds)", () => {
    expect(formatLapTime(64320)).toBe("1:04.320");
    expect(formatLapTime(74890)).toBe("1:14.890");
    expect(formatLapTime(78410)).toBe("1:18.410");
    expect(formatLapTime(4841)).toBe("0:04.841");
    expect(formatLapTime(0)).toBe("0:00.000");
  });

  it("handles floating point ms gracefully without decimal leakage", () => {
    expect(formatLapTime(29193.899999999994)).toBe("0:29.194");
  });
});

describe("formatDelta", () => {
  it("formats positive delta with + sign and 3 decimals", () => {
    expect(formatDelta(1240)).toBe("+1.240s");
    expect(formatDelta(530)).toBe("+0.530s");
  });
  it("formats zero delta", () => {
    expect(formatDelta(0)).toBe("+0.000s");
  });
  it("formats negative delta with − sign and 3 decimals", () => {
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
