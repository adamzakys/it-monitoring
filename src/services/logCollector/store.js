/**
 * Log store — persistensi normalized device_logs (audit trail) + korelasi
 * log → Event. Raw SELALU disimpan walau rule tidak match (zero-loss).
 * Mode resilient: ring buffer in-memory saat PostgreSQL tidak tersedia.
 */
const db = require('../../db');
const eventLogger = require('../eventLogger');
const { evaluate } = require('./rules');

const RING_MAX = 1000;
let ring = [];
let ringSeq = 0;
const corrThrottle = new Map(); // deviceId:ruleId -> lastEmitAt
const CORR_THROTTLE_MS = 60 * 1000;

// Normalisasi nama: "Mikrotik vm" ↔ hostname syslog "Mikrotik_vm" / "mikrotik-vm".
function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Cache device (ip/hostname -> device) — refresh 30s.
let deviceCache = { at: 0, byIp: new Map(), byName: new Map() };
async function refreshDeviceCache(force = false) {
  const now = Date.now();
  if (!force && now - deviceCache.at < 30000) return deviceCache;
  const next = { at: now, byIp: new Map(), byName: new Map() };
  try {
    if (db.isPostgresConnected()) {
      const r = await db.query('SELECT id, name, ip_address FROM devices');
      for (const d of r.rows || []) {
        if (d.ip_address) next.byIp.set(d.ip_address, d);
        if (d.name) next.byName.set(normName(d.name), d);
      }
    } else {
      for (const d of db.getMemoryStore().devices) {
        if (d.ip_address) next.byIp.set(d.ip_address, d);
        if (d.name) next.byName.set(normName(d.name), d);
      }
    }
  } catch (e) { /* pakai cache lama */ }
  deviceCache = next;
  return deviceCache;
}

/** Petakan IP pengirim (dan hostname sbg cadangan) ke device terdaftar. */
async function resolveDevice(sourceIp, hostname) {
  const cache = await refreshDeviceCache();
  let dev = null;
  if (sourceIp) dev = cache.byIp.get(sourceIp) || null;
  if (!dev && hostname) {
    dev = cache.byName.get(normName(hostname)) ||
      cache.byName.get(String(hostname).toLowerCase()) || null;
  }
  return dev;
}

function toPublic(row) {
  return {
    id: row.id,
    deviceId: row.device_id ?? null,
    sourceIp: row.source_ip ?? null,
    sourceType: row.source_type || 'syslog',
    transport: row.transport || null,
    facility: row.facility || null,
    severity: row.severity || 'info',
    program: row.program || null,
    message: row.message || '',
    rawMessage: row.raw_message || null,
    correlatedEventType: row.correlated_event_type || null,
    correlatedAt: row.correlated_at || null,
    deviceTimestamp: row.device_timestamp || null,
    receivedAt: row.received_at || null
  };
}

/**
 * @param {object} n normalized dari normalizer + enrich:
 *   { deviceId, deviceName, sourceIp, sourceType, transport, facility,
 *     severity, program, message, raw, deviceTimestamp }
 */
async function insertLog(n) {
  const rec = {
    deviceId: n.deviceId ?? null,
    sourceIp: n.sourceIp || null,
    sourceType: n.sourceType || 'syslog',
    transport: n.transport || null,
    facility: n.facility || null,
    severity: n.severity || 'info',
    program: n.program || null,
    message: String(n.message || '').slice(0, 4000),
    rawMessage: String(n.raw || n.message || '').slice(0, 8192),
    deviceTimestamp: n.deviceTimestamp || n.device_timestamp || null
  };

  // LAPISAN 2 — korelasi: raw disimpan dulu, rule hanya menambah Event bila
  // match (di-throttle 60s per device+rule agar log berulang tidak spam).
  const rule = rec.deviceId ? evaluate(rec) : null;
  const nowIso = new Date().toISOString();
  if (rule) {
    const key = `${rec.deviceId}:${rule.id}`;
    const last = corrThrottle.get(key) || 0;
    if (Date.now() - last >= CORR_THROTTLE_MS) {
      corrThrottle.set(key, Date.now());
      try {
        await eventLogger.emitEvent(rec.deviceId, n.deviceName || null, rule.eventType, null, 'syslog');
        rec.correlatedEventType = rule.eventType;
        rec.correlatedAt = nowIso;
      } catch (e) {
        console.warn('[LogStore] correlation event failed:', e.message);
      }
    }
  }

  let pgId = null;
  if (db.isPostgresConnected()) {
    try {
      const r = await db.query(
        `INSERT INTO device_logs
           (device_id, source_ip, source_type, transport, facility, severity,
            program, message, raw_message, correlated_event_type, correlated_at, device_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [rec.deviceId, rec.sourceIp, rec.sourceType, rec.transport, rec.facility,
          rec.severity, rec.program, rec.message, rec.rawMessage,
          rec.correlatedEventType || null, rec.correlatedAt || null, rec.deviceTimestamp]
      );
      pgId = r.rows[0].id;
    } catch (e) {
      console.error('[LogStore] insert failed:', e.message);
    }
  }

  const entry = { id: pgId || (++ringSeq), receivedAt: nowIso, ...rec };
  ring.unshift(entry);
  if (ring.length > RING_MAX) ring.pop();
  return entry;
}

/** Log terbaru dulu (id DESC). `afterId` = id terbaru yg sudah dilihat → ambil lebih lama. */
async function getLogs(deviceId, limit = 200, afterId = 0) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const after = parseInt(afterId, 10) || 0;
  if (db.isPostgresConnected()) {
    try {
      const params = after > 0
        ? [deviceId, after, lim]
        : [deviceId, lim];
      const sql = after > 0
        ? `SELECT * FROM device_logs WHERE device_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3`
        : `SELECT * FROM device_logs WHERE device_id = $1 ORDER BY id DESC LIMIT $2`;
      const r = await db.query(sql, params);
      return r.rows.map(toPublic);
    } catch (e) {
      console.error('[LogStore] getLogs error:', e.message);
    }
  }
  return ring
    .filter(x => x.deviceId === deviceId && (after <= 0 || x.id < after))
    .slice(0, lim)
    .map(x => ({ ...x, receivedAt: x.receivedAt || new Date().toISOString() }));
}

async function cleanup(days = 7) {
  if (!db.isPostgresConnected()) return 0;
  try {
    const r = await db.query(`DELETE FROM device_logs WHERE received_at < NOW() - ($1 || ' days')::interval`, [days]);
    return r.rowCount || 0;
  } catch (e) {
    console.warn('[LogStore] cleanup error:', e.message);
    return 0;
  }
}

function status() {
  return { pg: db.isPostgresConnected(), ring: ring.length };
}

module.exports = { insertLog, getLogs, resolveDevice, cleanup, status };
