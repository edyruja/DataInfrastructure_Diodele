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
  snapPointToPolyline,
  haversineMeters,
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
  deviceId: string;
  trackName: string;
};

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
  const [selectedLapId, setSelectedLapId] = useState<string | null>(null);
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
  const sessionIdRef = useRef<string>(sessionId);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Current session's live state & status detection (Near Real-Time Polling)
  const liveSessionState = liveSessionsMap[sessionId];
  const secondsSinceLastLive = liveSessionState
    ? (Date.now() - liveSessionState.lastSeen) / 1000
    : Infinity;

  const isCurrentSessionLive = secondsSinceLastLive < 10;
  const isCurrentSessionRecent = !isCurrentSessionLive && secondsSinceLastLive < 60;
  const liveTrackPoints = livePointsBySession[sessionId] ?? [];

  // ── Ordered Sessions: ALL LIVE SESSIONS APPEAR FIRST ABOVE DATABASE SESSIONS ──
  const orderedSessions = useMemo(() => {
    const allMap = new Map<string, ApiSession>();

    // 1. Add all sessions from the database
    for (const s of sessions) {
      allMap.set(s.session_id, s);
    }

    // 2. Add or update any live session from liveSessionsMap
    for (const [id, liveData] of Object.entries(liveSessionsMap)) {
      const existing = allMap.get(id);
      if (existing) {
        allMap.set(id, {
          ...existing,
          device_id: liveData.deviceId || existing.device_id,
          track_name: liveData.trackName || existing.track_name,
        });
      } else {
        allMap.set(id, {
          session_id: id,
          device_id: liveData.deviceId,
          track_name: liveData.trackName,
          created_at: new Date(liveData.lastSeen).toISOString(),
        });
      }
    }

    const all = Array.from(allMap.values());
    const liveList: ApiSession[] = [];
    const recordedList: ApiSession[] = [];

    const now = Date.now();
    for (const s of all) {
      const liveData = liveSessionsMap[s.session_id];
      if (liveData && now - liveData.lastSeen < 15000) {
        liveList.push(s);
      } else {
        recordedList.push(s);
      }
    }

    // Sort live sessions: most recently active first
    liveList.sort((a, b) => {
      const tA = liveSessionsMap[a.session_id]?.lastSeen ?? 0;
      const tB = liveSessionsMap[b.session_id]?.lastSeen ?? 0;
      return tB - tA;
    });

    // Sort recorded sessions: newest created_at first
    recordedList.sort((a, b) => {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    // ALL live sessions appear first, followed by all database sessions!
    return [...liveList, ...recordedList];
  }, [sessions, liveSessionsMap]);

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
          if (prev && liveSessionsMap[prev]) return prev;
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
  }, [liveSessionsMap]);

  // ── Near Real-Time Polling for live session chunks (No WebSocket) ──────────
  useEffect(() => {
    let isMounted = true;
    const pollIntervalMs = 1500; // poll every 1.5s for live telemetry chunks

    const pollLive = async () => {
      if (!isMounted || !sessionId) return;
      try {
        const livePts = await fetchLiveTelemetry(sessionId, 3500);
        if (!isMounted || !Array.isArray(livePts) || livePts.length === 0) return;

        const now = Date.now();
        const newest = livePts[livePts.length - 1]!;
        const prevBuf = liveBufferRef.current;
        const prevNewestOffset =
          prevBuf.length > 0 ? prevBuf[prevBuf.length - 1]!.lap_offset_ms : -1;

        // If new points arrived in D1
        if (newest.lap_offset_ms > prevNewestOffset || prevBuf.length === 0) {
          const currentLapNum = newest.lap_number || 1;
          const targetSession = sessions.find((s) => s.session_id === sessionId);

          setLiveSessionsMap((prev) => ({
            ...prev,
            [sessionId]: {
              lastSeen: now,
              currentLap: currentLapNum,
              currentLapTimeMs: newest.lap_offset_ms,
              speedKmh: newest.speed_kmh,
              gLat: newest.g_lat,
              gLon: newest.g_lon,
              totalG: Number(Math.hypot(newest.g_lat, newest.g_lon).toFixed(2)),
              lat: newest.lat,
              lon: newest.lon,
              deviceId: targetSession?.device_id || "Active Driver",
              trackName: targetSession?.track_name || "Circuit",
            },
          }));

          // Merge incoming points into playout buffer
          const existingOffsets = new Set(prevBuf.map((p) => p.lap_offset_ms));
          const fresh = livePts.filter((p) => !existingOffsets.has(p.lap_offset_ms));

          if (fresh.length > 0) {
            const updatedBuf = [...prevBuf, ...fresh].sort(
              (a, b) => a.lap_offset_ms - b.lap_offset_ms,
            );
            liveBufferRef.current = updatedBuf.slice(-300);

            // Accumulate distinct GPS points into livePointsBySession
            setLivePointsBySession((prev) => {
              const sessionPts = prev[sessionId] ?? [];
              const last = sessionPts[sessionPts.length - 1];
              const validGps = fresh.filter((p) => p.lat !== 0 && p.lon !== 0);
              if (validGps.length === 0) return prev;

              const filtered: TelemetryPoint[] = [];
              let refPt = last;
              for (const p of validGps) {
                if (refPt) {
                  const dist = haversineMeters(refPt.lat, refPt.lon, p.lat, p.lon);
                  if (dist >= 1.0 || p.speed_kmh >= 2.0) {
                    filtered.push(p);
                    refPt = p;
                  }
                } else {
                  filtered.push(p);
                  refPt = p;
                }
              }
              return {
                ...prev,
                [sessionId]: [...sessionPts, ...filtered],
              };
            });
          }

          // If current lap advanced on active session, refresh laps from DB
          if (currentLapNum > lastLapRef.current) {
            lastLapRef.current = currentLapNum;
            fetchLaps(sessionId).then(setLaps).catch(() => {});
          }
        }
      } catch {
        // network retry silent
      }
    };

    const timer = setInterval(pollLive, pollIntervalMs);
    pollLive();

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [sessionId, sessions]);

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

        const nextPlayhead = Math.min(newestOffset, livePlayheadMsRef.current + deltaMs * pace);
        livePlayheadMsRef.current = nextPlayhead;

        const frame = interpolateTelemetryPoint(buffer, nextPlayhead);
        if (frame) {
          setLiveInterpolatedFrame(frame);
        }
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

  // ── When sessionId changes: fetch laps + telemetry ───────────────────────
  useEffect(() => {
    if (!sessionId) {
      setLaps([]);
      setTelemetry([]);
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
        setLivePointsBySession((prev) => {
          if (prev[sessionId]?.length) return prev;
          return { ...prev, [sessionId]: telData };
        });
        if (lapData.length > 0) {
          lastLapRef.current = Math.max(...lapData.map((l) => l.lap_number));
          // Automatically select the best valid completed lap by default
          const validCandidates = lapData.filter((l) => isLapValid(l, lapData, telData));
          const best = validCandidates.reduce<ApiLap | null>(
            (b, l) => (!b || (l.duration_ms > 0 && l.duration_ms < b.duration_ms) ? l : b),
            null,
          );
          if (best) {
            setSelectedLapId(best.lap_id);
          } else {
            setSelectedLapId(lapData[0]!.lap_id);
          }
        }
      })
      .finally(() => setLoading(false));

    return () => ac.abort();
  }, [sessionId]);

  // ── Computed values ───────────────────────────────────────────────────────
  // Filter completed and valid laps only (incomplete or aborted laps under 15s are excluded)
  const validLaps = useMemo(() => {
    return laps.filter((l) => isLapValid(l, laps, telemetry));
  }, [laps, telemetry]);

  const bestLap = useMemo(() => {
    return validLaps.reduce<ApiLap | null>(
      (b, l) => (!b || (l.duration_ms > 0 && l.duration_ms < b.duration_ms) ? l : b),
      null,
    );
  }, [validLaps]);

  // Effective active lap: in recorded mode, defaults to the best completed lap!
  const effectiveLapId = useMemo(() => {
    if (isCurrentSessionLive) return null;
    if (selectedLapId) return selectedLapId;
    return bestLap?.lap_id ?? (laps.length > 0 ? laps[0]?.lap_id : null);
  }, [isCurrentSessionLive, selectedLapId, bestLap, laps]);

  // Active telemetry for recorded / filtered views
  const displayedTelemetry = useMemo(() => {
    if (isCurrentSessionLive) return telemetry;
    if (effectiveLapId) {
      const filtered = telemetry.filter((p) => p.lap_id === effectiveLapId);
      if (filtered.length > 0) return filtered;
    }
    return telemetry;
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
      if (effectiveLapId) {
        const lapPts = telemetry.filter((p) => p.lap_id === effectiveLapId);
        if (lapPts.length > 8) return lapPts;
      }
      const lap1 = telemetry.filter((p) => p.lap_number === 1);
      return lap1.length > 8 ? lap1 : telemetry;
    }

    // 2. Live session:
    // When Lap 1 is complete (current_lap >= 2 or completed laps exist):
    const currentLiveLap = liveSessionState?.currentLap ?? 1;
    if (currentLiveLap >= 2 || laps.length > 0) {
      const lap1Live = liveTrackPoints.filter((p) => p.lap_number === 1);
      if (lap1Live.length > 8) return lap1Live;
      const lap1Tel = telemetry.filter((p) => p.lap_number === 1);
      if (lap1Tel.length > 8) return lap1Tel;
    }

    // Still in live Lap 1: no reference track yet (actively being created)
    return [];
  }, [isCurrentSessionLive, telemetry, selectedLapId, liveSessionState?.currentLap, laps.length, liveTrackPoints]);

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

  const isClosedLoop = useMemo(() => {
    if (activeTrackPoints.length < 15) return false;
    const first = activeTrackPoints[0]!;
    const last = activeTrackPoints[activeTrackPoints.length - 1]!;
    return haversineMeters(first.lat, first.lon, last.lat, last.lon) < 35;
  }, [activeTrackPoints]);

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

  // Smooth Catmull-Rom spline interpolated track (silky road curves for both live and recorded sessions)
  const smoothFullTrack = useMemo(() => {
    return interpolateTrackSpline(fullProjectedTrack, isClosedLoop, 4);
  }, [fullProjectedTrack, isClosedLoop]);

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

  const startPoint = smoothFullTrack.length > 0 ? smoothFullTrack[0] : null;

  const endPoint =
    smoothFullTrack.length > 1 && !isClosedLoop
      ? smoothFullTrack[smoothFullTrack.length - 1]
      : null;

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

  // ── Live / Replay Car Dot ────────────────────────────────────────────────
  // In Replay Mode: car moves continuously at 60 FPS along the circuit track without pausing or jumping.
  // In Live Mode: smoothly glides using 60 FPS interpolated buffered chunk coordinates.
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
    if (!isCurrentSessionLive || fullProjectedTrack.length === 0 || !trackBounds) {
      return null;
    }

    const liveLat = liveInterpolatedFrame?.lat ?? liveSessionState?.lat;
    const liveLon = liveInterpolatedFrame?.lon ?? liveSessionState?.lon;
    const liveSpd = liveInterpolatedFrame?.speed_kmh ?? liveSessionState?.speedKmh ?? 0;
    const currentLiveLap = liveSessionState?.currentLap ?? 1;

    if (liveLat && liveLon) {
      const rawPos = projectCoordWithBounds(liveLat, liveLon, trackBounds, 400, 220, 24);

      // From Lap 2 onwards: Snap to established reference circuit track
      if (referenceTrack.length > 0 && currentLiveLap >= 2) {
        const snapped = snapPointToPolyline(rawPos, fullProjectedTrack, 45);
        return {
          x: snapped.x,
          y: snapped.y,
          speed: liveSpd,
          segmentIndex: snapped.segmentIndex,
          isSnapped: true,
        };
      }

      return {
        x: rawPos.x,
        y: rawPos.y,
        speed: liveSpd,
        segmentIndex: fullProjectedTrack.length - 1,
        isSnapped: false,
      };
    }

    // Fallback during live Lap 1 if GPS fix not yet interpolated
    const head = fullProjectedTrack[fullProjectedTrack.length - 1];
    if (!head) return null;
    return {
      x: head.x,
      y: head.y,
      speed: liveSpd,
      segmentIndex: fullProjectedTrack.length - 1,
      isSnapped: false,
    };
  }, [
    isReplaying,
    replayTrackPos,
    fullProjectedTrack,
    isCurrentSessionLive,
    liveInterpolatedFrame,
    liveSessionState,
    trackBounds,
    referenceTrack.length,
  ]);

  // Dynamic speed trace polyline:
  // - In Replay Mode: evolves dynamically at 60 FPS up to the replay car position, smoothed with spline.
  // - In Live Mode on Lap 2+: renders ONLY the colored trace for current lap behind the moving car.
  // - In Live Mode on Lap 1: follows the live car as Lap 1 is driven.
  // - In Recorded Sessions: renders the full trace of the selected lap.
  const activeSpeedTrace = useMemo(() => {
    if (isReplaying) {
      return interpolateTrackSpline(projectedTrack, false, 3);
    }

    const currentLiveLap = liveSessionState?.currentLap ?? 1;
    const isLiveLap2Plus =
      isCurrentSessionLive && (currentLiveLap >= 2 || laps.length > 0) && referenceTrack.length > 0;

    if (isLiveLap2Plus && trackBounds) {
      const currentLapPoints = liveTrackPoints.filter(
        (p) => (p.lap_number ?? 1) === currentLiveLap,
      );
      if (currentLapPoints.length === 0) {
        return carDot ? [carDot] : [];
      }
      const pts = currentLapPoints.map((p) => {
        const raw = projectCoordWithBounds(p.lat, p.lon, trackBounds, 400, 220, 24);
        const snapped =
          fullProjectedTrack.length > 1 ? snapPointToPolyline(raw, fullProjectedTrack, 30) : raw;
        return {
          x: snapped.x,
          y: snapped.y,
          speed: p.speed_kmh ?? 0,
          apex: p.is_corner_apex ?? 0,
        };
      });
      if (carDot && pts.length > 0) {
        pts[pts.length - 1] = {
          x: carDot.x,
          y: carDot.y,
          speed: carDot.speed,
          apex: 0,
        };
      }
      return interpolateTrackSpline(pts, false, 3);
    }

    if (isCurrentSessionLive && trackBounds && liveTrackPoints.length > 1) {
      const pts = liveTrackPoints.map((p) => {
        const { x, y } = projectCoordWithBounds(p.lat, p.lon, trackBounds, 400, 220, 24);
        return {
          x,
          y,
          speed: p.speed_kmh ?? 0,
          apex: p.is_corner_apex ?? 0,
        };
      });
      return interpolateTrackSpline(pts, isClosedLoop, 3);
    }

    return smoothFullTrack;
  }, [
    isReplaying,
    projectedTrack,
    isCurrentSessionLive,
    liveSessionState?.currentLap,
    laps.length,
    referenceTrack.length,
    trackBounds,
    liveTrackPoints,
    fullProjectedTrack,
    smoothFullTrack,
    carDot,
    isClosedLoop,
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
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.speed_kmh
      : maxSpeed;

  const currentGLat = isCurrentSessionLive
    ? (liveInterpolatedFrame?.g_lat ?? liveSessionState?.gLat ?? 0)
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.g_lat
      : maxGLat;

  const currentGLon = isCurrentSessionLive
    ? (liveInterpolatedFrame?.g_lon ?? liveSessionState?.gLon ?? 0)
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.g_lon
      : -maxGBrake;

  const totalG = isCurrentSessionLive
    ? (liveInterpolatedFrame?.total_g ?? liveSessionState?.totalG ?? 0)
    : isReplaying && currentReplayFrame
      ? currentReplayFrame.total_g
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

  const isGActive = Boolean(hoveredPoint) || isCurrentSessionLive || isReplaying;

  // SVG G-meter needle dot position
  const rawGx = 110 + (isGActive ? effectiveGLat : 0) * scalePxPerG;
  const rawGy = 110 - (isGActive ? effectiveGLon : 0) * scalePxPerG;
  const gx = Math.max(10, Math.min(210, rawGx));
  const gy = Math.max(10, Math.min(210, rawGy));

  // Current session object
  const session = orderedSessions.find((s) => s.session_id === sessionId);

  // Visible laps: All laps or Valid only (incomplete laps filtered out)
  const visibleLaps = useMemo(() => {
    if (validOnly) {
      return laps.filter((l) => isLapValid(l, laps, telemetry));
    }
    return laps;
  }, [validOnly, laps, telemetry]);

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
                    const isSessionLive = liveData && (Date.now() - liveData.lastSeen) < 10000;
                    const isSessionRecent = liveData && !isSessionLive && (Date.now() - liveData.lastSeen) < 60000;
                    return (
                      <SelectItem key={s.session_id} value={s.session_id}>
                        <div className="flex items-center gap-2 py-0.5">
                          {isSessionLive ? (
                            <span className="flex items-center gap-1 font-semibold text-green-400">
                              <span className="size-2 rounded-full bg-green-500 animate-pulse" />
                              LIVE
                            </span>
                          ) : isSessionRecent ? (
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
                ● LIVE {liveSessionState?.deviceId ? `· ${liveSessionState.deviceId}` : ""}
              </span>
            ) : isCurrentSessionRecent ? (
              <span className="flex items-center gap-2 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-yellow-400">
                <span className="size-2 rounded-full bg-yellow-500" />
                ● Recent
              </span>
            ) : Object.keys(liveSessionsMap).length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const firstLiveId = Object.keys(liveSessionsMap)[0];
                  if (firstLiveId) {
                    setSessionId(firstLiveId);
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
                    {smoothFullTrack.length > 0 ? `${smoothFullTrack.length} pts` : "No data"}
                  </span>
                )}
                {(selectedLapId || effectiveLapId) && (
                  <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-xs text-accent font-mono">
                    Lap {laps.find((l) => l.lap_id === (selectedLapId ?? effectiveLapId))?.lap_number ?? ""}
                    {bestLap && (selectedLapId ?? effectiveLapId) === bestLap.lap_id ? " · Best" : ""}
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
                  <polyline
                    points={smoothFullTrack
                      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
                      .join(" ")}
                    fill="none"
                    stroke="rgba(255, 255, 255, 0.09)"
                    strokeWidth="15"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Road Asphalt Surface */}
                  <polyline
                    points={smoothFullTrack
                      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
                      .join(" ")}
                    fill="none"
                    stroke="#141416"
                    strokeWidth="11"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {/* Per-segment Coloured Speed Trace */}
                  {activeSpeedTrace.slice(0, -1).map((pt, i) => {
                    const next = activeSpeedTrace[i + 1];
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
                    Speed <b className="text-foreground">{displaySpeed.toFixed(1)} km/h</b>
                  </>
                ) : (
                  <>
                    Peak speed <b className="text-foreground">{displaySpeed.toFixed(1)} km/h</b>
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
                      const isValid = isLapValid(lap, laps, telemetry);
                      const isBest = isValid && bestLap?.lap_id === lap.lap_id;
                      const isSelected = (selectedLapId ?? effectiveLapId) === lap.lap_id;
                      const delta =
                        isValid && bestLap && !isBest && lap.duration_ms > 0
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
                              {!isValid && (
                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-normal">
                                  (incomplete)
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
