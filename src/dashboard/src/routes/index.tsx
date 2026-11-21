// API_BASE_URL and WS_LIVE_URL are defined in @/lib/telemetry-sessions
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
import { Slider } from "@/components/ui/slider";
import { RefreshCw, Play, Pause, RotateCcw, Plus, Minus } from "lucide-react";
import {
  type ApiSession,
  type ApiLap,
  type TelemetryPoint,
  type LiveFrame,
  type WsMessage,
  type Projected,
  WS_LIVE_URL,
  fetchSessions,
  fetchLaps,
  fetchTelemetry,
  formatLapTime,
  formatDelta,
  formatSessionDateTime,
  speedColor,
  computeTrackBounds,
  projectPoints,
  projectCoordWithBounds,
  snapPointToPolyline,
  haversineMeters,
  interpolateTelemetryPoint,
  extractGpsWaypoints,
  interpolateTrackPosition,
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
// G-G Diagram Zoom Levels (1.5G default -> 1.2G -> 0.9G -> 0.6G for small forces)
// ---------------------------------------------------------------------------

const G_ZOOM_LEVELS = [
  { maxG: 1.5, circles: ["0.5", "1.0", "1.5"] },
  { maxG: 1.2, circles: ["0.4", "0.8", "1.2"] },
  { maxG: 0.9, circles: ["0.3", "0.6", "0.9"] },
  { maxG: 0.6, circles: ["0.2", "0.4", "0.6"] },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function Index() {
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [laps, setLaps] = useState<ApiLap[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [liveTrackPoints, setLiveTrackPoints] = useState<TelemetryPoint[]>([]);
  const [selectedLapId, setSelectedLapId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [liveFrame, setLiveFrame] = useState<LiveFrame | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [validOnly, setValidOnly] = useState(false);

  // ── G-G Diagram Zoom (index into G_ZOOM_LEVELS) ───────────────────────────
  const [gZoomIndex, setGZoomIndex] = useState<number>(0);

  // ── 60 FPS Replay Mode (Historical sessions from DB only) ──────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<number>(1);
  const [replayTimeMs, setReplayTimeMs] = useState<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const lastTickTimeRef = useRef<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLapRef = useRef<number>(1);

  // ── Load sessions from database ──────────────────────────────────────────
  const loadSessions = useCallback(async (selectFirst = false) => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const data = await fetchSessions();
      setSessions(data);
      const first = data[0];
      if (first) {
        setSessionId((prev) => {
          if (!prev || selectFirst || !data.some((s) => s.session_id === prev)) {
            return first.session_id;
          }
          return prev;
        });
      }
    } catch (err) {
      console.error("fetchSessions error:", err);
      setSessionsError(err instanceof Error ? err.message : "Error fetching sessions");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

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

          // If current lap advanced (lap 1 ended, lap 2 started), refresh laps from DB
          if (msg.current_lap > lastLapRef.current) {
            lastLapRef.current = msg.current_lap;
            if (msg.session_id) {
              fetchLaps(msg.session_id).then(setLaps).catch(() => {});
            }
          }

          // Accumulate live GPS points
          if (msg.frame.lat !== 0 && msg.frame.lon !== 0) {
            const newPt: TelemetryPoint = {
              lap_id: `${msg.session_id}_lap_${String(msg.current_lap).padStart(2, "0")}`,
              lap_number: msg.current_lap,
              lap_offset_ms: msg.current_lap_time_ms,
              lat: msg.frame.lat,
              lon: msg.frame.lon,
              speed_kmh: msg.frame.speed_kmh,
              bearing: 0,
              g_lat: msg.frame.g_lat,
              g_lon: msg.frame.g_lon,
              is_corner_apex: msg.frame.is_corner_apex,
            };

            setLiveTrackPoints((prev) => {
              const last = prev[prev.length - 1];
              if (last) {
                // Ignore micro stationary noise (< 1.2m and < 1.5 km/h)
                const dist = haversineMeters(last.lat, last.lon, newPt.lat, newPt.lon);
                if (dist < 1.2 && newPt.speed_kmh < 1.5) {
                  return prev;
                }
              }
              return [...prev, newPt];
            });
          }

          // Ensure session is in the list
          setSessions((prev) => {
            if (!prev.some((s) => s.session_id === msg.session_id)) {
              return [
                {
                  session_id: msg.session_id,
                  device_id: msg.device_id,
                  track_name: msg.track_name,
                  created_at: new Date().toISOString(),
                },
                ...prev,
              ];
            }
            return prev;
          });
        } else if (msg.type === "LAP_COMPLETED") {
          if (msg.session_id) {
            fetchLaps(msg.session_id).then(setLaps).catch(() => {});
          }
        } else if (msg.type === "SESSION_ENDED") {
          setIsLive(false);
          setLiveFrame(null);
          loadSessions();
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
  }, [loadSessions]);

  // ── On mount: load sessions + open WS ─────────────────────────────────────
  useEffect(() => {
    loadSessions(true);
    connectWs();

    return () => {
      wsRef.current?.close();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [loadSessions, connectWs]);

  // ── When sessionId changes: fetch laps + telemetry ───────────────────────
  useEffect(() => {
    if (!sessionId) {
      setLaps([]);
      setTelemetry([]);
      setLiveTrackPoints([]);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setSelectedLapId(null);
    lastLapRef.current = 1;

    Promise.all([
      fetchLaps(sessionId, ac.signal).catch((err) => {
        console.warn("fetchLaps error:", err);
        return [] as ApiLap[];
      }),
      fetchTelemetry(sessionId, ac.signal).catch((err) => {
        console.warn("fetchTelemetry error:", err);
        return [] as TelemetryPoint[];
      }),
    ])
      .then(([lapData, telData]) => {
        setLaps(lapData);
        setTelemetry(telData);
        setLiveTrackPoints(telData);
        if (lapData.length > 0) {
          lastLapRef.current = Math.max(...lapData.map((l) => l.lap_number));
        }
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, [sessionId]);

  // ── Computed values ───────────────────────────────────────────────────────
  const isCurrentSessionLive = isLive && liveFrame?.session_id === sessionId;

  // Active telemetry for recorded / filtered views
  const displayedTelemetry = useMemo(() => {
    if (!selectedLapId) return telemetry;
    return telemetry.filter((p) => p.lap_id === selectedLapId);
  }, [telemetry, selectedLapId]);

  // Duration and base time of current displayed telemetry
  const baseTimeMs = useMemo(() => {
    return displayedTelemetry.length > 0 ? displayedTelemetry[0]!.lap_offset_ms : 0;
  }, [displayedTelemetry]);

  const totalDurationMs = useMemo(() => {
    if (displayedTelemetry.length < 2) return 0;
    const start = displayedTelemetry[0]!.lap_offset_ms;
    const end = displayedTelemetry[displayedTelemetry.length - 1]!.lap_offset_ms;
    return Math.max(0, end - start);
  }, [displayedTelemetry]);

  // Reset replay state whenever session or lap selection changes
  useEffect(() => {
    setIsPlaying(false);
    setReplayTimeMs(null);
  }, [sessionId, selectedLapId]);

  // ── 60 FPS Replay Animation Loop (requestAnimationFrame) ─────────────────
  useEffect(() => {
    if (!isPlaying || isCurrentSessionLive || !displayedTelemetry.length || totalDurationMs <= 0) {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      lastTickTimeRef.current = null;
      return;
    }

    const tick = (now: number) => {
      if (lastTickTimeRef.current === null) {
        lastTickTimeRef.current = now;
      }
      const deltaSec = (now - lastTickTimeRef.current) / 1000;
      lastTickTimeRef.current = now;

      setReplayTimeMs((prev) => {
        const current = prev ?? 0;
        const next = current + deltaSec * 1000 * replaySpeed;
        if (next >= totalDurationMs) {
          setIsPlaying(false);
          return totalDurationMs;
        }
        return next;
      });

      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      lastTickTimeRef.current = null;
    };
  }, [isPlaying, isCurrentSessionLive, displayedTelemetry, totalDurationMs, replaySpeed]);

  const isReplaying =
    !isCurrentSessionLive && replayTimeMs !== null && displayedTelemetry.length > 1;

  // Interpolated 60 FPS state for replay
  const currentReplayFrame = useMemo(() => {
    if (!isReplaying || replayTimeMs === null) return null;
    return interpolateTelemetryPoint(displayedTelemetry, baseTimeMs + replayTimeMs);
  }, [isReplaying, replayTimeMs, displayedTelemetry, baseTimeMs]);

  // ── Reference Track: the established circuit path ────────────────────────
  // On Lap 1 (live), track is being discovered live (referenceTrack = empty).
  // From Lap 2 onwards (or for recorded sessions), referenceTrack holds Lap 1 points (the circuit layout).
  const referenceTrack = useMemo(() => {
    // 1. Recorded session from database:
    if (!isCurrentSessionLive) {
      if (telemetry.length === 0) return [];
      if (selectedLapId) {
        return telemetry.filter((p) => p.lap_id === selectedLapId);
      }
      const lap1 = telemetry.filter((p) => p.lap_number === 1);
      return lap1.length > 8 ? lap1 : telemetry;
    }

    // 2. Live session:
    // When Lap 1 is complete (current_lap >= 2 or completed laps exist):
    const currentLiveLap = liveFrame?.current_lap ?? 1;
    if (currentLiveLap >= 2 || laps.length > 0) {
      const lap1Live = liveTrackPoints.filter((p) => p.lap_number === 1);
      if (lap1Live.length > 8) return lap1Live;
      const lap1Tel = telemetry.filter((p) => p.lap_number === 1);
      if (lap1Tel.length > 8) return lap1Tel;
    }

    // Still in live Lap 1: no reference track yet (actively being created)
    return [];
  }, [isCurrentSessionLive, telemetry, selectedLapId, liveFrame?.current_lap, laps.length, liveTrackPoints]);

  // Points used to determine circuit geometry and compute bounds
  const activeTrackPoints = useMemo(() => {
    if (referenceTrack.length > 0) {
      return referenceTrack;
    }
    // During live Lap 1: use the accumulated live points
    if (isCurrentSessionLive) {
      return liveTrackPoints.length > 0 ? liveTrackPoints : telemetry;
    }
    return telemetry;
  }, [referenceTrack, isCurrentSessionLive, liveTrackPoints, telemetry]);

  // Track GPS waypoints: deduplicates consecutive stationary points for continuous 60 FPS trajectory
  const trackWaypoints = useMemo(() => {
    return extractGpsWaypoints(activeTrackPoints);
  }, [activeTrackPoints]);

  // Track bounding box (smooth auto-expansion during Lap 1, locked on Lap 2+)
  const trackBounds = useMemo(() => {
    const pts = trackWaypoints.length > 0 ? trackWaypoints : activeTrackPoints;
    return computeTrackBounds(pts);
  }, [trackWaypoints, activeTrackPoints]);

  // Full projected track points inside SVG viewBox (400 x 220)
  const fullProjectedTrack = useMemo(() => {
    const pts = trackWaypoints.length > 0 ? trackWaypoints : activeTrackPoints;
    return projectPoints(pts, 400, 220, 24, trackBounds);
  }, [trackWaypoints, activeTrackPoints, trackBounds]);

  // Smooth 60 FPS Track Position for Replay (interpolates continuously along waypoints)
  const replayTrackPos = useMemo(() => {
    if (!isReplaying || replayTimeMs === null || trackWaypoints.length === 0) return null;
    return interpolateTrackPosition(trackWaypoints, baseTimeMs + replayTimeMs);
  }, [isReplaying, replayTimeMs, trackWaypoints, baseTimeMs]);

  // Dynamic track polyline: In Replay Mode, evolves dynamically at 60 FPS up to current car position!
  const projectedTrack = useMemo(() => {
    if (!isReplaying || !replayTrackPos || !trackBounds || fullProjectedTrack.length === 0) {
      return fullProjectedTrack;
    }
    const sliced = fullProjectedTrack.slice(0, replayTrackPos.index + 1);
    const carPos = projectCoordWithBounds(
      replayTrackPos.lat,
      replayTrackPos.lon,
      trackBounds,
      400,
      220,
      24,
    );
    return [
      ...sliced,
      {
        x: carPos.x,
        y: carPos.y,
        speed: replayTrackPos.speed_kmh,
        apex: 0,
      },
    ];
  }, [isReplaying, replayTrackPos, fullProjectedTrack, trackBounds]);

  const startPoint = fullProjectedTrack.length > 0 ? fullProjectedTrack[0] : null;
  const isClosedLoop = useMemo(() => {
    if (activeTrackPoints.length < 15) return false;
    const first = activeTrackPoints[0]!;
    const last = activeTrackPoints[activeTrackPoints.length - 1]!;
    return haversineMeters(first.lat, first.lon, last.lat, last.lon) < 35;
  }, [activeTrackPoints]);

  const endPoint =
    fullProjectedTrack.length > 1 && !isClosedLoop
      ? fullProjectedTrack[fullProjectedTrack.length - 1]
      : null;

  const mapMaxSpeed = useMemo(() => {
    const list = isCurrentSessionLive ? liveTrackPoints : displayedTelemetry;
    if (!list.length) return 1;
    return Math.max(...list.map((p) => p.speed_kmh));
  }, [isCurrentSessionLive, liveTrackPoints, displayedTelemetry]);

  // ── Live / Replay Car Dot ────────────────────────────────────────────────
  // In Replay Mode: car moves continuously at 60 FPS along the circuit track without pausing or jumping.
  // In Live Mode: snaps to reference track on Lap 2+, tracks leading edge on Lap 1.
  const carDot = useMemo(() => {
    // 1. Replay Mode:
    if (isReplaying && replayTrackPos && trackBounds) {
      const pos = projectCoordWithBounds(
        replayTrackPos.lat,
        replayTrackPos.lon,
        trackBounds,
        400,
        220,
        24,
      );
      return {
        x: pos.x,
        y: pos.y,
        speed: replayTrackPos.speed_kmh,
        isSnapped: false,
      };
    }

    // 2. Live Mode:
    if (!isCurrentSessionLive || !liveFrame || fullProjectedTrack.length === 0 || !trackBounds) {
      return null;
    }

    // From Lap 2 onwards: Snap to established reference circuit track
    if (referenceTrack.length > 0 && liveFrame.current_lap >= 2) {
      const rawPos = projectCoordWithBounds(
        liveFrame.frame.lat,
        liveFrame.frame.lon,
        trackBounds,
        400,
        220,
        24,
      );
      const snapped = snapPointToPolyline(rawPos, fullProjectedTrack, 45);
      return {
        x: snapped.x,
        y: snapped.y,
        speed: liveFrame.frame.speed_kmh,
        segmentIndex: snapped.segmentIndex,
        isSnapped: true,
      };
    }

    // During live Lap 1: Car dot is at the head of the live path
    const head = fullProjectedTrack[fullProjectedTrack.length - 1];
    if (!head) return null;
    return {
      x: head.x,
      y: head.y,
      speed: liveFrame.frame.speed_kmh,
      segmentIndex: fullProjectedTrack.length - 1,
      isSnapped: false,
    };
  }, [
    isReplaying,
    replayTrackPos,
    fullProjectedTrack,
    isCurrentSessionLive,
    liveFrame,
    trackBounds,
    referenceTrack.length,
  ]);

  // Overall points buffer for KPIs
  const allPoints = isCurrentSessionLive ? liveTrackPoints : telemetry;

  const bestLap = laps.reduce<ApiLap | null>(
    (b, l) => (!b || (l.duration_ms > 0 && l.duration_ms < b.duration_ms) ? l : b),
    null,
  );

  const maxSpeed = useMemo(() => {
    const liveSpeed = isCurrentSessionLive && liveFrame ? liveFrame.frame.speed_kmh : 0;
    if (laps.length > 0) return Math.max(liveSpeed, ...laps.map((l) => l.max_speed_kmh));
    if (allPoints.length > 0) return Math.max(liveSpeed, ...allPoints.map((p) => p.speed_kmh));
    return liveSpeed;
  }, [laps, allPoints, isCurrentSessionLive, liveFrame]);

  const maxGLat = useMemo(() => {
    const liveGLat = isCurrentSessionLive && liveFrame ? Math.abs(liveFrame.frame.g_lat) : 0;
    if (laps.length > 0) return Math.max(liveGLat, ...laps.map((l) => l.max_g_lat));
    if (allPoints.length > 0) return Math.max(liveGLat, ...allPoints.map((p) => Math.abs(p.g_lat)));
    return liveGLat;
  }, [laps, allPoints, isCurrentSessionLive, liveFrame]);

  const maxGBrake = useMemo(() => {
    const liveGBrake = isCurrentSessionLive && liveFrame ? Math.max(0, -liveFrame.frame.g_lon) : 0;
    if (laps.length > 0) return Math.max(liveGBrake, ...laps.map((l) => l.max_g_brake));
    if (allPoints.length > 0) return Math.max(liveGBrake, ...allPoints.map((p) => Math.max(0, -p.g_lon)));
    return liveGBrake;
  }, [laps, allPoints, isCurrentSessionLive, liveFrame]);

  const avgSpeed = useMemo(() => {
    if (laps.length > 0) {
      const valid = laps.filter((l) => l.avg_speed_kmh > 0);
      if (valid.length > 0) {
        return valid.reduce((s, l) => s + l.avg_speed_kmh, 0) / valid.length;
      }
    }
    if (allPoints.length > 0) {
      return allPoints.reduce((s, p) => s + p.speed_kmh, 0) / allPoints.length;
    }
    return 0;
  }, [laps, allPoints]);

  const displaySpeed = isCurrentSessionLive && liveFrame
    ? liveFrame.frame.speed_kmh
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.speed_kmh
      : maxSpeed;

  const currentGLat = isCurrentSessionLive && liveFrame
    ? liveFrame.frame.g_lat
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.g_lat
      : maxGLat;

  const currentGLon = isCurrentSessionLive && liveFrame
    ? liveFrame.frame.g_lon
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.g_lon
      : -maxGBrake;

  const totalG = isCurrentSessionLive && liveFrame
    ? liveFrame.frame.total_g
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.total_g
      : 0;

  // Active zoom level on G-G Diagram
  const currentGZoom = G_ZOOM_LEVELS[gZoomIndex] ?? G_ZOOM_LEVELS[0];
  const scalePxPerG = 96 / currentGZoom.maxG;

  // SVG G-meter needle dot position
  const rawGx = 110 + (isCurrentSessionLive || isReplaying ? currentGLat : 0) * scalePxPerG;
  const rawGy = 110 - (isCurrentSessionLive || isReplaying ? currentGLon : 0) * scalePxPerG;
  const gx = Math.max(10, Math.min(210, rawGx));
  const gy = Math.max(10, Math.min(210, rawGy));

  // Current session object
  const session = sessions.find((s) => s.session_id === sessionId);

  // Visible laps (all | valid only: duration > 0 or lap > 1)
  const visibleLaps = validOnly
    ? laps.filter((l) => l.lap_number > 1 || l.duration_ms > 0)
    : laps;

  // G-G scatter: in Replay mode, shows points appearing sequentially up to current timestamp!
  const gSample = useMemo(() => {
    if (isReplaying && currentReplayFrame) {
      const upToNow = displayedTelemetry.filter(
        (p) => p.lap_offset_ms <= currentReplayFrame.timeMs,
      );
      if (upToNow.length <= 150) return upToNow;
      const step = Math.ceil(upToNow.length / 150);
      return upToNow.filter((_, i) => i % step === 0);
    }
    const source = isCurrentSessionLive ? liveTrackPoints : displayedTelemetry;
    if (source.length <= 150) return source;
    const step = Math.ceil(source.length / 150);
    return source.filter((_, i) => i % step === 0);
  }, [isReplaying, currentReplayFrame, isCurrentSessionLive, liveTrackPoints, displayedTelemetry]);

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
      label: isCurrentSessionLive ? "Live speed" : isReplaying ? "Replay speed" : "Max speed",
      value: displaySpeed.toFixed(1),
      unit: "km/h",
      sub: isCurrentSessionLive
        ? "Live"
        : isReplaying
          ? `T: ${formatLapTime(replayTimeMs ?? 0)}`
          : "Session peak",
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
      sub: isCurrentSessionLive
        ? `Current: ${liveFrame?.frame.g_lat.toFixed(2)} G`
        : isReplaying && currentReplayFrame
          ? `Current: ${currentReplayFrame.g_lat.toFixed(2)} G`
          : "Session max",
    },
    {
      label: "Max braking G",
      value: `−${maxGBrake.toFixed(2)}`,
      unit: "G",
      sub: isCurrentSessionLive
        ? `Current: ${liveFrame ? Math.abs(liveFrame.frame.g_lon).toFixed(2) : "0.00"} G`
        : isReplaying && currentReplayFrame
          ? `Current: ${Math.abs(currentReplayFrame.g_lon).toFixed(2)} G`
          : "Session max",
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

          {/* Session Selector & Refresh */}
          <div className="order-last flex w-full items-center gap-2 md:order-none md:w-[420px]">
            {sessionsLoading && sessions.length === 0 ? (
              <div className="flex h-11 flex-1 items-center gap-2 rounded-md bg-secondary px-4 text-sm text-muted-foreground">
                <RefreshCw className="size-4 animate-spin text-accent" />
                <span>Loading sessions…</span>
              </div>
            ) : sessionsError && sessions.length === 0 ? (
              <div className="flex h-11 flex-1 items-center justify-between rounded-md border border-destructive/50 bg-destructive/10 px-3 text-xs text-destructive">
                <span>Failed to load sessions</span>
                <Button size="sm" variant="ghost" onClick={() => loadSessions(true)} className="h-7 text-xs">
                  Retry
                </Button>
              </div>
            ) : sessions.length === 0 ? (
              <div className="flex h-11 flex-1 items-center rounded-md bg-secondary px-4 text-sm text-muted-foreground">
                No sessions found in database
              </div>
            ) : (
              <Select
                value={sessionId}
                onValueChange={(val) => {
                  setSessionId(val);
                  setSelectedLapId(null);
                }}
              >
                <SelectTrigger aria-label="Select session" className="h-11 flex-1 bg-secondary px-4">
                  <SelectValue placeholder="Select session…" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {sessions.map((s) => {
                    const isSessionLive = liveFrame?.session_id === s.session_id;
                    return (
                      <SelectItem key={s.session_id} value={s.session_id}>
                        <div className="flex items-center gap-2 py-0.5">
                          {isSessionLive && (
                            <span className="size-2 rounded-full bg-green-500 animate-pulse" />
                          )}
                          <span className="font-medium text-foreground">
                            {s.track_name || "Unknown Track"}
                          </span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">{s.device_id}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {formatSessionDateTime(s.created_at)}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}

            <Button
              variant="outline"
              size="icon"
              onClick={() => loadSessions(false)}
              disabled={sessionsLoading}
              title="Refresh sessions from database"
              className="h-11 w-11 shrink-0 border-border bg-secondary hover:bg-secondary/80"
            >
              <RefreshCw className={`size-4 ${sessionsLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          {/* Status Badge */}
          <div className="flex items-center gap-2">
            {isCurrentSessionLive ? (
              <span className="flex items-center gap-2 rounded-full border border-green-500/30 bg-green-500/10 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-green-400">
                <span className="size-2 rounded-full animate-pulse bg-green-500" />
                ● LIVE
              </span>
            ) : liveFrame ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSessionId(liveFrame.session_id);
                  setSelectedLapId(null);
                }}
                className="h-8 gap-2 rounded-full border-green-500/40 bg-green-500/10 px-3 font-mono text-[11px] text-green-400 hover:bg-green-500/20"
              >
                <span className="size-2 rounded-full animate-pulse bg-green-500" />
                Live streaming · View
              </Button>
            ) : (
              <span className="flex items-center gap-2 rounded-full border border-border px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                <span className="size-2 rounded-full bg-muted-foreground/40" />
                ● Recorded
              </span>
            )}
          </div>
        </header>

        {/* Hero */}
        <section className="relative mt-10">
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
                {session
                  ? `${session.device_id} · ${formatSessionDateTime(session.created_at)}`
                  : "Waiting for session…"}
              </p>
              <h1 className="mt-2 text-5xl font-semibold tracking-tight md:text-6xl">
                {session?.track_name || (session ? "Session " + session.session_id : "No session")}
              </h1>
              <p className="mt-3 text-sm text-muted-foreground">
                {laps.length} lap{laps.length !== 1 ? "s" : ""} recorded · {allPoints.length} data points
                {isCurrentSessionLive && liveFrame ? ` · Lap ${liveFrame.current_lap} in progress` : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground">
                Best lap
              </p>
              <div className="mt-2 text-5xl font-semibold tracking-tight md:text-6xl">
                {loading ? (
                  <Skeleton className="h-14 w-44 ml-auto" />
                ) : bestLap ? (
                  formatLapTime(bestLap.duration_ms)
                ) : (
                  "—"
                )}
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {bestLap
                  ? `Lap ${bestLap.lap_number} · session best`
                  : laps.length > 0
                    ? "No valid lap times"
                    : "No laps yet"}
              </p>
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 top-32 select-none text-center text-[22vw] font-bold leading-none tracking-tighter text-ghost-text md:text-[14rem]">
            GT2 RS
          </div>
          <div className="relative mx-auto mt-24 max-w-5xl md:mt-32">
            <div className="absolute inset-x-[8%] bottom-[12%] h-[18%] rounded-[50%] border border-border bg-secondary/40 blur-[1px]" />
            <img src={car} alt="911 GT2 RS side profile" className="relative w-full" />
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
              <div
                className={`mt-3 font-mono text-2xl font-semibold ${
                  "highlight" in k && k.highlight
                    ? "text-accent"
                    : "negative" in k && k.negative
                      ? "text-destructive"
                      : ""
                }`}
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
              </div>
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

        {/* Replay Controls (Only for historical sessions from database, never in live mode) */}
        {!isCurrentSessionLive && displayedTelemetry.length > 1 && (
          <section className="panel mt-4 p-4 border-accent/20 bg-secondary/30">
            <div className="flex flex-wrap items-center justify-between gap-4">
              {/* Play / Pause / Restart */}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={isPlaying ? "default" : "outline"}
                  onClick={() => {
                    if (isPlaying) {
                      setIsPlaying(false);
                    } else {
                      if (replayTimeMs === null || replayTimeMs >= totalDurationMs) {
                        setReplayTimeMs(0);
                      }
                      setIsPlaying(true);
                    }
                  }}
                  className="h-9 gap-2 rounded-full px-4 font-mono text-xs font-semibold"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="size-3.5 fill-current" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play className="size-3.5 fill-current ml-0.5" />
                      {replayTimeMs !== null && replayTimeMs < totalDurationMs
                        ? "Resume"
                        : "Play Replay"}
                    </>
                  )}
                </Button>

                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    setReplayTimeMs(0);
                  }}
                  title="Restart from beginning"
                  className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="size-4" />
                </Button>

                {isReplaying && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setIsPlaying(false);
                      setReplayTimeMs(null);
                    }}
                    className="h-8 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Exit Replay
                  </Button>
                )}
              </div>

              {/* Scrubber slider and time display */}
              <div className="flex flex-1 items-center gap-3 min-w-[240px]">
                <span className="font-mono text-xs text-muted-foreground w-20 shrink-0 text-right">
                  {formatLapTime(replayTimeMs ?? totalDurationMs)}
                </span>
                <Slider
                  value={[Math.min(totalDurationMs, Math.max(0, replayTimeMs ?? totalDurationMs))]}
                  min={0}
                  max={totalDurationMs}
                  step={16}
                  onValueChange={(val) => {
                    const t = val[0] ?? 0;
                    setReplayTimeMs(t);
                  }}
                  className="flex-1 cursor-pointer"
                />
                <span className="font-mono text-xs text-muted-foreground w-20 shrink-0">
                  {formatLapTime(totalDurationMs)}
                </span>
              </div>

              {/* Speed Multiplier (1x, 2x, 4x) & 60 FPS indicator */}
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider hidden sm:inline mr-1">
                  Speed:
                </span>
                {[1, 2, 4].map((spd) => (
                  <Button
                    key={spd}
                    size="sm"
                    variant={replaySpeed === spd ? "default" : "secondary"}
                    onClick={() => setReplaySpeed(spd)}
                    className="h-7 w-8 p-0 font-mono text-xs rounded"
                  >
                    {spd}x
                  </Button>
                ))}
                <span className="ml-2 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent font-medium">
                  60 FPS
                </span>
              </div>
            </div>
          </section>
        )}

        {/* Map + G-G */}
        <section className="mt-3 grid gap-3 md:grid-cols-2">

          {/* Track Map */}
          <div className="panel p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">Circuit map &amp; speed trace</h2>
                {selectedLapId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedLapId(null)}
                    className="h-6 text-xs text-accent hover:text-accent/80 px-2"
                  >
                    Reset to all laps ✕
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isCurrentSessionLive ? (
                  <span className="flex items-center gap-1.5 rounded-full border border-green-500/40 bg-green-500/10 px-3 py-1 font-mono text-xs text-green-400">
                    <span className="size-2 rounded-full bg-green-500 animate-pulse" />
                    {liveFrame && liveFrame.current_lap >= 2
                      ? `Lap ${liveFrame.current_lap} · Pe traseul creat`
                      : "Lap 1 · Creare traseu live"}
                  </span>
                ) : isReplaying ? (
                  <span className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-xs text-accent">
                    <span className={`size-2 rounded-full bg-accent ${isPlaying ? "animate-pulse" : ""}`} />
                    Replay · {formatLapTime(replayTimeMs ?? 0)}
                  </span>
                ) : (
                  <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                    {fullProjectedTrack.length > 0 ? `${fullProjectedTrack.length} pts` : "No data"}
                  </span>
                )}
                {selectedLapId && (
                  <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-xs text-accent font-mono">
                    Lap {laps.find((l) => l.lap_id === selectedLapId)?.lap_number ?? ""}
                  </span>
                )}
              </div>
            </div>

            <svg viewBox="0 0 400 220" className="mt-4 w-full select-none">
              {fullProjectedTrack.length > 1 ? (
                <>
                  {/* Faint Ghost Track Outline when Replaying (to see full circuit ahead) */}
                  {isReplaying && (
                    <>
                      <polyline
                        points={fullProjectedTrack.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
                        fill="none"
                        stroke="rgba(255, 255, 255, 0.05)"
                        strokeWidth="15"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <polyline
                        points={fullProjectedTrack.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
                        fill="none"
                        stroke="rgba(255, 255, 255, 0.02)"
                        strokeWidth="11"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
                  )}

                  {/* Road Corridor Outer Border / Curbs (Traseu cu lățime reală) */}
                  <polyline
                    points={projectedTrack.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
                    fill="none"
                    stroke="rgba(255, 255, 255, 0.09)"
                    strokeWidth="15"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Road Asphalt Surface */}
                  <polyline
                    points={projectedTrack.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
                    fill="none"
                    stroke="#141416"
                    strokeWidth="11"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Per-segment Coloured Speed Trace */}
                  {projectedTrack.slice(0, -1).map((pt, i) => {
                    const next = projectedTrack[i + 1];
                    if (!next) return null;
                    return (
                      <line
                        key={i}
                        x1={pt.x}
                        y1={pt.y}
                        x2={next.x}
                        y2={next.y}
                        stroke={speedColor(pt.speed, mapMaxSpeed)}
                        strokeWidth="3.5"
                        strokeLinecap="round"
                      />
                    );
                  })}

                  {/* Start Point Marker (Green) */}
                  {startPoint && (
                    <circle
                      cx={startPoint.x}
                      cy={startPoint.y}
                      r="4.5"
                      fill="#22c55e"
                      stroke="#09090b"
                      strokeWidth="2"
                    />
                  )}

                  {/* End Point Marker (Red, only if open sprint track) */}
                  {endPoint && (
                    <circle
                      cx={endPoint.x}
                      cy={endPoint.y}
                      r="4.5"
                      fill="#ef4444"
                      stroke="#09090b"
                      strokeWidth="2"
                    />
                  )}


                  {/* Car Dot (Replay mode or Live mode) */}
                  {carDot && (
                    <g>
                      <circle
                        cx={carDot.x}
                        cy={carDot.y}
                        r="11"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="1.5"
                        opacity="0.3"
                      />
                      <circle
                        cx={carDot.x}
                        cy={carDot.y}
                        r="6"
                        fill="#09090b"
                        stroke="var(--accent)"
                        strokeWidth="3"
                      />
                      <circle
                        cx={carDot.x}
                        cy={carDot.y}
                        r="2.5"
                        fill="var(--accent)"
                      />
                    </g>
                  )}
                </>
              ) : (
                <text
                  x="200"
                  y="110"
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize="13"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {isCurrentSessionLive
                    ? "Recording live telemetry… Drive to draw circuit map"
                    : loading
                      ? "Loading telemetry…"
                      : "No telemetry data yet"}
                </text>
              )}
            </svg>

            <div className="mt-3 flex justify-between font-mono text-xs text-muted-foreground">
              <span>
                {isReplaying ? "Speed " : "Peak speed "}
                <b className="text-foreground">{displaySpeed.toFixed(1)} km/h</b>
              </span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-[11px]">
                  <span className="size-2 rounded-full bg-[#ef4444]" /> Slow
                  <span className="size-2 rounded-full bg-[#eab308] ml-1" /> Med
                  <span className="size-2 rounded-full bg-[#22c55e] ml-1" /> Fast
                </span>
                {isCurrentSessionLive && liveFrame && (
                  <span>
                    Lap <b className="text-foreground">{liveFrame.current_lap}</b>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* G-G Diagram */}
          <div className="panel p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <h2 className="font-medium">G-G diagram</h2>
                {/* Zoom Controls */}
                <div className="flex items-center gap-0.5 rounded-full border border-border bg-secondary/80 px-1 py-0.5 shadow-sm">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setGZoomIndex((prev) => Math.min(G_ZOOM_LEVELS.length - 1, prev + 1))}
                    disabled={gZoomIndex >= G_ZOOM_LEVELS.length - 1}
                    title="Zoom in (mărește scara pentru forțe G mici)"
                    className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <Plus className="size-3" />
                  </Button>
                  <span className="font-mono text-[11px] font-semibold text-accent min-w-[3.2rem] text-center">
                    ±{currentGZoom.maxG}G
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setGZoomIndex((prev) => Math.max(0, prev - 1))}
                    disabled={gZoomIndex <= 0}
                    title="Zoom out"
                    className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <Minus className="size-3" />
                  </Button>
                </div>
              </div>
              <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                {(isCurrentSessionLive && liveFrame) || isReplaying
                  ? `Total G ${totalG.toFixed(2)}`
                  : `${gSample.length} samples`}
              </span>
            </div>

            <svg viewBox="0 0 220 220" className="mx-auto mt-4 w-full max-w-[260px]">
              {/* Concentric dashed circles (3 levels: 0.33, 0.66, 1.0 of max scale) */}
              {[96, 64, 32].map((r) => (
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

              {/* Dynamic Labels for circles based on active zoom level */}
              <text x="113" y="81" fill="var(--muted-foreground)" fontSize="7" opacity="0.75">
                {currentGZoom.circles[0]}G
              </text>
              <text x="113" y="49" fill="var(--muted-foreground)" fontSize="7" opacity="0.75">
                {currentGZoom.circles[1]}G
              </text>
              <text x="113" y="17" fill="var(--muted-foreground)" fontSize="7" opacity="0.75">
                {currentGZoom.circles[2]}G
              </text>

              {/* Crosshairs */}
              <line x1="10" y1="110" x2="210" y2="110" stroke="var(--border)" />
              <line x1="110" y1="10" x2="110" y2="210" stroke="var(--border)" />

              {/* Scatter dots from telemetry (hidden during Replay, shown in normal/exit view) */}
              {!isReplaying &&
                gSample.map((p, i) => {
                  const cx = Math.max(10, Math.min(210, 110 + p.g_lat * scalePxPerG));
                  const cy = Math.max(10, Math.min(210, 110 - p.g_lon * scalePxPerG));
                  return (
                    <circle
                      key={i}
                      cx={cx}
                      cy={cy}
                      r="1.8"
                      fill="var(--accent)"
                      opacity="0.45"
                    />
                  );
                })}

              {/* Indicator: Live mode has needle line, Replay mode has only the moving point without line, Exit/Static has center dot */}
              {isCurrentSessionLive ? (
                <>
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
                </>
              ) : isReplaying ? (
                <g>
                  <circle
                    cx={gx}
                    cy={gy}
                    r="10"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="1.5"
                    opacity="0.3"
                  />
                  <circle
                    cx={gx}
                    cy={gy}
                    r="6"
                    fill="var(--accent)"
                    stroke="#09090b"
                    strokeWidth="2"
                  />
                </g>
              ) : (
                <circle
                  cx="110"
                  cy="110"
                  r="3.5"
                  fill="var(--accent)"
                  opacity="0.8"
                />
              )}
            </svg>

            <div className="mt-3 flex justify-between font-mono text-xs text-muted-foreground">
              <span>
                Lateral{" "}
                <b className="text-accent">
                  {isCurrentSessionLive || isReplaying
                    ? `${currentGLat >= 0 ? "+" : ""}${currentGLat.toFixed(2)} G`
                    : `+${maxGLat.toFixed(2)} G max`}
                </b>
              </span>
              <span>
                Longitudinal{" "}
                <b className="text-destructive">
                  {isCurrentSessionLive || isReplaying
                    ? `${currentGLon >= 0 ? "+" : "−"}${Math.abs(currentGLon).toFixed(2)} G`
                    : `−${maxGBrake.toFixed(2)} G max brk`}
                </b>
              </span>
            </div>
          </div>
        </section>

        {/* Laps Table */}
        <section className="panel mt-3 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">
                Session laps{" "}
                <span className="ml-2 rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                  {laps.length} total
                </span>
              </h2>
              {selectedLapId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedLapId(null)}
                  className="h-7 text-xs text-accent hover:text-accent/80"
                >
                  Show all laps ✕
                </Button>
              )}
            </div>
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
                  {["Lap", "Lap time", "Delta", "Max speed", "Max lat G", "Max brk G", "Trace"].map(
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
                  ? Array.from({ length: 3 }).map((_, i) => (
                      <tr key={i} className="border-t border-border">
                        {Array.from({ length: 7 }).map((__, j) => (
                          <td key={j} className="py-3">
                            <Skeleton className="h-4 w-20" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : visibleLaps.map((lap) => {
                      const isBest = bestLap?.lap_id === lap.lap_id;
                      const isSelected = selectedLapId === lap.lap_id;
                      const delta =
                        bestLap && !isBest && lap.duration_ms > 0
                          ? formatDelta(lap.duration_ms - bestLap.duration_ms)
                          : null;
                      return (
                        <tr
                          key={lap.lap_id}
                          onClick={() =>
                            setSelectedLapId((prev) =>
                              prev === lap.lap_id ? null : lap.lap_id,
                            )
                          }
                          className={`cursor-pointer border-t border-border transition-colors hover:bg-secondary/60 ${
                            isSelected
                              ? "bg-accent/10 border-accent/40"
                              : isBest
                                ? "bg-secondary/40"
                                : ""
                          }`}
                        >
                          <td className="py-3 font-medium">
                            <div className="flex items-center gap-2">
                              {isSelected && (
                                <span className="size-1.5 rounded-full bg-accent" />
                              )}
                              L{lap.lap_number}
                            </div>
                          </td>
                          <td className={isBest ? "text-accent font-semibold" : ""}>
                            {formatLapTime(lap.duration_ms)}
                          </td>
                          <td>
                            {isBest ? (
                              <span className="rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground">
                                BEST
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                {delta ?? "—"}
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
                          <td>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedLapId((prev) =>
                                  prev === lap.lap_id ? null : lap.lap_id,
                                );
                              }}
                            >
                              {isSelected ? "Selected" : "View lap"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                {!loading && visibleLaps.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="py-8 text-center text-muted-foreground"
                    >
                      {allPoints.length > 0
                        ? "Session in progress (telemetry points available above, lap not finalized yet)"
                        : "No laps recorded yet"}
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
