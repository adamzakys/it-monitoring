const { WebSocketServer } = require('ws');
const db = require('../db');
const influxService = require('./influxService');
const { emitEvent, EVENT_TYPES } = require('./eventLogger');
const { INCIDENT_STATES, createIncident, updateIncidentSeverity, closeIncident, getActiveIncidentForDevice } = require('./incidentManager');

let wss = null;
let intervalId = null;

// Track client subscriptions: ws -> { deviceId, interfaceName }
const clientSubscriptions = new Map();

// Flapping & Health protection trackers: deviceId -> { failCount: 0, warnCount: 0, okCount: 0, currentStatus: 'online' }
const healthTrackers = new Map();

function initStreamService(server) {
  wss = new WebSocketServer({ server, path: '/ws/metrics' });

  wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected.');
    // Default subscription: Device 1, ether1
    clientSubscriptions.set(ws, { deviceId: 1, interfaceName: 'ether1' });

    // Send immediate initial sync
    sendInitialSync(ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.action === 'subscribe') {
          clientSubscriptions.set(ws, {
            deviceId: parseInt(msg.deviceId, 10) || 1,
            interfaceName: msg.interfaceName || 'ether1'
          });
          console.log(`[WebSocket] Client subscribed to Device ${msg.deviceId}, Interface: ${msg.interfaceName}`);
        }
      } catch (err) {
        console.error('[WebSocket Message Error]', err.message);
      }
    });

    ws.on('close', () => {
      clientSubscriptions.delete(ws);
      console.log('[WebSocket] Client disconnected.');
    });
  });

  // Start 1-second high-resolution ticker
  if (!intervalId) {
    intervalId = setInterval(runTick, 1000);
    console.log('[StreamService] 1-second real-time streaming engine started.');
  }
}

async function sendInitialSync(ws) {
  let devices = [];
  let alerts = [];

  if (db.isPostgresConnected()) {
    try {
      const devRes = await db.query('SELECT * FROM devices ORDER BY id ASC');
      devices = devRes?.rows || [];
      const alertRes = await db.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 15');
      alerts = alertRes?.rows || [];
    } catch (e) {
      devices = db.getMemoryStore().devices;
      alerts = db.getMemoryStore().alerts;
    }
  } else {
    devices = db.getMemoryStore().devices;
    alerts = db.getMemoryStore().alerts;
  }

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      type: 'INIT_SYNC',
      devices,
      alerts,
      timestamp: new Date().toISOString()
    }));
  }
}

/**
 * 1-second interval execution loop
 * Evaluates ALL devices independently every second!
 */
async function runTick() {
  if (!wss || wss.clients.size === 0) return;

  const now = new Date();
  const timestamp = now.toLocaleTimeString('id-ID', { hour12: false });

  // Get active devices from DB
  let devices = [];
  if (db.isPostgresConnected()) {
    try {
      const devRes = await db.query('SELECT * FROM devices ORDER BY id ASC');
      devices = devRes?.rows || [];
    } catch (e) {
      devices = db.getMemoryStore().devices;
    }
  } else {
    devices = db.getMemoryStore().devices;
  }

  // 1. Evaluate metrics and health for ALL devices in parallel
  const deviceMetrics = new Map();

  for (const dev of devices) {
    const defaultIface = dev.device_type === 'router' ? 'ether1' : 'enp0s3';
    const metric = await generateOrFetchMetrics(dev, defaultIface);

    // Evaluate health & trigger alerts if state changes
    const computedStatus = await evaluateDeviceHealth(dev, metric);
    metric.status = computedStatus;

    // Always sync ping_latency/packet_loss ke DB agar UI/kpi tidak stale
    // (tidak menyentuh status — sudah di-handle evaluateDeviceHealth)
    await updateDeviceMetricsInDb(dev.id, metric.latency, metric.packetLoss);

    deviceMetrics.set(dev.id, metric);
  }

  // 2. Broadcast updates to all connected clients
  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) continue;

    const sub = clientSubscriptions.get(client) || { deviceId: 1, interfaceName: 'ether1' };
    const targetDevice = devices.find(d => d.id === sub.deviceId) || devices[0];

    if (!targetDevice) continue;

    // Fetch metric specific to client's selected interface
    let subMetric = deviceMetrics.get(targetDevice.id);
    if (sub.interfaceName && sub.interfaceName !== (targetDevice.device_type === 'router' ? 'ether1' : 'enp0s3')) {
      subMetric = await generateOrFetchMetrics(targetDevice, sub.interfaceName);
      subMetric.status = deviceMetrics.get(targetDevice.id)?.status || targetDevice.status;
    }

    // 2a. Send the primary chart tick for selected device
    client.send(JSON.stringify({
      type: 'METRIC_TICK',
      timestamp,
      fullTime: now.toISOString(),
      deviceId: targetDevice.id,
      deviceName: targetDevice.name,
      interfaceName: sub.interfaceName,
      inMbps: subMetric.inMbps,
      outMbps: subMetric.outMbps,
      latency: subMetric.latency,
      packetLoss: subMetric.packetLoss,
      status: subMetric.status
    }));

    // 2b. Broadcast telemetry update for ALL devices so all cards reflect real status
    for (const [devId, m] of deviceMetrics.entries()) {
      client.send(JSON.stringify({
        type: 'DEVICE_TELEMETRY',
        deviceId: devId,
        latency: m.latency,
        packetLoss: m.packetLoss,
        status: m.status
      }));
    }
  }
}

