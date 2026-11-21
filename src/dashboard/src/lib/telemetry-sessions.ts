// API + WebSocket client for DataInfrastructure_Diodele telemetry backend

const RAW_API_URL = (
  (typeof import.meta !== "undefined" && (import.meta.env?.["VITE_API_URL"] as string | undefined)) ||
  "https://datainfrastructure-diodele.cristianstefanpopa05.workers.dev"
).replace(/\/+$/, "");

export const API_BASE_URL = RAW_API_URL.endsWith("/api")
  ? RAW_API_URL
  : `${RAW_API_URL}/api`;

export const WS_LIVE_URL =
  (typeof import.meta !== "undefined" && (import.meta.env?.["VITE_WS_URL"] as string | undefined)) ||
  `${RAW_API_URL.replace(/^http/, "ws")}/ws?role=web`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiSession = {
  session_id: string;
  device_id: string;
  track_name: string;
  created_at: string;
};

export type ApiLap = {
  lap_id: string;
  lap_number: number;
  duration_ms: number;
  max_speed_kmh: number;
  avg_speed_kmh: number;
  max_g_lat: number;
  max_g_brake: number;
  is_valid?: boolean | number;
};

export type TelemetryPoint = {
  lap_id: string;
  lap_number: number;
  lap_offset_ms: number;
  lat: number;
  lon: number;
  speed_kmh: number;
  bearing: number;
  g_lat: number;
  g_lon: number;
  is_corner_apex: 0 | 1;
};

export type LiveFrame = {
  type: "LIVE_FRAME";
  status: "STREAMING";
  session_id: string;
  device_id: string;
  track_name: string;
  current_lap: number;
  current_lap_time_ms: number;
  frame: {
    lat: number;
    lon: number;
    speed_kmh: number;
    g_lat: number;
    g_lon: number;
    total_g: number;
    is_corner_apex: 0 | 1;
  };
};

export type LapCompletedMsg = {
  type: "LAP_COMPLETED";
  session_id: string;
  lap_number: number;
  duration_ms: number;
};

export type SessionEndedMsg = { type: "SESSION_ENDED"; session_id: string };

export type WsMessage = LiveFrame | LapCompletedMsg | SessionEndedMsg;

// ---------------------------------------------------------------------------
// API fetch helpers
// ---------------------------------------------------------------------------

export async function fetchSessions(
  signal?: AbortSignal,
): Promise<ApiSession[]> {
  const res = await fetch(`${API_BASE_URL}/sessions`, {
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`fetchSessions: HTTP ${res.status}`);
  return res.json() as Promise<ApiSession[]>;
}

export async function fetchLaps(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ApiLap[]> {
  const res = await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/laps`, {
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`fetchLaps: HTTP ${res.status}`);
  return res.json() as Promise<ApiLap[]>;
}

export async function fetchTelemetry(
  sessionId: string,
  signal?: AbortSignal,
): Promise<TelemetryPoint[]> {
  const res = await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/telemetry`, {
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`fetchTelemetry: HTTP ${res.status}`);
  return res.json() as Promise<TelemetryPoint[]>;
}

export async function fetchLapTelemetry(
  lapId: string,
  signal?: AbortSignal,
): Promise<TelemetryPoint[]> {
  const res = await fetch(`${API_BASE_URL}/laps/${encodeURIComponent(lapId)}/telemetry`, {
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`fetchLapTelemetry: HTTP ${res.status}`);
  return res.json() as Promise<TelemetryPoint[]>;
}

export async function fetchLiveTelemetry(
  sessionId: string,
  lastMs: number = 2000,
  signal?: AbortSignal,
): Promise<TelemetryPoint[]> {
  const res = await fetch(
    `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/live?last_ms=${encodeURIComponent(lastMs)}`,
    { signal: signal ?? null },
  );
  if (!res.ok) throw new Error(`fetchLiveTelemetry: HTTP ${res.status}`);
  return res.json() as Promise<TelemetryPoint[]>;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Format ISO date string into readable Date & Time */
export function formatSessionDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })} ${d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  } catch {
    return iso;
  }
}

