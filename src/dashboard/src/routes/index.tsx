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
  type Projected,
  type InterpolatedFrame,
  fetchSessions,
  fetchLaps,
  fetchTelemetry,
  fetchLiveTelemetry,
  formatLapTime,
  formatDelta,
  isLapValid,
  formatSessionDateTime,
  speedColor,
  computeTrackBounds,
  projectPoints,
  projectCoordWithBounds,
  buildReplayTimeline,
  interpolateTelemetryPoint,
  extractGpsWaypoints,
  interpolateTrackPosition,
  interpolateTrackSpline,
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

const EMPTY_TELEMETRY: TelemetryPoint[] = [];

type ActiveLiveSession = {
  lastSeen: number;
  currentLap: number;
  currentLapTimeMs: number;
  speedKmh: number;
  gLat: number;
  gLon: number;
  totalG: number;
  lat: number;
  lon: number;
};

function mergeLivePoints(previous: TelemetryPoint[], incoming: TelemetryPoint[]): TelemetryPoint[] {
  const key = (point: TelemetryPoint) =>
    point.session_offset_ms ?? `${point.lap_id}:${point.lap_offset_ms}`;
  const points = new Map(previous.map((point) => [key(point), point]));
  for (const point of incoming) points.set(key(point), point);
  return [...points.values()].sort((a, b) =>
    a.session_offset_ms !== undefined && b.session_offset_ms !== undefined
      ? a.session_offset_ms - b.session_offset_ms
      : a.lap_number - b.lap_number || a.lap_offset_ms - b.lap_offset_ms
  );
}

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
  const [selectedLapId, setSelectedLapId] = useState<string | null>();
  const [loading, setLoading] = useState(false);

  // Multi-device active live sessions state (session_id -> ActiveLiveSession)
  const [liveSessionsMap, setLiveSessionsMap] = useState<Record<string, ActiveLiveSession>>({});
  const [livePointsBySession, setLivePointsBySession] = useState<Record<string, TelemetryPoint[]>>({});

  // ── Buffered Chunk Playback engine for 60 FPS continuous live playout ──────
  const liveBufferRef = useRef<TelemetryPoint[]>([]);
  const livePlayheadMsRef = useRef<number | null>(null);
  const [liveInterpolatedFrame, setLiveInterpolatedFrame] = useState<InterpolatedFrame | null>(null);
  const liveAnimFrameRef = useRef<number | null>(null);
  const liveLastTickRef = useRef<number | null>(null);

  const [validOnly, setValidOnly] = useState(false);

  // ── G-G Diagram Zoom (index into G_ZOOM_LEVELS) ───────────────────────────
  const [gZoomIndex, setGZoomIndex] = useState<number>(0);

  // ── Track Hover State (Speed & G-G sync on mouse hover) ───────────────────
  const [hoveredPoint, setHoveredPoint] = useState<Projected | null>(null);

  // ── 60 FPS Replay Mode (Historical sessions from DB only) ──────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<number>(1);
  const [replayTimeMs, setReplayTimeMs] = useState<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const lastTickTimeRef = useRef<number | null>(null);

  const lastLapRef = useRef<number>(1);

  // Current session's live state & status detection (Real-time tracking)
  const currentSessionObj = useMemo(() => {
    return sessions.find((s) => s.session_id === sessionId);
  }, [sessions, sessionId]);

  const liveSessionState = liveSessionsMap[sessionId];
  const currentSessionLastUpdateMs = useMemo(() => {
    if (liveSessionState) return liveSessionState.lastSeen;
    const str = currentSessionObj?.updated_at || currentSessionObj?.created_at;
    return str ? new Date(str).getTime() : 0;
  }, [liveSessionState, currentSessionObj]);

  const secondsSinceLastLive = currentSessionLastUpdateMs > 0
    ? (Date.now() - currentSessionLastUpdateMs) / 1000
    : Infinity;

  const isCurrentSessionLive = currentSessionObj?.stop_ts == null && secondsSinceLastLive < 10;
  const isCurrentSessionRecent = !isCurrentSessionLive && secondsSinceLastLive < 60;
  const recordingRevision = isCurrentSessionLive ? undefined : currentSessionObj?.telemetry_revision;
  const liveTrackPoints = livePointsBySession[sessionId] ?? EMPTY_TELEMETRY;

  // ── Ordered Sessions: LIVE sessions appear first, then RECENT, then RECORDED by updated_at ──
  const { liveSessions, recentSessions, recordedSessions } = useMemo(() => {
    const liveList: ApiSession[] = [];
    const recentList: ApiSession[] = [];
    const recordedList: ApiSession[] = [];
    const now = Date.now();

    for (const s of sessions) {
      const liveData = liveSessionsMap[s.session_id];
      const lastUpdateStr = liveData
        ? new Date(liveData.lastSeen).toISOString()
        : s.updated_at || s.created_at;
      const lastUpdateMs = lastUpdateStr ? new Date(lastUpdateStr).getTime() : 0;
      const secondsAgo = (now - lastUpdateMs) / 1000;

      if (s.stop_ts == null && secondsAgo < 10) {
        liveList.push(s);
      } else if (secondsAgo < 60) {
        recentList.push(s);
      } else {
        recordedList.push(s);
      }
    }

    const sortByTime = (a: ApiSession, b: ApiSession) => {
      const tA = new Date(a.updated_at || a.created_at).getTime();
      const tB = new Date(b.updated_at || b.created_at).getTime();
      return tB - tA;
    };

    liveList.sort(sortByTime);
    recentList.sort(sortByTime);
    recordedList.sort(sortByTime);

    return { liveSessions: liveList, recentSessions: recentList, recordedSessions: recordedList };
  }, [sessions, liveSessionsMap]);

  const orderedSessions = useMemo(() => {
    return [...liveSessions, ...recentSessions, ...recordedSessions];
  }, [liveSessions, recentSessions, recordedSessions]);

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
          // If already viewing an active live session, stay on it
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

  useEffect(() => {
    liveBufferRef.current = [];
    livePlayheadMsRef.current = null;
    setLiveInterpolatedFrame(null);
    setLaps([]);
    setTelemetry([]);
    setSelectedLapId(undefined);
    lastLapRef.current = 1;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let polling = false;

    async function pollLive() {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const points = await fetchLiveTelemetry(sessionId, 3500, controller.signal);
        if (controller.signal.aborted) return;
        const newest = points.at(-1);
        if (!newest) {
          setLiveSessionsMap((previous) => {
            if (!previous[sessionId]) return previous;
            const next = { ...previous };
            delete next[sessionId];
            return next;
          });
          return;
        }

        const currentLap = newest.lap_number;
        const previousLap = liveBufferRef.current.at(-1)?.lap_id;
        if (newest.lap_id !== previousLap) livePlayheadMsRef.current = null;
        liveBufferRef.current = points.filter((point) => point.lap_id === newest.lap_id);

        setLiveSessionsMap((previous) => ({
          ...previous,
          [sessionId]: {
            lastSeen: Date.now(),
            currentLap,
            currentLapTimeMs: newest.lap_offset_ms,
            speedKmh: newest.speed_kmh,
            gLat: newest.g_lat,
            gLon: newest.g_lon,
            totalG: Math.hypot(newest.g_lat, newest.g_lon),
            lat: newest.lat,
            lon: newest.lon,
          },
        }));

        setLivePointsBySession((previous) => ({
          ...previous,
          [sessionId]: mergeLivePoints(previous[sessionId] ?? [], points),
        }));

        if (currentLap !== lastLapRef.current) {
          const nextLaps = await fetchLaps(sessionId, controller.signal);
          if (!controller.signal.aborted) {
            lastLapRef.current = currentLap;
            setLaps(nextLaps);
          }
        }
      } catch {
        // The next poll retries transient failures.
      } finally {
        polling = false;
      }
    }

    void pollLive();
    const timer = setInterval(pollLive, 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [sessionId]);

  // Periodic heartbeat & session background poll (every 4.5s)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setLiveSessionsMap((prev) => {
        let changed = false;
        const next: Record<string, ActiveLiveSession> = {};
        for (const [id, data] of Object.entries(prev)) {
          if (now - data.lastSeen < 60000) {
            next[id] = data;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // Background refresh of sessions
      fetchSessions().then(setSessions).catch(() => {});
    }, 4500);

    return () => clearInterval(timer);
  }, []);

  // ── Buffered Chunk Playback: 60 FPS Playout Loop for Live Mode ────────────
  useEffect(() => {
    if (!isCurrentSessionLive) {
      if (liveAnimFrameRef.current) {
        cancelAnimationFrame(liveAnimFrameRef.current);
        liveAnimFrameRef.current = null;
      }
      liveLastTickRef.current = null;
      setLiveInterpolatedFrame(null);
      return;
    }

    const tickLive = (now: number) => {
      if (liveLastTickRef.current === null) {
        liveLastTickRef.current = now;
      }
      const deltaMs = Math.min(100, now - liveLastTickRef.current);
      liveLastTickRef.current = now;

      const buffer = liveBufferRef.current;
      if (buffer.length > 0) {
        const oldestOffset = buffer[0]!.lap_offset_ms;
        const newestOffset = buffer[buffer.length - 1]!.lap_offset_ms;

        if (livePlayheadMsRef.current === null) {
          livePlayheadMsRef.current = Math.max(oldestOffset, newestOffset - 1500);
        }

        const lag = newestOffset - livePlayheadMsRef.current;
        let pace = 1.0;
        if (lag > 2500) pace = 1.25;
        else if (lag < 400) pace = 0.75;

        const nextPlayhead = Math.max(
          oldestOffset,
          Math.min(newestOffset, livePlayheadMsRef.current + deltaMs * pace),
        );
        livePlayheadMsRef.current = nextPlayhead;

        setLiveInterpolatedFrame(interpolateTelemetryPoint(buffer, nextPlayhead));
      }

      liveAnimFrameRef.current = requestAnimationFrame(tickLive);
    };

    liveAnimFrameRef.current = requestAnimationFrame(tickLive);

    return () => {
      if (liveAnimFrameRef.current) {
        cancelAnimationFrame(liveAnimFrameRef.current);
        liveAnimFrameRef.current = null;
      }
      liveLastTickRef.current = null;
    };
  }, [isCurrentSessionLive]);

  // Initial load on mount
  useEffect(() => {
    loadSessions(true);
  }, [loadSessions]);

  useEffect(() => {
    if (!sessionId) return;
    const ac = new AbortController();
    setLoading(true);

    Promise.all([fetchLaps(sessionId, ac.signal), fetchTelemetry(sessionId, ac.signal)])
      .then(([lapData, telData]) => {
        if (ac.signal.aborted) return;
        setLaps(lapData);
        setTelemetry(telData);
        setLivePointsBySession((previous) => ({
          ...previous,
          [sessionId]: mergeLivePoints(telData, previous[sessionId] ?? []),
        }));
      })
      .catch((error) => {
        if (!ac.signal.aborted) console.warn("Could not load session telemetry", error);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [sessionId, isCurrentSessionLive, recordingRevision]);

  // ── Computed values ───────────────────────────────────────────────────────
  // Filter completed and valid laps only (incomplete or aborted laps under 15s are excluded)
  const validLaps = useMemo(() => {
    return laps.filter((l) => isLapValid(l, laps, telemetry));
  }, [laps, telemetry]);

  const validLapIds = useMemo(() => new Set(validLaps.map((lap) => lap.lap_id)), [validLaps]);

  const bestLap = useMemo(() => {
    return validLaps.reduce<ApiLap | null>(
      (b, l) => (!b || (l.duration_ms > 0 && l.duration_ms < b.duration_ms) ? l : b),
      null,
    );
  }, [validLaps]);

  // Effective active lap: in recorded mode, defaults to the best completed lap!
  const effectiveLapId = useMemo(() => {
    if (isCurrentSessionLive) return null;
    if (selectedLapId === null) return null;
    if (selectedLapId && laps.some((lap) => lap.lap_id === selectedLapId)) return selectedLapId;
    return bestLap?.lap_id ?? (laps.length > 0 ? laps[0]?.lap_id : null);
  }, [isCurrentSessionLive, selectedLapId, bestLap, laps]);

  const displayedTelemetry = useMemo(() => {
    if (isCurrentSessionLive) return telemetry;
    if (effectiveLapId) return telemetry.filter((point) => point.lap_id === effectiveLapId);
    return buildReplayTimeline(telemetry);
  }, [isCurrentSessionLive, effectiveLapId, telemetry]);

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

  // Interpolated 60 FPS state for replay (map & speed trace)
  const currentReplayFrame = useMemo(() => {
    if (!isReplaying || replayTimeMs === null) return null;
    return interpolateTelemetryPoint(displayedTelemetry, baseTimeMs + replayTimeMs);
  }, [isReplaying, replayTimeMs, displayedTelemetry, baseTimeMs]);

  const currentLiveLap = liveSessionState?.currentLap ?? 1;
  const referenceTrack = useMemo(() => {
    if (!isCurrentSessionLive) return displayedTelemetry;
    const firstLap = liveTrackPoints.filter((point) => point.lap_number === 1);
    return firstLap.length > 0 ? firstLap : liveTrackPoints;
  }, [isCurrentSessionLive, displayedTelemetry, liveTrackPoints]);

  const liveLapPoints = useMemo(
    () => liveTrackPoints.filter((point) => point.lap_number === currentLiveLap),
    [liveTrackPoints, currentLiveLap],
  );
  const trackWaypoints = useMemo(() => extractGpsWaypoints(referenceTrack), [referenceTrack]);
  const liveWaypoints = useMemo(() => extractGpsWaypoints(liveLapPoints), [liveLapPoints]);
  const trackBounds = useMemo(() => computeTrackBounds(trackWaypoints), [trackWaypoints]);
  const fullProjectedTrack = useMemo(
    () => projectPoints(trackWaypoints, 400, 220, 24, trackBounds),
    [trackWaypoints, trackBounds],
  );
  const smoothFullTrack = useMemo(
    () => interpolateTrackSpline(fullProjectedTrack),
    [fullProjectedTrack],
  );
  const trackPath = useMemo(() => smoothFullTrack.map((point, index) =>
    `${index === 0 || point.breakBefore ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`
  ).join(" "), [smoothFullTrack]);

  const replayTarget = isReplaying ? baseTimeMs + (replayTimeMs ?? 0) : null;
  const replayTrackPos = useMemo(() => {
    const first = trackWaypoints[0];
    const last = trackWaypoints.at(-1);
    if (replayTarget === null || !first || !last || replayTarget < first.timeMs || replayTarget > last.timeMs) {
      return null;
    }
    return interpolateTrackPosition(trackWaypoints, replayTarget);
  }, [replayTarget, trackWaypoints]);

  const startPoint = smoothFullTrack[0];
  const endPoint = smoothFullTrack.length > 1 ? smoothFullTrack.at(-1) : undefined;

  // Hover handler for circuit map SVG: locates nearest track point and syncs speed + G-force
  const handleTrackMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const trackSource = smoothFullTrack.length > 0 ? smoothFullTrack : fullProjectedTrack;
      if (trackSource.length < 2) return;
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * 400;
      const svgY = ((e.clientY - rect.top) / rect.height) * 220;

      let closest: Projected | null = null;
      let minDistanceSq = Infinity;

      for (let i = 0; i < trackSource.length; i++) {
        const pt = trackSource[i]!;
        const dx = pt.x - svgX;
        const dy = pt.y - svgY;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDistanceSq) {
          minDistanceSq = d2;
          closest = pt;
        }
      }

      if (closest && Math.sqrt(minDistanceSq) <= 45) {
        setHoveredPoint(closest);
      } else {
        setHoveredPoint(null);
      }
    },
    [smoothFullTrack, fullProjectedTrack],
  );

  const mapMaxSpeed = useMemo(() => {
    const list = isCurrentSessionLive ? liveTrackPoints : displayedTelemetry;
    if (!list.length) return 1;
    return Math.max(...list.map((p) => p.speed_kmh));
  }, [isCurrentSessionLive, liveTrackPoints, displayedTelemetry]);

  const carDot = useMemo(() => {
    if (!trackBounds) return null;
    if (isReplaying) {
      return replayTrackPos
        ? projectCoordWithBounds(replayTrackPos.lat, replayTrackPos.lon, trackBounds)
        : null;
    }
    if (!isCurrentSessionLive) return null;
    if (!liveInterpolatedFrame && livePlayheadMsRef.current !== null) return null;
    const time = liveInterpolatedFrame?.timeMs ?? liveSessionState?.currentLapTimeMs;
    if (time === undefined) return null;
    const first = liveWaypoints[0];
    const last = liveWaypoints.at(-1);
    if (!first || !last || time < first.timeMs || time > last.timeMs) return null;
    const position = interpolateTrackPosition(liveWaypoints, time);
    return position ? projectCoordWithBounds(position.lat, position.lon, trackBounds) : null;
  }, [
    isReplaying,
    replayTrackPos,
    trackBounds,
    isCurrentSessionLive,
    liveInterpolatedFrame,
    liveSessionState,
    liveWaypoints,
  ]);

  const activeSpeedTrace = useMemo(() => {
    if (!trackBounds) return [];
    if (isCurrentSessionLive) {
      return interpolateTrackSpline(projectPoints(liveWaypoints, 400, 220, 24, trackBounds));
    }
    if (replayTarget === null) return smoothFullTrack;

    const trace = fullProjectedTrack.filter((point) => point.timeMs! <= replayTarget);
    if (carDot && replayTrackPos && (trace.at(-1)?.timeMs ?? -1) < replayTarget) {
      trace.push({ ...carDot, speed: replayTrackPos.speed_kmh, apex: 0 });
    }
    return interpolateTrackSpline(trace);
  }, [
    isCurrentSessionLive,
    liveWaypoints,
    trackBounds,
    replayTarget,
    fullProjectedTrack,
    smoothFullTrack,
    carDot,
    replayTrackPos,
  ]);

  // Overall points buffer for KPIs
  const allPoints = isCurrentSessionLive ? liveTrackPoints : telemetry;

  const maxSpeed = useMemo(() => {
    const liveSpeed = isCurrentSessionLive
      ? (liveInterpolatedFrame?.speed_kmh ?? liveSessionState?.speedKmh ?? 0)
      : 0;
    if (laps.length > 0) return Math.max(liveSpeed, ...laps.map((l) => l.max_speed_kmh));
    if (allPoints.length > 0) return Math.max(liveSpeed, ...allPoints.map((p) => p.speed_kmh));
    return liveSpeed;
  }, [laps, allPoints, isCurrentSessionLive, liveInterpolatedFrame, liveSessionState]);

  const maxGLat = useMemo(() => {
    const liveGLat = isCurrentSessionLive
      ? Math.abs(liveInterpolatedFrame?.g_lat ?? liveSessionState?.gLat ?? 0)
      : 0;
    if (laps.length > 0) return Math.max(liveGLat, ...laps.map((l) => l.max_g_lat));
    if (allPoints.length > 0) return Math.max(liveGLat, ...allPoints.map((p) => Math.abs(p.g_lat)));
    return liveGLat;
  }, [laps, allPoints, isCurrentSessionLive, liveInterpolatedFrame, liveSessionState]);

  const maxGBrake = useMemo(() => {
    const liveGBrake = isCurrentSessionLive
      ? Math.max(0, -(liveInterpolatedFrame?.g_lon ?? liveSessionState?.gLon ?? 0))
      : 0;
    if (laps.length > 0) return Math.max(liveGBrake, ...laps.map((l) => l.max_g_brake));
    if (allPoints.length > 0) return Math.max(liveGBrake, ...allPoints.map((p) => Math.max(0, -p.g_lon)));
    return liveGBrake;
  }, [laps, allPoints, isCurrentSessionLive, liveInterpolatedFrame, liveSessionState]);

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

  const displaySpeed = isCurrentSessionLive
    ? (liveInterpolatedFrame?.speed_kmh ?? liveSessionState?.speedKmh ?? 0)
    : isReplaying
      ? currentReplayFrame?.speed_kmh
      : maxSpeed;

  const currentGLat = isCurrentSessionLive
    ? (liveInterpolatedFrame?.g_lat ?? liveSessionState?.gLat ?? 0)
    : isReplaying
      ? (currentReplayFrame?.g_lat ?? 0)
      : maxGLat;

  const currentGLon = isCurrentSessionLive
    ? (liveInterpolatedFrame?.g_lon ?? liveSessionState?.gLon ?? 0)
    : isReplaying
      ? (currentReplayFrame?.g_lon ?? 0)
      : -maxGBrake;

  const totalG = isCurrentSessionLive
    ? (liveInterpolatedFrame?.total_g ?? liveSessionState?.totalG ?? 0)
    : isReplaying && currentReplayFrame
      ? Number(Math.hypot(currentReplayFrame.g_lat ?? 0, currentReplayFrame.g_lon ?? 0).toFixed(2))
      : 0;

  // Active zoom level on G-G Diagram
  const currentGZoom = G_ZOOM_LEVELS[gZoomIndex] ?? G_ZOOM_LEVELS[0];
  const scalePxPerG = 96 / currentGZoom.maxG;

  // Effective G-forces: When user hovers on a track point, prioritize hovered G-forces!
  const effectiveGLat = hoveredPoint
    ? (hoveredPoint.g_lat ?? 0)
    : currentGLat;

  const effectiveGLon = hoveredPoint
    ? (hoveredPoint.g_lon ?? 0)
    : currentGLon;

  const isGActive = Boolean(hoveredPoint || currentReplayFrame) || isCurrentSessionLive;

  // SVG G-meter needle dot position
  const rawGx = 110 + (isGActive ? effectiveGLat : 0) * scalePxPerG;
  const rawGy = 110 - (isGActive ? effectiveGLon : 0) * scalePxPerG;
  const gx = Math.max(10, Math.min(210, rawGx));
  const gy = Math.max(10, Math.min(210, rawGy));

  // Current session object
  const session = orderedSessions.find((s) => s.session_id === sessionId);

  // Visible laps: All laps or Valid only (incomplete laps filtered out)
  const visibleLaps = validOnly ? validLaps : laps;

  // G-G scatter: in Replay mode, shows points appearing sequentially up to current timestamp!
  const gSample = useMemo(() => {
    if (isReplaying && replayTimeMs !== null) {
      const targetMs = baseTimeMs + replayTimeMs;
      const upToNow = displayedTelemetry.filter(
        (p) => p.lap_offset_ms <= targetMs,
      );
      if (upToNow.length <= 150) return upToNow;
      const step = Math.ceil(upToNow.length / 150);
      return upToNow.filter((_, i) => i % step === 0);
    }
    const source = isCurrentSessionLive ? liveTrackPoints : displayedTelemetry;
    if (source.length <= 150) return source;
    const step = Math.ceil(source.length / 150);
    return source.filter((_, i) => i % step === 0);
  }, [isReplaying, replayTimeMs, baseTimeMs, isCurrentSessionLive, liveTrackPoints, displayedTelemetry]);

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
      value: displaySpeed?.toFixed(1) ?? "—",
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
        ? `Current: ${(liveInterpolatedFrame?.g_lat ?? liveSessionState?.gLat ?? 0).toFixed(2)} G`
        : isReplaying && currentReplayFrame
          ? `Current: ${(currentReplayFrame.g_lat ?? 0).toFixed(2)} G`
          : "Session max",
    },
    {
      label: "Max braking G",
      value: `−${maxGBrake.toFixed(2)}`,
      unit: "G",
      sub: isCurrentSessionLive
        ? `Current: ${Math.abs(liveInterpolatedFrame?.g_lon ?? liveSessionState?.gLon ?? 0).toFixed(2)} G`
        : isReplaying && currentReplayFrame
          ? `Current: ${Math.abs(currentReplayFrame.g_lon ?? 0).toFixed(2)} G`
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
            {sessionsLoading && orderedSessions.length === 0 ? (
              <div className="flex h-11 flex-1 items-center gap-2 rounded-md bg-secondary px-4 text-sm text-muted-foreground">
                <RefreshCw className="size-4 animate-spin text-accent" />
                <span>Loading sessions…</span>
              </div>
            ) : sessionsError && orderedSessions.length === 0 ? (
              <div className="flex h-11 flex-1 items-center justify-between rounded-md border border-destructive/50 bg-destructive/10 px-3 text-xs text-destructive">
                <span>Failed to load sessions</span>
                <Button size="sm" variant="ghost" onClick={() => loadSessions(true)} className="h-7 text-xs">
                  Retry
                </Button>
              </div>
            ) : orderedSessions.length === 0 ? (
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
                  {orderedSessions.map((s) => {
                    const liveData = liveSessionsMap[s.session_id];
                    const lastUpdateStr = liveData
                      ? new Date(liveData.lastSeen).toISOString()
                      : s.updated_at || s.created_at;
                    const lastUpdateMs = lastUpdateStr ? new Date(lastUpdateStr).getTime() : 0;
                    const secAgo = (Date.now() - lastUpdateMs) / 1000;
                    const isItemLive = secAgo < 10;
                    const isItemRecent = !isItemLive && secAgo < 60;
                    return (
                      <SelectItem key={s.session_id} value={s.session_id}>
                        <div className="flex items-center gap-2 py-0.5">
                          {isItemLive ? (
                            <span className="flex items-center gap-1 font-semibold text-green-400">
                              <span className="size-2 rounded-full bg-green-500 animate-pulse" />
                              LIVE
                            </span>
                          ) : isItemRecent ? (
                            <span className="flex items-center gap-1 font-semibold text-yellow-400">
                              <span className="size-2 rounded-full bg-yellow-500" />
                              RECENT
                            </span>
                          ) : (
                            <span className="size-1.5 rounded-full bg-muted-foreground/30" />
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
                ● LIVE {session?.device_id ? `· ${session.device_id}` : ""}
              </span>
            ) : isCurrentSessionRecent ? (
              <span className="flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-yellow-400">
                <span className="size-2 rounded-full bg-yellow-500" />
                ● Recent
              </span>
            ) : liveSessions.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const firstLive = liveSessions[0];
                  if (firstLive) {
                    setSessionId(firstLive.session_id);
                    setSelectedLapId(null);
                  }
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
                {isCurrentSessionLive && liveSessionState ? ` · Lap ${liveSessionState.currentLap} in progress` : ""}
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

              {/* Speed Multiplier (1x, 2x, 3x) & Telemetry Hz indicator */}
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider hidden sm:inline mr-1">
                  Speed:
                </span>
                {[1, 2, 3].map((spd) => (
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
                <span className="ml-2 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 font-mono text-[10px] text-accent font-medium">
                  {replaySpeed * 20} Hz
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
                {effectiveLapId && (
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
                    {liveSessionState && liveSessionState.currentLap >= 2
                      ? `Lap ${liveSessionState.currentLap} · Pe traseul creat`
                      : "Lap 1 · Creare traseu live"}
                  </span>
                ) : isReplaying ? (
                  <span className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-xs text-accent">
                    <span className={`size-2 rounded-full bg-accent ${isPlaying ? "animate-pulse" : ""}`} />
                    Replay · {formatLapTime(replayTimeMs ?? 0)}
                  </span>
                ) : (
                  <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                    {smoothFullTrack.length > 0 ? `${trackWaypoints.length} GPS pts` : "No data"}
                  </span>
                )}
                {effectiveLapId && (
                  <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-xs text-accent font-mono">
                    Lap {laps.find((l) => l.lap_id === effectiveLapId)?.lap_number ?? ""}
                    {bestLap && effectiveLapId === bestLap.lap_id ? " · Best" : ""}
                  </span>
                )}
              </div>
            </div>

            <svg
              viewBox="0 0 400 220"
              className="mt-4 w-full select-none cursor-crosshair"
              onMouseMove={handleTrackMouseMove}
              onMouseLeave={() => setHoveredPoint(null)}
            >
              {smoothFullTrack.length > 1 ? (
                <>
                  {/* Road Corridor Outer Border / Curbs (Circuit Outline / Overlay) */}
                  <path
                    d={trackPath}
                    fill="none"
                    stroke="rgba(255, 255, 255, 0.09)"
                    strokeWidth="15"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Road Asphalt Surface */}
                  <path
                    d={trackPath}
                    fill="none"
                    stroke="#141416"
                    strokeWidth="11"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Per-segment Coloured Speed Trace */}
                  {activeSpeedTrace.slice(0, -1).map((pt, i) => {
                    const next = activeSpeedTrace[i + 1];
                    if (!next || next.breakBefore) return null;
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

                  {/* Hover Point Indicator and Floating Speed Tooltip */}
                  {hoveredPoint && (
                    <g className="pointer-events-none transition-all duration-75">
                      <circle
                        cx={hoveredPoint.x}
                        cy={hoveredPoint.y}
                        r="11"
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth="2"
                        opacity="0.85"
                      />
                      <circle
                        cx={hoveredPoint.x}
                        cy={hoveredPoint.y}
                        r="4.5"
                        fill="#ffffff"
                        stroke="#09090b"
                        strokeWidth="2"
                      />
                      <g
                        transform={`translate(${Math.max(45, Math.min(355, hoveredPoint.x))}, ${
                          hoveredPoint.y < 35 ? hoveredPoint.y + 26 : hoveredPoint.y - 14
                        })`}
                      >
                        <rect
                          x="-42"
                          y="-18"
                          width="84"
                          height="22"
                          rx="5"
                          fill="#09090b"
                          stroke="#ffffff"
                          strokeWidth="1.5"
                          filter="drop-shadow(0 2px 6px rgba(0,0,0,0.6))"
                        />
                        <text
                          x="0"
                          y="-3"
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize="11"
                          fontFamily="JetBrains Mono, monospace"
                          fontWeight="700"
                        >
                          {hoveredPoint.speed.toFixed(1)} km/h
                        </text>
                      </g>
                    </g>
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
                {hoveredPoint ? (
                  <>
                    Hover: <b className="text-white font-semibold">{hoveredPoint.speed.toFixed(1)} km/h</b>
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      ({hoveredPoint.g_lat && hoveredPoint.g_lat >= 0 ? "+" : ""}{(hoveredPoint.g_lat ?? 0).toFixed(2)}G lat,{" "}
                      {hoveredPoint.g_lon && hoveredPoint.g_lon >= 0 ? "+" : "−"}{Math.abs(hoveredPoint.g_lon ?? 0).toFixed(2)}G lon)
                    </span>
                  </>
                ) : isReplaying ? (
                  <>
                    Speed <b className="text-foreground">{displaySpeed?.toFixed(1) ?? "—"} km/h</b>
                  </>
                ) : (
                  <>
                    Peak speed <b className="text-foreground">{displaySpeed?.toFixed(1) ?? "—"} km/h</b>
                  </>
                )}
              </span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-[11px]">
                  <span className="size-2 rounded-full bg-[#ef4444]" /> Slow
                  <span className="size-2 rounded-full bg-[#eab308] ml-1" /> Med
                  <span className="size-2 rounded-full bg-[#22c55e] ml-1" /> Fast
                </span>
                {isCurrentSessionLive && liveSessionState && (
                  <span>
                    Lap <b className="text-foreground">{liveSessionState.currentLap}</b>
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
                {isCurrentSessionLive || isReplaying
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

              {/* Indicator: Hover mode has white vector line + pulse dot, Live mode has needle line, Replay mode has moving dot, Static has center dot */}
              {hoveredPoint ? (
                <g className="transition-all duration-75">
                  <line
                    x1="110"
                    y1="110"
                    x2={gx}
                    y2={gy}
                    stroke="#ffffff"
                    strokeWidth="2.5"
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={gx}
                    cy={gy}
                    r="12"
                    fill="none"
                    stroke="#ffffff"
                    strokeWidth="1.5"
                    opacity="0.4"
                  />
                  <circle
                    cx={gx}
                    cy={gy}
                    r="6.5"
                    fill="#ffffff"
                    stroke="#09090b"
                    strokeWidth="2"
                  />
                </g>
              ) : isCurrentSessionLive ? (
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
                <g className="transition-all duration-75">
                  <line
                    x1="110"
                    y1="110"
                    x2={gx}
                    y2={gy}
                    stroke="var(--accent)"
                    strokeWidth="2.5"
                    strokeDasharray="2 2"
                  />
                  <circle
                    cx={gx}
                    cy={gy}
                    r="12"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="1.5"
                    opacity="0.4"
                  />
                  <circle
                    cx={gx}
                    cy={gy}
                    r="6.5"
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
                <b className={hoveredPoint ? "text-white font-semibold" : "text-accent"}>
                  {effectiveGLat >= 0 ? "+" : ""}{effectiveGLat.toFixed(2)} G
                </b>
                {hoveredPoint && (
                  <span className="ml-1 text-[10px] text-white/80 font-medium">
                    (hover)
                  </span>
                )}
              </span>
              <span>
                Longitudinal{" "}
                <b className={hoveredPoint ? "text-white font-semibold" : "text-destructive"}>
                  {effectiveGLon >= 0 ? "+" : "−"}{Math.abs(effectiveGLon).toFixed(2)} G
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
                  {validOnly ? `${visibleLaps.length} valid` : `${laps.length} total`}
                </span>
              </h2>
              {effectiveLapId && (
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
                      const isValid = validLapIds.has(lap.lap_id);
                      const isBest = isValid && bestLap?.lap_id === lap.lap_id;
                      const isSelected = effectiveLapId === lap.lap_id;
                      const delta =
                        isValid && bestLap && !isBest && lap.duration_ms > 0
                          ? formatDelta(lap.duration_ms - bestLap.duration_ms)
                          : null;
                      return (
                        <tr
                          key={lap.lap_id}
                          onClick={() =>
                            setSelectedLapId(effectiveLapId === lap.lap_id ? null : lap.lap_id)
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
                              {!isValid && (
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-normal">
                                  {lap.is_complete === false || lap.is_complete === 0 || lap.duration_ms < 15000
                                    ? "Incomplete"
                                    : "Unverified"}
                                </span>
                              )}
                            </div>
                          </td>
                          <td
                            className={
                              isBest
                                ? "text-accent font-semibold"
                                : !isValid
                                  ? "text-muted-foreground/60 line-through"
                                  : ""
                            }
                          >
                            {formatLapTime(lap.duration_ms)}
                          </td>
                          <td>
                            {isBest ? (
                              <span className="rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground font-semibold">
                                BEST
                              </span>
                            ) : !isValid ? (
                              <span className="rounded bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">
                                INVALID
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
                                setSelectedLapId(effectiveLapId === lap.lap_id ? null : lap.lap_id);
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