/**
 * Evaluates 100% real metrics from InfluxDB.
 * Jika InfluxDB belum punya data, fallback ke:
 * 1) Real-time ICMP ping (latency)
 * 2) Real-time SNMP query untuk bytes_in/bytes_out via snmpget
 *
 * Phase 1: switched from `exec` (shell interpolation) to `spawn` (args array).
 */
const { spawn } = require('child_process');

// Phase 1: strict target validator. Mirrors the one in routes/api.js.
const RE_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const RE_IPV6 = /^(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}$|^(?:[0-9A-Fa-f]{1,4}:){1,7}:$|^::1?$|^(?:[0-9A-Fa-f]{1,4}:){1,6}(?:\d{1,3}\.){3}\d{1,3}$/;
const RE_HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/;
const RE_PORT = /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const RE_COMMUNITY = /^[A-Za-z0-9_\-]{1,32}$/;

function _isValidTarget(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  return RE_IPV4.test(value) || RE_IPV6.test(value) || RE_HOSTNAME.test(value);
}
function _isValidPort(value) {
  return typeof value === 'string' && RE_PORT.test(value);
}
function _isValidCommunity(value) {
  return typeof value === 'string' && RE_COMMUNITY.test(value);
}

const pingCache = new Map(); // deviceId -> { latency, loss, ts }
const snmpCache = new Map();  // deviceId -> { ifName, inMbps, outMbps, ts }

async function realTimePing(ipAddress) {
  // Phase 1: reject malformed targets instead of interpolating into shell.
  if (!_isValidTarget(ipAddress)) {
    return { latency_ms: null, packet_loss: 100, reachable: false };
  }
  return new Promise(resolve => {
    const child = spawn('ping', ['-c', '1', '-W', '1', ipAddress], { timeout: 1500 });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => {
      resolve({ latency_ms: null, packet_loss: 100, reachable: false });
    });
    child.on('close', () => {
      if (!stdout) {
        resolve({ latency_ms: null, packet_loss: 100, reachable: false });
        return;
      }
      const matchTime = stdout.match(/time=([0-9.]+)\s*ms/);
      const matchLoss = stdout.match(/([\d.]+)%\s*packet loss/);
      if (matchTime) {
        resolve({
          latency_ms: parseFloat(matchTime[1]),
          packet_loss: matchLoss ? parseFloat(matchLoss[1]) : 0,
          reachable: true
        });
      } else {
        resolve({ latency_ms: null, packet_loss: 100, reachable: false });
      }
    });
  });
}

/**
 * Real-time SNMP query untuk bytes counters via snmpget.
 * Returns array of { interface_name, bytes_in, bytes_out, oper_status, speed_mbps }.
 * Requires net-snmp tools installed and SNMP agent reachable.
 * Phase 1: uses spawn() with arg array and validates all user-derived fields.
 */