/** Format duration_ms as "M:SS.mmm" (integer milliseconds, 3 decimals) e.g. 64320 → "1:04.320", 4841 → "0:04.841" */
export function formatLapTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "0:00.000";
  const roundedMs = Math.round(ms);
  const totalSec = Math.floor(roundedMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const millis = roundedMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Format delta vs best in ms (integer milliseconds, 3 decimals) e.g. +1240 → "+1.240s" */
export function formatDelta(ms: number): string {
  if (!isFinite(ms)) return "—";
  const sign = ms >= 0 ? "+" : "−";
  const abs = Math.round(Math.abs(ms));
  const secs = Math.floor(abs / 1000);
  const millis = abs % 1000;
  return `${sign}${secs}.${String(millis).padStart(3, "0")}s`;
}

/**
 * Evaluates whether a lap is complete and valid.
 * An incomplete or aborted lap (e.g. session stopped prematurely after a few seconds)
 * is considered invalid and must not be selected as the best lap nor shown in "Valid only".
 */
export function isLapValid(
  lap: ApiLap,
  allLaps?: ApiLap[],
  telemetryPoints?: TelemetryPoint[],
): boolean {
  // 1. Explicit invalid flag from backend if present
  if (lap.is_valid === false || (lap as any).is_valid === 0) {
    return false;
  }

  // 2. Minimum duration requirement:
  // Any real circuit lap requires at least 15 seconds (15,000 ms).
  if (!lap.duration_ms || lap.duration_ms < 15000) {
    return false;
  }

  // 3. Telemetry point count check if telemetry is loaded
  if (telemetryPoints && telemetryPoints.length > 0) {
    const lapPts = telemetryPoints.filter(
      (p) => p.lap_id === lap.lap_id || p.lap_number === lap.lap_number,
    );
    // If telemetry is present for the session and this lap has fewer than 25 points (~1-2 seconds), it's incomplete
    if (lapPts.length > 0 && lapPts.length < 25) {
      return false;
    }
  }

  // 4. Relative duration check vs other laps in the session:
  // An aborted/incomplete lap will be less than 50% of the fastest candidate lap.
  if (allLaps && allLaps.length > 1) {
    const candidateDurations = allLaps
      .filter((l) => l.duration_ms && l.duration_ms >= 15000)
      .map((l) => l.duration_ms);

    if (candidateDurations.length > 0) {
      const minDuration = Math.min(...candidateDurations);
      if (lap.duration_ms < minDuration * 0.5) {
        return false;
      }
    }
  }

  return true;
}

/** Map speed to a colour: green (fast) → yellow → red (slow/braking) */
export function speedColor(speed: number, maxSpeed: number): string {
  if (maxSpeed === 0) return "#22c55e";
  const t = Math.max(0, Math.min(1, speed / maxSpeed));
  // t=1 → green, t=0 → red, via yellow at t=0.5
  if (t >= 0.5) {
    // green ↔ yellow
    const f = (t - 0.5) * 2;
    const r = Math.round(255 * (1 - f));
    return `rgb(${r},205,0)`;
  } else {
    // yellow ↔ red
    const f = t * 2;
    const g = Math.round(205 * f);
    return `rgb(220,${g},0)`;
  }
}

// ---------------------------------------------------------------------------
// Circuit projection & track snapping helpers
// ---------------------------------------------------------------------------

export type Projected = {
  x: number;
  y: number;
  speed: number;
  apex: 0 | 1;
  g_lat?: number | undefined;
  g_lon?: number | undefined;
  lat?: number | undefined;
  lon?: number | undefined;
  timeMs?: number | undefined;
};

export type TrackBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function computeTrackBounds(
  points: Array<{ lat: number; lon: number }>,
  minSpanMeters = 60,
): TrackBounds | null {
  const valid = points.filter((p) => p.lat !== 0 && p.lon !== 0);
  if (valid.length === 0) return null;

  const first = valid[0]!;
  let minLat = first.lat;
  let maxLat = first.lat;
  let minLon = first.lon;
  let maxLon = first.lon;

  for (let i = 1; i < valid.length; i++) {
    const p = valid[i]!;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const meanLat = (minLat + maxLat) / 2;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((meanLat * Math.PI) / 180);

  const spanLatMeters = (maxLat - minLat) * metersPerDegLat;
  const spanLonMeters = (maxLon - minLon) * metersPerDegLon;

  if (spanLatMeters < minSpanMeters) {
    const padDeg = (minSpanMeters - spanLatMeters) / 2 / metersPerDegLat;
    minLat -= padDeg;
    maxLat += padDeg;
  }

  if (spanLonMeters < minSpanMeters) {
    const padDeg = (minSpanMeters - spanLonMeters) / 2 / (metersPerDegLon || 1);
    minLon -= padDeg;
    maxLon += padDeg;
  }

  return { minLat, maxLat, minLon, maxLon };
}

export function projectCoordWithBounds(
  lat: number,
  lon: number,
  bounds: TrackBounds,
  w = 400,
  h = 220,
  pad = 24,
): { x: number; y: number } {
  const meanLatRad = (((bounds.minLat + bounds.maxLat) / 2) * Math.PI) / 180;
  const cosLat = Math.cos(meanLatRad);

  const rangeX = Math.max(0.000001, (bounds.maxLon - bounds.minLon) * cosLat);
  const rangeY = Math.max(0.000001, bounds.maxLat - bounds.minLat);

  const scale = Math.min((w - 2 * pad) / rangeX, (h - 2 * pad) / rangeY);
  const offsetX = (w - rangeX * scale) / 2;
  const offsetY = (h - rangeY * scale) / 2;

  return {
    x: offsetX + (lon - bounds.minLon) * cosLat * scale,
    y: h - offsetY - (lat - bounds.minLat) * scale,
  };
}

export function projectPoints(
  points: Array<{
    lat: number;
    lon: number;
    speed_kmh: number;
    is_corner_apex?: 0 | 1;
    g_lat?: number;
    g_lon?: number;
    timeMs?: number;
    lap_offset_ms?: number;
  }>,
  w = 400,
  h = 220,
  pad = 24,
  boundsOverride?: TrackBounds | null,
): Projected[] {
  const valid = points.filter((p) => p.lat !== 0 && p.lon !== 0);
  if (!valid.length) return [];

  const bounds = boundsOverride || computeTrackBounds(valid);
  if (!bounds) return [];

  return valid.map((p) => {
    const { x, y } = projectCoordWithBounds(p.lat, p.lon, bounds, w, h, pad);
    return {
      x,
      y,
      speed: p.speed_kmh,
      apex: p.is_corner_apex ?? 0,
      g_lat: p.g_lat ?? 0,
      g_lon: p.g_lon ?? 0,
      lat: p.lat,
      lon: p.lon,
      timeMs: p.timeMs ?? p.lap_offset_ms,
    };
  });
}

/**
 * Catmull-Rom Spline Interpolator for 2D track points.
 * Produces a densely-sampled, curved trajectory passing through all points,
 * smoothing sharp jagged GPS segments for both live and recorded circuit views.
 */
export function interpolateTrackSpline(
  points: Projected[],
  isClosed = false,
  pointsPerSegment = 4,
): Projected[] {
  if (!points || points.length <= 2) return points ? [...points] : [];

  const n = points.length;
  const result: Projected[] = [];

  const getPt = (i: number): Projected => {
    if (isClosed) {
      return points[(i + n) % n]!;
    }
    return points[Math.max(0, Math.min(n - 1, i))]!;
  };

  const segmentsCount = isClosed ? n : n - 1;

  for (let i = 0; i < segmentsCount; i++) {
    const p0 = getPt(i - 1);
    const p1 = getPt(i);
    const p2 = getPt(i + 1);
    const p3 = getPt(i + 2);

    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const subSegments = Math.max(1, Math.min(8, Math.round((dist / 10) * pointsPerSegment)));

    for (let s = 0; s < subSegments; s++) {
      const t = s / subSegments;
      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom spline formula
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);

      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

      const speed = p1.speed + (p2.speed - p1.speed) * t;
      const g_lat =
        p1.g_lat !== undefined && p2.g_lat !== undefined
          ? p1.g_lat + (p2.g_lat - p1.g_lat) * t
          : undefined;
      const g_lon =
        p1.g_lon !== undefined && p2.g_lon !== undefined
          ? p1.g_lon + (p2.g_lon - p1.g_lon) * t
          : undefined;
      const lat =
        p1.lat !== undefined && p2.lat !== undefined
          ? p1.lat + (p2.lat - p1.lat) * t
          : undefined;
      const lon =
        p1.lon !== undefined && p2.lon !== undefined
          ? p1.lon + (p2.lon - p1.lon) * t
          : undefined;

      result.push({
        x: Number(x.toFixed(1)),
        y: Number(y.toFixed(1)),
        speed: Number(speed.toFixed(1)),
        apex: t > 0.5 ? p2.apex : p1.apex,
        g_lat: g_lat !== undefined ? Number(g_lat.toFixed(2)) : undefined,
        g_lon: g_lon !== undefined ? Number(g_lon.toFixed(2)) : undefined,
        lat,
        lon,
        timeMs:
          p1.timeMs !== undefined && p2.timeMs !== undefined
            ? Math.round(p1.timeMs + (p2.timeMs - p1.timeMs) * t)
            : undefined,
      });
    }
  }

  // Push final endpoint for open tracks
  if (!isClosed) {
    const last = points[n - 1]!;
    result.push({ ...last });
  } else if (result.length > 0) {
    result.push({ ...result[0]! });
  }

  return result;
}

export type InterpolatedFrame = {
  index: number;
  alpha: number;
  timeMs: number;
  lat: number;
  lon: number;
  speed_kmh: number;
  g_lat: number;
  g_lon: number;
  total_g: number;
  is_corner_apex: 0 | 1;
};

/**
 * 60 FPS Telemetry Interpolator
 * Efficient binary-search + linear interpolation between recorded telemetry points.
 */
export function interpolateTelemetryPoint(
  points: TelemetryPoint[],
  timeMs: number,
): InterpolatedFrame | null {
  if (!points || points.length === 0) return null;

  const first = points[0]!;
  if (points.length === 1 || timeMs <= first.lap_offset_ms) {
    return {
      index: 0,
      alpha: 0,
      timeMs: first.lap_offset_ms,
      lat: first.lat,
      lon: first.lon,
      speed_kmh: first.speed_kmh,
      g_lat: first.g_lat,
      g_lon: first.g_lon,
      total_g: Math.hypot(first.g_lat, first.g_lon),
      is_corner_apex: first.is_corner_apex,
    };
  }

  const last = points[points.length - 1]!;
  if (timeMs >= last.lap_offset_ms) {
    return {
      index: points.length - 1,
      alpha: 1,
      timeMs: last.lap_offset_ms,
      lat: last.lat,
      lon: last.lon,
      speed_kmh: last.speed_kmh,
      g_lat: last.g_lat,
      g_lon: last.g_lon,
      total_g: Math.hypot(last.g_lat, last.g_lon),
      is_corner_apex: last.is_corner_apex,
    };
  }

  // Binary search: find largest index where points[mid].lap_offset_ms <= timeMs
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.lap_offset_ms <= timeMs) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const idx = Math.max(0, high);
  const nextIdx = Math.min(points.length - 1, idx + 1);
  const p0 = points[idx]!;
  const p1 = points[nextIdx]!;

  const span = p1.lap_offset_ms - p0.lap_offset_ms;
  const rawAlpha = span > 0 ? (timeMs - p0.lap_offset_ms) / span : 0;
  const alpha = Math.max(0, Math.min(1, rawAlpha));

  const g_lat = Number((p0.g_lat + (p1.g_lat - p0.g_lat) * alpha).toFixed(2));
  const g_lon = Number((p0.g_lon + (p1.g_lon - p0.g_lon) * alpha).toFixed(2));
  const speed_kmh = Number((p0.speed_kmh + (p1.speed_kmh - p0.speed_kmh) * alpha).toFixed(1));

  return {
    index: idx,
    alpha,
    timeMs,
    lat: p0.lat + (p1.lat - p0.lat) * alpha,
    lon: p0.lon + (p1.lon - p0.lon) * alpha,
    speed_kmh,
    g_lat,
    g_lon,
    total_g: Number(Math.hypot(g_lat, g_lon).toFixed(2)),
    is_corner_apex: alpha > 0.5 ? p1.is_corner_apex : p0.is_corner_apex,
  };
}

