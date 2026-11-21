// ---------------------------------------------------------------------------
// Physics & Geo Metrics Helpers (Self-contained for Terraform / Worker bundle)
// ---------------------------------------------------------------------------

function computeSampleSliceMetrics(slice, speedKmh, accelGps = 0, bearing = 0) {
  if (!slice || slice.length === 0) {
    return { g_lat: 0, g_lon: 0, abs_g_lat: 0, g_brake: 0, total_g: 0, is_corner_apex: 0, speed_kmh: speedKmh || 0 };
  }

  const len = slice.length;
  const avgAx = slice.reduce((s, p) => s + (p.ax || 0), 0) / len;
  const avgAy = slice.reduce((s, p) => s + (p.ay || 0), 0) / len;
  const avgAz = slice.reduce((s, p) => s + (p.az || 0), 0) / len;
  const avgGz = slice.reduce((s, p) => s + Math.abs(p.gz || 0), 0) / len;

  const sensorMag = Math.sqrt(avgAx * avgAx + avgAy * avgAy + avgAz * avgAz);
  const totalG = Number(sensorMag.toFixed(3));

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
      const dynamicGLat = sensorMag * ratioLat;
      const dynamicGLon = sensorMag * ratioLon * (accelGps >= 0 ? 1 : -1);
      gLat = Number(dynamicGLat.toFixed(3));
      gLon = Number(dynamicGLon.toFixed(3));
      gBrake = dynamicGLon < 0 ? Number(Math.abs(dynamicGLon).toFixed(3)) : 0;
    } else {
      gLat = Number((Math.abs(avgAx) * 0.2).toFixed(3));
      gLon = 0;
      gBrake = 0;
    }
  }

  const absGLat = Number(Math.abs(gLat).toFixed(3));
  const isCornerApex = (absGLat > 0.35 || avgGz > 0.35) && (speedKmh || 0) > 10 ? 1 : 0;

  return { g_lat: gLat, g_lon: gLon, abs_g_lat: absGLat, g_brake: gBrake, total_g: totalG, is_corner_apex: isCornerApex, speed_kmh: speedKmh || 0 };
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

// ---------------------------------------------------------------------------
// In-memory session state for Consumer processing (per Worker instance)
// ---------------------------------------------------------------------------

const sessionStore = new Map();

// ---------------------------------------------------------------------------
// CONSUMER: processBatch — toată logica de calcule și scriere în D1
// ---------------------------------------------------------------------------