async function realTimeSnmpPoll(device) {
  const ip = device.ip_address;
  const community = device.snmp_community || 'public';
  const port = device.snmp_port || 161;
  const version = device.snmp_version || '2c';

  if (!ip) { return { ok: false, error: 'no_ip', interfaces: [] }; }
  // Phase 1: refuse to spawn if any user-derived value is malformed.
  if (!_isValidTarget(ip) || !_isValidCommunity(community) || !_isValidPort(String(port))) {
    return { ok: false, error: 'invalid_target', interfaces: [] };
  }

  // Walk ifXTable → can take a few seconds, so we wrap with timeout.
  // IF-MIB::ifXTable is an internal constant; only ip/community/port are
  // user-derived and have been validated above.
  return new Promise(resolve => {
    const child = spawn(
      'snmpwalk',
      ['-v' + version, '-c', community, '-t', '1', '-r', '0', ip + ':' + port, 'IF-MIB::ifXTable'],
      { timeout: 6000, maxBuffer: 1024 * 1024 }
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => {
      resolve({ ok: false, error: 'snmp_unreachable', interfaces: [] });
    });
    child.on('close', () => {
      if (!stdout) {
        resolve({ ok: false, error: 'snmp_unreachable', interfaces: [] });
        return;
      }
      // Parse output: "IF-MIB::ifHCInOctets.1 = Counter64: 12345678"
      // Group by interface index
      const byIdx = {};
      const lines = stdout.split('\n');
      for (const line of lines) {
        // ifName.X = STRING: ether1
        let m = line.match(/IF-MIB::ifName\.(\d+)\s*=\s*STRING:\s*(\S+)/);
        if (m) {
          if (!byIdx[m[1]]) byIdx[m[1]] = { interface_name: m[2] };
          continue;
        }
        m = line.match(/IF-MIB::ifHCInOctets\.(\d+)\s*=\s*Counter64:\s*(\d+)/);
        if (m) {
          if (!byIdx[m[1]]) byIdx[m[1]] = {};
          byIdx[m[1]].bytes_in = parseInt(m[2], 10) || 0;
          continue;
        }
        m = line.match(/IF-MIB::ifHCOutOctets\.(\d+)\s*=\s*Counter64:\s*(\d+)/);
        if (m) {
          if (!byIdx[m[1]]) byIdx[m[1]] = {};
          byIdx[m[1]].bytes_out = parseInt(m[2], 10) || 0;
          continue;
        }
        m = line.match(/IF-MIB::ifOperStatus\.(\d+)\s*=\s*INTEGER:\s*(\d+)/);
        if (m) {
          if (!byIdx[m[1]]) byIdx[m[1]] = {};
          byIdx[m[1]].oper_status = parseInt(m[2], 10);
          continue;
        }
        m = line.match(/IF-MIB::ifHighSpeed\.(\d+)\s*=\s*(?:Gauge32|INTEGER):\s*(\d+)/);
        if (m) {
          if (!byIdx[m[1]]) byIdx[m[1]] = {};
          byIdx[m[1]].speed_mbps = parseInt(m[2], 10);
          continue;
        }
      }

      const interfaces = Object.values(byIdx).filter(i => i.interface_name);
      resolve({ ok: interfaces.length > 0, error: interfaces.length === 0 ? 'no_data' : null, interfaces });
    });
  });
}

/**
 * Real-time system metrics via direct SNMP walk.
 * Returns { sys_uptime_ticks, cpu_load_pct, has_data }.
 * Uses sysUpTime.0 (.1.3.6.1.2.1.1.3.0) and hrProcessorLoad (.1.3.6.1.2.1.25.3.3.1.2).
 * Phase 1: uses spawn() with arg arrays and validates user-derived fields.
 */
