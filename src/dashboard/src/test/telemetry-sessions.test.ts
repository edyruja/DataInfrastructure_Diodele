import { describe, expect, it } from "vitest";
import {
  formatLapTime,
  formatDelta,
  isLapValid,
  speedColor,
  formatSessionDateTime,
  computeTrackBounds,
  projectPoints,
  snapPointToPolyline,
  interpolateTelemetryPoint,
  extractGpsWaypoints,
  interpolateTrackPosition,
  interpolateTrackSpline,
  buildReplayTimeline,
} from "@/lib/telemetry-sessions";

describe("extractGpsWaypoints and interpolateTrackPosition (60 FPS smooth circuit movement)", () => {
  const rawPoints = [
    // 4 points with identical GPS (simulating phone accelerometer batch)
    { lap_id: "l1", lap_number: 1, lap_offset_ms: 0, lat: 46.7800, lon: 23.6100, speed_kmh: 36, bearing: 0, g_lat: 0, g_lon: 0, is_corner_apex: 0 as const },
    { lap_id: "l1", lap_number: 1, lap_offset_ms: 250, lat: 46.7800, lon: 23.6100, speed_kmh: 36, bearing: 0, g_lat: 0, g_lon: 0, is_corner_apex: 0 as const },
    { lap_id: "l1", lap_number: 1, lap_offset_ms: 500, lat: 46.7800, lon: 23.6100, speed_kmh: 36, bearing: 0, g_lat: 0, g_lon: 0, is_corner_apex: 0 as const },
    { lap_id: "l1", lap_number: 1, lap_offset_ms: 750, lat: 46.7800, lon: 23.6100, speed_kmh: 36, bearing: 0, g_lat: 0, g_lon: 0, is_corner_apex: 0 as const },
    // Next GPS fix at t=1000
    { lap_id: "l1", lap_number: 1, lap_offset_ms: 1000, lat: 46.7801, lon: 23.6101, speed_kmh: 40, bearing: 0, g_lat: 0, g_lon: 0, is_corner_apex: 0 as const },
  ];

  it("extracts distinct GPS waypoints without duplicate stationary coordinates", () => {
    const waypoints = extractGpsWaypoints(rawPoints);
    expect(waypoints.length).toBe(2);
    expect(waypoints[0]!.timeMs).toBe(0);
    expect(waypoints[1]!.timeMs).toBe(1000);
  });

  it("keeps corrupt jumps and missing GPS out of the trace and the replay position", () => {
    const point = rawPoints[0]!;
    const points = [
      point,
      { ...point, lap_offset_ms: 50, lat: 46.784 },
      { ...point, lap_offset_ms: 100, lat: 46.78402 },
      { ...point, lap_offset_ms: 4000, lat: 46.7841 },
    ];
    const waypoints = extractGpsWaypoints(points);
    expect(waypoints.map((p) => p.breakBefore ?? false)).toEqual([false, true, false, true]);
    expect(interpolateTrackPosition(waypoints, 25)).toBeNull();
    expect(interpolateTrackPosition(waypoints, 2000)).toBeNull();
    expect(interpolateTrackPosition(waypoints, 75)?.lat).toBeCloseTo(46.78401);
    const projected = projectPoints(waypoints);
    const smooth = interpolateTrackSpline(projected);
    expect(smooth.filter((p) => p.breakBefore)).toHaveLength(2);
  });

  it("builds a session replay from one chronological clock while preserving lap breaks", () => {
    const point = rawPoints[0]!;
    const nextLap = { ...point, lap_id: "l2", lap_number: 2 };
    const points = buildReplayTimeline([
      { ...point, lap_offset_ms: 950, session_offset_ms: 950 },
      { ...nextLap, lap_offset_ms: 15, session_offset_ms: 965 },
      { ...nextLap, lap_offset_ms: 60, session_offset_ms: 1010 },
    ]);
    expect(points.map((p) => p.lap_offset_ms)).toEqual([950, 965, 1010]);
    expect(extractGpsWaypoints(points)[1]?.breakBefore).toBe(true);
    expect(buildReplayTimeline([
      { ...point, lap_offset_ms: 950 },
      { ...nextLap, lap_offset_ms: 15 },
    ]).map((p) => p.lap_offset_ms)).toEqual([950, 966]);
  });

  it("interpolates continuous 60 FPS trajectory between GPS fixes without pausing or teleporting", () => {
    const waypoints = extractGpsWaypoints(rawPoints);
    // At t = 250ms (where raw points were previously frozen)
    const at250 = interpolateTrackPosition(waypoints, 250);
    expect(at250).not.toBeNull();
    expect(at250!.lat).toBeCloseTo(46.780025, 7); // Smoothly 25% of the distance!
    expect(at250!.lon).toBeCloseTo(23.610025, 7);

    // At t = 500ms
    const at500 = interpolateTrackPosition(waypoints, 500);
    expect(at500!.lat).toBeCloseTo(46.78005, 7); // Smoothly 50% of the distance!
    expect(at500!.lon).toBeCloseTo(23.61005, 7);
  });
});

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
      lat: 46.78002,
      lon: 23.61002,
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
    expect(res!.lat).toBeCloseTo(46.78001, 6);
    expect(res!.lon).toBeCloseTo(23.61001, 6);
    expect(res!.alpha).toBeCloseTo(0.5, 2);
  });

  it("handles boundary before start and after end", () => {
    const before = interpolateTelemetryPoint(points, -10);
    expect(before!.speed_kmh).toBe(50);
    const after = interpolateTelemetryPoint(points, 200);
    expect(after!.speed_kmh).toBe(60);
  });

  it("does not estimate telemetry inside a missing interval or between laps", () => {
    const start = points[0]!;
    const end = points[1]!;
    expect(interpolateTelemetryPoint([start, { ...end, lap_offset_ms: 3500 }], 1000)).toBeNull();
    expect(interpolateTelemetryPoint([start, { ...end, lap_id: "l2" }], 50)).toBeNull();
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

describe("isLapValid and Best Lap Selection", () => {
  const sessionLaps = [
    {
      lap_id: "ses_lap_01",
      lap_number: 1,
      duration_ms: 105862, // 1:45.862
      max_speed_kmh: 59.3,
      avg_speed_kmh: 45.1,
      max_g_lat: 0.32,
      max_g_brake: 0.28,
    },
    {
      lap_id: "ses_lap_02",
      lap_number: 2,
      duration_ms: 98943, // 1:38.943
      max_speed_kmh: 55.7,
      avg_speed_kmh: 46.8,
      max_g_lat: 0.21,
      max_g_brake: 0.22,
    },
    {
      lap_id: "ses_lap_03",
      lap_number: 3,
      duration_ms: 4055, // 0:04.055 (incomplete lap stopped prematurely)
      max_speed_kmh: 43.2,
      avg_speed_kmh: 30.1,
      max_g_lat: 0.09,
      max_g_brake: 0.07,
    },
  ];

  it("marks completed laps as valid and incomplete laps under 15s as invalid", () => {
    expect(isLapValid(sessionLaps[0]!, sessionLaps)).toBe(true);
    expect(isLapValid(sessionLaps[1]!, sessionLaps)).toBe(true);
    expect(isLapValid(sessionLaps[2]!, sessionLaps)).toBe(false);
  });

  it("excludes a long lap explicitly stopped before crossing the line", () => {
    expect(isLapValid({ ...sessionLaps[0]!, is_complete: false, is_valid: false })).toBe(false);
  });

  it("excludes incomplete laps when finding session best lap, picking L2 instead of L3", () => {
    const validLaps = sessionLaps.filter((l) => isLapValid(l, sessionLaps));
    expect(validLaps.length).toBe(2);
    expect(validLaps.map((l) => l.lap_number)).toEqual([1, 2]);

    const bestLap = validLaps.reduce<typeof sessionLaps[0] | null>(
      (b, l) => (!b || (l.duration_ms > 0 && l.duration_ms < b.duration_ms) ? l : b),
      null,
    );

    expect(bestLap).not.toBeNull();
    expect(bestLap!.lap_number).toBe(2);
    expect(bestLap!.duration_ms).toBe(98943);
  });

  it("calculates accurate delta for L1 relative to L2 (+6.919s instead of +101s)", () => {
    const l1 = sessionLaps[0]!;
    const best = sessionLaps[1]!; // L2
    const deltaMs = l1.duration_ms - best.duration_ms;
    expect(formatDelta(deltaMs)).toBe("+6.919s");
  });

  it("preserves g_lat and g_lon in projected points for circuit hover synchronization", () => {
    const pts = [
      { lat: 46.7800, lon: 23.6100, speed_kmh: 55, g_lat: 0.85, g_lon: -0.45 },
      { lat: 46.7810, lon: 23.6110, speed_kmh: 60, g_lat: -0.62, g_lon: 0.30 },
    ];
    const projected = projectPoints(pts);
    expect(projected.length).toBe(2);
    expect(projected[0]!.g_lat).toBe(0.85);
    expect(projected[0]!.g_lon).toBe(-0.45);
    expect(projected[0]!.speed).toBe(55);
    expect(projected[1]!.g_lat).toBe(-0.62);
    expect(projected[1]!.g_lon).toBe(0.30);
  });
});

describe("interpolateTrackSpline (smooth circuit curve interpolation)", () => {
  const coarsePoints = [
    { x: 50, y: 50, speed: 40, apex: 0 as const, g_lat: 0.1, g_lon: 0.2 },
    { x: 100, y: 150, speed: 70, apex: 1 as const, g_lat: 0.9, g_lon: -0.5 },
    { x: 200, y: 150, speed: 90, apex: 0 as const, g_lat: 0.2, g_lon: 0.4 },
    { x: 250, y: 50, speed: 50, apex: 0 as const, g_lat: 0.0, g_lon: -0.2 },
  ];

  it("densifies coarse track points into a smooth curved spline trajectory", () => {
    const smooth = interpolateTrackSpline(coarsePoints, false, 4);
    expect(smooth.length).toBeGreaterThan(coarsePoints.length);

    // First and last points should match original endpoints
    expect(smooth[0]!.x).toBeCloseTo(50, 0);
    expect(smooth[0]!.y).toBeCloseTo(50, 0);
    expect(smooth[smooth.length - 1]!.x).toBeCloseTo(250, 0);
    expect(smooth[smooth.length - 1]!.y).toBeCloseTo(50, 0);
  });

  it("smoothly interpolates speed and g-forces across intermediate spline points", () => {
    const smooth = interpolateTrackSpline(coarsePoints, false, 4);
    // Find an intermediate point between point 0 (speed 40) and point 1 (speed 70)
    const midPoint = smooth.find((p) => p.x > 60 && p.x < 90);
    expect(midPoint).toBeDefined();
    expect(midPoint!.speed).toBeGreaterThan(40);
    expect(midPoint!.speed).toBeLessThan(70);
    expect(midPoint!.g_lat).toBeDefined();
  });

  it("handles closed loop track interpolation without seams", () => {
    const closed = interpolateTrackSpline(coarsePoints, true, 4);
    expect(closed.length).toBeGreaterThan(coarsePoints.length);
    // In a closed loop, first and last point connect
    const first = closed[0]!;
    const last = closed[closed.length - 1]!;
    expect(first.x).toBeCloseTo(last.x, 0);
    expect(first.y).toBeCloseTo(last.y, 0);
  });

  it("handles boundary condition with minimal points gracefully", () => {
    expect(interpolateTrackSpline([], false)).toEqual([]);
    const single = [{ x: 10, y: 10, speed: 30, apex: 0 as const }];
    expect(interpolateTrackSpline(single, false)).toEqual(single);
  });
});