async function processBatchConsumer(data, env) {
  const sessionId = data.session_id;
  const trackName = data.track_name || "Default-Track";
  const deviceId = data.device_id || "S23-Driver";

  // STOP_SESSION: finalizăm sesiunea și scriem ultimul tur
  if (data.event_type === "STOP_SESSION") {
    const ses = sessionStore.get(sessionId);
    if (ses) {
      await saveCompletedLap(ses, ses.lastSampleTs, env);
      sessionStore.delete(sessionId);
    }
    return;
  }

  if (data.event_type !== "telemetry_batch" || !Array.isArray(data.samples) || data.samples.length === 0) {
    return;
  }

  const firstSampleTs = data.samples[0].ts;
  const lastSampleTs = data.samples[data.samples.length - 1].ts;

  let ses = sessionStore.get(sessionId);

  if (!ses) {
    // 1. Extragem timestamp-ul de bază al sesiunii direct din sessionId (ex: ses_1795286789116 -> 1795286789116)
    let sessionBaseTs = firstSampleTs;
    const tsMatch = sessionId.match(/(\d{12,14})/);
    if (tsMatch) {
      sessionBaseTs = parseInt(tsMatch[1], 10);
    }

    // 2. Verificăm dacă există deja sesiunea în D1 și dacă are tururi anterioare
    const { results: existingSes } = await env.DB.prepare(
      "SELECT created_at FROM sessions WHERE session_id = ?"
    )
      .bind(sessionId)
      .all();

    if (!existingSes || existingSes.length === 0) {
      const nowIso = new Date(sessionBaseTs).toISOString();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO sessions (session_id, device_id, track_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(sessionId, deviceId, trackName, nowIso, nowIso)
        .run();
    }

    // Verificăm dacă avem deja tururi finalizate în D1 pentru această sesiune
    const { results: existingLaps } = await env.DB.prepare(
      "SELECT lap_number, duration_ms FROM laps WHERE session_id = ? ORDER BY lap_number ASC"
    )
      .bind(sessionId)
      .all();

    let lapNumber = 1;
    let lapStartTime = sessionBaseTs;
    if (existingLaps && existingLaps.length > 0) {
      lapNumber = existingLaps.length + 1;
      const totalPrevDuration = existingLaps.reduce((acc, l) => acc + (l.duration_ms || 0), 0);
      lapStartTime = sessionBaseTs + totalPrevDuration;
    }

    // Căutăm coordonatele de start dacă au fost deja salvate în D1
    let startLat = data.gps?.lat || 0;
    let startLon = data.gps?.lon || 0;
    const { results: firstPt } = await env.DB.prepare(
      "SELECT lat, lon FROM telemetry_points WHERE lap_id LIKE ? ORDER BY id ASC LIMIT 1"
    )
      .bind(`${sessionId}%`)
      .all();

    if (firstPt && firstPt.length > 0 && firstPt[0].lat && firstPt[0].lon) {
      startLat = firstPt[0].lat;
      startLon = firstPt[0].lon;
    }

    ses = {
      sessionId,
      trackName,
      deviceId,
      sessionBaseTs,
      startLat,
      startLon,
      lapNumber,
      lapStartTime,
      lastSampleTs,
      leftStartZone: false,
      lapMaxSpeed: 0,
      lapSpeedSum: 0,
      lapPointCount: 0,
      lapMaxGLat: 0,
      lapMaxGBrake: 0,
      pointsBuffer: [],
      lastSpeedMps: 0,
      lastGpsTs: firstSampleTs,
    };
    sessionStore.set(sessionId, ses);
  }

  const gps = data.gps || { lat: 0, lon: 0, speed: 0, bearing: 0 };
  const speedKmh = Number((gps.speed * 3.6).toFixed(1));
  const currentSpeedMps = gps.speed || 0;

  // Accelerație longitudinală din variația de viteză GPS
  const dtSeconds = Math.max(0.05, (lastSampleTs - ses.lastGpsTs) / 1000);
  const accelGps = (currentSpeedMps - ses.lastSpeedMps) / dtSeconds;
  ses.lastSpeedMps = currentSpeedMps;
  ses.lastGpsTs = lastSampleTs;

  if (ses.startLat === 0 && gps.lat !== 0 && gps.lon !== 0) {
    ses.startLat = gps.lat;
    ses.startLon = gps.lon;
  }

  const chunkSize = Math.max(1, Math.floor(data.samples.length / 4));

  for (let i = 0; i < data.samples.length; i += chunkSize) {
    const slice = data.samples.slice(i, i + chunkSize);
    if (slice.length === 0) continue;

    const m = computeSampleSliceMetrics(slice, speedKmh, accelGps, gps.bearing || 0);

    if (speedKmh > ses.lapMaxSpeed) ses.lapMaxSpeed = speedKmh;
    ses.lapSpeedSum += speedKmh;
    ses.lapPointCount += 1;
    if (m.abs_g_lat > ses.lapMaxGLat) ses.lapMaxGLat = m.abs_g_lat;
    if (m.g_brake > ses.lapMaxGBrake) ses.lapMaxGBrake = m.g_brake;

    const sliceEndTs = slice[slice.length - 1].ts;
    ses.lastSampleTs = sliceEndTs;

    const lapId = `${ses.sessionId}_lap_${String(ses.lapNumber).padStart(2, "0")}`;
    const lapOffsetMs = Math.max(0, sliceEndTs - ses.lapStartTime);

    ses.pointsBuffer.push({
      lap_id: lapId,
      lap_offset_ms: lapOffsetMs,
      lat: gps.lat,
      lon: gps.lon,
      speed_kmh: speedKmh,
      bearing: gps.bearing,
      g_lat: m.g_lat,
      g_lon: m.g_lon,
      is_corner_apex: m.is_corner_apex,
    });
  }

  // Detecție tur (lap detection)
  if (ses.startLat !== 0 && gps.lat !== 0) {
    const dist = haversineMeters(ses.startLat, ses.startLon, gps.lat, gps.lon);
    if (dist > 25) {
      ses.leftStartZone = true;
    } else if (dist < 15 && ses.leftStartZone && lastSampleTs - ses.lapStartTime > 10000) {
      await saveCompletedLap(ses, lastSampleTs, env);
      ses.lapNumber += 1;
      ses.lapStartTime = lastSampleTs;
      ses.leftStartZone = false;
      ses.lapMaxSpeed = 0;
      ses.lapSpeedSum = 0;
      ses.lapPointCount = 0;
      ses.lapMaxGLat = 0;
      ses.lapMaxGBrake = 0;
    }
  }

  // Flush în D1 la fiecare 20 de puncte
  if (ses.pointsBuffer.length >= 20) {
    await flushPointsToD1(ses, env);
  }
}

async function flushPointsToD1(ses, env) {
  if (ses.pointsBuffer.length === 0) return;
  const toInsert = [...ses.pointsBuffer];
  ses.pointsBuffer = [];

  const stmt = env.DB.prepare(
    "INSERT INTO telemetry_points (lap_id, lap_offset_ms, lat, lon, speed_kmh, bearing, g_lat, g_lon, is_corner_apex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const updateSes = env.DB.prepare(
    "UPDATE sessions SET updated_at = ? WHERE session_id = ?"
  ).bind(new Date().toISOString(), ses.sessionId);

  await env.DB.batch([
    ...toInsert.map((p) =>
      stmt.bind(p.lap_id, p.lap_offset_ms, p.lat, p.lon, p.speed_kmh, p.bearing, p.g_lat, p.g_lon, p.is_corner_apex)
    ),
    updateSes,
  ]);
}

async function saveCompletedLap(ses, endTs, env) {
  await flushPointsToD1(ses, env);
  const lapId = `${ses.sessionId}_lap_${String(ses.lapNumber).padStart(2, "0")}`;
  const durationMs = Math.max(0, endTs - ses.lapStartTime);
  const avgSpeed = ses.lapPointCount > 0
    ? Number((ses.lapSpeedSum / ses.lapPointCount).toFixed(1))
    : 0;

  await env.DB.prepare(
    "INSERT OR REPLACE INTO laps (lap_id, session_id, lap_number, duration_ms, max_speed_kmh, avg_speed_kmh, max_g_lat, max_g_brake) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      lapId,
      ses.sessionId,
      ses.lapNumber,
      durationMs,
      ses.lapMaxSpeed,
      avgSpeed,
      Number(ses.lapMaxGLat.toFixed(2)),
      Number(ses.lapMaxGBrake.toFixed(2))
    )
    .run();
}

// ---------------------------------------------------------------------------
// Worker: fetch (PRODUCER) + queue (CONSUMER)
// ---------------------------------------------------------------------------

export default {
  // ── PRODUCER: Preia POST-ul de la telefon și îl trimite în Cloudflare Queue ──
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

    // POST /api/telemetry — PRODUCER: bagă datele în coadă
    if (request.method === "POST" && (url.pathname === "/api/telemetry" || url.pathname === "/telemetry")) {
      try {
        const data = await request.json();
        await env.TELEMETRY_QUEUE.send(data);
        return new Response(JSON.stringify({ status: "queued" }), {
          status: 202,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Bad request" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── REST API pentru Dashboard (GET-uri din D1) ──

    if (url.pathname === "/api/sessions" || url.pathname === "/sessions") {
      const { results } = await env.DB.prepare(
        "SELECT session_id, device_id, track_name, created_at, COALESCE(updated_at, created_at) as updated_at FROM sessions ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50"
      ).all();
      return Response.json(results, { headers: corsHeaders });
    }

    const lapsMatch = url.pathname.match(/^(\/api)?\/sessions\/([^/]+)\/laps$/);
    if (lapsMatch) {
      const sessionId = decodeURIComponent(lapsMatch[2]);
      const { results } = await env.DB.prepare(
        "SELECT * FROM laps WHERE session_id = ? ORDER BY lap_number ASC"
      )
        .bind(sessionId)
        .all();
      return Response.json(results, { headers: corsHeaders });
    }

    const telemetryMatch = url.pathname.match(/^(\/api)?\/sessions\/([^/]+)\/telemetry$/);
    if (telemetryMatch) {
      const sessionId = decodeURIComponent(telemetryMatch[2]);
      const { results } = await env.DB.prepare(
        `SELECT tp.*, COALESCE(l.lap_number, 1) as lap_number
         FROM telemetry_points tp
         LEFT JOIN laps l ON tp.lap_id = l.lap_id
         WHERE l.session_id = ? OR tp.lap_id LIKE ?
         ORDER BY COALESCE(l.lap_number, 1) ASC, tp.lap_offset_ms ASC, tp.id ASC`
      )
        .bind(sessionId, `${sessionId}%`)
        .all();
      return Response.json(results, { headers: corsHeaders });
    }

    const lapPointsMatch = url.pathname.match(/^(\/api)?\/laps\/([^/]+)\/telemetry$/);
    if (lapPointsMatch) {
      const lapId = decodeURIComponent(lapPointsMatch[2]);
      const { results } = await env.DB.prepare(
        "SELECT * FROM telemetry_points WHERE lap_id = ? ORDER BY lap_offset_ms ASC, id ASC"
      )
        .bind(lapId)
        .all();
      return Response.json(results, { headers: corsHeaders });
    }

    // ── LIVE POLLING: ultimele N milisecunde de telemetrie pentru animație fluidă ──
    // GET /api/sessions/:id/live?last_ms=2000
    const liveMatch = url.pathname.match(/^(\/api)?\/sessions\/([^/]+)\/live$/);
    if (liveMatch) {
      const sessionId = decodeURIComponent(liveMatch[2]);
      const lastMs = parseInt(url.searchParams.get("last_ms") || "2000", 10);

      // Verificăm dacă sesiunea a avut activitate reală în ultimele 12 secunde
      const { results: sesResults } = await env.DB.prepare(
        "SELECT updated_at, created_at FROM sessions WHERE session_id = ?"
      )
        .bind(sessionId)
        .all();

      const ses = sesResults?.[0];
      const lastUpdateStr = ses?.updated_at || ses?.created_at;
      const lastUpdateMs = lastUpdateStr ? new Date(lastUpdateStr).getTime() : 0;
      const secondsAgo = (Date.now() - lastUpdateMs) / 1000;

      // Dacă nu a trimis date în ultimele 12 secunde, sesiunea NU este live!
      if (!lastUpdateMs || secondsAgo > 12) {
        return Response.json([], {
          headers: {
            ...corsHeaders,
            "X-Session-Status": "offline",
            "X-Seconds-Ago": String(Math.round(secondsAgo)),
          },
        });
      }

      // Luăm cel mai recent lap_offset_ms din sesiune
      const { results: latest } = await env.DB.prepare(
        `SELECT tp.lap_offset_ms
         FROM telemetry_points tp
         LEFT JOIN laps l ON tp.lap_id = l.lap_id
         WHERE l.session_id = ? OR tp.lap_id LIKE ?
         ORDER BY tp.id DESC
         LIMIT 1`
      )
        .bind(sessionId, `${sessionId}%`)
        .all();

      if (!latest || latest.length === 0) {
        return Response.json([], { headers: corsHeaders });
      }

      const maxOffset = latest[0].lap_offset_ms;
      const minOffset = Math.max(0, maxOffset - lastMs);

      // Returnăm toate punctele din fereastra de timp cerută
      const { results } = await env.DB.prepare(
        `SELECT tp.*, COALESCE(l.lap_number, 1) as lap_number
         FROM telemetry_points tp
         LEFT JOIN laps l ON tp.lap_id = l.lap_id
         WHERE (l.session_id = ? OR tp.lap_id LIKE ?)
           AND tp.lap_offset_ms >= ?
           AND tp.lap_offset_ms <= ?
         ORDER BY tp.lap_offset_ms ASC`
      )
        .bind(sessionId, `${sessionId}%`, minOffset, maxOffset)
        .all();

      return Response.json(results, { headers: corsHeaders });
    }

    return new Response("F1 Telemetry API Online — Queue Architecture", { headers: corsHeaders });
  },

  // ── CONSUMER: Preia mesajele din Cloudflare Queue și execută calculele + scrie în D1 ──
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processBatchConsumer(message.body, env);
        message.ack(); // Confirmăm procesarea: Cloudflare șterge mesajul din coadă
      } catch (err) {
        console.error("Queue consumer error:", err);
        message.retry(); // Dacă a eșuat, Cloudflare reîncercă automat mesajul
      }
    }
  },
};