async function getRealTimeSystemInfo(device) {
  const ip = device.ip_address;
  const community = device.snmp_community || 'public';
  const port = device.snmp_port || 161;
  const version = device.snmp_version || '2c';

  if (!ip) { return { has_data: false }; }
  // Phase 1: refuse to spawn if any user-derived value is malformed.
  if (!_isValidTarget(ip) || !_isValidCommunity(community) || !_isValidPort(String(port))) {
    return { has_data: false };
  }

  return new Promise(resolve => {
    // Run 2 SNMP gets in parallel. OIDs are hard-coded constants; only
    // ip/community/port/version are user-derived and have been validated.
    const getArgs = (oid) => ['-v' + version, '-c', community, '-t', '2', '-r', '0', ip + ':' + port, oid];
    let completed = 0;
    const result = { has_data: false, sys_uptime_ticks: null, cpu_load_pct: null };

    const finish = () => {
      if (++completed < 2) return;
      resolve(result);
    };

    const runSpawn = (oid) => new Promise((res) => {
      const child = spawn('snmpget', getArgs(oid), { timeout: 4000 });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.on('error', () => res(''));
      child.on('close', () => res(stdout));
    });

    runSpawn('.1.3.6.1.2.1.1.3.0').then((stdout) => {
      if (stdout) {
        // "DISMAN-EVENT-MIB::sysUpTimeInstance = Timeticks: (12345) 0:00:01.23"
        const m = stdout.match(/\((\d+)\)/);
        if (m) {
          result.sys_uptime_ticks = parseInt(m[1], 10);
          result.has_data = true;
        }
      }
      finish();
    });

    // hrProcessorLoad is a table — get the first entry
    runSpawn('.1.3.6.1.2.1.25.3.3.1.2.1').then((stdout) => {
      if (stdout) {
        // "HOST-RESOURCES-MIB::hrProcessorLoad.1 = INTEGER: 5"
        const m = stdout.match(/=\s*INTEGER:\s*(\d+)/);
        if (m) {
          result.cpu_load_pct = parseInt(m[1], 10);
          result.has_data = true;
        }
      }
      finish();
    });
  });
}

/**
 * Real-time throughput Mbps (In/Out) untuk selected interface via SNMP delta.
 * Cache hasil 1.5 detik.
 */
async function getRealTimeInterfaceMbps(device, interfaceName) {
  const cached = snmpCache.get(`${device.id}:${interfaceName}`);
  const now = Date.now();

  if (cached && (now - cached.ts) < 1500) {
    return { inMbps: cached.inMbps, outMbps: cached.outMbps, reachable: true };
  }

  const result = await realTimeSnmpPoll(device);
  if (!result.ok || result.interfaces.length === 0) {
    return { inMbps: 0, outMbps: 0, reachable: false, interfaces: result.interfaces };
  }

  // Get current bytes for this interface
  const current = result.interfaces.find(i => i.interface_name === interfaceName);
  if (!current || current.bytes_in === undefined) {
    return { inMbps: 0, outMbps: 0, reachable: false, interfaces: result.interfaces };
  }

  // Compute delta from cache
  let inMbps = 0, outMbps = 0;
  if (cached) {
    const dt = (now - cached.ts) / 1000;
    if (dt > 0) {
      const inDelta = current.bytes_in - (cached.bytes_in || current.bytes_in);
      const outDelta = current.bytes_out - (cached.bytes_out || current.bytes_out);
      // Wraparound handling
      const inDeltaNorm = inDelta >= 0 ? inDelta : 0;
      const outDeltaNorm = outDelta >= 0 ? outDelta : 0;
      inMbps = (inDeltaNorm * 8) / dt / 1000000;
      outMbps = (outDeltaNorm * 8) / dt / 1000000;
    }
  }

  // Update cache
  snmpCache.set(`${device.id}:${interfaceName}`, {
    bytes_in: current.bytes_in,
    bytes_out: current.bytes_out,
    inMbps,
    outMbps,
    ts: now
  });

  return { inMbps, outMbps, reachable: true, interfaces: result.interfaces };
}

/**
 * Get all interface list real-time via SNMP walk.
 * Bypasses InfluxDB entirely.
 */
async function getRealTimeInterfaces(device) {
  const result = await realTimeSnmpPoll(device);
  return result.interfaces;
}

