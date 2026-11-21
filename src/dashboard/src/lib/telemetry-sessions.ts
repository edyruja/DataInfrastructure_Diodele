// API + WebSocket client for DataInfrastructure_Diodele telemetry backend

export const API_BASE_URL =
  "https://datainfrastructure-diodele.cristianstefanpopa05.workers.dev";
export const WS_LIVE_URL =
  "wss://datainfrastructure-diodele.cristianstefanpopa05.workers.dev/ws?role=web";

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

export type SessionEndedMsg = { type: "SESSION_ENDED"; session_id: string };

export type WsMessage = LiveFrame | SessionEndedMsg;

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
  const res = await fetch(`${API_BASE_URL}/sessions/${sessionId}/laps`, {
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`fetchLaps: HTTP ${res.status}`);
  return res.json() as Promise<ApiLap[]>;
}

export async function fetchTelemetry(
  sessionId: string,
  signal?: AbortSignal,
): Promise<TelemetryPoint[]> {
  const res = await fetch(`${API_BASE_URL}/sessions/${sessionId}/telemetry`, {
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`fetchTelemetry: HTTP ${res.status}`);
  return res.json() as Promise<TelemetryPoint[]>;
}

export async function fetchLapTelemetry(
  lapId: string,
  signal?: AbortSignal,
): Promise<TelemetryPoint[]> {
  const res = await fetch(`${API_BASE_URL}/laps/${lapId}/telemetry`, {
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`fetchLapTelemetry: HTTP ${res.status}`);
  return res.json() as Promise<TelemetryPoint[]>;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Format duration_ms as "M:SS.mmm"  e.g. 64320 → "1:04.320" */
export function formatLapTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const millis = ms % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Format delta vs best in ms e.g. +1240 → "+1.240s" */
export function formatDelta(ms: number): string {
  const sign = ms >= 0 ? "+" : "−";
  const abs = Math.abs(ms);
  const secs = Math.floor(abs / 1000);
  const millis = abs % 1000;
  return `${sign}${secs}.${String(millis).padStart(3, "0")}s`;
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
