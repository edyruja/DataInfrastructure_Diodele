// API_BASE_URL and WS_LIVE_URL are defined in @/lib/telemetry-sessions
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import car from "@/assets/gt2rs-side.png";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ApiSession,
  type ApiLap,
  type TelemetryPoint,
  type LiveFrame,
  type WsMessage,
  WS_LIVE_URL,
  fetchSessions,
  fetchLaps,
  fetchTelemetry,
  formatLapTime,
  formatDelta,
  speedColor,
} from "@/lib/telemetry-sessions";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "911 GT2 RS — Live Track Telemetry" },
      {
        name: "description",
        content: "Lap times, speed trace and G-forces for the 911 GT2 RS — live telemetry.",
      },
      { property: "og:title", content: "911 GT2 RS — Live Track Telemetry" },
      { property: "og:description", content: "Lap times, speed trace and G-forces for the 911 GT2 RS." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:image", content: car },
      { name: "twitter:image", content: car },
    ],
  }),
  component: Index,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Projected = { x: number; y: number; speed: number; apex: 0 | 1 };

function projectPoints(
  points: TelemetryPoint[],
  w = 400,
  h = 220,
  pad = 20,
): Projected[] {
  if (!points.length) return [];
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const rangeX = maxLon - minLon || 1;
  const rangeY = maxLat - minLat || 1;
  const scale = Math.min((w - 2 * pad) / rangeX, (h - 2 * pad) / rangeY);
  return points.map((p) => ({
    x: pad + (p.lon - minLon) * scale,
    y: h - pad - (p.lat - minLat) * scale,
    speed: p.speed_kmh,
    apex: p.is_corner_apex,
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Index() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [laps, setLaps] = useState<ApiLap[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [validOnly, setValidOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── WebSocket setup ──────────────────────────────────────────────────────
  const connectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    const ws = new WebSocket(WS_LIVE_URL);
    wsRef.current = ws;

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        if (msg.type === "LIVE_FRAME") {
          setLiveFrame(msg);
          setIsLive(true);
        } else if (msg.type === "SESSION_ENDED") {
          setIsLive(false);
          setLiveFrame(null);
        }
      } catch {
        // ignore malformed frames
      }
    };

    const scheduleRetry = () => {
      setIsLive(false);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        connectWs();
      }, 5000);
    };

    ws.onclose = scheduleRetry;
    ws.onerror = scheduleRetry;
  }, []);

  // ── On mount: fetch sessions + open WS ───────────────────────────────────
  useEffect(() => {
    const ac = new AbortController();

    fetchSessions(ac.signal)
      .then((data) => {
        setSessions(data);
        const first = data[0];
        if (first) setSessionId(first.session_id);
      })
      .catch(() => {/* ignore abort */});

    connectWs();

    return () => {
      ac.abort();
      wsRef.current?.close();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [connectWs]);

  // ── When sessionId changes: fetch laps + telemetry ───────────────────────
  useEffect(() => {
    if (!sessionId) return;
    const ac = new AbortController();
    setLoading(true);

    Promise.all([
      fetchLaps(sessionId, ac.signal),
      fetchTelemetry(sessionId, ac.signal),
    ])
      .then(([lapData, telData]) => {
        setLaps(lapData);
        setTelemetry(telData);
      })
      .catch(() => {/* ignore abort */})
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, [sessionId]);

  // ── Computed values ───────────────────────────────────────────────────────
  const bestLap = laps.reduce<ApiLap | null>(
    (b, l) => (!b || l.duration_ms < b.duration_ms ? l : b),
    null,
  );
  const maxSpeed = laps.length ? Math.max(...laps.map((l) => l.max_speed_kmh)) : 0;
  const maxGLat  = laps.length ? Math.max(...laps.map((l) => l.max_g_lat))    : 0;
  const maxGBrake = laps.length ? Math.max(...laps.map((l) => l.max_g_brake)) : 0;
  const avgSpeed =
    laps.length
      ? laps.reduce((s, l) => s + l.avg_speed_kmh, 0) / laps.length
      : 0;

  const displaySpeed = liveFrame ? liveFrame.frame.speed_kmh : maxSpeed;
  const gLat = liveFrame ? liveFrame.frame.g_lat : (bestLap?.max_g_lat ?? 0);
  const gLon = liveFrame ? liveFrame.frame.g_lon : 0;
  const totalG = liveFrame ? liveFrame.frame.total_g : 0;

  // SVG G-meter live dot position
  const gx = 110 + gLat * 52;
  const gy = 110 - gLon * 47;

  // Current session object
  const session = sessions.find((s) => s.session_id === sessionId);

  // Visible laps (all | valid only)
  const visibleLaps = validOnly ? laps.filter((l) => l.lap_number > 1) : laps;

  // Track map projection
  const projected = projectPoints(telemetry);
  const mapMaxSpeed = telemetry.length
    ? Math.max(...telemetry.map((p) => p.speed_kmh))
    : 1;

  // Live position on map
  let liveDot: Projected | null = null;
  if (liveFrame && telemetry.length > 0) {
    const pLat = liveFrame.frame.lat;
    const pLon = liveFrame.frame.lon;
    const fake = projectPoints([
      ...telemetry,
      {
        lap_id: "",
        lap_number: 0,
        lap_offset_ms: 0,
        lat: pLat,
        lon: pLon,
        speed_kmh: liveFrame.frame.speed_kmh,
        bearing: 0,
        g_lat: liveFrame.frame.g_lat,
        g_lon: liveFrame.frame.g_lon,
        is_corner_apex: 0,
      },
    ]);
    liveDot = fake[fake.length - 1] ?? null;
  }

  // G-G scatter (sample up to 80 points)
  const gSample = telemetry.length > 80
    ? telemetry.filter((_, i) => i % Math.ceil(telemetry.length / 80) === 0)
    : telemetry;

  // KPI cards
  const kpis = [
    {
      label: "Best lap",
      value: bestLap ? formatLapTime(bestLap.duration_ms) : "—",
      unit: "",
      sub: bestLap ? `Lap ${bestLap.lap_number} · session best` : "—",
      highlight: true,
    },
    {
      label: "Max speed",
      value: displaySpeed.toFixed(1),
      unit: "km/h",
      sub: liveFrame ? "Live" : "Session max",
    },
    {
      label: "Avg speed",
      value: avgSpeed.toFixed(1),
      unit: "km/h",
      sub: "",
      bar: maxSpeed > 0 ? Math.round((avgSpeed / maxSpeed) * 100) : 0,
    },
    {
      label: "Max lat G",
      value: maxGLat.toFixed(2),
      unit: "G",
      sub: "Session max",
    },
    {
      label: "Max braking G",
      value: `−${maxGBrake.toFixed(2)}`,
      unit: "G",
      sub: "Session max",
      negative: true,
    },
  ] as const;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-shell p-3 md:p-8">
      <div className="mx-auto max-w-7xl rounded-[2rem] border border-border bg-background p-5 md:p-10">

        {/* Nav */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-sm font-semibold tracking-[0.35em]">
            PORSCHE
          </span>

          <div className="order-last w-full md:order-none md:w-80">
            {sessions.length === 0 ? (
              <div className="flex h-11 items-center rounded-md bg-secondary px-4 text-sm text-muted-foreground">
                Loading sessions…
              </div>
            ) : (
              <Select value={sessionId} onValueChange={setSessionId}>
                <SelectTrigger aria-label="Select session" className="h-11 bg-secondary px-4">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sessions.map((s) => (
                    <SelectItem key={s.session_id} value={s.session_id}>
                      {s.track_name} · {s.device_id} ·{" "}
                      {new Date(s.created_at).toLocaleDateString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <span className="flex items-center gap-2 rounded-full border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-wider">
            <span
              className={`size-2 rounded-full ${isLive ? "animate-pulse bg-green-500" : "bg-muted-foreground"}`}
            />
            {isLive ? "● LIVE" : "● Offline"}
          </span>
        </header>

        {/* Hero */}
        <section className="relative mt-10">
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
                {session
                  ? `${session.device_id} · ${new Date(session.created_at).toLocaleDateString()}`
                  : "Waiting for session…"}
              </p>
              <h1 className="mt-2 text-5xl font-semibold tracking-tight md:text-6xl">
                {session?.track_name ?? "No session"}
              </h1>
              <p className="mt-3 text-sm text-muted-foreground">
                {laps.length} lap{laps.length !== 1 ? "s" : ""} recorded
                {liveFrame ? ` · Lap ${liveFrame.current_lap} in progress` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
                Best lap
              </p>
              <p className="mt-2 text-5xl font-semibold tracking-tight md:text-6xl">
                {bestLap ? formatLapTime(bestLap.duration_ms) : "—"}
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                {bestLap ? `Lap ${bestLap.lap_number} · session best` : "No laps yet"}
              </p>
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-32 select-none text-center text-[22vw] font-bold leading-none tracking-tighter text-ghost-text md:text-[14rem]">
            GT2 RS
          </div>
          <div className="relative mx-auto mt-24 max-w-5xl md:mt-32">
            <div className="absolute inset-x-[8%] bottom-[12%] h-[18%] rounded-[50%] border border-border bg-secondary/40 blur-[1px]" />
            <img src={car} alt="Red 911 GT2 RS side profile" className="relative w-full" />
          </div>
        </section>

        {/* KPIs */}
        <section className="mt-24 grid grid-cols-2 gap-3 md:mt-32 md:grid-cols-5">
          {kpis.map((k) => (
            <div
              key={k.label}
              className={`panel p-5 ${"highlight" in k && k.highlight ? "border-accent/60" : ""}`}
            >
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p
                className={`mt-3 font-mono text-2xl font-semibold ${"highlight" in k && k.highlight ? "text-accent" : "negative" in k && k.negative ? "text-destructive" : ""}`}
              >
                {loading ? (
                  <Skeleton className="h-7 w-24" />
                ) : (
                  <>
                    {k.value}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      {k.unit}
                    </span>
                  </>
                )}
              </p>
              {"bar" in k && k.bar ? (
                <div className="mt-3 h-1 rounded-full bg-secondary">
                  <div
                    className="h-1 rounded-full bg-accent"
                    style={{ width: `${k.bar}%` }}
                  />
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  {"sub" in k ? k.sub : ""}
                </p>
              )}
            </div>
          ))}
        </section>

        {/* Map + G-G */}
        <section className="mt-3 grid gap-3 md:grid-cols-2">

          {/* Track Map */}
          <div className="panel p-6">
            <div className="flex justify-between">
              <h2 className="font-medium">Circuit map &amp; speed trace</h2>
              <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                {telemetry.length > 0 ? `${telemetry.length} pts` : "No data"}
              </span>
            </div>
            <svg viewBox="0 0 400 220" className="mt-4 w-full">
              {projected.length > 1 ? (
                <>
                  {/* Per-segment coloured polyline */}
                  {projected.slice(0, -1).map((pt, i) => {
                    const next = projected[i + 1];
                    if (!next) return null;
                    return (
                      <line
                        key={i}
                        x1={pt.x}
                        y1={pt.y}
                        x2={next.x}
                        y2={next.y}
                        stroke={speedColor(pt.speed, mapMaxSpeed)}
                        strokeWidth="3"
                        strokeLinecap="round"
                      />
                    );
                  })}
                  {/* Apex markers */}
                  {projected
                    .filter((p) => p.apex === 1)
                    .map((p, i) => (
                      <circle
                        key={`apex-${i}`}
                        cx={p.x}
                        cy={p.y}
                        r="4"
                        fill="orange"
                        opacity="0.8"
                      />
                    ))}
                  {/* Live position */}
                  {liveDot && (
                    <circle
                      cx={liveDot.x}
                      cy={liveDot.y}
                      r="7"
                      fill="var(--background)"
                      stroke="var(--accent)"
                      strokeWidth="3"
                    />
                  )}
                </>
              ) : (
                <text
                  x="200"
                  y="110"
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize="14"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {loading ? "Loading telemetry…" : "No telemetry data yet"}
                </text>
              )}
            </svg>
            <div className="mt-3 flex justify-between font-mono text-xs text-muted-foreground">
              <span>
                Peak speed{" "}
                <b className="text-foreground">{displaySpeed.toFixed(1)} km/h</b>
              </span>
              {liveFrame && (
                <span>
                  Lap <b className="text-foreground">{liveFrame.current_lap}</b>
                </span>
              )}
            </div>
          </div>

          {/* G-G Diagram */}
          <div className="panel p-6">
            <div className="flex justify-between">
              <h2 className="font-medium">G-G diagram</h2>
              <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                {liveFrame
                  ? `Total G ${totalG.toFixed(2)}`
                  : `${gSample.length} samples`}
              </span>
            </div>
            <svg viewBox="0 0 220 220" className="mx-auto mt-4 w-full max-w-[260px]">
              {/* Concentric dashed circles */}
              {[100, 70, 40].map((r) => (
                <circle
                  key={r}
                  cx="110"
                  cy="110"
                  r={r}
                  fill="none"
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                />
              ))}
              {/* Crosshairs */}
              <line x1="10" y1="110" x2="210" y2="110" stroke="var(--border)" />
              <line x1="110" y1="10" x2="110" y2="210" stroke="var(--border)" />
              {/* Scatter dots from telemetry */}
              {gSample.map((p, i) => (
                <circle
                  key={i}
                  cx={110 + p.g_lat * 52}
                  cy={110 - p.g_lon * 47}
                  r="1.6"
                  fill="var(--accent)"
                  opacity="0.4"
                />
              ))}
              {/* Live needle */}
              <line
                x1="110"
                y1="110"
                x2={gx}
                y2={gy}
                stroke="var(--accent)"
                strokeWidth="3"
              />
              <circle
                cx={gx}
                cy={gy}
                r="6"
                fill="var(--background)"
                stroke="var(--accent)"
                strokeWidth="3"
              />
            </svg>
            <div className="mt-3 flex justify-between font-mono text-xs text-muted-foreground">
              <span>
                Lateral{" "}
                <b className="text-accent">
                  +{gLat.toFixed(2)} G
                </b>
              </span>
              <span>
                Longitudinal{" "}
                <b className="text-destructive">
                  {gLon >= 0 ? "+" : "−"}{Math.abs(gLon).toFixed(2)} G
                </b>
              </span>
            </div>
          </div>
        </section>

        {/* Laps Table */}
        <section className="panel mt-3 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">
              Session laps{" "}
              <span className="ml-2 rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                {laps.length} total
              </span>
            </h2>
            <div className="flex rounded-full bg-secondary p-1 text-xs">
              {(["All laps", "Valid only"] as const).map((l, i) => (
                <Button
                  key={l}
                  size="sm"
                  variant={validOnly === (i === 1) ? "default" : "ghost"}
                  aria-pressed={validOnly === (i === 1)}
                  onClick={() => setValidOnly(i === 1)}
                  className="rounded-full px-4"
                >
                  {l}
                </Button>
              ))}
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[600px] font-mono text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  {["Lap", "Lap time", "Delta", "Max speed", "Max lat G", "Max brk G"].map(
                    (h) => (
                      <th key={h} className="py-3 font-normal">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: 4 }).map((_, i) => (
                      <tr key={i} className="border-t border-border">
                        {Array.from({ length: 6 }).map((__, j) => (
                          <td key={j} className="py-3">
                            <Skeleton className="h-4 w-20" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : visibleLaps.map((lap) => {
                      const isBest = bestLap?.lap_id === lap.lap_id;
                      const delta =
                        bestLap && !isBest
                          ? formatDelta(lap.duration_ms - bestLap.duration_ms)
                          : null;
                      return (
                        <tr
                          key={lap.lap_id}
                          className={`border-t border-border ${isBest ? "bg-secondary" : ""}`}
                        >
                          <td className="py-3">L{lap.lap_number}</td>
                          <td className={isBest ? "text-accent" : ""}>
                            {formatLapTime(lap.duration_ms)}
                          </td>
                          <td>
                            {isBest ? (
                              <span className="rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground">
                                BEST
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                {delta}
                              </span>
                            )}
                          </td>
                          <td>
                            {lap.max_speed_kmh.toFixed(1)}{" "}
                            <span className="text-muted-foreground">km/h</span>
                          </td>
                          <td>{lap.max_g_lat.toFixed(2)} G</td>
                          <td className="text-destructive">
                            −{lap.max_g_brake.toFixed(2)} G
                          </td>
                        </tr>
                      );
                    })}
                {!loading && visibleLaps.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="py-8 text-center text-muted-foreground"
                    >
                      No laps recorded yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </div>
  );
}