async function generateOrFetchMetrics(device, interfaceName) {
  // 1. Try InfluxDB first
  try {
    const realData = await influxService.getLiveTelemetry(device.id, interfaceName);
    if (realData.has_data) {
      return {
        inMbps: realData.in_mbps,
        outMbps: realData.out_mbps,
        latency: realData.latency_ms,
        packetLoss: realData.packet_loss,
        has_data: true
      };
    }
  } catch (err) {
    // InfluxDB error - fall through
  }

  // 2. Fallback: direct ICMP ping (latency) + direct SNMP query (throughput)
  const cached = pingCache.get(device.id);
  const now = Date.now();
  let pingResult;
  if (cached && (now - cached.ts) < 1500) {
    pingResult = { latency_ms: cached.latency, packet_loss: cached.loss, reachable: cached.latency !== null };
  } else if (device.ip_address) {
    pingResult = await realTimePing(device.ip_address);
    pingCache.set(device.id, {
      latency: pingResult.latency_ms,
      loss: pingResult.packet_loss,
      ts: now
    });
  } else {
    pingResult = { latency_ms: null, packet_loss: null, reachable: false };
  }

  // 3. Real-time SNMP for throughput (Mbps) of selected interface
  let inMbps = 0, outMbps = 0;
  if (interfaceName && device.ip_address) {
    const snmp = await getRealTimeInterfaceMbps(device, interfaceName);
    inMbps = snmp.inMbps;
    outMbps = snmp.outMbps;
  }

  return {
    inMbps,
    outMbps,
    latency: pingResult.latency_ms,
    packetLoss: pingResult.packet_loss,
    has_data: false
  };
}

/**
 * Health Evaluation & Flapping Protection:
 * - 2 consecutive failures -> CRITICAL DOWN alert
 * - 2 consecutive warnings -> WARNING alert (high latency/loss)
 * - 2 consecutive healthy  -> RECOVERY alert
 */
async function evaluateDeviceHealth(device, metric) {
  if (!healthTrackers.has(device.id)) {
    healthTrackers.set(device.id, {
      failCount: 0,
      warnCount: 0,
      okCount: 0,
      currentStatus: device.status || 'online'
    });
  }

  const track = healthTrackers.get(device.id);

  // Jika tidak ada data telemetri baru dari InfluxDB (misal Telegraf/VM baru menyala),
  // pertahankan status terakhir dan jangan reset penghitung error.
  if (metric.has_data === false) {
    return track.currentStatus;
  }

  const isOffline = metric.packetLoss >= 100 || (metric.latency === 0 && metric.packetLoss > 0);
  const isWarning = !isOffline && (metric.packetLoss > 2 || metric.latency > 45);

  if (isOffline) {
    track.failCount++;
    track.warnCount = 0;
    track.okCount = 0;

    if (track.failCount >= 2 && track.currentStatus !== 'offline') {
      track.currentStatus = 'offline';
      await emitEvent(device.id, device.name, EVENT_TYPES.OFFLINE, metric.packetLoss);
      const existingIncident = await getActiveIncidentForDevice(device.id);
      if (existingIncident) {
        await updateIncidentSeverity(device.id, 'critical', INCIDENT_STATES.OFFLINE, metric);
      } else {
        await createIncident(device.id, device.name, 'critical', INCIDENT_STATES.OFFLINE, metric);
      }
      await triggerAlert({
        deviceId: device.id,
        type: 'connection_lost',
        title: 'Host Unreachable (100% Packet Loss)',
        target: `${device.name} (${device.ip_address})`,
        severity: 'critical'
      });
      await updateDeviceStatusInDb(device.id, 'offline', 0, 100);
    }
  } else if (isWarning) {
    track.warnCount++;
    track.failCount = 0;
    track.okCount = 0;

    if (track.warnCount >= 2 && track.currentStatus !== 'warning') {
      track.currentStatus = 'warning';
      const eventType = metric.latency > 45 ? EVENT_TYPES.LATENCY_HIGH : EVENT_TYPES.PACKET_LOSS_HIGH;
      await emitEvent(device.id, device.name, eventType, metric.latency || metric.packetLoss);
      await createIncident(device.id, device.name, 'warning', INCIDENT_STATES.WARNING, metric);
      await triggerAlert({
        deviceId: device.id,
        type: 'degraded',
        title: `Latency Degradation (${metric.latency}ms, ${metric.packetLoss}% Loss)`,
        target: `${device.name} (${device.ip_address})`,
        severity: 'warning'
      });
      await updateDeviceStatusInDb(device.id, 'warning', metric.latency, metric.packetLoss);
    }
  } else {
    track.okCount++;
    track.failCount = 0;
    track.warnCount = 0;

    if (track.okCount >= 2 && (track.currentStatus === 'offline' || track.currentStatus === 'warning')) {
      const prevStatus = track.currentStatus;
      track.currentStatus = 'online';
      await emitEvent(device.id, device.name, EVENT_TYPES.ONLINE, metric.latency);
      await closeIncident(device.id, INCIDENT_STATES.RECOVERED, metric);
      await triggerAlert({
        deviceId: device.id,
        type: 'recovered',
        title: prevStatus === 'offline' ? 'Device Recovered & Connection Stable' : 'Latency Normalized (< 45ms)',
        target: `${device.name} (${device.ip_address})`,
        severity: 'info'
      });
      await updateDeviceStatusInDb(device.id, 'online', metric.latency, 0);
    }
  }

  return track.currentStatus;
}