export type GpsWaypoint = {
  timeMs: number;
  lat: number;
  lon: number;
  speed_kmh: number;
  g_lat: number;
  g_lon: number;
};

/**
 * Extracts clean, distinct GPS waypoints from telemetry points.
 * Eliminates duplicate/frozen GPS coordinates caused by sensor chunking,
 * ensuring continuous 60 FPS interpolation without pauses or teleportation.
 */
export function extractGpsWaypoints(points: TelemetryPoint[]): GpsWaypoint[] {
  const valid = points.filter((p) => p.lat !== 0 && p.lon !== 0);
  if (!valid.length) return [];

  const waypoints: GpsWaypoint[] = [];

  for (let i = 0; i < valid.length; i++) {
    const p = valid[i]!;
    if (waypoints.length === 0) {
      waypoints.push({
        timeMs: p.lap_offset_ms,
        lat: p.lat,
        lon: p.lon,
        speed_kmh: p.speed_kmh,
        g_lat: p.g_lat,
        g_lon: p.g_lon,
      });
      continue;
    }

    const last = waypoints[waypoints.length - 1]!;
    const dist = haversineMeters(last.lat, last.lon, p.lat, p.lon);
    const dt = p.lap_offset_ms - last.timeMs;

    // Record as new waypoint if vehicle moved (>= 0.6m) or stationary interval passed (> 400ms)
    // or if it's the very last point
    if (dist >= 0.6 || (p.speed_kmh === 0 && dt > 400) || i === valid.length - 1) {
      const timeMs = dt > 0 ? p.lap_offset_ms : last.timeMs + 10;
      waypoints.push({
        timeMs,
        lat: p.lat,
        lon: p.lon,
        speed_kmh: p.speed_kmh,
        g_lat: p.g_lat,
        g_lon: p.g_lon,
      });
    }
  }

  return waypoints;
}

