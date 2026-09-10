const express = require('express');
const router = express.Router();
const db = require('../db');
const telegrafManager = require('../services/telegrafManager');
const influxService = require('../services/influxService');
const streamService = require('../services/streamService');
const topologyDiscovery = require('../services/topologyDiscovery');
const uptimeService = require('../services/uptimeService');

// ============================================================================
// Input Validation Utilities (Phase 1 — Security Hardening)
// ----------------------------------------------------------------------------
// These functions strictly validate user-supplied input before it is passed
// into shell commands (spawn). They REJECT anything that does not match
// a conservative pattern. They are intentionally NOT a general-purpose
// validation library — only the fields the codebase actually consumes.
// ============================================================================

const RE_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const RE_IPV6 = /^(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}$|^(?:[0-9A-Fa-f]{1,4}:){1,7}:$|^::1?$|^(?:[0-9A-Fa-f]{1,4}:){1,6}(?:\d{1,3}\.){3}\d{1,3}$/;
// RFC 1123 hostname: labels of letters/digits/hyphens, separated by dots.
// Each label 1-63 chars, total <=253, no leading/trailing hyphen in any label.
const RE_HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/;
const RE_PORT = /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const RE_COMMUNITY = /^[A-Za-z0-9_\-]{1,32}$/;
// Numeric OID only (e.g. ".1.3.6.1.2.1.1.3.0" or "1.3.6.1.2.1.1.3.0").
// We do NOT permit textual MIB names here because they are not user input
// — they are constants in the codebase.
const RE_SNMP_OID = /^\.?[0-9]+(?:\.[0-9]+)*$/;

function isValidTarget(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  return RE_IPV4.test(value) || RE_IPV6.test(value) || RE_HOSTNAME.test(value);
}

function isValidPort(value) {
  return typeof value === 'string' && RE_PORT.test(value);
}

function isValidCommunity(value) {
  return typeof value === 'string' && RE_COMMUNITY.test(value);
}

function isValidOid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && RE_SNMP_OID.test(value);
}

/**
 * pg DATE → 'YYYY-MM-DD' tanpa pergeseran zona waktu.
 * (pg mengembalikan DATE sebagai Date tengah malam waktu lokal server;
 *  serialisasi JSON biasa ke ISO UTC menggeser tanggal -/+ 1 hari.)
 */
function pgDateToStr(value) {
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
    case '23505':        return 'Duplicate record.';
    case '23503':        return 'Referenced record not found.';
    case '23502':        return 'Required field missing.';
    case '22P02':        return 'Invalid input format.';
    default:             return fallback;
  }
}

