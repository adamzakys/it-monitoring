const express = require('express');
const router = express.Router();
const db = require('../db');
const telegrafManager = require('../services/telegrafManager');
const influxService = require('../services/influxService');
const streamService = require('../services/streamService');
const topologyDiscovery = require('../services/topologyDiscovery');
const uptimeService = require('../services/uptimeService');
const { isValidTarget, isValidPort, isValidCommunity, isValidOid } = require('../utils/validators');

// =============================================================
// SNMP Inventory Enrichment — isi vendor/model/routeros_version
// dari sysDescr (.1.3.6.1.2.1.1.1.0) bila kolom masih kosong.
// Best-effort: kalau device tidak merespons SNMP, dibiarkan null
// dan UI menampilkan "—". Hanya di-query SEKALI (ketika kolom
// kosong) — hasilnya di-cache ke tabel devices.
// =============================================================
const SYS_DESCR_OID = '.1.3.6.1.2.1.1.1.0';

function snmpGetSysDescr(device, timeoutMs = 2500) {
  const { spawn } = require('child_process');
  const ip = device.ip_address;
  const community = device.snmp_community || 'public';
  const port = device.snmp_port || 161;
  const version = device.snmp_version || '2c';

  if (!ip || !isValidTarget(ip) || !isValidCommunity(community) || !isValidPort(String(port))) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } resolve(null); }, timeoutMs);
    let stdout = '';
    const child = spawn(
      'snmpget',
      ['-v' + version, '-c', community, '-t', '2', '-r', '0', '-On', `${ip}:${port}`, SYS_DESCR_OID],
      { timeout: timeoutMs }
    );
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', () => {
      clearTimeout(t);
      if (!stdout.trim()) return resolve(null);
      const eqIdx = stdout.indexOf('=');
      let value = eqIdx >= 0 ? stdout.substring(eqIdx + 1).trim() : stdout.trim();
      // Strip tipe SNMP ("STRING: ...")
      const colonIdx = value.indexOf(': ');
      if (colonIdx >= 0) value = value.substring(colonIdx + 2).trim();
      value = value.replace(/^"+|"+$/g, '').trim();
      resolve(value || null);
    });
  });
}

/**
 * Parse sysDescr menjadi { vendor, model, routeros_version }.
 * Vendor-agnostik best-effort; return null per field bila tak dikenal.
 */
function parseSysDescr(sysDescr) {
  if (!sysDescr) return { vendor: null, model: null, routeros_version: null };
  const s = String(sysDescr);
  let vendor = null, model = null, version = null;

  // RouterOS: "RouterOS RB750Gr3" / "RouterOS x86" / "MikroTik RouterOS ..."
  const ros = s.match(/RouterOS(?:v[\d.]+)?\s+([\w\-.]+)/i);
  if (ros || /mikrotik/i.test(s)) {
    vendor = vendor || 'MikroTik';
    model = model || (ros ? ros[1] : null);
    const ver = s.match(/v(6\.\d+(?:\.\d+)?|7\.\d+(?:\.\d+)?)/i);
    if (ver) version = ver[1];
  }

  // Linux: "Linux <hostname> <kernel-version> ..." 
  const lx = s.match(/^Linux\s+\S+\s+([^\s]+)/i);
  if (lx) {
    vendor = vendor || 'Linux';
    version = version || lx[1];
  }

  // Cisco IOS / IOS-XE
  if (/Cisco IOS/i.test(s)) {
    vendor = vendor || 'Cisco';
    const ver = s.match(/Version\s+([\w.()]+)/i);
    if (ver) version = version || ver[1];
    const mod = s.match(/(C\d+[\w\-]+)/i);
    if (mod) model = model || mod[1];
  }

  // Ubiquiti / EdgeOS / UniFi
  if (/Ubiquiti|EdgeOS|UniFi/i.test(s)) {
    vendor = vendor || 'Ubiquiti';
  }

  // Fallback generik: vendor = kata pertama sebelum spasi
  if (!vendor) {
    const first = s.split(/[^A-Za-z0-9]+/).filter(Boolean)[0];
    if (first) vendor = first;
  }

  return { vendor, model, routeros_version: version };
}

async function enrichDeviceInventory(device) {
  // Kolom sudah terisi → lewati (cache).
  if (device.vendor && device.model) {
    return device;
  }
  const sysDescr = await snmpGetSysDescr(device);
  if (!sysDescr) return device;
  const parsed = parseSysDescr(sysDescr);
  const updates = {};
  if (!device.vendor && parsed.vendor) updates.vendor = parsed.vendor;
  if (!device.model && parsed.model) updates.model = parsed.model;
  if (!device.routeros_version && parsed.routeros_version) updates.routeros_version = parsed.routeros_version;

  if (Object.keys(updates).length > 0) {
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(`UPDATE devices SET ${sets} WHERE id = ?`,
      [...Object.values(updates), device.id]);
    console.log(`[Inventory] Device ${device.id} enriched: ${JSON.stringify(updates)}`);
    Object.assign(device, updates);
  }
  return device;
}

/**
 * pg DATE → 'YYYY-MM-DD' tanpa pergeseran zona waktu.
 * (pg mengembalikan DATE sebagai Date tengah malam waktu lokal server;
 *  serialisasi JSON biasa ke ISO UTC menggeser tanggal -/+ 1 hari.
 *  SQLite menyimpan date sebagai string 'YYYY-MM-DD' → kembalikan apa adanya.)
 */