/**
 * Smooth 60 FPS Track Position Interpolator
 * Returns the exact (lat, lon, speed) along the continuous circuit path at any timeMs.
 */
export function interpolateTrackPosition(
  waypoints: GpsWaypoint[],
  timeMs: number,
): { lat: number; lon: number; speed_kmh: number; index: number; alpha: number } | null {
  if (!waypoints || waypoints.length === 0) return null;

  const first = waypoints[0]!;
  if (waypoints.length === 1 || timeMs <= first.timeMs) {
    return {
      lat: first.lat,
      lon: first.lon,
      speed_kmh: first.speed_kmh,
      index: 0,
      alpha: 0,
    };
  }

  const last = waypoints[waypoints.length - 1]!;
  if (timeMs >= last.timeMs) {
    return {
      lat: last.lat,
      lon: last.lon,
      speed_kmh: last.speed_kmh,
      index: waypoints.length - 1,
      alpha: 1,
    };
  }

  // Binary search for segment: waypoints[idx].timeMs <= timeMs
  let low = 0;
  let high = waypoints.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (waypoints[mid]!.timeMs <= timeMs) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const idx = Math.max(0, Math.min(waypoints.length - 2, high));
  const w0 = waypoints[idx]!;
  const w1 = waypoints[idx + 1]!;

  const span = w1.timeMs - w0.timeMs;
  const alpha = span > 0 ? Math.max(0, Math.min(1, (timeMs - w0.timeMs) / span)) : 0;

  return {
    lat: w0.lat + (w1.lat - w0.lat) * alpha,
    lon: w0.lon + (w1.lon - w0.lon) * alpha,
    speed_kmh: Number((w0.speed_kmh + (w1.speed_kmh - w0.speed_kmh) * alpha).toFixed(1)),
    index: idx,
    alpha,
  };
}

