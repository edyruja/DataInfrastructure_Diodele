// ---------------------------------------------------------------------------
// Physics & Geo Metrics Helpers (Self-contained for Terraform / Worker bundle)
// ---------------------------------------------------------------------------

function computeSampleSliceMetrics(avgAx, avgAy, avgAz, avgGzSigned, speedKmh, accelGps) {
  const avgGz = Math.abs(avgGzSigned);

  const sensorMag = Math.sqrt(avgAx * avgAx + avgAy * avgAy + avgAz * avgAz);

  let gLat = 0;
  let gLon = 0;
  let gBrake = 0;

  if ((speedKmh || 0) > 3) {
    const speedMps = (speedKmh || 0) / 3.6;
    const aLatKinematic = Math.abs(speedMps * avgGz);
    const aLonKinematic = Math.abs(accelGps);
    const kNorm = Math.sqrt(aLonKinematic * aLonKinematic + aLatKinematic * aLatKinematic);

    if (kNorm > 0.08) {
      const ratioLat = aLatKinematic / kNorm;
      const ratioLon = aLonKinematic / kNorm;
      // Semnul virajului: dacă mașina virează stânga sau dreapta, gLat trebuie să fie pozitiv sau negativ
      const turnSign = avgGzSigned >= 0 ? 1 : -1;
      const dynamicGLat = sensorMag * ratioLat * turnSign;
      const dynamicGLon = sensorMag * ratioLon * (accelGps >= 0 ? 1 : -1);
      gLat = Number(dynamicGLat.toFixed(3));
      gLon = Number(dynamicGLon.toFixed(3));
      gBrake = dynamicGLon < 0 ? Number(Math.abs(dynamicGLon).toFixed(3)) : 0;
    } else {
      // Linie dreaptă sau accelerație laterală pură din senzorul fizic
      if (avgGz < 0.08) {
        // Mașina merge drept (nu virează): forța laterală este 0, forța e exclusiv longitudinală!
        gLat = 0;
        const lonSign = (accelGps < 0 || avgAy < 0) ? -1 : 1;
        gLon = Number((sensorMag * lonSign).toFixed(3));
        gBrake = gLon < 0 ? Number(Math.abs(gLon).toFixed(3)) : 0;
      } else {
        gLat = Number((avgAx * 0.2).toFixed(3));
        gLon = 0;
        gBrake = 0;
      }
    }
  }

  const absGLat = Number(Math.abs(gLat).toFixed(3));
  const isCornerApex = (absGLat > 0.35 || avgGz > 0.35) && (speedKmh || 0) > 10 ? 1 : 0;

  return { g_lat: gLat, g_lon: gLon, abs_g_lat: absGLat, g_brake: gBrake, is_corner_apex: isCornerApex, speed_kmh: speedKmh || 0 };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Store the input before deriving laps. Queue delivery can be late, duplicated,
// or distributed across independent Worker instances.
function storeMessage(data, env) {
  if (typeof data?.session_id !== "string" || !data.session_id) return [];
  const sessionId = data.session_id;
  if (data.event_type === "STOP_SESSION") {
    const stopTs = Date.parse(data.timestamp ?? "");
    if (!Number.isSafeInteger(stopTs)) return [];
    return [env.DB.prepare(
      `INSERT INTO telemetry_stops (session_id, stop_ts) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET stop_ts = MIN(telemetry_stops.stop_ts, excluded.stop_ts)`
    ).bind(sessionId, stopTs)];
  }

  if (data.event_type !== "telemetry_batch" || !Array.isArray(data.samples)) return [];
  const samples = data.samples
    .filter((sample) => Number.isSafeInteger(sample?.ts) && sample.ts > 0 && sample.ts < 8.64e15)
    .sort((a, b) => a.ts - b.ts);
  if (!samples.length) return [];

  const firstTs = samples[0].ts;
  const lastTs = samples.at(-1).ts;
  const declaredStart = Number(/^ses_(\d{13})(?:_|$)/.exec(sessionId)?.[1]);
  const startTs = declaredStart > 0 && declaredStart <= firstTs ? declaredStart : firstTs;
  const gps = data.gps;
  const validGps = Number.isFinite(gps?.lat) && Math.abs(gps.lat) <= 90 &&
    Number.isFinite(gps?.lon) && Math.abs(gps.lon) <= 180 && (gps.lat !== 0 || gps.lon !== 0);
  const lat = validGps ? gps.lat : 0;
  const lon = validGps ? gps.lon : 0;
  const speed = validGps && Number.isFinite(gps.speed) ? Math.max(0, gps.speed) : 0;
  const bearing = validGps && Number.isFinite(gps.bearing) ? gps.bearing : 0;

  const sliceSize = Math.max(1, Math.floor(samples.length / 4));
  const slices = [];
  for (let i = 0; i < samples.length; i += sliceSize) {
    const slice = samples.slice(i, i + sliceSize);
    // Preserve the means used by the existing G-force calculation.
    const means = ["ax", "ay", "az", "gz"].map((key) =>
      slice.reduce((sum, sample) => sum + (Number.isFinite(sample[key]) ? sample[key] : 0), 0) / slice.length
    );
    slices.push([slice.at(-1).ts, ...means]);
  }

  return [
    env.DB.prepare(
      `INSERT INTO sessions (session_id, device_id, track_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         created_at = MIN(sessions.created_at, excluded.created_at),
         updated_at = CASE WHEN EXISTS (
           SELECT 1 FROM telemetry_batches
           WHERE session_id = excluded.session_id AND end_ts = ?
         ) OR EXISTS (
           SELECT 1 FROM telemetry_stops WHERE session_id = excluded.session_id
         ) THEN sessions.updated_at
         ELSE MAX(COALESCE(sessions.updated_at, sessions.created_at), excluded.updated_at) END`
    ).bind(sessionId,
      typeof data.device_id === "string" && data.device_id ? data.device_id : "S23-Driver",
      typeof data.track_name === "string" && data.track_name ? data.track_name : "Default-Track",
      new Date(startTs).toISOString(), new Date().toISOString(), lastTs),
    env.DB.prepare(
      `INSERT INTO telemetry_batches (session_id, end_ts, lat, lon, speed, bearing, slices)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, end_ts) DO NOTHING`
    ).bind(sessionId, lastTs, lat, lon, speed, bearing, JSON.stringify(slices)),
  ];
}

const LAP_ENTRY_METERS = 15;
const LAP_EXIT_METERS = 25;
const MIN_LAP_MS = 15_000;

function passesStart(start, previous, current, distance) {
  if (haversineMeters(start.lat, start.lon, current.lat, current.lon) <= LAP_ENTRY_METERS) {
    return true;
  }
  // Also detect a pass between fixes when neither fix is inside the start zone.
  const a = haversineMeters(start.lat, start.lon, previous.lat, previous.lon);
  const b = haversineMeters(start.lat, start.lon, current.lat, current.lon);
  const along = (a * a + distance * distance - b * b) / (2 * distance);
  return along > 0 && along < distance && a * a - along * along <= LAP_ENTRY_METERS ** 2;
}

function lapIdFor(sessionId, lapNumber) {
  return `${sessionId}_lap_${String(lapNumber).padStart(2, "0")}`;
}

function buildSessionTelemetry(sessionId, batches, stopTs) {
  const rows = [];
  let previousBatch;
  for (const batch of batches) {
    const dt = previousBatch ? (batch.end_ts - previousBatch.end_ts) / 1000 : 0;
    const accelGps = dt > 0 && dt <= 2.5 && (previousBatch.lat || previousBatch.lon)
      ? (batch.speed - previousBatch.speed) / Math.max(0.05, dt)
      : 0;
    previousBatch = batch;
    const speedKmh = Number((batch.speed * 3.6).toFixed(1));
    for (const [ts, ax, ay, az, gz] of JSON.parse(batch.slices)) {
      if (ts > stopTs) continue;
      rows.push({
        ts,
        lat: batch.lat,
        lon: batch.lon,
        bearing: batch.bearing,
        ...computeSampleSliceMetrics(ax, ay, az, gz, speedKmh, accelGps),
      });
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  if (!rows.length) return { laps: [], points: [] };

  const points = [];
  const laps = [];
  const declaredStart = Number(/^ses_(\d{13})(?:_|$)/.exec(sessionId)?.[1]);
  const sessionStart = declaredStart > 0 && declaredStart <= rows[0].ts ? declaredStart : rows[0].ts;
  let lapNumber = 1;
  let lapStart = sessionStart;
  let lapId = lapIdFor(sessionId, lapNumber);
  let count = 0;
  let sumSpeed = 0;
  let maxSpeed = 0;
  let maxLat = 0;
  let maxBrake = 0;
  let start;
  let previousFix;
  let lastValidTs = -Infinity;
  let traveled = 0;
  let leftStart = false;
  let lastTs = -1;

  function finishLap(complete) {
    laps.push({
      lap_id: lapId,
      session_id: sessionId,
      lap_number: lapNumber,
      duration_ms: lastTs - lapStart,
      max_speed_kmh: maxSpeed,
      avg_speed_kmh: Number((sumSpeed / count).toFixed(1)),
      max_g_lat: Number(maxLat.toFixed(2)),
      max_g_brake: Number(maxBrake.toFixed(2)),
      is_complete: complete,
      is_valid: complete,
    });
  }

  for (const point of rows) {
    if (point.ts === lastTs) continue;
    lastTs = point.ts;
    let crossed = false;
    if (point.lat || point.lon) {
      start ??= point;
      if (previousFix) {
        const distance = haversineMeters(previousFix.lat, previousFix.lon, point.lat, point.lon);
        if (distance > 0) {
          const seconds = Math.min(2.5, (point.ts - previousFix.ts) / 1000);
          const maxSpeedMps = Math.max(point.speed_kmh, previousFix.speed_kmh) / 3.6;
          const continuous = point.ts - lastValidTs <= 2500 &&
            distance <= 15 + Math.max(12, 1.5 * maxSpeedMps) * Math.max(1, seconds);
          if (continuous) {
            traveled += distance;
            crossed = leftStart && traveled >= 75 && point.ts - lapStart >= MIN_LAP_MS &&
              passesStart(start, previousFix, point, distance);
            if (haversineMeters(start.lat, start.lon, point.lat, point.lon) >= LAP_EXIT_METERS) {
              leftStart = true;
            }
          }
          previousFix = point;
        }
      } else {
        previousFix = point;
      }
      lastValidTs = point.ts;
    }

    points.push({
      lap_id: lapId,
      lap_number: lapNumber,
      lap_offset_ms: point.ts - lapStart,
      session_offset_ms: point.ts - sessionStart,
      lat: point.lat,
      lon: point.lon,
      bearing: point.bearing,
      speed_kmh: point.speed_kmh,
      g_lat: point.g_lat,
      g_lon: point.g_lon,
      is_corner_apex: point.is_corner_apex,
    });
    count++;
    sumSpeed += point.speed_kmh;
    maxSpeed = Math.max(maxSpeed, point.speed_kmh);
    maxLat = Math.max(maxLat, point.abs_g_lat);
    maxBrake = Math.max(maxBrake, point.g_brake);

    if (crossed) {
      finishLap(true);
      lapNumber++;
      lapId = lapIdFor(sessionId, lapNumber);
      lapStart = point.ts;
      count = sumSpeed = maxSpeed = maxLat = maxBrake = traveled = 0;
      leftStart = false;
    }
  }
  if (count) finishLap(false);
  return { laps, points };
}

// The cache is optional. The indexed cursor also sees batches committed late
// with earlier source timestamps, so every rebuild produces the same projection.
const sessionCache = new Map();

async function readSessionTelemetry(sessionId, env) {
  const cached = sessionCache.get(sessionId);
  const [recent, stop] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, end_ts, lat, lon, speed, bearing, slices FROM telemetry_batches WHERE session_id = ? AND id > ? ORDER BY id"
    ).bind(sessionId, cached?.cursor ?? 0),
    env.DB.prepare("SELECT stop_ts FROM telemetry_stops WHERE session_id = ?").bind(sessionId),
  ]);
  const stopTs = stop.results[0]?.stop_ts ?? Infinity;
  if (!recent.results.length && cached?.stopTs === stopTs) return cached.telemetry;
  const batches = [...(cached?.batches ?? []), ...recent.results];
  if (!batches.length) return null;

  batches.sort((a, b) => a.end_ts - b.end_ts);
  const cursor = recent.results.at(-1)?.id ?? cached?.cursor;
  const telemetry = buildSessionTelemetry(sessionId, batches, stopTs);

  if (batches.length <= 5000 && cursor >= (sessionCache.get(sessionId)?.cursor ?? 0)) {
    sessionCache.delete(sessionId);
    sessionCache.set(sessionId, { batches, cursor, stopTs, telemetry });
    if (sessionCache.size > 4) sessionCache.delete(sessionCache.keys().next().value);
  }
  return telemetry;
}

