// ---------------------------------------------------------------------------
// Physics & Geo Metrics Helpers (Self-contained for Terraform / Worker bundle)
// ---------------------------------------------------------------------------

export function computeSampleSliceMetrics(slice, speedKmh, accelGps = 0, bearing = 0) {
  if (!slice || slice.length === 0) {
    return {
      g_lat: 0,
      g_lon: 0,
      abs_g_lat: 0,
      g_brake: 0,
      total_g: 0,
      is_corner_apex: 0,
      speed_kmh: speedKmh || 0,
    };
  }

  const len = slice.length;
  const avgAx = slice.reduce((s, p) => s + (p.ax || 0), 0) / len;
  const avgAy = slice.reduce((s, p) => s + (p.ay || 0), 0) / len;
  const avgAz = slice.reduce((s, p) => s + (p.az || 0), 0) / len;
  const avgGz = slice.reduce((s, p) => s + Math.abs(p.gz || 0), 0) / len;

  // 1. Forța G REALĂ totală din senzorii fizici (magnitudinea 3D a accelerometrului)
  const sensorMag = Math.sqrt(avgAx * avgAx + avgAy * avgAy + avgAz * avgAz);
  const totalG = Number(sensorMag.toFixed(3));

  let gLat = 0;
  let gLon = 0;
  let gBrake = 0;

  // 2. Aliniem forța G reală pe direcția de mers (bearing) doar dacă mașina e în mișcare (> 3 km/h)
  // Astfel eliminăm orice distorsiune când miști telefonul în mână pe loc!
  if ((speedKmh || 0) > 3) {
    const speedMps = (speedKmh || 0) / 3.6;
    const aLatKinematic = Math.abs(speedMps * avgGz);
    const aLonKinematic = Math.abs(accelGps);
    const kNorm = Math.sqrt(aLonKinematic * aLonKinematic + aLatKinematic * aLatKinematic);

    if (kNorm > 0.08) {
      // Împărțim forța G reală pe axa longitudinală (față/frânare) și axa laterală (viraj)
      const ratioLat = aLatKinematic / kNorm;
      const ratioLon = aLonKinematic / kNorm;

      const dynamicGLat = sensorMag * ratioLat;
      const dynamicGLon = sensorMag * ratioLon * (accelGps >= 0 ? 1 : -1);

      gLat = Number(dynamicGLat.toFixed(3));
      gLon = Number(dynamicGLon.toFixed(3));
      // Frânarea reală: când accelerația pe direcția de mers este negativă (opusă înaintării)
      gBrake = dynamicGLon < 0 ? Number(Math.abs(dynamicGLon).toFixed(3)) : 0;
    } else {
      // Viteză constantă în linie dreaptă
      gLat = Number((Math.abs(avgAx) * 0.2).toFixed(3));
      gLon = 0;
      gBrake = 0;
    }
  }

  const absGLat = Number(Math.abs(gLat).toFixed(3));
  const isCornerApex = (absGLat > 0.35 || avgGz > 0.35) && (speedKmh || 0) > 10 ? 1 : 0;

  return {
    g_lat: gLat,
    g_lon: gLon,
    abs_g_lat: absGLat,
    g_brake: gBrake,
    total_g: totalG,
    is_corner_apex: isCornerApex,
    speed_kmh: speedKmh || 0,
  };
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
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
// Telemetry Hub (Durable Object)
// ---------------------------------------------------------------------------

export class TelemetryHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.webClients = new Set();
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const role = url.searchParams.get("role") || "phone";

    if (role === "web") {
      this.webClients.add(server);
      server.addEventListener("close", () => this.webClients.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    let activeSessionId = url.searchParams.get("session") || `ses_${Date.now()}`;
    const defaultTrack = url.searchParams.get("track") || "Default-Track";
    const defaultDevice = url.searchParams.get("device") || "S23-Driver";

    server.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.session_id) {
          activeSessionId = data.session_id;
        }

        if (data.event_type === "STOP_SESSION") {
          await this.finalizeSession(activeSessionId);
          return;
        }

        if (data.event_type === "telemetry_batch" && Array.isArray(data.samples) && data.samples.length > 0) {
          const trackName = data.track_name || defaultTrack;
          const deviceId = data.device_id || defaultDevice;
          await this.processBatch(data, activeSessionId, trackName, deviceId);
        }
      } catch (err) {
        console.error("WS error:", err);
      }
    });

    server.addEventListener("close", async () => {
      await this.finalizeSession(activeSessionId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async processBatch(data, sessionId, trackName, deviceId) {
    let ses = this.sessions.get(sessionId);
    const firstSampleTs = data.samples[0].ts;
    const lastSampleTs = data.samples[data.samples.length - 1].ts;

    if (!ses) {
      await this.env.DB.prepare(
        "INSERT OR IGNORE INTO sessions (session_id, device_id, track_name, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(sessionId, deviceId, trackName, new Date().toISOString())
        .run();

      ses = {
        sessionId,
        trackName,
        deviceId,
        startLat: data.gps?.lat || 0,
        startLon: data.gps?.lon || 0,
        lapNumber: 1,
        lapStartTime: firstSampleTs,
        lastSampleTs: lastSampleTs,
        leftStartZone: false,
        lapMaxSpeed: 0,
        lapSpeedSum: 0,
        lapPointCount: 0,
        lapMaxGLat: 0,
        lapMaxGBrake: 0,
        pointsBuffer: [],
      };
      this.sessions.set(sessionId, ses);
    }

    const gps = data.gps || { lat: 0, lon: 0, speed: 0, bearing: 0 };
    const speedKmh = Number((gps.speed * 3.6).toFixed(1));
    const currentSpeedMps = gps.speed || 0;

    // Calculăm accelerația pe direcția de mers din variația de viteză GPS
    const lastSpeedMps = ses.lastSpeedMps !== undefined ? ses.lastSpeedMps : currentSpeedMps;
    const lastGpsTs = ses.lastGpsTs || lastSampleTs;
    const dtSeconds = Math.max(0.05, (lastSampleTs - lastGpsTs) / 1000);
    const accelGps = (currentSpeedMps - lastSpeedMps) / dtSeconds;

    ses.lastSpeedMps = currentSpeedMps;
    ses.lastGpsTs = lastSampleTs;

    if (ses.startLat === 0 && gps.lat !== 0 && gps.lon !== 0) {
      ses.startLat = gps.lat;
      ses.startLon = gps.lon;
    }

    const chunkSize = Math.max(1, Math.floor(data.samples.length / 4));
    let latestFrame = null;

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

      const point = {
        lap_id: lapId,
        lap_offset_ms: lapOffsetMs,
        lat: gps.lat,
        lon: gps.lon,
        speed_kmh: speedKmh,
        bearing: gps.bearing,
        g_lat: m.g_lat,
        g_lon: m.g_lon,
        is_corner_apex: m.is_corner_apex,
      };

      ses.pointsBuffer.push(point);
      latestFrame = { ...point, total_g: m.total_g };
    }

    if (ses.startLat !== 0 && gps.lat !== 0) {
      const dist = haversineMeters(ses.startLat, ses.startLon, gps.lat, gps.lon);
      if (dist > 25) {
        ses.leftStartZone = true;
      } else if (dist < 15 && ses.leftStartZone && lastSampleTs - ses.lapStartTime > 10000) {
        await this.saveCompletedLap(ses, lastSampleTs);
        const completedLap = ses.lapNumber;
        const lapDuration = Math.max(0, lastSampleTs - ses.lapStartTime);
        ses.lapNumber += 1;
        ses.lapStartTime = lastSampleTs;
        ses.leftStartZone = false;
        ses.lapMaxSpeed = 0;
        ses.lapSpeedSum = 0;
        ses.lapPointCount = 0;
        ses.lapMaxGLat = 0;
        ses.lapMaxGBrake = 0;

        this.broadcastToWeb({
          type: "LAP_COMPLETED",
          session_id: ses.sessionId,
          lap_number: completedLap,
          duration_ms: lapDuration,
        });
      }
    }

    if (ses.pointsBuffer.length >= 20) {
      await this.flushPointsToD1(ses);
    }

    if (latestFrame) {
      this.broadcastToWeb({
        type: "LIVE_FRAME",
        status: "STREAMING",
        session_id: ses.sessionId,
        device_id: ses.deviceId,
        track_name: ses.trackName,
        current_lap: ses.lapNumber,
        current_lap_time_ms: Math.max(0, lastSampleTs - ses.lapStartTime),
        frame: latestFrame,
      });
    }
  }

  async flushPointsToD1(ses) {
    if (ses.pointsBuffer.length === 0) return;
    const toInsert = [...ses.pointsBuffer];
    ses.pointsBuffer = [];

    const stmt = this.env.DB.prepare(
      "INSERT INTO telemetry_points (lap_id, lap_offset_ms, lat, lon, speed_kmh, bearing, g_lat, g_lon, is_corner_apex) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    await this.env.DB.batch(
      toInsert.map((p) =>
        stmt.bind(p.lap_id, p.lap_offset_ms, p.lat, p.lon, p.speed_kmh, p.bearing, p.g_lat, p.g_lon, p.is_corner_apex)
      )
    );
  }

  async saveCompletedLap(ses, endTs) {
    await this.flushPointsToD1(ses);
    const lapId = `${ses.sessionId}_lap_${String(ses.lapNumber).padStart(2, "0")}`;
    const durationMs = Math.max(0, endTs - ses.lapStartTime);
    const avgSpeed = ses.lapPointCount > 0
      ? Number((ses.lapSpeedSum / ses.lapPointCount).toFixed(1))
      : 0;

    await this.env.DB.prepare(
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

  async finalizeSession(sessionId) {
    const ses = this.sessions.get(sessionId);
    if (!ses) return;
    await this.saveCompletedLap(ses, ses.lastSampleTs);
    this.sessions.delete(sessionId);
    this.broadcastToWeb({ type: "SESSION_ENDED", session_id: sessionId });
  }

  broadcastToWeb(msg) {
    const text = JSON.stringify(msg);
    for (const client of this.webClients) {
      try {
        client.send(text);
      } catch {
        this.webClients.delete(client);
      }
    }
  }
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

    if (url.pathname === "/ws") {
      const id = env.TELEMETRY_HUB.idFromName("global-hub");
      return env.TELEMETRY_HUB.get(id).fetch(request);
    }

    if (url.pathname === "/api/sessions" || url.pathname === "/sessions") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50"
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
         ORDER BY tp.id ASC`
      )
        .bind(sessionId, `${sessionId}%`)
        .all();
      return Response.json(results, { headers: corsHeaders });
    }

    const lapPointsMatch = url.pathname.match(/^(\/api)?\/laps\/([^/]+)\/telemetry$/);
    if (lapPointsMatch) {
      const lapId = decodeURIComponent(lapPointsMatch[2]);
      const { results } = await env.DB.prepare(
        "SELECT * FROM telemetry_points WHERE lap_id = ? ORDER BY lap_offset_ms ASC"
      )
        .bind(lapId)
        .all();
      return Response.json(results, { headers: corsHeaders });
    }

    return new Response("F1 Telemetry API Online", { headers: corsHeaders });
  },
};