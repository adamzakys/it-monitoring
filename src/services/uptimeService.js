/**
 * UptimeService — 30-Day SLA Availability yang BERSUMBER data nyata.
 *
 * Latar belakang: tabel `daily_uptime` di PostgreSQL tidak pernah diisi oleh
 * proses apa pun, sehingga endpoint /api/kpi & /api/reports/sla jatuh ke
 * `generateFallbackTrendline()` (deret sine/cos buatan). Service ini mengisi
 * tabel tersebut dari measurement `ping` di InfluxDB (percent_packet_loss
 * per probe Telegraf), per hari kalender:
 *   - total_checks        = jumlah sampel ping hari itu (semua device)
 *   - successful_checks   = sampel dengan packet loss < 100 (device reachable)
 *   - uptime_percentage   = successful / total * 100
 *
 * Sinkronisasi lazy + cache 5 menit; dipanggil dari route /api/kpi dan
 * /api/reports/sla sebelum membaca tabel.
 */

const db = require('../db');
const influxService = require('./influxService');

let lastSyncAt = 0;
let syncPromise = null;
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 menit

/**
 * Aggregate ping probes from InfluxDB into one row per calendar day (UTC).
 * Returns [{ date: 'YYYY-MM-DD', total_checks, successful_checks, uptime_percentage }]
 * ordered oldest → newest. Days without any probe data are omitted.
 */
async function computeDailyAvailability(days = 31) {
  const { queryApi, bucket } = influxService.getClient();
  const rangeDays = Math.max(days, 2);

  // 1) Successful samples per day (packet loss < 100) — sample weighted.
  //    group() merges all device series so aggregateWindow sums across devices.
  const successFlux = `
    from(bucket: "${bucket}")
      |> range(start: -${rangeDays}d)
      |> filter(fn: (r) => r["_measurement"] == "ping" and r["_field"] == "percent_packet_loss")
      |> map(fn: (r) => ({ r with _value: if r._value < 100.0 then 1.0 else 0.0 }))
      |> group()
      |> aggregateWindow(every: 1d, fn: sum, createEmpty: false)
  `;

  // 2) Total probe samples per day.
  const totalFlux = `
    from(bucket: "${bucket}")
      |> range(start: -${rangeDays}d)
      |> filter(fn: (r) => r["_measurement"] == "ping" and r["_field"] == "percent_packet_loss")
      |> group()
      |> aggregateWindow(every: 1d, fn: count, createEmpty: false)
  `;

  const run = (flux) => new Promise((resolve, reject) => {
    const rows = [];
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true;
      if (err) reject(err); else resolve(rows);
    };
    queryApi.queryRows(flux, {
      next: (row, tableMeta) => {
        try {
          const o = tableMeta.toObject(row);
          rows.push({ day: new Date(o._time).toISOString().slice(0, 10), value: o._value });
        } catch (e) { /* skip row */ }
      },
      error: (e) => done(e),
      complete: () => done(null)
    });
    // safety timeout (avoid hanging route on slow/large 30d scan)
    setTimeout(() => done(new Error('influx aggregate timeout')), 45000);
  });

  const [successRows, totalRows] = await Promise.all([run(successFlux), run(totalFlux)]);
  const successByDay = new Map();
  for (const r of successRows) successByDay.set(r.day, (successByDay.get(r.day) || 0) + r.value);
  const totalByDay = new Map();
  for (const r of totalRows) totalByDay.set(r.day, (totalByDay.get(r.day) || 0) + r.value);

  const dayList = Array.from(new Set([...successByDay.keys(), ...totalByDay.keys()])).sort();
  const out = [];
  for (const day of dayList) {
    const total = Math.round(totalByDay.get(day) || 0);
    const success = Math.round(successByDay.get(day) || 0);
    if (total <= 0) continue;
    const pct = parseFloat(((success / total) * 100).toFixed(2));
    out.push({
      date: day,
      total_checks: total,
      successful_checks: success,
      uptime_percentage: pct
    });
  }
  return out;
}

/**
 * Sync real InfluxDB availability into daily_uptime (upsert per date).
 * Lazy + cache: call often is cheap; the heavy aggregate runs at most once
 * every SYNC_INTERVAL_MS. Safe no-op when PostgreSQL/InfluxDB unavailable.
 */
async function ensureDailyUptime() {
  if (!db.isPostgresConnected()) return { ok: false, reason: 'no postgres' };
  const now = Date.now();
  if (now - lastSyncAt < SYNC_INTERVAL_MS && syncPromise) {
    return syncPromise;
  }
  lastSyncAt = now;
  syncPromise = (async () => {
    try {
      const rows = await computeDailyAvailability(31);
      for (const r of rows) {
        await db.query(
          `INSERT INTO daily_uptime (date, total_checks, successful_checks, uptime_percentage)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (date) DO UPDATE SET
             total_checks = EXCLUDED.total_checks,
             successful_checks = EXCLUDED.successful_checks,
             uptime_percentage = EXCLUDED.uptime_percentage`,
          [r.date, r.total_checks, r.successful_checks, r.uptime_percentage]
        );
      }
      if (rows.length > 0) {
        console.log(`[UptimeService] daily_uptime synced from InfluxDB: ${rows.length} day(s) (${rows[0].date} .. ${rows[rows.length - 1].date})`);
      }
      return { ok: true, days: rows.length };
    } catch (err) {
      console.warn(`[UptimeService] daily uptime sync failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  })();
  return syncPromise;
}

module.exports = {
  ensureDailyUptime,
  computeDailyAvailability
};