const legacyLapPrefix = (sessionId) => `${sessionId}_lap_`;
const LEGACY_LAP_NUMBER = "COALESCE(l.lap_number, CAST(substr(tp.lap_id, length(?) + 1) AS INTEGER))";
function isTelemetrySchemaMissing(error) {
  const message = `${error?.message ?? error} ${error?.cause?.message ?? ""}`;
  return /no such table: (?:main\.)?telemetry_(?:batches|stops)\b/i.test(message);
}

// Deployments may reach the Worker before the additive D1 schema is applied.
async function readWithLegacySchema(read, fallback) {
  try {
    return await read();
  } catch (error) {
    if (!isTelemetrySchemaMissing(error)) throw error;
    return fallback();
  }
}

async function persistMessages(messages, env) {
  const write = async () => {
    const statements = messages.flatMap((message) => storeMessage(message, env));
    if (!statements.length) return false;
    await env.DB.batch(statements);
    return true;
  };

  try {
    return await write();
  } catch (error) {
    if (!isTelemetrySchemaMissing(error)) throw error;
  }

  // Keep the additive migration in sync with schema.sql for older D1 deployments.
  // A retry is safe when several requests initialize the schema concurrently.
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS telemetry_batches (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id TEXT NOT NULL,
         end_ts INTEGER NOT NULL,
         lat REAL NOT NULL,
         lon REAL NOT NULL,
         speed REAL NOT NULL,
         bearing REAL NOT NULL,
         slices TEXT NOT NULL,
         UNIQUE (session_id, end_ts)
       )`
    ),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_telemetry_batch_cursor ON telemetry_batches(session_id, id)"
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS telemetry_stops (
         session_id TEXT PRIMARY KEY,
         stop_ts INTEGER NOT NULL
       )`
    ),
  ]);
  return write();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "POST" && (url.pathname === "/api/telemetry" || url.pathname === "/telemetry")) {
      let data;
      try {
        data = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
      }

      try {
        if (!await persistMessages([data], env)) {
          return Response.json({ error: "Invalid telemetry event" }, { status: 400, headers: corsHeaders });
        }
        return Response.json({ status: "stored" }, { status: 202, headers: corsHeaders });
      } catch (error) {
        console.error("Telemetry write failed", error);
        try {
          await env.TELEMETRY_QUEUE?.send(data);
        } catch (queueError) {
          console.error("Telemetry retry queue unavailable", queueError);
        }
        return Response.json(
          { error: "Telemetry storage unavailable" },
          { status: 503, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === "/api/sessions" || url.pathname === "/sessions") {
      const { results } = await readWithLegacySchema(
        () => env.DB.prepare(
          `SELECT s.session_id, s.device_id, s.track_name, s.created_at,
                  COALESCE(s.updated_at, s.created_at) AS updated_at, st.stop_ts,
                  (SELECT MAX(tb.id) FROM telemetry_batches tb WHERE tb.session_id = s.session_id) AS telemetry_revision
           FROM sessions s LEFT JOIN telemetry_stops st USING (session_id)
           ORDER BY COALESCE(s.updated_at, s.created_at) DESC LIMIT 50`
        ).all(),
        () => env.DB.prepare(
          `SELECT session_id, device_id, track_name, created_at,
                  COALESCE(updated_at, created_at) AS updated_at,
                  NULL AS stop_ts, NULL AS telemetry_revision
           FROM sessions ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50`
        ).all()
      );
      return Response.json(results, { headers: corsHeaders });
    }

    const sessionMatch = url.pathname.match(/^(\/api)?\/sessions\/([^/]+)\/(laps|telemetry|live)$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[2]);
      const action = sessionMatch[3];
      const prefix = legacyLapPrefix(sessionId);
      const end = prefix + "\uffff";
      const lastMs = Math.min(60_000, Math.max(1, Number(url.searchParams.get("last_ms")) || 2000));

      if (action === "live") {
        const { results } = await readWithLegacySchema(
          () => env.DB.prepare(
            `SELECT COALESCE(s.updated_at, s.created_at) AS updated_at, st.stop_ts
             FROM sessions s LEFT JOIN telemetry_stops st USING (session_id) WHERE s.session_id = ?`
          ).bind(sessionId).all(),
          () => env.DB.prepare(
            `SELECT COALESCE(updated_at, created_at) AS updated_at, NULL AS stop_ts
             FROM sessions WHERE session_id = ?`
          ).bind(sessionId).all()
        );
        const session = results[0];
        if (!session || session.stop_ts != null || !(Date.now() - Date.parse(session.updated_at) <= 12_000)) {
          return Response.json([], { headers: { ...corsHeaders, "X-Session-Status": "offline" } });
        }
      }

      const recorded = await readWithLegacySchema(
        () => readSessionTelemetry(sessionId, env),
        () => null
      );
      if (recorded) {
        if (action === "laps") return Response.json(recorded.laps, { headers: corsHeaders });
        if (action === "telemetry") return Response.json(recorded.points, { headers: corsHeaders });
        const last = recorded.points.at(-1)?.session_offset_ms;
        return Response.json(
          recorded.points.filter((point) => point.session_offset_ms >= last - lastMs),
          { headers: corsHeaders }
        );
      }

      // Historical rows do not have source timestamps. Keep their original
      // lap IDs and expose partial traces even when there is no summary row.
      if (action === "laps") {
        const { results } = await env.DB.prepare(
          `SELECT l.lap_id, l.session_id, l.lap_number, l.duration_ms,
                  ROUND(MAX(COALESCE(l.max_speed_kmh, 0), COALESCE(MAX(tp.speed_kmh), 0)), 1) AS max_speed_kmh,
                  ROUND(COALESCE(AVG(tp.speed_kmh), l.avg_speed_kmh, 0), 1) AS avg_speed_kmh,
                  ROUND(MAX(COALESCE(ABS(l.max_g_lat), 0), COALESCE(MAX(ABS(tp.g_lat)), 0)), 2) AS max_g_lat,
                  ROUND(MAX(COALESCE(ABS(l.max_g_brake), 0), COALESCE(-MIN(tp.g_lon), 0)), 2) AS max_g_brake,
                  NULL AS is_complete, NULL AS is_valid
           FROM laps l LEFT JOIN telemetry_points tp ON l.lap_id = tp.lap_id
           WHERE l.session_id = ?
           GROUP BY l.lap_id
           UNION ALL
           SELECT tp.lap_id, ?, ${LEGACY_LAP_NUMBER}, MAX(tp.lap_offset_ms),
                  COALESCE(MAX(tp.speed_kmh), 0), COALESCE(ROUND(AVG(tp.speed_kmh), 1), 0),
                  COALESCE(ROUND(MAX(ABS(tp.g_lat)), 2), 0),
                  COALESCE(ROUND(MAX(0, -MIN(tp.g_lon)), 2), 0), 0, 0
           FROM telemetry_points tp LEFT JOIN laps l ON tp.lap_id = l.lap_id
           WHERE l.lap_id IS NULL AND tp.lap_id >= ? AND tp.lap_id < ?
           GROUP BY tp.lap_id
           ORDER BY lap_number`
        ).bind(sessionId, sessionId, prefix, prefix, end).all();
        return Response.json(results, { headers: corsHeaders });
      }

      if (action === "live") {
        const { results } = await env.DB.prepare(
          `SELECT tp.lap_id, tp.lap_offset_ms FROM telemetry_points tp
           LEFT JOIN laps l ON tp.lap_id = l.lap_id
           WHERE l.session_id = ? OR (tp.lap_id >= ? AND tp.lap_id < ?)
           ORDER BY tp.id DESC LIMIT 1`
        ).bind(sessionId, prefix, end).all();
        const latest = results[0];
        if (!latest) return Response.json([], { headers: corsHeaders });
        const { results: points } = await env.DB.prepare(
          `SELECT tp.*, ${LEGACY_LAP_NUMBER} AS lap_number FROM telemetry_points tp
           LEFT JOIN laps l ON tp.lap_id = l.lap_id
           WHERE tp.lap_id = ? AND tp.lap_offset_ms BETWEEN ? AND ?
           ORDER BY tp.lap_offset_ms, tp.id`
        ).bind(prefix, latest.lap_id, latest.lap_offset_ms - lastMs, latest.lap_offset_ms).all();
        return Response.json(points, { headers: corsHeaders });
      }

      const { results } = await env.DB.prepare(
        `SELECT tp.*, ${LEGACY_LAP_NUMBER} AS lap_number
         FROM telemetry_points tp LEFT JOIN laps l ON tp.lap_id = l.lap_id
         WHERE l.session_id = ? OR (tp.lap_id >= ? AND tp.lap_id < ?)
         ORDER BY lap_number, tp.lap_offset_ms, tp.id`
      ).bind(prefix, sessionId, prefix, end).all();
      return Response.json(results, { headers: corsHeaders });
    }

    const lapMatch = url.pathname.match(/^(\/api)?\/laps\/([^/]+)\/telemetry$/);
    if (lapMatch) {
      const lapId = decodeURIComponent(lapMatch[2]);
      const sessionId = /^(.*)_lap_\d+$/.exec(lapId)?.[1];
      if (sessionId) {
        const recorded = await readWithLegacySchema(
          () => readSessionTelemetry(sessionId, env),
          () => null
        );
        if (recorded) {
          return Response.json(recorded.points.filter((point) => point.lap_id === lapId), { headers: corsHeaders });
        }
      }
      const { results } = await env.DB.prepare(
        `SELECT tp.*, ${LEGACY_LAP_NUMBER} AS lap_number
         FROM telemetry_points tp LEFT JOIN laps l ON tp.lap_id = l.lap_id
         WHERE tp.lap_id = ? ORDER BY tp.lap_offset_ms, tp.id`
      ).bind(legacyLapPrefix(sessionId ?? ""), lapId).all();
      return Response.json(results, { headers: corsHeaders });
    }

    return new Response("F1 Telemetry API Online", { headers: corsHeaders });
  },

  // Persist the queue batch atomically before acknowledging its messages.
  async queue(batch, env) {
    await persistMessages(batch.messages.map((message) => message.body), env);
    batch.ackAll();
  },
};
