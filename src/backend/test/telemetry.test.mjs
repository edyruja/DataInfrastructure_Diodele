import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const workerModule = new URL("../src/index.js", import.meta.url).href;
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function createDatabase(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(schema);
  const DB = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const bind = (...values) => ({
        run: () => /^SELECT/i.test(sql) ? { results: statement.all(...values) } : statement.run(...values),
        all: async () => ({ results: statement.all(...values) }),
      });
      return { ...bind(), bind };
    },
    async batch(statements) {
      db.exec("BEGIN TRANSACTION");
      try {
        const results = statements.map((statement) => statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, env: { DB } };
}

async function deliver(worker, env, data) {
  let acknowledged = false;
  await worker.queue({
    messages: data.map((body) => ({ body })),
    ackAll() { acknowledged = true; },
  }, env);
  assert.equal(acknowledged, true);
}

async function get(worker, env, path) {
  const result = await worker.fetch(new Request("https://example.test/api" + path), env);
  assert.equal(result.ok, true);
  return result.json();
}

test("two Workers agree on lap boundaries after retries, reverse ordering and an early stop delivery", async (t) => {
  const { db, env } = createDatabase(t);
  const { default: writer } = await import(workerModule + "#writer");
  const { default: otherWriter } = await import(workerModule + "#other-writer");
  const base = Math.floor(Date.now() / 1000) * 1000 - 32_000;
  const sessionId = `ses_${base}`;
  const path = `/sessions/${sessionId}`;
  const square = [
    [0, 0], [0, 10], [0, 20], [0, 30], [0, 40], [0, 50],
    [10, 50], [20, 50], [30, 50], [40, 50], [50, 50],
    [50, 40], [50, 30], [50, 20], [50, 10], [50, 0],
    [40, 0], [30, 0], [20, 0], [10, 0], [0, 0],
  ];
  // Start the second lap, then stop while stationary off the start line.
  const route = [...square, ...square.slice(1, 11), ...Array.from({ length: 8 }, () => [50, 50])];
  const batches = route.map(([north, east], index) => ({
    session_id: sessionId,
    event_type: "telemetry_batch",
    gps: { lat: 44 + north / 111195, lon: 26 + east / 79950, speed: 10, bearing: 0 },
    samples: [{ ts: base + index * 1000 }],
  }));

  await deliver(writer, env, batches.slice(0, 18).reverse());
  assert.deepEqual((await get(writer, env, path + "/laps")).map((lap) => lap.is_complete), [false]);
  await deliver(otherWriter, env, batches.slice(18, 32).reverse());
  const live = await get(writer, env, path + "/live?last_ms=16000");
  assert.deepEqual([...new Set(live.map((point) => point.lap_number))], [1, 2]);
  assert(live.every((point, i) => i === 0 || point.session_offset_ms > live[i - 1].session_offset_ms));

  const stop = base + (route.length - 1) * 1000 + 400;
  await deliver(otherWriter, env, [{
    session_id: sessionId, event_type: "STOP_SESSION", timestamp: new Date(stop).toISOString(),
  }]);
  assert.deepEqual(await get(writer, env, path + "/live"), []);

  const tooLate = { ...batches.at(-1), samples: [{ ts: stop + 500 }] };
  await deliver(writer, env, [...batches.slice(30).reverse(), batches[1], tooLate]);
  const laps = await get(writer, env, path + "/laps");
  assert.deepEqual(laps.map((lap) => [lap.lap_number, lap.is_complete, lap.is_valid]), [
    [1, true, true],
    [2, false, false],
  ]);
  assert(laps[1].duration_ms >= 15_000);

  const points = await get(otherWriter, env, path + "/telemetry");
  assert.deepEqual(points.map((point) => point.session_offset_ms), route.map((_, i) => i * 1000));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM telemetry_batches").get().count, route.length + 1);
  const firstLapPoints = await get(writer, env, "/laps/" + laps[0].lap_id + "/telemetry");
  assert.equal(firstLapPoints.at(-1).lap_offset_ms, laps[0].duration_ms);
  assert.deepEqual((await get(otherWriter, env, path + "/laps")), laps);
});

test("legacy sessions load before the additive D1 migration and retain access after it", async (t) => {
  const { db, env } = createDatabase(t);
  const { default: worker } = await import(workerModule + "#legacy");
  db.exec("DROP TABLE telemetry_batches; DROP TABLE telemetry_stops;");
  db.exec(`
    INSERT INTO sessions (session_id, created_at, updated_at)
    VALUES ('ses_legacy', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO laps VALUES ('ses_legacy_lap_01', 'ses_legacy', 1, 20000, 15, 10, 0, 0);
    INSERT INTO telemetry_points (lap_id, lap_offset_ms, lat, lon, speed_kmh, g_lat, g_lon)
    VALUES ('ses_legacy_lap_01', 20000, 44, 26, 50, 0.5, -0.2),
           ('ses_legacy_lap_04', 6000, 44, 26, 30, 0.3, -0.1),
           ('ses_legacy_other_lap_02', 1000, 44, 26, 40, 0.4, 0.2);
  `);
  db.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = 'ses_legacy'").run(new Date().toISOString());
  const sessions = await get(worker, env, "/sessions");
  assert.equal(sessions[0].session_id, "ses_legacy");
  assert.equal(sessions[0].telemetry_revision, null);
  assert.equal(sessions[0].stop_ts, null);
  const laps = await get(worker, env, "/sessions/ses_legacy/laps");
  assert.deepEqual(laps.map((lap) => [lap.lap_number, lap.is_complete]), [[1, null], [4, 0]]);
  const { max_speed_kmh, avg_speed_kmh, max_g_lat, max_g_brake } = laps[0];
  assert.deepEqual([max_speed_kmh, avg_speed_kmh, max_g_lat, max_g_brake], [50, 50, 0.5, 0.2]);
  const points = await get(worker, env, "/sessions/ses_legacy/telemetry");
  assert.deepEqual(points.map((point) => point.lap_number), [1, 4]);
  assert.equal((await get(worker, env, "/sessions/ses_legacy/live"))[0].lap_number, 4);
  assert.equal((await get(worker, env, "/laps/ses_legacy_lap_04/telemetry"))[0].lap_number, 4);

  db.exec(schema);
  assert.deepEqual(await get(worker, env, "/sessions"), sessions);
  assert.deepEqual(await get(worker, env, "/sessions/ses_legacy/laps"), laps);
});