function pgDateToStr(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dt = value instanceof Date ? value : new Date(value);
  if (isNaN(dt.getTime())) return String(value);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Attach validators onto the router object so `require('./routes/api')` still
// returns the router (backward compatible), but Phase 1 internal call sites
// can also reach the helpers via `router.isValidTarget`, etc.
router.isValidTarget = isValidTarget;
router.isValidPort = isValidPort;
router.isValidCommunity = isValidCommunity;
router.isValidOid = isValidOid;

/**
 * Phase 1: produce a safe, human-readable error string for API responses.
 * Rules:
 *  - Never include the raw `err.message` (it can contain SQL fragments,
 *    stack-trace hints, or user-derived data).
 *  - Always log the full error server-side for diagnostics.
 *  - Categorize by well-known DB / network errors to give a useful
 *    client-side hint without leaking internals.
 */
function safeError(err, fallback = 'Internal server error') {
  if (err) {
    // Server-side log: full diagnostic information.
    try { console.error('[API Error]', err && err.stack ? err.stack : err); } catch (e) { /* ignore */ }
  }
  if (!err) return fallback;
  const code = err.code || (err.cause && err.cause.code);
  switch (code) {
    case 'ECONNREFUSED': return 'Upstream service unavailable.';
    case 'ETIMEDOUT':    return 'Upstream service timed out.';
    case 'ENOTFOUND':    return 'Upstream host not found.';
    // PostgreSQL legacy codes (kompatibel lama)
    case '23505':        return 'Duplicate record.';
    case '23503':        return 'Referenced record not found.';
    case '23502':        return 'Required field missing.';
    case '22P02':        return 'Invalid input format.';
    // SQLite codes (better-sqlite3 — database aktual)
    case 'SQLITE_CONSTRAINT_PRIMARYKEY': return 'Duplicate record.';
    case 'SQLITE_CONSTRAINT_UNIQUE':     return 'Duplicate record.';
    case 'SQLITE_CONSTRAINT_FOREIGNKEY': return 'Referenced record not found.';
    case 'SQLITE_CONSTRAINT_NOTNULL':    return 'Required field missing.';
    case 'SQLITE_CONSTRAINT_CHECK':      return 'Value violates a check constraint.';
    case 'SQLITE_BUSY':                  return 'Database is busy. Try again.';
    case 'SQLITE_READONLY':              return 'Database is read-only.';
    case 'SQLITE_NOMEM':                 return 'Database ran out of memory.';
    default:             return fallback;
  }
}

// 1. KPI & Global Summary Endpoint
router.get('/kpi', async (req, res) => {
  try {
    const devRes = await db.query('SELECT * FROM devices ORDER BY sort_order ASC, id ASC');
    const devices = devRes.rows;

    const total = devices.length;
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const warning = devices.filter(d => d.status === 'warning').length;

    // SLA 30 hari RIIL: daily_uptime diisi dari InfluxDB ping oleh uptimeService
    let uptime30d = 100;
    let trendline = [];
    let dailyBreakdown = [];

    // Seed daily_uptime dari data ping InfluxDB (lazy, cache 5 menit)
    try {
      await uptimeService.ensureDailyUptime();
    } catch (e) {
      console.warn('[KPI] daily uptime sync failed:', e.message);
    }

    try {
      const upRes = await db.query(
        `SELECT date, uptime_percentage, total_checks, successful_checks FROM daily_uptime
         WHERE date >= date('now', '-30 days')
         ORDER BY date ASC`
      );
      // B6: FILL window 30 hari kalender penuh. Hari tanpa sampel ping
      // (Telegraf mati / belum ada data) ditandai pct=null — BUKAN di-skip.
      // Tanpa fill ini, sparkline memampatkan hari bolong sehingga dua hari
      // yang terpisah berminggu-minggu terlihat seperti bertetangga.
      const byDate = new Map();
      for (const r of upRes.rows) {
        byDate.set(String(r.date).slice(0, 10), r);
      }
      const filled = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const row = byDate.get(d);
        filled.push({
          date: d,
          pct: row ? parseFloat(row.uptime_percentage) : null,
          total_checks: row ? Math.round(row.total_checks) : 0,
          successful_checks: row ? Math.round(row.successful_checks) : 0
        });
      }
      dailyBreakdown = filled;
      // SLA 30d: rata-rata hanya hari yang punya data (hari tanpa sampel
      // tidak dihitung 0% maupun 100% — tidak tahu kondisi sebenarnya).
      const known = filled.filter(f => f.pct !== null);
      if (known.length > 0) {
        trendline = known.map(d => d.pct);
        const sum = known.reduce((acc, d) => acc + d.pct, 0);
        uptime30d = parseFloat((sum / known.length).toFixed(2));
      }
      if (dailyBreakdown.length === 0) {
        uptime30d = total === 0 ? 100 : parseFloat(((online / total) * 100).toFixed(2));
        trendline = [];
      }
    } catch (e) {
      uptime30d = total === 0 ? 100 : parseFloat(((online / total) * 100).toFixed(2));
      trendline = [];
    }

    res.json({
      success: true,
      uptime_30d: uptime30d,
      trendline,
      daily_breakdown: dailyBreakdown,
      sla_data_days: dailyBreakdown.filter(d => d.pct !== null).length,
      total_devices: total,
      online_count: online,
      offline_count: offline,
      warning_count: warning,
      db_connected: false, // SQLite mode
      last_updated: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// GET /api/uptime/days?days=30 — B6 fondasi Report dashboard:
// deret uptime harian yang DIISI penuh per kalender (pct=null = hari tanpa
// sampel), plus nama device-level opsional lewat ?device_id=.
router.get('/uptime/days', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const deviceId = req.query.device_id ? parseInt(req.query.device_id, 10) : null;

    const upRes = await db.query(
      `SELECT date, uptime_percentage, total_checks, successful_checks
         FROM daily_uptime WHERE date >= date('now', ?)
        ORDER BY date ASC`,
      [`-${days} days`]
    );
    const byDate = new Map();
    for (const r of upRes.rows) {
      byDate.set(String(r.date).slice(0, 10), r);
    }

    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = byDate.get(d);
      let pct = row ? parseFloat(row.uptime_percentage) : null;
      // Hari terisi selalu lebih ewe — clamp [0..100].
      if (pct !== null) pct = Math.max(0, Math.min(100, pct));
      series.push({
        date: d,
        pct,
        total_checks: row ? Math.round(row.total_checks) : 0,
        successful_checks: row ? Math.round(row.successful_checks) : 0
      });
    }

    const known = series.filter(s => s.pct !== null);
    const avg = known.length > 0
      ? parseFloat((known.reduce((acc, s) => acc + s.pct, 0) / known.length).toFixed(2))
      : null;

    res.json({
      success: true,
      window_days: days,
      device_id: deviceId, // di-reserve: per-device breakdown butuh data ping per device di InfluxDB
      data_days: known.length,
      avg_uptime: avg,
      days: series
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 2. Devices CRUD
router.get('/devices', async (req, res) => {
  try {
    const devRes = await db.query('SELECT * FROM devices ORDER BY sort_order ASC, id ASC');
    const devices = devRes.rows;

    const ifaceRes = await db.query('SELECT * FROM interfaces ORDER BY id ASC');
    const interfaces = ifaceRes.rows;

    // Attach interfaces to each device
    const enriched = devices.map(d => ({
      ...d,
      interfaces: interfaces.filter(i => i.device_id === d.id)
    }));

    res.json({ success: true, devices: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// Background job: sync interfaces for all devices from InfluxDB
// Called periodically and on-demand
async function syncAllDeviceInterfaces() {
  try {
    const devRes = await db.query('SELECT id, ip_address FROM devices');
    const devices = devRes.rows;

    for (const dev of devices) {
      const actualIfaces = await influxService.getDeviceInterfaces(dev.id, dev.ip_address);
      if (actualIfaces.length > 0) {
        // Delete default templates if we have real interfaces now (seed uses 'ether1', 'enp0s3')
        await db.query(
          `DELETE FROM interfaces WHERE device_id = ? AND (interface_name = 'ether1' OR interface_name = 'enp0s3')`,
          [dev.id]
        );
        // Insert actual interfaces
        for (const ifaceName of actualIfaces) {
          await db.query(
            `INSERT INTO interfaces (device_id, interface_name, status, speed_bps)
             VALUES (?, ?, 'up', 1000000000)
             ON CONFLICT(device_id, interface_name) DO NOTHING`,
            [dev.id, ifaceName]
          );
        }
      }
    }
    console.log('[InterfaceSync] Background sync completed for', devices.length, 'devices');
  } catch (err) {
    console.error('[InterfaceSync] Background sync error:', err.message);
  }
}

// Manual trigger endpoint for interface sync
router.post('/devices/sync-interfaces', async (req, res) => {
  // Run in background, don't block response
  syncAllDeviceInterfaces().catch(() => {});
  res.json({ success: true, message: 'Interface sync triggered in background' });
});

router.post('/devices', async (req, res) => {
  const { name, ip_address, device_type, snmp_community, snmp_version, snmp_port, polling_interval } = req.body;

  if (!name || !ip_address) {
    return res.status(400).json({ success: false, error: 'Name and IP address are required.' });
  }

  // Phase 1: validate IP/host/port/community at the route boundary so
  // no shell-quoted user input ever reaches Telegraf config generation.
  if (!router.isValidTarget(ip_address)) {
    return res.status(400).json({ success: false, error: 'Invalid IP address or hostname.' });
  }
  if (snmp_community !== undefined && snmp_community !== '' && !router.isValidCommunity(snmp_community)) {
    return res.status(400).json({ success: false, error: 'Invalid SNMP community string.' });
  }
  if (snmp_port !== undefined && snmp_port !== '' && !router.isValidPort(String(snmp_port))) {
    return res.status(400).json({ success: false, error: 'Invalid SNMP port.' });
  }

  try {
    let newDevice = null;
    const intervalVal = parseInt(polling_interval, 10) || 1;
    const portVal = parseInt(snmp_port, 10) || 161;

    // Immediate real ICMP ping (tidak nunggu Telegraf/InfluxDB)
    const pingResult = await realTimePingForAPI(ip_address);

    const result = await db.query(
      `INSERT INTO devices (name, ip_address, device_type, snmp_community, snmp_version, snmp_port, polling_interval, status, ping_latency, packet_loss, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [name, ip_address, device_type || 'router', snmp_community || 'public', snmp_version || '2c', portVal, intervalVal,
       pingResult.reachable ? 'online' : 'offline',
       pingResult.latency_ms, pingResult.packet_loss]
    );
    const newId = result.lastInsertRowid;
    const deviceRes = await db.query('SELECT * FROM devices WHERE id = ?', [newId]);
    newDevice = deviceRes.rows[0];

    // Auto-generate Telegraf config & reload
    const telegrafSync = telegrafManager.syncDeviceConfig(newDevice);

    // Trigger immediate topology discovery in background (don't await, don't block response)
    // This way the new device's LLDP/CDP neighbors are discovered within seconds
    if (topologyDiscovery && typeof topologyDiscovery.discoverTopology === 'function') {
      topologyDiscovery.discoverTopology().catch(e => {
        console.warn('[AddDevice] Background topology discovery error:', e.message);
      });
    }

    res.status(201).json({
      success: true,
      device: newDevice,
      telegraf: telegrafSync,
      ping_result: pingResult
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

/**
 * Helper: real-time ICMP ping untuk Add Device endpoint.
 * Mengembalikan { reachable, latency_ms, packet_loss } atau null jika gagal.
 * Phase 1: uses spawn() with an args array (no shell), and rejects targets
 * that fail the strict target validator.
 */
function realTimePingForAPI(ipAddress) {
  if (!router.isValidTarget(ipAddress)) {
    return Promise.resolve({ reachable: false, latency_ms: null, packet_loss: 100 });
  }
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    const child = spawn('ping', ['-c', '1', '-W', '2', ipAddress], { timeout: 2500 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', () => {
      resolve({ reachable: false, latency_ms: null, packet_loss: 100 });
    });
    child.on('close', (code) => {
      if (code !== 0 || !stdout) {
        resolve({ reachable: false, latency_ms: null, packet_loss: 100 });
        return;
      }
      const matchTime = stdout.match(/time=([0-9.]+)\s*ms/);
      const matchLoss = stdout.match(/([\d.]+)%\s*packet loss/);
      if (matchTime) {
        resolve({
          reachable: true,
          latency_ms: parseFloat(matchTime[1]),
          packet_loss: matchLoss ? parseFloat(matchLoss[1]) : 0
        });
      } else {
        resolve({ reachable: false, latency_ms: null, packet_loss: 100 });
      }
    });
  });
}

router.delete('/devices/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);

  try {
    await db.query('DELETE FROM devices WHERE id = ?', [id]);

    // Remove Telegraf config & reload
    telegrafManager.removeDeviceConfig(id);

    // Clear health tracker for deleted device (prevents memory leak)
    streamService.clearHealthTracker(id);

    res.json({ success: true, message: `Device ${id} deleted and Telegraf config removed.` });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ============================================================================
// Device Order & Presets — urutan tampilan device di Device Inventory
// ----------------------------------------------------------------------------
// Kolom `devices.sort_order` dihitung dari order array frontend (drag & drop).
// Preset disimpan di tabel `app_settings` (key = 'device_order_presets') sebagai
// JSON array [{ name, order: [deviceId,...], created_at }].
// ============================================================================

const PRESETS_KEY = 'device_order_presets';
const MAX_PRESETS = 20;

function sanitizePresetName(name) {
  const clean = String(name || '').trim().replace(/[^A-Za-z0-9 _\-.]/g, '').slice(0, 40);
  return clean;
}

/** Baca preset dari app_settings. Mengembalikan array (bisa kosong). */
function readPresets() {
  try {
    const r = db.query('SELECT value FROM app_settings WHERE key = ?', [PRESETS_KEY]);
    if (r.rows.length === 0) return [];
    const parsed = JSON.parse(r.rows[0].value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[DeviceOrder] readPresets error:', e.message);
    return [];
  }
}

function writePresets(presets) {
  try {
    db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      [PRESETS_KEY, JSON.stringify(presets)]
    );
  } catch (e) {
    console.warn('[DeviceOrder] writePresets error:', e.message);
    throw e;
  }
}

// POST /api/device-order — body: { order: [deviceId, ...] } → set sort_order 0..n
router.post('/device-order', async (req, res) => {
  const order = (req.body && Array.isArray(req.body.order)) ? req.body.order : null;
  if (!order) return res.status(400).json({ success: false, error: 'order array required' });

  // Sanitize: uniqui device id integer valid
  const seen = new Set();
  const ids = [];
  for (const raw of order) {
    const id = parseInt(raw, 10);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return res.status(400).json({ success: false, error: 'No valid device ids.' });

  try {
    db.transaction((d) => {
      const stmt = d.prepare('UPDATE devices SET sort_order = ? WHERE id = ?');
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i + 1, ids[i]);
      }
    });
    res.json({ success: true, message: `Device order updated (${ids.length} devices).` });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// GET /api/device-order/presets — daftar preset urutan yang disimpan
router.get('/device-order/presets', (req, res) => {
  const presets = readPresets();
  res.json({ success: true, presets });
});

// POST /api/device-order/presets — body: { name, order: [deviceId,...] } → save/replace preset
router.post('/device-order/presets', (req, res) => {
  const name = sanitizePresetName(req.body && req.body.name);
  const order = (req.body && Array.isArray(req.body.order)) ? req.body.order : null;
  if (!name) return res.status(400).json({ success: false, error: 'Preset name required.' });
  if (!order) return res.status(400).json({ success: false, error: 'order array required.' });

  const seen = new Set();
  const cleanOrder = [];
  for (const raw of order) {
    const id = parseInt(raw, 10);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cleanOrder.push(id);
  }
  if (cleanOrder.length === 0) return res.status(400).json({ success: false, error: 'No valid device ids.' });

  try {
    let presets = readPresets();
    const existing = presets.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.order = cleanOrder;
      existing.updated_at = new Date().toISOString();
    } else {
      presets.push({ name, order: cleanOrder, created_at: new Date().toISOString() });
    }
    // Limit: buang preset paling lama bila oversize
    if (presets.length > MAX_PRESETS) {
      presets = presets.slice(presets.length - MAX_PRESETS);
    }
    writePresets(presets);
    res.json({ success: true, message: `Preset "${name}" saved.`, presets });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// POST /api/device-order/presets/apply — body: { name } → apply preset sebagai urutan aktual
router.post('/device-order/presets/apply', async (req, res) => {
  const name = sanitizePresetName(req.body && req.body.name);
  if (!name) return res.status(400).json({ success: false, error: 'Preset name required.' });

  try {
    const presets = readPresets();
    const preset = presets.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!preset) return res.status(404).json({ success: false, error: 'Preset not found.' });

    const ids = preset.order;
    db.transaction((d) => {
      const stmt = d.prepare('UPDATE devices SET sort_order = ? WHERE id = ?');
      for (let i = 0; i < ids.length; i++) {
        stmt.run(i + 1, ids[i]);
      }
    });
    res.json({ success: true, message: `Preset "${preset.name}" applied.`, order: ids });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// DELETE /api/device-order/presets/:name — hapus preset
router.delete('/device-order/presets/:name', (req, res) => {
  const name = sanitizePresetName(req.params.name);
  if (!name) return res.status(400).json({ success: false, error: 'Preset name required.' });

  try {
    const presets = readPresets().filter(p => p.name.toLowerCase() !== name.toLowerCase());
    writePresets(presets);
    res.json({ success: true, message: `Preset "${name}" deleted.`, presets });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 2b. Update / Edit Device
router.put('/devices/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, ip_address, device_type, snmp_community, snmp_version, snmp_port, polling_interval } = req.body;

  if (!id) return res.status(400).json({ success: false, error: 'Invalid device id' });
  if (!name || !ip_address) {
    return res.status(400).json({ success: false, error: 'Name and IP address are required.' });
  }
  // Phase 1: same validation as POST.
  if (!router.isValidTarget(ip_address)) {
    return res.status(400).json({ success: false, error: 'Invalid IP address or hostname.' });
  }
  if (snmp_community !== undefined && snmp_community !== '' && !router.isValidCommunity(snmp_community)) {
    return res.status(400).json({ success: false, error: 'Invalid SNMP community string.' });
  }
  if (snmp_port !== undefined && snmp_port !== '' && !router.isValidPort(String(snmp_port))) {
    return res.status(400).json({ success: false, error: 'Invalid SNMP port.' });
  }

  try {
    let updatedDevice = null;
    const intervalVal = parseInt(polling_interval, 10) || 1;
    const portVal = parseInt(snmp_port, 10) || 161;

    const result = await db.query(
      `UPDATE devices
       SET name = ?, ip_address = ?, device_type = ?, snmp_community = ?,
           snmp_version = ?, snmp_port = ?, polling_interval = ?
       WHERE id = ? `,
      [name, ip_address, device_type || 'router', snmp_community || 'public',
       snmp_version || '2c', portVal, intervalVal, id]
    );
    const deviceRes = await db.query('SELECT * FROM devices WHERE id = ?', [id]);
    updatedDevice = deviceRes.rows[0];;
    if (!updatedDevice) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Regenerate Telegraf config dengan nilai baru → otomatis reload
    const telegrafSync = telegrafManager.syncDeviceConfig(updatedDevice);

    res.json({
      success: true,
      device: updatedDevice,
      telegraf: telegrafSync,
      message: `Device ${name} updated. Telegraf config regenerated.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3. Device Deep-Dive Endpoint (comprehensive per-device metrics)
router.get('/devices/:id/deep-dive', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid device id' });

  try {
    // 1. Hardware / inventory from PostgreSQL (or memory store)
    let device = null;
    const r = await db.query('SELECT * FROM devices WHERE id = ?', [id]);
    device = r.rows[0] || null;
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // 1b. Enrich inventory (vendor/model/routeros_version) dari sysDescr SNMP
    // bila masih kosong; hasil di-cache ke tabel devices. Dibungkus budget
    // agar SNMP lambat tidak menahan respons deep-dive.
    try {
      device = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(device), 3500);
        enrichDeviceInventory(device).then(d => { clearTimeout(t); resolve(d); }).catch(() => { clearTimeout(t); resolve(device); });
      });
    } catch (e) {
      // Best-effort — jangan menggagalkan deep-dive bila SNMP sysDescr gagal.
    }

    // 2. InfluxDB queries in parallel
    const [interfaces, latencyHist, lossHist, throughputRates, systemMetrics, errorCounters] = await Promise.all([
      influxService.getInterfaceDeepMetrics(id).catch(() => []),
      influxService.getLatencyHistory(id, 5).catch(() => []),
      influxService.getPacketLossHistory(id, 5).catch(() => []),
      influxService.getInterfaceThroughputRates(id, 5).catch(() => []),
      influxService.getSystemMetrics(id).catch(() => ({ has_data: false })),
      influxService.getInterfaceErrorCounters(id).catch(() => [])
    ]);

    // 2b. Some agents write net_interface rows without an interface_name tag;
    // they collapse into a single "unknown" entry which is useless for the
    // interface table/selector. Prefer the realtime SNMP walk (real names)
    // whenever InfluxDB only produced "unknown" interfaces.
    if (interfaces.length > 0 && interfaces.every(i => !i.interface_name || i.interface_name === 'unknown')) {
      interfaces.length = 0;
    }

    // 2c. Realtime fallbacks (SNMP walk / ICMP ping / system info) run only for
    // devices without InfluxDB data yet. They run in PARALLEL under a shared
    // budget so one slow/unreachable SNMP agent cannot hold the whole deep-dive
    // response for its full serial timeout (~4s+).
    const needIfaceFallback = interfaces.length === 0 && device && device.ip_address;
    const needPingFallback = latencyHist.length === 0 && device && device.ip_address;
    const needSysFallback = device && device.ip_address && (
      systemMetrics.sys_uptime_ticks == null ||
      systemMetrics.cpu_load_pct == null ||
      systemMetrics.memory_total == null ||
      systemMetrics.storage_entries.length === 0
    );

    const withBudget = (p, ms) => new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      Promise.resolve(p)
        .then((v) => { clearTimeout(t); resolve(v); })
        .catch(() => { clearTimeout(t); resolve(null); });
    });

    const [realtimeIfaces, ping, realtimeSys] = await Promise.all([
      needIfaceFallback ? withBudget(streamService.getRealTimeInterfaces(device), 2500) : Promise.resolve(null),
      needPingFallback ? withBudget(streamService.realTimePing(device.ip_address), 2500) : Promise.resolve(null),
      needSysFallback ? withBudget(streamService.getRealTimeSystemInfo(device), 2500) : Promise.resolve(null)
    ]);

    let realtimeFallback = false;
    if (realtimeIfaces && realtimeIfaces.length > 0) {
      interfaces.push(...realtimeIfaces.map(i => ({
        interface_name: i.interface_name,
        oper_status: i.oper_status,
        speed_mbps: i.speed_mbps,
        bytes_in: i.bytes_in,
        bytes_out: i.bytes_out,
        source: 'realtime-snmp'
      })));
      realtimeFallback = true;
      console.log(`[DeepDive] Device ${id}: using realtime SNMP for ${realtimeIfaces.length} interfaces (no InfluxDB data yet)`);
    }

    // Also fall back for latency/loss if no InfluxDB data (single ping → ±30 pts)
    let realtimeLatencyHist = [];
    let realtimeLossHist = [];
    if (ping && ping.reachable) {
      const now = new Date();
      realtimeLatencyHist = Array.from({ length: 30 }, (_, i) => {
        const t = new Date(now.getTime() - (29 - i) * 5000);
        return { time: t.toISOString(), min: ping.latency_ms, avg: ping.latency_ms, max: ping.latency_ms, jitter: 0 };
      });
      realtimeLossHist = Array.from({ length: 30 }, (_, i) => {
        const t = new Date(now.getTime() - (29 - i) * 5000);
        return { time: t.toISOString(), value: ping.packet_loss || 0 };
      });
    }

    // 3. System resources — gabung per-metrik: InfluxDB (riwayat 60s telegraf)
    // primer; SNMP realtime hanya melengkapi metrik yang belum ada di Influx.
    // Nilai apa pun yang tampil berasal dari salah satu sumber nyata tsb.
    const rtSys = (realtimeSys && realtimeSys.has_data) ? realtimeSys : null;
    const pick = (influxVal, rtVal) => {
      if (influxVal !== null && influxVal !== undefined) return { value: influxVal, source: 'influx' };
      if (rtVal !== null && rtVal !== undefined) return { value: rtVal, source: 'snmp' };
      return null;
    };

    const uptime = pick(systemMetrics.sys_uptime_ticks, rtSys ? rtSys.sys_uptime_ticks : null);
    const cpu = pick(systemMetrics.cpu_load_pct, rtSys ? rtSys.cpu_load_pct : null);

    // Storage/memory (unit hrStorage: jumlah unit × alloc_units = bytes).
    // Satu entri mewakili satu BARIS hrStorageTable. Diklasifikasi per baris
    // (storage_type tidak unik) supaya mount filesystem tidak tercampur dengan
    // pseudo-memory, "Virtual memory", dan "Swap space".
    const influxStorageRaw = (systemMetrics.storage_entries || []).filter(e => (e.alloc_units || 0) > 0);
    const rtStorageRaw = ((rtSys && rtSys.storage_entries) || []).filter(e => (e.alloc_units || 0) > 0);
    const storageRaw = influxStorageRaw.length > 0 ? influxStorageRaw : rtStorageRaw;
    const storageSource = influxStorageRaw.length > 0 ? 'influx' : (rtStorageRaw.length > 0 ? 'snmp' : null);
    const toBytes = (e) => ({
      descr: e.descr || '', storage_type: e.storage_type || '',
      total_bytes: (e.size || 0) * e.alloc_units,
      used_bytes: (e.used || 0) * e.alloc_units
    });
    const storageEntriesBytes = storageRaw.map(toBytes);
    const roleOf = influxService.classifyHrStorageEntry;
    const pctOf = (used, total) => total > 0 ? parseFloat(((used / total) * 100).toFixed(1)) : 0;

    // Memory runtime: total = memori fisik, used = MemTotal - MemAvailable
    // (lihat influxService.computeHrStorageMemory). Tidak memakai field
    // Cached/Buffers/Shared dan tidak menjumlahkannya.
    const memoryEntry = storageEntriesBytes.find(e => roleOf(e) === 'memory');
    const availableEntry = storageEntriesBytes.find(e => roleOf(e) === 'memory_available');
    let memory = null;
    if (memoryEntry && memoryEntry.total_bytes > 0) {
      const totalBytes = memoryEntry.total_bytes;
      const availBytes = availableEntry
        ? (availableEntry.total_bytes > 0 ? availableEntry.total_bytes : availableEntry.used_bytes)
        : null;
      const usedBytes = availBytes != null
        ? Math.max(0, totalBytes - availBytes)
        : memoryEntry.used_bytes;
      memory = {
        supported: true,
        source: storageSource,
        total_bytes: totalBytes,
        used_bytes: usedBytes,
        used_percent: pctOf(usedBytes, totalBytes),
        // legacy alias — dikonsumsi UI saat ini
        pct: pctOf(usedBytes, totalBytes)
      };
    }

    // Storage = mount filesystem nyata saja. "/" = Primary Storage.
    // Dikecualikan:
    //  - Mount internal systemd (/run/credentials/*) — unit ephemeral 256 KiB.
    //  - Pseudo/tmpfs filesystem (devtmpfs, tmpfs, ramfs, shm, run/lock,
    //    /run/user/*) — bukan storage persisten; hanya menimbulkan deretan
    //    baris yang tampak seperti disk penuh padahal bukan.
    //  - /proc, /sys, /dev, /run, /tmp — virtual kernel & tmpfs.
    const PSEUDO_FS = /(^|\/)(dev|proc|sys|tmp|shm|lock|run|var\/run|credentials|snap\/)(\/|$)|(^|\/)(devtmpfs|tmpfs|ramfs|overlay|proc|sysfs|cgroup|securityfs|debugfs|tracefs|pstore|bpf|configfs|fusectl|hugetlbfs|mqueue|nsfs)(\/|$)/i;
    const mountEntries = storageEntriesBytes
      .filter(e => roleOf(e) === 'mount' && e.total_bytes > 0
        && !PSEUDO_FS.test(e.descr)
        && !/^\/run\/credentials(\/|$)/.test(e.descr))
      .sort((a, b) => (a.descr === '/' ? -1 : b.descr === '/' ? 1 : a.descr.localeCompare(b.descr)));

    const swapEntry = storageEntriesBytes.find(e => roleOf(e) === 'swap');
    const swap = (swapEntry && swapEntry.total_bytes > 0)
      ? {
          supported: true, source: storageSource,
          total_bytes: swapEntry.total_bytes, used_bytes: swapEntry.used_bytes,
          used_percent: pctOf(swapEntry.used_bytes, swapEntry.total_bytes)
        }
      : { supported: false, reason: 'Perangkat tidak melaporkan swap via hrStorage (HOST-RESOURCES)', source: null };

    // hrStorageVirtualMemory = RAM + swap. Bukan storage, hanya diekspos
    // sebagai konteks (bukan kartu "Storage — Virtual memory").
    const virtualEntry = storageEntriesBytes.find(e => roleOf(e) === 'virtual_memory');
    const virtualMemory = (virtualEntry && virtualEntry.total_bytes > 0)
      ? {
          total_bytes: virtualEntry.total_bytes, used_bytes: virtualEntry.used_bytes,
          used_percent: pctOf(virtualEntry.used_bytes, virtualEntry.total_bytes)
        }
      : null;

    // sys_uptime_human — kompatibel dgn konsumen lama.
    let sysUptimeHuman = null;
    if (uptime && uptime.value) {
      const totalSec = Math.floor(uptime.value / 100);
      const days = Math.floor(totalSec / 86400);
      const hours = Math.floor((totalSec % 86400) / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      sysUptimeHuman = `${days}d ${hours}h ${mins}m`;
    }

    const canSnmp = !!(device && device.ip_address && device.snmp_community);
    const noDataReason = canSnmp
      ? 'Perangkat tidak merespons atau tidak menyediakan metrik ini via SNMP/InfluxDB'
      : 'Perangkat tidak dikonfigurasi SNMP dan belum ada riwayat InfluxDB';
    const metric = (sel, label, reason = null) => sel
      ? { supported: true, source: sel.source, ...(label && { value: sel.value }) }
      : { supported: false, reason: reason || noDataReason, source: null };

    const system = {
      has_data: !!(uptime || cpu || memory || mountEntries.length > 0 || systemMetrics.has_data),
      source: systemMetrics.sys_uptime_ticks != null || systemMetrics.cpu_load_pct != null || influxStorageRaw.length > 0
        ? 'influx'
        : (rtSys ? 'snmp' : null),
      updated_at: systemMetrics.fetched_at || (rtSys && rtSys.fetched_at) || new Date().toISOString(),
      // Legacy (backward-compat): tetap diekspos untuk konsumen lama
      // (storage_entries dalam satuan hrStorage: alloc_units/size/used).
      sys_uptime_ticks: uptime ? uptime.value : null,
      sys_uptime_human: sysUptimeHuman,
      cpu_load_pct: cpu ? cpu.value : null,
      storage_entries: storageRaw,
      // Struktur baru (vendor-agnostic): tiap metrik { supported, value, source }.
      uptime: metric(uptime),
      cpu_load_pct: metric(cpu, true, 'CPU load tidak tersedia (tidak ada hrProcessorLoad/telegraf)'),
      memory: memory || { supported: false, reason: noDataReason, source: null },
      // Storage = mount filesystem nyata; "/" sebagai Primary Storage.
      storage: mountEntries.length > 0
        ? {
            supported: true, source: storageSource,
            primary: mountEntries.find(e => e.descr === '/') || mountEntries[0],
            entries: mountEntries
          }
        : { supported: false, reason: 'Perangkat tidak melaporkan filesystem via hrStorage (HOST-RESOURCES)', source: null },
      // Swap dipisah dari Storage (hrStorageVirtualMemory), bukan kartu storage.
      swap,
      virtual_memory: virtualMemory,
      temperature_c: { supported: false, reason: 'Sensor suhu tidak dilaporkan perangkat via SNMP (HOST-RESOURCES/health kosong)', source: null },
      battery: { supported: false, reason: 'Perangkat tidak melaporkan baterai/UPS (UPS-MIB tidak tersedia)', source: null },
      unsupported: []
    };
    system.unsupported = ['temperature_c', 'battery']
      .filter(k => system[k] && system[k].supported === false);

    // 4. Format latency stats summary
    // Use real-time ping data if InfluxDB is empty
    const effectiveLatencyHist = latencyHist.length > 0 ? latencyHist : realtimeLatencyHist;
    let latencySummary = { avg: 0, min: 0, max: 0, jitter: 0, samples: 0 };
    if (effectiveLatencyHist.length > 0) {
      latencySummary.samples = effectiveLatencyHist.length;
      latencySummary.avg = parseFloat((effectiveLatencyHist.reduce((s, p) => s + p.avg, 0) / effectiveLatencyHist.length).toFixed(2));
      latencySummary.min = parseFloat(Math.min(...effectiveLatencyHist.map(p => p.min)).toFixed(2));
      latencySummary.max = parseFloat(Math.max(...effectiveLatencyHist.map(p => p.max)).toFixed(2));
      latencySummary.jitter = parseFloat((effectiveLatencyHist.reduce((s, p) => s + p.jitter, 0) / effectiveLatencyHist.length).toFixed(2));
    }

    // 5. Packet loss summary (fallback to realtime if InfluxDB empty)
    const effectiveLossHist = lossHist.length > 0 ? lossHist : realtimeLossHist;
    let lossSummary = { avg: 0, max: 0, samples: 0 };
    if (effectiveLossHist.length > 0) {
      lossSummary.samples = effectiveLossHist.length;
      lossSummary.avg = parseFloat((effectiveLossHist.reduce((s, p) => s + p.value, 0) / effectiveLossHist.length).toFixed(3));
      lossSummary.max = parseFloat(Math.max(...effectiveLossHist.map(p => p.value)).toFixed(2));
    }

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      device: {
        id: device.id,
        name: device.name,
        ip_address: device.ip_address,
        device_type: device.device_type,
        snmp_community: device.snmp_community,
        snmp_version: device.snmp_version,
        snmp_port: device.snmp_port,
        polling_interval: device.polling_interval,
        status: device.status,
        last_seen: device.last_seen,
        created_at: device.created_at,
        // Inventory fields are optional — the devices table may not have these
        // columns yet, so pass through whatever the row exposes (UI renders "—").
        vendor: device.vendor ?? null,
        model: device.model ?? null,
        routeros_version: device.routeros_version ?? null
      },
      interfaces,
      interface_rates: throughputRates,
      error_counters: errorCounters,
      latency_history: effectiveLatencyHist,
      latency_summary: latencySummary,
      loss_history: effectiveLossHist,
      loss_summary: lossSummary,
      data_source: realtimeFallback ? 'realtime-snmp' : 'influxdb',
      system
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ============================================================================
// Configuration Readiness Advisor — Pre-flight diagnostics per device
// Returns: checks (5 layers), gaps, dynamic command recommendations
// ============================================================================
router.get('/devices/:id/readiness', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid device id' });

  try {
    const profiler = require('../services/profiler');
    const result = await profiler.getReadiness(id);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error || 'Device not found' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ============================================================================
// Syslog Forwarding — status + verifikasi aktif
// ----------------------------------------------------------------------------
// Syslog push & event-driven: "ada log historis" bukan bukti konfigurasi masih
// aktif. /syslog-status memakai jendela pendek; /syslog-verify menunggu log
// BARU setelah cursor → user menjalankan `/log warning "BMS-TEST"` di device.
// ============================================================================
router.get('/devices/:id/syslog-status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid device id' });

  try {
    const r = await db.query('SELECT * FROM devices WHERE id = ?', [id]);
    const device = r.rows[0] || null;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const profiler = require('../services/profiler');
    const logStore = require('../services/logCollector/store');
    const check = await profiler.checkSyslog(device);
    const cursorId = await logStore.getLatestLogId(id);

    res.json({
      success: true,
      device_id: id,
      check,
      cursorId,
      server_time: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

router.get('/devices/:id/syslog-verify', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid device id' });

  const sinceId = parseInt(req.query.sinceId, 10) || 0;
  const timeout = Math.min(Math.max(parseInt(req.query.timeout, 10) || 45000, 1000), 60000);

  try {
    const logStore = require('../services/logCollector/store');
    const log = await logStore.watchForNewLog(id, sinceId, timeout);
    res.json({
      success: true,
      received: !!log,
      log: log || null,
      since_id: sinceId,
      waited_ms: timeout
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3a2. Device Logs — audit trail normalized (syslog/SNMP trap), terbaru dulu.
router.get('/devices/:id/logs', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid device id' });
  try {
    const logStore = require('../services/logCollector/store');
    const limit = parseInt(req.query.limit, 10) || 200;
    const after = parseInt(req.query.after, 10) || 0;
    const logs = await logStore.getLogs(id, limit, after);
    res.json({ success: true, device_id: id, logs, source: 'device_logs' });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ============================================================================
// 3a3. BMS Threat Timeline — sesi korelasi log
// ----------------------------------------------------------------------------
// Mengembalikan incident (sesi korelasi) + event individual yang tidak memiliki
// rule (fallback), sehingga tidak ada event yang hilang dari tampilan.
// Poros waktu = received_at (jam server); device_timestamp tetap dikirim dan
// selisihnya tersedia sebagai clockDriftMs.
// ============================================================================
router.get('/devices/:id/threat-timeline', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid device id' });
  try {
    const threatTimeline = require('../services/threatTimeline');
    const includeResolved = String(req.query.includeResolved || '') === 'true';
    const incidentLimit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const looseLimit = Math.min(Math.max(parseInt(req.query.looseLimit, 10) || 50, 0), 200);

    const data = await threatTimeline.getTimelineForDevice(id, {
      includeResolved,
      incidentLimit,
      looseLimit
    });

    res.json({
      success: true,
      device_id: id,
      source: data.source,
      time_axis: 'received_at',
      incident_count: data.incidents.length,
      loose_count: data.looseEvents.length,
      incidents: data.incidents,
      loose_events: data.looseEvents,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3a4. Detail satu threat incident + seluruh event kronologisnya.
router.get('/threat-incidents/:key', async (req, res) => {
  try {
    const threatTimeline = require('../services/threatTimeline');
    const incident = await threatTimeline.getIncident(req.params.key);
    if (!incident) {
      return res.status(404).json({ success: false, error: 'Threat incident not found' });
    }
    res.json({ success: true, incident, event_count: incident.events.length });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3a5. Acknowledge incident (Open → Acknowledged).
router.post('/threat-incidents/:key/ack', async (req, res) => {
  try {
    const threatTimeline = require('../services/threatTimeline');
    const by = (req.body && req.body.by) || req.headers['x-operator'] || 'operator';
    const incident = await threatTimeline.ack(req.params.key, by);
    if (!incident) {
      return res.status(404).json({ success: false, error: 'Threat incident not found or already handled' });
    }
    res.json({ success: true, incident });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3a6. Status engine threat + statistik pembuangan log (observabilitas).
router.get('/threat/status', async (req, res) => {
  try {
    const threatTimeline = require('../services/threatTimeline');
    const syslogSource = require('../services/logCollector/sources/syslog');
    const data = await threatTimeline.status();
    res.json({
      success: true,
      ...data,
      syslog_dropped: typeof syslogSource.droppedStats === 'function' ? syslogSource.droppedStats() : null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3b. Per-interface throughput history (5m sliding, 5s resolution)
router.get('/devices/:id/interface-history', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const interfaceName = req.query.interface;
  const minutes = parseInt(req.query.minutes || '5', 10);
  if (!id || !interfaceName) {
    return res.status(400).json({ success: false, error: 'id and interface required' });
  }
  try {
    const data = await influxService.getInterfaceThroughputHistory(id, interfaceName, minutes);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3b2. Real-time interface list via direct SNMP walk (bypasses InfluxDB)
router.get('/devices/:id/interfaces-realtime', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: 'id required' });
  try {
    const r = await db.query('SELECT * FROM devices WHERE id = ?', [id]);
    const device = r.rows[0];
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const interfaces = await streamService.getRealTimeInterfaces(device);
    res.json({
      success: true,
      source: 'snmpwalk',
      device_id: id,
      interfaces
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3a. Regenerate ALL Telegraf configs + cleanup orphans (untuk sinkronisasi total)
router.post('/telegraf/regenerate-all', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM devices ORDER BY id ASC');
    const devices = r.rows;

    // Cleanup orphan configs (device_X.conf dimana X tidak ada di DB)
    const activeIds = devices.map(d => d.id);
    const removedCount = telegrafManager.cleanupOrphanConfigs(activeIds);

    // Regenerate semua config
    const results = telegrafManager.regenerateAllConfigs(devices);

    res.json({
      success: true,
      message: `Regenerated ${results.length} Telegraf configs, removed ${removedCount} orphan(s).`,
      generated: results,
      orphans_removed: removedCount,
      telegraf_pids: (() => {
        const { execSync } = require('child_process');
        try {
          return execSync('pgrep -f "telegraf --config-directory"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        } catch (e) { return []; }
      })()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 3c. Telegraf agent status check
router.get('/telegraf/status', (req, res) => {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  let pids = [];
  let realPid = null;
  let isRunning = false;
  let lastLogLines = [];

  try {
    pids = execSync('pgrep -f "telegraf --config-directory"', { encoding: 'utf8', timeout: 2000 })
      .trim().split('\n').filter(Boolean);
    for (const p of pids) {
      try {
        const comm = fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim();
        if (comm === 'telegraf') {
          realPid = parseInt(p, 10);
          isRunning = true;
          break;
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* no process */ }

  // Tail log untuk info error terakhir
  const logFile = '/tmp/telegraf.log';
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > 0) {
      const buf = Buffer.alloc(Math.min(stat.size, 4096));
      const fd = fs.openSync(logFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, stat.size - buf.length);
      fs.closeSync(fd);
      lastLogLines = buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-8);
    }
  } catch (e) { /* no log */ }

  // List config files
  const confDir = process.env.TELEGRAF_CONF_DIR || './telegraf.d';
  let configFiles = [];
  try {
    const resolved = path.resolve(confDir);
    configFiles = fs.readdirSync(resolved)
      .filter(f => f.endsWith('.conf'))
      .map(f => {
        const stat = fs.statSync(path.join(resolved, f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      });
  } catch (e) { /* no conf dir */ }

  res.json({
    success: true,
    is_running: isRunning,
    real_pid: realPid,
    all_pids: pids.map(p => parseInt(p, 10)),
    config_dir: confDir,
    config_files: configFiles,
    last_log: lastLogLines,
    hint: isRunning
      ? 'Telegraf agent running. Data akan masuk ke InfluxDB dalam beberapa detik.'
      : 'Telegraf TIDAK berjalan. Jalankan: cd /home/urzection/Documents/it-monitoring && ./scripts/restart-telegraf.sh'
  });
});

// 3. Test Connection Endpoint (REAL Immediate Ping & SNMP probe)
router.post('/devices/test-connection', async (req, res) => {
  const { ip_address } = req.body;
  if (!ip_address) {
    return res.status(400).json({ success: false, message: 'IP address required' });
  }
  // Phase 1: reject malformed targets at the boundary.
  if (!router.isValidTarget(ip_address)) {
    return res.status(400).json({ success: false, message: 'Invalid IP address or hostname.' });
  }

  const { spawn } = require('child_process');
  const dgram = require('dgram');

  // Real ICMP ping (Phase 1: spawn with args array, no shell)
  const pingChild = spawn('ping', ['-c', '1', '-W', '1', ip_address], { timeout: 2500 });
  let pingStdout = '';
  pingChild.stdout.on('data', (chunk) => { pingStdout += chunk.toString(); });
  pingChild.on('error', () => { /* fall through to default pingResult */ });
  pingChild.on('close', () => {
    let pingResult = { status: 'TIMEOUT', latency_ms: '0.00', loss: '100%' };
    if (pingStdout) {
      const matchTime = pingStdout.match(/time=([0-9.]+)\s*ms/);
      if (matchTime) {
        pingResult = { status: 'OK', latency_ms: matchTime[1], loss: '0%' };
      }
    }

    // Real SNMP UDP probe (sysDescr 1.3.6.1.2.1.1.1.0)
    const client = dgram.createSocket('udp4');
    const snmpPacket = Buffer.from([
      0x30, 0x29, 0x02, 0x01, 0x01, 0x04, 0x06, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63,
      0xa0, 0x1c, 0x02, 0x04, 0x01, 0x02, 0x03, 0x04, 0x02, 0x01, 0x00, 0x02, 0x01,
      0x00, 0x30, 0x0e, 0x30, 0x0c, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01,
      0x01, 0x00, 0x05, 0x00
    ]);

    let responded = false;
    client.on('message', (msg) => {
      responded = true;
      client.close();
      const raw = msg.toString('binary');
      // Clean readable text
      const cleanDescr = raw.replace(/[^\x20-\x7E]/g, ' ').trim().slice(-60);
      res.json({
        success: true,
        ping: pingResult,
        snmp: {
          status: 'OK',
          sysDescr: cleanDescr || 'SNMP v2c Agent OK'
        }
      });
    });

    client.send(snmpPacket, 161, ip_address, () => {
      setTimeout(() => {
        if (!responded) {
          try { client.close(); } catch (e) {}
          res.json({
            success: pingResult.status === 'OK',
            ping: pingResult,
            snmp: {
              status: 'TIMEOUT',
              sysDescr: 'No SNMP response on port 161'
            }
          });
        }
      }, 1000);
    });
  });
});

// 4b. Incidents
router.get('/incidents', async (req, res) => {
  try {
    const incidentManager = require('../services/incidentManager');
    const active = await incidentManager.getAllActiveIncidents();
    const history = await incidentManager.getIncidentHistory(50);
    const archived = await incidentManager.getArchivedIncidents(100);
    res.json({ success: true, active, history, archived });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// POST /api/incidents/:id/archive — sembunyikan insiden dari live feed
// (mode maintenance). Notifikasi berhenti mengganggu, engine tetap melacak
// hingga device pulih (auto-unarchive saat resolved).
router.post('/incidents/:id/archive', async (req, res) => {
  try {
    const incidentManager = require('../services/incidentManager');
    const note = (req.body && typeof req.body.note === 'string') ? req.body.note : null;
    const incident = await incidentManager.archiveIncident(req.params.id, { note, by: 'operator' });
    if (!incident) {
      return res.status(404).json({ success: false, error: 'Incident not found' });
    }
    res.json({ success: true, message: 'Insiden diarsipkan (mode maintenance)', incident });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// POST /api/incidents/:id/unarchive — kembalikan insiden ke live feed.
router.post('/incidents/:id/unarchive', async (req, res) => {
  try {
    const incidentManager = require('../services/incidentManager');
    const incident = await incidentManager.unarchiveIncident(req.params.id);
    if (!incident) {
      return res.status(404).json({ success: false, error: 'Incident not found' });
    }
    res.json({ success: true, message: 'Insiden dikembalikan ke live feed', incident });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

router.get('/incidents/:id', async (req, res) => {
  try {
    const incidentManager = require('../services/incidentManager');
    const allActive = await incidentManager.getAllActiveIncidents();
    const incident = allActive.find(i => i.incidentId === req.params.id);
    if (incident) {
      return res.json({ success: true, incident });
    }
    const history = await incidentManager.getIncidentHistory(100);
    const historical = history.find(i => i.incidentId === req.params.id);
    if (historical) {
      return res.json({ success: true, incident: historical });
    }
    res.status(404).json({ success: false, error: 'Incident not found' });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 4. Alerts
router.get('/alerts', async (req, res) => {
  try {
    const alertRes = await db.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50');
    const alerts = alertRes.rows;
    res.json({ success: true, alerts });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 4c. Activity Events
router.get('/events', async (req, res) => {
  try {
    const { deviceId, severity, eventType, limit = 100, offset = 0 } = req.query;
    const queryParts = ['SELECT * FROM events WHERE 1=1'];
    const params = [];

    if (deviceId) {
      queryParts.push(` AND device_id = ?`);
      params.push(parseInt(deviceId, 10));
    }
    if (severity && severity !== 'all') {
      queryParts.push(` AND severity = ?`);
      params.push(severity);
    }
    if (eventType && eventType !== 'all') {
      queryParts.push(` AND event_type = ?`);
      params.push(eventType);
    }

    queryParts.push(` ORDER BY timestamp DESC LIMIT ? OFFSET ?`);
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const eventRes = await db.query(queryParts.join(''), params);
    const events = eventRes.rows;
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 4b. Live Feed Snapshot - data live aktual (devices, alerts, ws, throughput aggregate)
router.get('/live-feed', async (req, res) => {
  try {
    const devRes = await db.query('SELECT id, name, ip_address, status, ping_latency, packet_loss, last_seen FROM devices ORDER BY id ASC');
    const devices = devRes.rows;
    const aRes = await db.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10');
    const alerts = aRes.rows;

    const total = devices.length;
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const warning = devices.filter(d => d.status === 'warning').length;
    const avgLatency = total === 0 ? 0
      : parseFloat((devices.reduce((s, d) => s + (parseFloat(d.ping_latency) || 0), 0) / total).toFixed(2));
    const avgLoss = total === 0 ? 0
      : parseFloat((devices.reduce((s, d) => s + (parseFloat(d.packet_loss) || 0), 0) / total).toFixed(2));

    res.json({
      success: true,
      server_time: new Date().toISOString(),
      total,
      online,
      warning,
      offline,
      avg_latency_ms: avgLatency,
      avg_packet_loss: avgLoss,
      active_alerts: alerts.filter(a => a.status === 'active').length,
      devices,
      recent_alerts: alerts
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 4c. Reports - SLA & agregat 30 hari (data riil dari daily_uptime + InfluxDB)
router.get('/reports/sla', async (req, res) => {
  try {
    // Rentang fleksibel (Report SLA upgrade): ?days=7|14|30|90+ selain 30.
    const windowDays = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

    // Seed daily_uptime dari data ping InfluxDB sebelum membaca tabel
    try {
      await uptimeService.ensureDailyUptime();
    } catch (e) {
      console.warn('[Reports] daily uptime sync failed:', e.message);
    }

    let daily = [];
    try {
      const r = await db.query(
        `SELECT date, total_checks, successful_checks, uptime_percentage
         FROM daily_uptime
         WHERE date >= date('now', ?)
         ORDER BY date ASC`,
        [`-${windowDays} days`]
      );
      daily = r.rows.map(row => ({
        date: pgDateToStr(row.date),
        total_checks: parseInt(row.total_checks, 10) || 0,
        successful_checks: parseInt(row.successful_checks, 10) || 0,
        uptime_percentage: parseFloat(row.uptime_percentage)
      }));
    } catch (e) {
      daily = [];
    }

    // Fill window kalender penuh (pola B6): hari tanpa sampel = pct null,
    // sehingga grafik tidak memampatkan hari bolong menjadi bertetangga.
    const byDate = new Map(daily.map(d => [d.date, d]));
    const filled = [];
    for (let i = windowDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = byDate.get(d);
      filled.push(row || {
        date: d,
        total_checks: 0,
        successful_checks: 0,
        uptime_percentage: null
      });
    }

    // SLA rentang: rata-rata hanya hari yang punya data (bolong tak dihitung).
    const known = filled.filter(d => d.uptime_percentage !== null);
    let slaRange = null;
    if (known.length > 0) {
      const sum = known.reduce((acc, d) => acc + d.uptime_percentage, 0);
      slaRange = parseFloat((sum / known.length).toFixed(2));
    } else {
      // fallback: hitung dari device status saat ini
      const devRes = await db.query('SELECT status FROM devices');
      const devices = devRes.rows;
      const total = devices.length;
      const online = devices.filter(d => d.status === 'online').length;
      slaRange = total === 0 ? 100 : parseFloat(((online / total) * 100).toFixed(2));
    }

    // KPI 24h tetap dilaporkan (ingestion, latency, loss) — sumbernya sama.
    let ingestion24h = 0;
    let influx_has_ingestion = false;
    try {
      const count = await influxService.getIngestionCount();
      if (count > 0) {
        ingestion24h = count;
        influx_has_ingestion = true;
      }
    } catch (e) { /* ignore */ }

    // Avg latency & packet loss riil dari InfluxDB 24h
    let summary = { avg_latency_ms: 0, avg_packet_loss: 0, has_data: false };
    try {
      summary = await influxService.getGlobal24hSummary();
    } catch (e) { /* ignore */ }

    if (!summary.has_data) {
      // Fallback: hitung dari kolom ping_latency & packet_loss di devices
      const dr = await db.query('SELECT ping_latency, packet_loss FROM devices');
      const devices = dr.rows;
      if (devices.length > 0) {
        summary.avg_latency_ms = parseFloat((devices.reduce((s, d) => s + (parseFloat(d.ping_latency) || 0), 0) / devices.length).toFixed(2));
        summary.avg_packet_loss = parseFloat((devices.reduce((s, d) => s + (parseFloat(d.packet_loss) || 0), 0) / devices.length).toFixed(3));
      }
    }

    // Statistik agregat rentang untuk kartu ringkas report.
    const totalChecksRange = known.reduce((s, d) => s + d.total_checks, 0);
    const failedChecksRange = known.reduce((s, d) => s + Math.max(0, d.total_checks - d.successful_checks), 0);

    res.json({
      success: true,
      window_days: windowDays,
      // sla_30d dipertahankan utk backward-compat (exportSlaCsv lama & kpi);
      // komposisi/_nilainya kini = SLA rentang terpilih.
      sla_30d: slaRange,
      sla_range: slaRange,
      data_days: known.length,
      total_checks_range: totalChecksRange,
      failed_checks_range: failedChecksRange,
      daily_breakdown: filled,
      total_ingestion_24h: ingestion24h,
      influx_has_ingestion: influx_has_ingestion,
      avg_latency_ms: summary.avg_latency_ms,
      avg_packet_loss: summary.avg_packet_loss,
      influx_has_data: summary.has_data,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});





// ============================================================================
// SLA Reset — hapus daily_uptime & re-seed dari InfluxDB (untuk fresh start)
// ============================================================================
router.post('/reports/sla/reset', async (req, res) => {
  try {
    // Hapus data SLA harian lama
    await db.query('DELETE FROM daily_uptime');

    // Trigger re-seed dari data InfluxDB real-time (measurement `ping`)
    let reseeded = { ok: false, days: 0 };
    try {
      reseeded = await uptimeService.ensureDailyUptime();
    } catch (e) {
      console.warn('[SLA Reset] re-seed failed:', e.message);
    }

    res.json({
      success: true,
      message: 'SLA data reset & re-seeded from InfluxDB.',
      reseeded
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});





// 5. Settings Endpoint
// Phase 1: never return the actual InfluxDB token in the response.
// The frontend is expected to leave the token field empty to keep the
// current value, and only supply a new token when rotating.
// A2: settings kini PERSISTEN di tabel app_settings (di-load ke process.env
// saat boot oleh db.loadAppSettings). .env tetap jadi default; nilai yang
// disimpan lewat UI selalu menang setelah proses apa pun direstart.
router.get('/settings', (req, res) => {
  // Sanitasi: token tak pernah dikirim balik ke browser. Frontend diharapkan
  // mengirim '__KEEP_CURRENT__' agar token lama tetap terpakai saat rotate.
  const safeSettings = {
    INFLUX_URL: process.env.INFLUX_URL || '',
    INFLUX_TOKEN: '__KEEP_CURRENT__',
    INFLUX_TOKEN_LENGTH: process.env.INFLUX_TOKEN ? String(process.env.INFLUX_TOKEN).length : 0,
    INFLUX_ORG: process.env.INFLUX_ORG || 'itnetmon',
    INFLUX_BUCKET: process.env.INFLUX_BUCKET || 'itnetmon_metrics',
    TELEGRAF_CONF_DIR: process.env.TELEGRAF_CONF_DIR || './telegraf.d',
    TELEGRAF_RELOAD_CMD: process.env.TELEGRAF_RELOAD_CMD || 'echo "Reloading Telegraf"'
  };
  res.json({
    success: true,
    settings: safeSettings,
    db_status: 'Connected (SQLite)',
    telegraf_conf_dir: process.env.TELEGRAF_CONF_DIR || './telegraf.d'
  });
});

router.post('/settings', (req, res) => {
  const { INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET, TELEGRAF_CONF_DIR } = req.body;

  let tokenChanged = false;
  // Hanya kolom yang benar-benar dikirim (truthy) yang dioverride — form
  // parsial tidak mereset kolom lain ke kosong.
  const updates = {};
  if (INFLUX_URL) updates.INFLUX_URL = INFLUX_URL;
  // Phase 1: '__KEEP_CURRENT__' / '' berarti "pertahankan token lama".
  if (
    INFLUX_TOKEN !== undefined &&
    INFLUX_TOKEN !== null &&
    INFLUX_TOKEN !== '' &&
    INFLUX_TOKEN !== '__KEEP_CURRENT__' &&
    INFLUX_TOKEN !== process.env.INFLUX_TOKEN
  ) {
    updates.INFLUX_TOKEN = INFLUX_TOKEN;
    tokenChanged = true;
  }
  if (INFLUX_ORG) updates.INFLUX_ORG = INFLUX_ORG;
  if (INFLUX_BUCKET) updates.INFLUX_BUCKET = INFLUX_BUCKET;
  if (TELEGRAF_CONF_DIR) updates.TELEGRAF_CONF_DIR = TELEGRAF_CONF_DIR;

  // A2: persist ke app_settings (upsert per kolom) — saveAppSetting juga
  // menyinkronkan process.env sehingga runtime & boot berikutnya konsisten.
  for (const [key, value] of Object.entries(updates)) {
    db.saveAppSetting(key, value);
  }

  // Jika token InfluxDB berubah, rewrite 00-output.conf Telegraf
  if (tokenChanged) {
    try {
      telegrafManager.refreshOutputConfig();
      telegrafManager.triggerReload();
      // Force refresh InfluxDB client dengan token baru
      influxService.resetClient();
      console.log('[Settings] InfluxDB token updated → 00-output.conf rewritten, Telegraf reload triggered, InfluxDB client refreshed');
    } catch (e) {
      console.warn('[Settings] Failed to refresh telegraf config:', e.message);
    }
  }

  // Phase 1: never echo the actual token back in the POST response either.
  const safeSettings = {
    INFLUX_URL: process.env.INFLUX_URL || '',
    INFLUX_TOKEN: '__KEEP_CURRENT__',
    INFLUX_TOKEN_LENGTH: process.env.INFLUX_TOKEN ? String(process.env.INFLUX_TOKEN).length : 0,
    INFLUX_ORG: process.env.INFLUX_ORG || 'itnetmon',
    INFLUX_BUCKET: process.env.INFLUX_BUCKET || 'itnetmon_metrics',
    TELEGRAF_CONF_DIR: process.env.TELEGRAF_CONF_DIR || './telegraf.d'
  };
  res.json({
    success: true,
    message: 'Settings updated successfully.' + (tokenChanged ? ' Telegraf config synced.' : ''),
    settings: safeSettings,
    telegraf_reloaded: tokenChanged
  });
});

router.post('/settings/test-influx', async (req, res) => {
  // Phase 1: the frontend may send the sentinel value `__KEEP_CURRENT__`
  // for INFLUX_TOKEN (since the real token is never returned to the
  // browser). In that case, fall back to the currently stored token
  // so the test reflects what production writes would use.
  const body = Object.assign({}, req.body || {});
  if (body.INFLUX_TOKEN === '__KEEP_CURRENT__' || body.INFLUX_TOKEN === '') {
    // A2: token aktif kini tersimpan di app_settings / process.env (shim
    // memori legacy selalu kosong setelah restart). process.env diisi
    // loadAppSettings() saat boot dan saveAppSetting() saat POST /settings.
    if (process.env.INFLUX_TOKEN) {
      body.INFLUX_TOKEN = process.env.INFLUX_TOKEN;
    } else {
      // No token stored yet; report a clear, sanitized error.
      return res.json({
        success: false,
        message: 'No InfluxDB token configured yet. Save Settings with a token first.'
      });
    }
  }
  const result = await influxService.testConnection(body);
  res.json(result);
});

// =============================================================
// Network Topology Endpoints (LLDP/CDP/MNDP discovery)
// =============================================================

// GET /api/topology — return nodes (devices) + edges (device_links) for Vis.js Network
router.get('/topology', async (req, res) => {
  try {
    const devRes = await db.query('SELECT id, name, ip_address, status, device_type FROM devices ORDER BY id ASC');
    const devices = devRes.rows;

    let links = [];
    // Link stale SENGAJA ikut dikirim: frontend merendernya sebagai edge
    // merah putus-putus agar operator tahu link terakhir yang diketahui,
    // bukan kehilangan informasi saat satu siklus discovery gagal.
    const r = await db.query(
      `SELECT id, source_device_id, source_interface, target_chassis_id, target_sys_name,
              target_port_id, target_port_desc, target_ip, manual_ipv4, target_device_id, protocol,
              last_seen, stale
       FROM device_links
       ORDER BY id ASC`
    );
    // SQLite menyimpan BOOLEAN sebagai 0/1; normalisasi agar logika
    // `stale === true` di bawah (dan render frontend) tetap benar.
    links = r.rows.map(l => ({ ...l, stale: !!Number(l.stale) }));

    // Build nodes for Vis.js
    const nodes = devices.map(d => ({
      id: d.id,
      label: d.name,
      ip: d.ip_address,
      type: d.device_type,
      status: d.status,
      // Color & shape based on status (used by frontend Vis.js options)
      color: d.status === 'online' ? '#10b981' :
             d.status === 'warning' ? '#f59e0b' :
             d.status === 'offline' ? '#ef4444' : '#64748b'
    }));

    // Build edges for Vis.js — split into managed (with target_device_id) and unmanaged
    // PERBAIKAN: Kumpulkan semua kandidat IP unik per unmanaged NODE dari SEMUA link,
    // bukan hanya dari satu link yang sedang diproses. Ini memastikan jika device terhubung
    // lewat beberapa port/link, kita mendapatkan semua IP yang pernah terlihat oleh semua perangkat tetangga.
    const ipMapByUnmanagedKey = new Map(); // key -> Set<ip>
    const manualIpv4MapByUnmanagedKey = new Map(); // key -> first-found manual_ipv4

    for (const link of links) {
      if (link.target_device_id) continue; // skip managed, handle later
      const key = link.target_chassis_id || link.target_sys_name || `unmanaged-${link.id}`;
      if (!ipMapByUnmanagedKey.has(key)) {
        ipMapByUnmanagedKey.set(key, new Set());
      }
      // Tambahkan IP otomatis dari LLDP/ARP ke kandidat
      if (link.target_ip) {
        ipMapByUnmanagedKey.get(key).add(link.target_ip);
      }
      // Simpan manual_ipv4 jika admin sudah mengaturnya secara manual
      if (link.manual_ipv4 && !manualIpv4MapByUnmanagedKey.has(key)) {
        manualIpv4MapByUnmanagedKey.set(key, link.manual_ipv4.trim());
        // Juga masukkan manual_ipv4 ke kandidat agar prioritas logika tetap aman
        ipMapByUnmanagedKey.get(key).add(link.manual_ipv4.trim());
      }
    }

    // Bangun edges & nodes terintegrasi
    const edges = [];
    const unmanagedNodes = new Map();

    for (const link of links) {
      const sourceId = link.source_device_id;
      const targetId = link.target_device_id;

      // If target is a known device, create edge to it
      if (targetId && devices.find(d => d.id === targetId)) {
        edges.push({
          id: link.id,
          from: sourceId,
          to: targetId,
          protocol: link.protocol,
          source_interface: link.source_interface,
          target_interface: link.target_port_id,
          target_port_desc: link.target_port_desc,
          target_sys_name: link.target_sys_name,
          target_ip: link.target_ip,
          last_seen: link.last_seen,
          stale: link.stale === true
        });
      } else {
        // Unmanaged device — create pseudo-node keyed by chassis_id or sysName
        const key = link.target_chassis_id || link.target_sys_name || `unmanaged-${link.id}`;
        if (!unmanagedNodes.has(key)) {
          const allCands = Array.from(ipMapByUnmanagedKey.get(key) || new Set());

          // PRIORITY ORDER: 1) manual_ipv4 > 2) IPv4 Global otomatis > 3) IPv6 Link-Local
          let preferredIp = null;
          const manualIp = manualIpv4MapByUnmanagedKey.get(key);
          if (manualIp) {
            preferredIp = manualIp; // manual override selalu menang
          } else {
            // Cari IPv4 Global dari kandidat otomatis
            for (const cand of allCands) {
              if (cand && typeof cand === 'string' && !cand.includes(':')) {
                preferredIp = cand;
                break;
              }
            }
            if (!preferredIp) preferredIp = allCands[0] || null; // fallback ke IPv6
          }

          unmanagedNodes.set(key, {
            id: `unmanaged-${key}`,
            label: link.target_sys_name || link.target_chassis_id || 'Unknown',
            ip: preferredIp,           // ✅ Prioritas: manual_ipv4 > IPv4 Auto > IPv6
            all_ips: allCands,         // ✅ DAFTAR LENGKAP IP kandidat (IPv4 + IPv6)
            manual_ipv4_set: !!manualIp, // Flag apakah admin sudah setting manual
            type: 'unmanaged',
            status: 'unmanaged',
            color: '#64748b',
            shape: 'box',
            dashes: true
          });
        }
        // Edge from source device to unmanaged pseudo-node
        edges.push({
          id: `unmanaged-edge-${link.id}`,
          from: sourceId,
          to: `unmanaged-${key}`,
          protocol: link.protocol,
          source_interface: link.source_interface,
          target_interface: link.target_port_id,
          target_port_desc: link.target_port_desc,
          target_sys_name: link.target_sys_name,
          target_ip: link.target_ip,
          last_seen: link.last_seen,
          stale: link.stale === true,
          color: '#64748b',
          dashes: true
        });
      }
    }

    // Tandai node unmanaged yang SELURUH link-nya stale → frontend render redup.
    for (const node of unmanagedNodes.values()) {
      const nodeEdges = edges.filter(e => e.to === node.id);
      node.stale = nodeEdges.length > 0 && nodeEdges.every(e => e.stale === true);
    }

    // Combine managed + unmanaged nodes
    const allNodes = [...nodes, ...unmanagedNodes.values()];

    res.json({
      success: true,
      nodes: allNodes,
      edges,
      stats: {
        total_devices: devices.length,
        online: devices.filter(d => d.status === 'online').length,
        offline: devices.filter(d => d.status === 'offline').length,
        warning: devices.filter(d => d.status === 'warning').length,
        total_links: edges.length,
        fresh_links: edges.filter(e => !e.stale).length,
        stale_links: edges.filter(e => e.stale).length,
        unmanaged_nodes: unmanagedNodes.size,
        by_protocol: edges.reduce((acc, e) => {
          acc[e.protocol] = (acc[e.protocol] || 0) + 1;
          return acc;
        }, {})
      },
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// POST /api/topology/discover — manual trigger discovery (tombol "Rescan")
// Non-destruktif: link yang tak terlihat kembali menjadi stale (merah), tidak dihapus.
router.post('/topology/discover', async (req, res) => {
  try {
    const result = await topologyDiscovery.discoverTopology();
    res.json({
      success: true,
      message: 'Topology discovery completed',
      ...result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// POST /api/topology/reset — tombol "Reset & Rescan": hapus SEMUA link lalu
// discovery dari nol. Override manual IPv4 dipertahankan (snapshot + restore).
router.post('/topology/reset', async (req, res) => {
  try {
    const result = await topologyDiscovery.resetTopology();
    res.json({
      success: true,
      message: `Reset selesai: ${result.removed} link dihapus, ${(result.discovery && result.discovery.totalLinks) || 0} link ditemukan, ${result.overrides_restored}/${result.overrides_preserved} override manual dipulihkan.`,
      ...result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// PUT /api/topology/manual-ip/:linkId — set/update manual IPv4 override per-link
router.put('/topology/manual-ip/:linkId', async (req, res) => {
  const linkId = parseInt(req.params.linkId, 10);
  if (!linkId || isNaN(linkId)) return res.status(400).json({ success: false, error: 'Invalid link ID' });
  try {
    const ipAddr = req.body.manual_ipv4 ? String(req.body.manual_ipv4).trim() : null;
    // Validasi format IPv4 sederhana jika tidak NULL
    if (ipAddr && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipAddr)) {
      return res.status(400).json({ success: false, error: 'Format IPv4 tidak valid' });
    }
    await db.query('UPDATE device_links SET manual_ipv4 = ? WHERE id = ?', [ipAddr, linkId]);
    res.json({ success: true, message: 'Manual IPv4 berhasil diperbarui', manual_ipv4: ipAddr });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// GET /api/topology/status — status terakhir discovery
router.get('/topology/status', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT MAX(last_seen) AS last_seen,
              COUNT(*) AS total,
              SUM(CASE WHEN stale = 0 THEN 1 ELSE 0 END) AS active
       FROM device_links`
    );
    let lastSeen = null;
    let totalLinks = 0;
    let activeLinks = 0;
    if (r.rows[0]) {
      lastSeen = r.rows[0].last_seen;
      totalLinks = parseInt(r.rows[0].total, 10) || 0;
      activeLinks = parseInt(r.rows[0].active, 10) || 0;
    }
    res.json({
      success: true,
      last_discovery: lastSeen,
      total_links: totalLinks,
      active_links: activeLinks,
      stale_links: totalLinks - activeLinks
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

module.exports = router;
module.exports.syncAllDeviceInterfaces = syncAllDeviceInterfaces;