// 1. KPI & Global Summary Endpoint
router.get('/kpi', async (req, res) => {
  try {
    let devices = [];
    if (db.isPostgresConnected()) {
      const devRes = await db.query('SELECT * FROM devices');
      devices = devRes.rows;
    } else {
      devices = db.getMemoryStore().devices;
    }

    const total = devices.length;
    const online = devices.filter(d => d.status === 'online').length;
    const offline = devices.filter(d => d.status === 'offline').length;
    const warning = devices.filter(d => d.status === 'warning').length;

    // SLA 30 hari RIIL: daily_uptime diisi dari InfluxDB ping oleh
    // uptimeService (jangan pernah fallback ke deret sintetis).
    let uptime30d = 100;
    let trendline = [];
    let dailyBreakdown = [];

    if (db.isPostgresConnected()) {
      // Seed daily_uptime dari data ping InfluxDB (lazy, cache 5 menit)
      try {
        await uptimeService.ensureDailyUptime();
      } catch (e) {
        console.warn('[KPI] daily uptime sync failed:', e.message);
      }

      try {
        const upRes = await db.query(
          `SELECT date, uptime_percentage FROM daily_uptime
           WHERE date >= (CURRENT_DATE - INTERVAL '30 days')
           ORDER BY date ASC`
        );
        if (upRes.rows.length > 0) {
          dailyBreakdown = upRes.rows.map(r => ({
            date: pgDateToStr(r.date),
            pct: parseFloat(r.uptime_percentage)
          }));
          trendline = dailyBreakdown.map(d => d.pct);
          // Rata-rata SLA dari hari-hari yang benar-benar punya data
          const sum = dailyBreakdown.reduce((acc, d) => acc + d.pct, 0);
          uptime30d = parseFloat((sum / dailyBreakdown.length).toFixed(2));
        } else {
          // Belum ada satu hari pun data riil → pakai status terkini sebagai
          // indikator, TANPA trendline buatan (sparkline kosong = jujur).
          uptime30d = total === 0 ? 100 : parseFloat(((online / total) * 100).toFixed(2));
          trendline = [];
        }
      } catch (e) {
        uptime30d = total === 0 ? 100 : parseFloat(((online / total) * 100).toFixed(2));
        trendline = [];
      }
    } else {
      // Memory mode: hitung dari status device aktif (tanpa data sintetis)
      uptime30d = total === 0 ? 100 : parseFloat(((online / total) * 100).toFixed(2));
      trendline = [];
    }

    res.json({
      success: true,
      uptime_30d: uptime30d,
      trendline,
      daily_breakdown: dailyBreakdown,
      sla_data_days: dailyBreakdown.length,
      total_devices: total,
      online_count: online,
      offline_count: offline,
      warning_count: warning,
      db_connected: db.isPostgresConnected(),
      last_updated: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 2. Devices CRUD
router.get('/devices', async (req, res) => {
  try {
    let devices = [];
    let interfaces = [];

    if (db.isPostgresConnected()) {
      const devRes = await db.query('SELECT * FROM devices ORDER BY id ASC');
      devices = devRes.rows;

      // Sync interfaces from InfluxDB dynamically for each device (with IP fallback)
      for (const dev of devices) {
        const actualIfaces = await influxService.getDeviceInterfaces(dev.id, dev.ip_address);
        if (actualIfaces.length > 0) {
          // Delete default templates if we have real interfaces now
          await db.query(
            `DELETE FROM interfaces WHERE device_id = $1 AND (interface_name = 'ether1-WAN' OR interface_name = 'ether2-LAN')`,
            [dev.id]
          );
          // Insert actual interfaces
          for (const ifaceName of actualIfaces) {
            await db.query(
              `INSERT INTO interfaces (device_id, interface_name, status, speed_bps)
               VALUES ($1, $2, 'up', 1000000000)
               ON CONFLICT (device_id, interface_name) DO NOTHING`,
              [dev.id, ifaceName]
            );
          }
        }
      }

      const ifaceRes = await db.query('SELECT * FROM interfaces ORDER BY id ASC');
      interfaces = ifaceRes.rows;
    } else {
      devices = db.getMemoryStore().devices;

      // Sync interfaces in Memory Store
      for (const dev of devices) {
        const actualIfaces = await influxService.getDeviceInterfaces(dev.id, dev.ip_address);
        if (actualIfaces.length > 0) {
          const store = db.getMemoryStore();
          // Remove default templates
          store.interfaces = store.interfaces.filter(
            i => !(i.device_id === dev.id && (i.interface_name === 'ether1-WAN' || i.interface_name === 'ether2-LAN'))
          );
          // Add actual interfaces
          for (const ifaceName of actualIfaces) {
            if (!store.interfaces.some(i => i.device_id === dev.id && i.interface_name === ifaceName)) {
              store.interfaces.push({
                id: Date.now() + Math.random(),
                device_id: dev.id,
                interface_name: ifaceName,
                status: 'up',
                speed_bps: 1000000000
              });
            }
          }
        }
      }
      interfaces = db.getMemoryStore().interfaces;
    }

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

    if (db.isPostgresConnected()) {
      const result = await db.query(
        `INSERT INTO devices (name, ip_address, device_type, snmp_community, snmp_version, snmp_port, polling_interval, status, ping_latency, packet_loss, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()) RETURNING *`,
        [name, ip_address, device_type || 'router', snmp_community || 'public', snmp_version || '2c', portVal, intervalVal,
         pingResult.reachable ? 'online' : 'offline',
         pingResult.latency_ms, pingResult.packet_loss]
      );
      newDevice = result.rows[0];
    } else {
      const store = db.getMemoryStore();
      newDevice = {
        id: Date.now(),
        name,
        ip_address,
        device_type: device_type || 'router',
        snmp_community: snmp_community || 'public',
        snmp_version: snmp_version || '2c',
        snmp_port: portVal,
        polling_interval: intervalVal,
        status: pingResult.reachable ? 'online' : 'offline',
        ping_latency: pingResult.latency_ms,
        packet_loss: pingResult.packet_loss,
        last_seen: new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      store.devices.push(newDevice);
    }

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
    if (db.isPostgresConnected()) {
      await db.query('DELETE FROM devices WHERE id = $1', [id]);
    } else {
      const store = db.getMemoryStore();
      store.devices = store.devices.filter(d => d.id !== id);
      store.interfaces = store.interfaces.filter(i => i.device_id !== id);
    }

    // Remove Telegraf config & reload
    telegrafManager.removeDeviceConfig(id);

    res.json({ success: true, message: `Device ${id} deleted and Telegraf config removed.` });
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

    if (db.isPostgresConnected()) {
      const result = await db.query(
        `UPDATE devices
         SET name = $1, ip_address = $2, device_type = $3, snmp_community = $4,
             snmp_version = $5, snmp_port = $6, polling_interval = $7
         WHERE id = $8 RETURNING *`,
        [name, ip_address, device_type || 'router', snmp_community || 'public',
         snmp_version || '2c', portVal, intervalVal, id]
      );
      updatedDevice = result.rows[0];
      if (!updatedDevice) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }
    } else {
      const store = db.getMemoryStore();
      const dev = store.devices.find(d => d.id === id);
      if (!dev) {
        return res.status(404).json({ success: false, error: 'Device not found' });
      }
      dev.name = name;
      dev.ip_address = ip_address;
      dev.device_type = device_type || dev.device_type || 'router';
      dev.snmp_community = snmp_community || 'public';
      dev.snmp_version = snmp_version || '2c';
      dev.snmp_port = portVal;
      dev.polling_interval = intervalVal;
      updatedDevice = dev;
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
    if (db.isPostgresConnected()) {
      const r = await db.query('SELECT * FROM devices WHERE id = $1', [id]);
      device = r.rows[0] || null;
    }
    if (!device) {
      device = db.getMemoryStore().devices.find(d => d.id === id) || null;
    }
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

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
    const memory = pick(systemMetrics.memory_total, rtSys ? rtSys.memory_total_bytes : null);
    const memoryUsed = pick(systemMetrics.memory_used, rtSys ? rtSys.memory_used_bytes : null);

    // Storage (unit hrStorage: jumlah unit × alloc_units = bytes).
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
      has_data: !!(uptime || cpu || memory || storageEntriesBytes.length > 0 || systemMetrics.has_data),
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
      memory: memory && memoryUsed
        ? {
            supported: true, source: memory.source,
            total_bytes: memory.value, used_bytes: memoryUsed.value,
            pct: memory.value > 0 ? parseFloat(((memoryUsed.value / memory.value) * 100).toFixed(1)) : 0
          }
        : { supported: false, reason: noDataReason, source: null },
      storage: storageEntriesBytes.length > 0
        ? { supported: true, source: storageSource, entries: storageEntriesBytes }
        : { supported: false, reason: 'Perangkat tidak melaporkan storage via hrStorage (HOST-RESOURCES)', source: null },
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
    let device = null;
    if (db.isPostgresConnected()) {
      const r = await db.query('SELECT * FROM devices WHERE id = $1', [id]);
      device = r.rows[0];
    }
    if (!device) device = db.getMemoryStore().devices.find(d => d.id === id);
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
    let devices = [];
    if (db.isPostgresConnected()) {
      const r = await db.query('SELECT * FROM devices ORDER BY id ASC');
      devices = r.rows;
    } else {
      devices = db.getMemoryStore().devices;
    }

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
    res.json({ success: true, active, history });
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
    let alerts = [];
    if (db.isPostgresConnected()) {
      const alertRes = await db.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50');
      alerts = alertRes.rows;
    } else {
      alerts = db.getMemoryStore().alerts;
    }
    res.json({ success: true, alerts });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 4c. Activity Events
router.get('/events', async (req, res) => {
  try {
    const { deviceId, severity, eventType, limit = 100, offset = 0 } = req.query;
    let query = 'SELECT * FROM events WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (deviceId) {
      query += ` AND device_id = $${paramIdx}`;
      params.push(parseInt(deviceId, 10));
      paramIdx++;
    }
    if (severity && severity !== 'all') {
      query += ` AND severity = $${paramIdx}`;
      params.push(severity);
      paramIdx++;
    }
    if (eventType && eventType !== 'all') {
      query += ` AND event_type = $${paramIdx}`;
      params.push(eventType);
      paramIdx++;
    }

    query += ` ORDER BY timestamp DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    let events = [];
    if (db.isPostgresConnected()) {
      const eventRes = await db.query(query, params);
      events = eventRes.rows;
    }
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// 4b. Live Feed Snapshot - data live aktual (devices, alerts, ws, throughput aggregate)
router.get('/live-feed', async (req, res) => {
  try {
    let devices = [];
    let alerts = [];

    if (db.isPostgresConnected()) {
      const devRes = await db.query('SELECT id, name, ip_address, status, ping_latency, packet_loss, last_seen FROM devices ORDER BY id ASC');
      devices = devRes.rows;
      const aRes = await db.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10');
      alerts = aRes.rows;
    } else {
      devices = db.getMemoryStore().devices;
      alerts = db.getMemoryStore().alerts.slice(0, 10);
    }

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
    // Seed daily_uptime dari data ping InfluxDB sebelum membaca tabel
    if (db.isPostgresConnected()) {
      try {
        await uptimeService.ensureDailyUptime();
      } catch (e) {
        console.warn('[Reports] daily uptime sync failed:', e.message);
      }
    }

    let daily = [];
    if (db.isPostgresConnected()) {
      try {
        const r = await db.query(
          `SELECT date, total_checks, successful_checks, uptime_percentage
           FROM daily_uptime
           WHERE date >= (CURRENT_DATE - INTERVAL '30 days')
           ORDER BY date ASC`
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
    }

    // Hitung SLA 30 hari riil
    let sla30d = 100;
    if (daily.length > 0) {
      const sum = daily.reduce((acc, d) => acc + d.uptime_percentage, 0);
      sla30d = parseFloat((sum / daily.length).toFixed(2));
    } else {
      // fallback: hitung dari device status saat ini
      let devices = [];
      if (db.isPostgresConnected()) {
        const dr = await db.query('SELECT status FROM devices');
        devices = dr.rows;
      } else {
        devices = db.getMemoryStore().devices;
      }
      const total = devices.length;
      const online = devices.filter(d => d.status === 'online').length;
      sla30d = total === 0 ? 100 : parseFloat(((online / total) * 100).toFixed(2));
    }

    // Total ingestion points (24h) dari InfluxDB riil, only if available
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
      let devices = [];
      if (db.isPostgresConnected()) {
        const dr = await db.query('SELECT ping_latency, packet_loss FROM devices');
        devices = dr.rows;
      } else {
        devices = db.getMemoryStore().devices;
      }
      if (devices.length > 0) {
        summary.avg_latency_ms = parseFloat((devices.reduce((s, d) => s + (parseFloat(d.ping_latency) || 0), 0) / devices.length).toFixed(2));
        summary.avg_packet_loss = parseFloat((devices.reduce((s, d) => s + (parseFloat(d.packet_loss) || 0), 0) / devices.length).toFixed(3));
      }
    }

    res.json({
      success: true,
      sla_30d: sla30d,
      daily_breakdown: daily,
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

// 5. Settings Endpoint
// Phase 1: never return the actual InfluxDB token in the response.
// The frontend is expected to leave the token field empty to keep the
// current value, and only supply a new token when rotating.
router.get('/settings', (req, res) => {
  const store = db.getMemoryStore();
  // Build a sanitized copy of the settings object. Anything that looks
  // like a credential is replaced with a sentinel string.
  const safeSettings = Object.assign({}, store.settings);
  if (safeSettings.INFLUX_TOKEN) {
    // Preserve length info for UX but do NOT reveal the actual value.
    const len = String(safeSettings.INFLUX_TOKEN).length;
    safeSettings.INFLUX_TOKEN = '__KEEP_CURRENT__'; // sentinel; frontend will mask
    safeSettings.INFLUX_TOKEN_LENGTH = len;
  }
  res.json({
    success: true,
    settings: safeSettings,
    db_status: db.isPostgresConnected() ? 'Connected (PostgreSQL)' : 'In-Memory Resilient Fallback',
    telegraf_conf_dir: process.env.TELEGRAF_CONF_DIR || './telegraf.d'
  });
});

router.post('/settings', (req, res) => {
  const { INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET, TELEGRAF_CONF_DIR } = req.body;
  const store = db.getMemoryStore();

  let tokenChanged = false;
  if (INFLUX_URL) store.settings.INFLUX_URL = INFLUX_URL;
  // Phase 1: treat the sentinel value from GET as a no-op so the frontend
  // can submit a "leave current token" form without rotating the secret.
  if (
    INFLUX_TOKEN !== undefined &&
    INFLUX_TOKEN !== null &&
    INFLUX_TOKEN !== '' &&
    INFLUX_TOKEN !== '__KEEP_CURRENT__' &&
    store.settings.INFLUX_TOKEN !== INFLUX_TOKEN
  ) {
    store.settings.INFLUX_TOKEN = INFLUX_TOKEN;
    tokenChanged = true;
  }
  if (INFLUX_ORG) store.settings.INFLUX_ORG = INFLUX_ORG;
  if (INFLUX_BUCKET) store.settings.INFLUX_BUCKET = INFLUX_BUCKET;
  if (TELEGRAF_CONF_DIR) store.settings.TELEGRAF_CONF_DIR = TELEGRAF_CONF_DIR;

  // Sync process.env agar ensureConfDir() pakai token baru
  if (INFLUX_URL) process.env.INFLUX_URL = INFLUX_URL;
  if (
    INFLUX_TOKEN !== undefined &&
    INFLUX_TOKEN !== null &&
    INFLUX_TOKEN !== '' &&
    INFLUX_TOKEN !== '__KEEP_CURRENT__'
  ) {
    process.env.INFLUX_TOKEN = INFLUX_TOKEN;
  }
  if (INFLUX_ORG) process.env.INFLUX_ORG = INFLUX_ORG;
  if (INFLUX_BUCKET) process.env.INFLUX_BUCKET = INFLUX_BUCKET;

  // Jika token InfluxDB berubah, rewrite 00-output.conf Telegraf
  if (tokenChanged) {
    try {
      telegrafManager.refreshOutputConfig();
      telegrafManager.triggerReload();
      console.log('[Settings] InfluxDB token updated → 00-output.conf rewritten & Telegraf reload triggered');
    } catch (e) {
      console.warn('[Settings] Failed to refresh telegraf config:', e.message);
    }
  }

  // Phase 1: never echo the actual token back in the POST response either.
  const safeSettings = Object.assign({}, store.settings);
  if (safeSettings.INFLUX_TOKEN) {
    const len = String(safeSettings.INFLUX_TOKEN).length;
    safeSettings.INFLUX_TOKEN = '__KEEP_CURRENT__';
    safeSettings.INFLUX_TOKEN_LENGTH = len;
  }
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
    const store = db.getMemoryStore();
    if (store && store.settings && store.settings.INFLUX_TOKEN) {
      body.INFLUX_TOKEN = store.settings.INFLUX_TOKEN;
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
    let devices = [];
    if (db.isPostgresConnected()) {
      const r = await db.query('SELECT id, name, ip_address, status, device_type FROM devices ORDER BY id ASC');
      devices = r.rows;
    } else {
      devices = db.getMemoryStore().devices;
    }

    let links = [];
    if (db.isPostgresConnected()) {
      const r = await db.query(
        `SELECT id, source_device_id, source_interface, target_chassis_id, target_sys_name,
                target_port_id, target_port_desc, target_ip, manual_ipv4, target_device_id, protocol,
                last_seen, stale
         FROM device_links
         WHERE stale = false
         ORDER BY id ASC`
      );
      links = r.rows;
    } else {
      const store = db.getMemoryStore();
      links = (store.device_links || []).filter(l => !l.stale);
    }

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
          last_seen: link.last_seen
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
          color: '#64748b',
          dashes: true
        });
      }
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

// POST /api/topology/discover — manual trigger discovery
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
    if (db.isPostgresConnected()) {
      await db.query('UPDATE device_links SET manual_ipv4 = $1 WHERE id = $2', [ipAddr, linkId]);
    } else {
      const store = db.getMemoryStore();
      const links = store.device_links || [];
      const link = links.find(l => l.id === linkId);
      if (link) link.manual_ipv4 = ipAddr;
    }
    res.json({ success: true, message: 'Manual IPv4 berhasil diperbarui', manual_ipv4: ipAddr });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// GET /api/topology/status — status terakhir discovery
router.get('/topology/status', async (req, res) => {
  try {
    let lastSeen = null;
    let totalLinks = 0;
    let activeLinks = 0;
    if (db.isPostgresConnected()) {
      const r = await db.query(
        `SELECT MAX(last_seen) AS last_seen,
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE stale = false) AS active
         FROM device_links`
      );
      if (r.rows[0]) {
        lastSeen = r.rows[0].last_seen;
        totalLinks = parseInt(r.rows[0].total, 10) || 0;
        activeLinks = parseInt(r.rows[0].active, 10) || 0;
      }
    } else {
      const store = db.getMemoryStore();
      const links = store.device_links || [];
      totalLinks = links.length;
      activeLinks = links.filter(l => !l.stale).length;
      if (links.length > 0) {
        lastSeen = links.reduce((max, l) =>
          l.last_seen > max ? l.last_seen : max, links[0].last_seen);
      }
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