async function updateDeviceStatusInDb(deviceId, status, latency, packetLoss) {
  if (db.isPostgresConnected()) {
    try {
      await db.query(
        `UPDATE devices SET status = $1, ping_latency = $2, packet_loss = $3, last_seen = NOW() WHERE id = $4`,
        [status, latency, packetLoss, deviceId]
      );
    } catch (e) {
      console.error('[DB Status Update Error]', e.message);
    }
  }
  const memDev = db.getMemoryStore().devices.find(d => d.id === deviceId);
  if (memDev) {
    memDev.status = status;
    memDev.ping_latency = latency;
    memDev.packet_loss = packetLoss;
  }
}

/**
 * Update ping_latency & packet_loss real-time ke DB tanpa mengubah status.
 * Dipanggil setiap tick agar data di DB selalu fresh (tidak stale).
 */
async function updateDeviceMetricsInDb(deviceId, latency, packetLoss) {
  if (db.isPostgresConnected()) {
    try {
      await db.query(
        `UPDATE devices SET ping_latency = $1, packet_loss = $2, last_seen = NOW() WHERE id = $3`,
        [latency, packetLoss, deviceId]
      );
    } catch (e) {
      // silent - jangan spam log tiap detik
    }
  }
  const memDev = db.getMemoryStore().devices.find(d => d.id === deviceId);
  if (memDev) {
    memDev.ping_latency = latency;
    memDev.packet_loss = packetLoss;
  }
}

async function triggerAlert(alertData) {
  // Dedup: skip kalau alert dengan type+device+status active sudah ada dalam 5 menit terakhir
  // (menghindari spam alert saat flapping device)
  const recent = db.getMemoryStore().alerts.find(a =>
    a.device_id === alertData.deviceId &&
    a.type === alertData.type &&
    a.status === 'active' &&
    (Date.now() - new Date(a.created_at).getTime()) < 5 * 60 * 1000
  );
  if (recent) {
    return; // skip duplicate
  }

  const alert = {
    id: Date.now(),
    device_id: alertData.deviceId,
    type: alertData.type,
    title: alertData.title,
    target: alertData.target,
    severity: alertData.severity,
    status: 'active',
    created_at: new Date().toISOString()
  };

  // 1. Insert into PostgreSQL (dengan menyertakan device_id)
  if (db.isPostgresConnected()) {
    try {
      await db.query(
        `INSERT INTO alerts (device_id, type, title, target, severity, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [alert.device_id, alert.type, alert.title, alert.target, alert.severity, alert.status, alert.created_at]
      );
    } catch (err) {
      console.error('[StreamService DB Alert Insert Error]', err.message);
    }
  }

  // 2. Insert into memory store
  db.getMemoryStore().alerts.unshift(alert);

  // 3. Broadcast via WebSocket
  broadcastNewAlert(alert);
}

function broadcastNewAlert(alert) {
  if (!wss) return;
  const payload = JSON.stringify({
    type: 'NEW_ALERT',
    alert
  });

  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

module.exports = {
  initStreamService,
  broadcastNewAlert,
  getRealTimeInterfaces,
  realTimeSnmpPoll,
  getRealTimeInterfaceMbps,
  realTimePing,
  getRealTimeSystemInfo
};