/**
 * Snaps a 2D point (x, y) onto the closest segment of a reference track polyline.
 * If distance is within maxCorridorPx, snaps directly to the centerline.
 * If slightly further away, clamps to the corridor threshold so the car never falls off track.
 */
export function snapPointToPolyline(
  p: { x: number; y: number },
  polyline: Array<{ x: number; y: number }>,
  maxCorridorPx = 45,
): { x: number; y: number; distance: number; segmentIndex: number } {
  if (polyline.length === 0) return { x: p.x, y: p.y, distance: 0, segmentIndex: 0 };
  if (polyline.length === 1) {
    const first = polyline[0]!;
    const d = Math.hypot(p.x - first.x, p.y - first.y);
    return { x: first.x, y: first.y, distance: d, segmentIndex: 0 };
  }

  let best = { x: polyline[0]!.x, y: polyline[0]!.y, distSq: Infinity, segmentIndex: 0 };

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;

    let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const sx = a.x + t * dx;
    const sy = a.y + t * dy;
    const distSq = (p.x - sx) ** 2 + (p.y - sy) ** 2;

    if (distSq < best.distSq) {
      best = { x: sx, y: sy, distSq, segmentIndex: i };
    }
  }

  const distance = Math.sqrt(best.distSq);

  if (distance <= maxCorridorPx) {
    return { x: best.x, y: best.y, distance, segmentIndex: best.segmentIndex };
  } else {
    const ratio = maxCorridorPx / distance;
    const clampedX = best.x + (p.x - best.x) * ratio;
    const clampedY = best.y + (p.y - best.y) * ratio;
    return { x: clampedX, y: clampedY, distance, segmentIndex: best.segmentIndex };
  }
}
