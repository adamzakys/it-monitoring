const db = require('../db');

const SEVERITY_ORDER = { info: 0, warning: 1, critical: 2 };

const STATUS = {
  ACTIVE: 'active',
  RESOLVED: 'resolved'
};

const INCIDENT_STATES = {
  ONLINE: 'ONLINE',
  WARNING: 'WARNING',
  OFFLINE: 'OFFLINE',
  RECOVERED: 'RECOVERED'
};

const memoryIncidents = new Map();
const pendingCreations = new Set();

function generateIncidentId(deviceId) {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `inc-${deviceId}-${timestamp}-${randomPart}`;
}

function getStatusHistoryLabel(eventType, metric) {
  switch (eventType) {
    case INCIDENT_STATES.WARNING:
      if (metric && metric.latency > 45) {
        return `Warning triggered (latency ${metric.latency}ms > 45ms threshold)`;
      }
      if (metric && metric.packetLoss > 2) {
        return `Warning triggered (packet loss ${metric.packetLoss}% > 2% threshold)`;
      }
      return 'Warning triggered';
    case INCIDENT_STATES.OFFLINE:
      if (metric) {
        if (metric.packetLoss >= 100) {
          return `Device unreachable (${metric.packetLoss}% packet loss)`;
        }
        if (metric.latency === 0 && metric.packetLoss > 0) {
          return `Device unreachable (${metric.packetLoss}% loss, latency timeout)`;
        }
        if (metric.packetLoss > 0) {
          return `Device unreachable (${metric.packetLoss}% packet loss)`;
        }
      }
      return 'Device unreachable (offline)';
    case INCIDENT_STATES.RECOVERED:
      return 'Device recovered (online)';
    case INCIDENT_STATES.ONLINE:
      return 'Device online';
    default:
      return `State changed: ${eventType}`;
  }
}

function buildRootCause(eventType, metric) {
  if (eventType === INCIDENT_STATES.OFFLINE) {
    if (metric && metric.packetLoss >= 100) {
      return {
        rule: 'packet_loss_total',
        threshold: 100,
        observed: metric.packetLoss,
        message: 'Device stopped responding. 100% packet loss detected.'
      };
    }
    if (metric && metric.latency === 0 && metric.packetLoss > 0) {
      return {
        rule: 'latency_timeout',
        threshold: 0,
        observed: metric.latency,
        message: 'Device stopped responding. Latency timeout with packet loss.'
      };
    }
    return {
      rule: 'device_unreachable',
      threshold: null,
      observed: metric?.packetLoss ?? null,
      message: 'Device stopped responding.'
    };
  }
  if (eventType === INCIDENT_STATES.WARNING) {
    if (metric && metric.latency > 45) {
      return {
        rule: 'latency_threshold',
        threshold: 45,
        observed: metric.latency,
        message: `Latency exceeded warning threshold (${metric.latency}ms > 45ms).`
      };
    }
    if (metric && metric.packetLoss > 2) {
      return {
        rule: 'packet_loss_threshold',
        threshold: 2,
        observed: metric.packetLoss,
        message: `Packet loss exceeded warning threshold (${metric.packetLoss}% > 2%).`
      };
    }
    return {
      rule: 'performance_degraded',
      threshold: null,
      observed: metric?.latency ?? metric?.packetLoss ?? null,
      message: 'Device performance degraded.'
    };
  }
  if (eventType === INCIDENT_STATES.ONLINE || eventType === INCIDENT_STATES.RECOVERED) {
    return {
      rule: 'connectivity_restored',
      threshold: null,
      observed: metric?.latency ?? null,
      message: 'Device connectivity restored.'
    };
  }
  return {
    rule: 'unknown',
    threshold: null,
    observed: null,
    message: 'Unknown root cause.'
  };
}

function createEvidence(metric, existingEvidence = null) {
  const ev = existingEvidence ? { ...existingEvidence } : {};
  if (metric) {
    if (metric.latency != null) {
      if (ev.hasOwnProperty('maxLatency')) {
        ev.maxLatency = Math.max(ev.maxLatency, metric.latency);
      } else {
        ev.maxLatency = metric.latency;
      }
    }
    if (metric.packetLoss != null) {
      if (ev.hasOwnProperty('maxPacketLoss')) {
        ev.maxPacketLoss = Math.max(ev.maxPacketLoss, metric.packetLoss);
      } else {
        ev.maxPacketLoss = metric.packetLoss;
      }
    }
    if (metric.inMbps != null) {
      if (ev.hasOwnProperty('maxInMbps')) {
        ev.maxInMbps = Math.max(ev.maxInMbps, metric.inMbps);
      } else {
        ev.maxInMbps = metric.inMbps;
      }
    }
    if (metric.outMbps != null) {
      if (ev.hasOwnProperty('maxOutMbps')) {
        ev.maxOutMbps = Math.max(ev.maxOutMbps, metric.outMbps);
      } else {
        ev.maxOutMbps = metric.outMbps;
      }
    }
  }
  return ev;
}

function addStatusHistoryEntry(incident, newEventType, metric) {
  if (!incident.statusHistory) {
    incident.statusHistory = [];
  }
  incident.statusHistory.push({
    status: newEventType,
    event: getStatusHistoryLabel(newEventType, metric),
    timestamp: new Date().toISOString()
  });
}

async function createIncident(deviceId, deviceName, severity, eventType, metric) {
  if (pendingCreations.has(deviceId)) {
    await new Promise(r => setTimeout(r, 100));
    const existing = await getActiveIncidentForDevice(deviceId);
    if (existing) return existing;
  }
  pendingCreations.add(deviceId);

  try {
    const existingActive = await getActiveIncidentForDevice(deviceId);
    if (existingActive) {
      return existingActive;
    }

    const incidentId = generateIncidentId(deviceId);
    const rootCause = buildRootCause(eventType, metric);
    const now = new Date().toISOString();

    const incident = {
      incidentId,
      deviceId,
      deviceName,
      currentSeverity: severity,
      status: STATUS.ACTIVE,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      rootCause,
      evidence: createEvidence(metric),
      statusHistory: [
        {
          status: eventType,
          event: getStatusHistoryLabel(eventType, metric),
          timestamp: now
        }
      ]
    };

    memoryIncidents.set(deviceId, incident);

    try {
      await db.query(
        `INSERT INTO incidents (incident_id, device_id, device_name, current_severity, status, started_at, root_cause, evidence, status_history)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [incidentId, deviceId, deviceName, severity, STATUS.ACTIVE, incident.startedAt, JSON.stringify(incident.rootCause), JSON.stringify(incident.evidence), JSON.stringify(incident.statusHistory)]
      );
    } catch (err) {
      console.error('[IncidentManager] Failed to create incident:', err.message);
      memoryIncidents.delete(deviceId);
    }

    return incident;
  } finally {
    pendingCreations.delete(deviceId);
  }
}

async function updateIncidentSeverity(deviceId, newSeverity, eventType, metric) {
  const incident = await getActiveIncidentForDevice(deviceId);
  if (!incident) {
    return null;
  }

  if (SEVERITY_ORDER[newSeverity] <= SEVERITY_ORDER[incident.currentSeverity]) {
    return incident;
  }

  incident.currentSeverity = newSeverity;
  incident.rootCause = buildRootCause(eventType, metric);
  incident.evidence = createEvidence(metric, incident.evidence);
  addStatusHistoryEntry(incident, eventType, metric);

  try {
    await db.query(
      `UPDATE incidents SET current_severity = ?, root_cause = ?, evidence = ?, status_history = ? WHERE incident_id = ? AND status = ?`,
      [newSeverity, JSON.stringify(incident.rootCause), JSON.stringify(incident.evidence), JSON.stringify(incident.statusHistory), incident.incidentId, STATUS.ACTIVE]
    );
  } catch (err) {
    console.error('[IncidentManager] Failed to update incident:', err.message);
  }

  return incident;
}

async function closeIncident(deviceId, eventType, metric) {
  const incident = await getActiveIncidentForDevice(deviceId);
  if (!incident) {
    return null;
  }

  incident.status = STATUS.RESOLVED;
  incident.endedAt = new Date().toISOString();
  incident.durationMs = new Date(incident.endedAt).getTime() - new Date(incident.startedAt).getTime();
  incident.evidence = createEvidence(metric, incident.evidence);
  addStatusHistoryEntry(incident, eventType, metric);
  // Device pulih → maintenance selesai → arsip otomatis diangkat agar
  // riwayat insiden kembali tampil normal di Audit Center.
  const hadArchive = !!incident.archivedAt;
  incident.archivedAt = null;
  incident.archivedNote = null;
  incident.archivedBy = null;

  memoryIncidents.delete(deviceId);

  try {
    await db.query(
      `UPDATE incidents SET status = ?, ended_at = ?, duration_ms = ?, root_cause = ?, evidence = ?, status_history = ?,
          archived_at = NULL, archived_note = NULL, archived_by = NULL
        WHERE incident_id = ?`,
      [STATUS.RESOLVED, incident.endedAt, incident.durationMs, JSON.stringify(incident.rootCause), JSON.stringify(incident.evidence), JSON.stringify(incident.statusHistory), incident.incidentId]
    );
  } catch (err) {
    console.error('[IncidentManager] Failed to close incident:', err.message);
  }

  return incident;
}

async function getActiveIncidentForDevice(deviceId) {
  if (memoryIncidents.has(deviceId)) {
    const inc = memoryIncidents.get(deviceId);
    if (inc.status === STATUS.ACTIVE) {
      return inc;
    }
  }

  try {
    const res = await db.query(
      `SELECT * FROM incidents WHERE device_id = ? AND status = ? LIMIT 1`,
      [deviceId, STATUS.ACTIVE]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
      const incident = parseIncidentRow(row);
      memoryIncidents.set(deviceId, incident);
      return incident;
    }
  } catch (err) {
    console.error('[IncidentManager] Failed to get active incident:', err.message);
  }

  return null;
}

function parseIncidentRow(row) {
  return {
    incidentId: row.incident_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    currentSeverity: row.current_severity,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    rootCause: typeof row.root_cause === 'string' ? JSON.parse(row.root_cause) : row.root_cause,
    evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence,
    statusHistory: typeof row.status_history === 'string' ? JSON.parse(row.status_history) : (row.status_history || []),
    archivedAt: row.archived_at || null,
    archivedNote: row.archived_note || null,
    archivedBy: row.archived_by || null
  };
}

async function getAllActiveIncidents() {
  const active = [];
  for (const inc of memoryIncidents.values()) {
    // Insiden yang diarsipkan (mode maintenance) tidak masuk live feed.
    if (inc.status === STATUS.ACTIVE && !inc.archivedAt) {
      active.push(inc);
    }
  }

  try {
    const res = await db.query(
      `SELECT * FROM incidents WHERE status = ? AND archived_at IS NULL ORDER BY started_at DESC`,
      [STATUS.ACTIVE]
    );
    for (const row of res.rows) {
      if (!active.find(i => i.incidentId === row.incident_id)) {
        active.push(parseIncidentRow(row));
      }
    }
  } catch (err) {
    console.error('[IncidentManager] Failed to get active incidents:', err.message);
  }

  return active;
}

async function getArchivedIncidents(limit = 100) {
  try {
    const res = await db.query(
      `SELECT * FROM incidents WHERE archived_at IS NOT NULL
        ORDER BY archived_at DESC, started_at DESC LIMIT ?`,
      [Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)]
    );
    return res.rows.map(parseIncidentRow);
  } catch (err) {
    console.error('[IncidentManager] Failed to get archived incidents:', err.message);
    return [];
  }
}

/**
 * Arsipkan insiden (mode maintenance): hidden dari live feed & nav badge,
 * engine tetap melacak hingga device pulih. Auto-unarchive saat resolved.
 */
async function archiveIncident(incidentId, { note = null, by = null } = {}) {
  if (!incidentId) return null;
  const archivedAt = new Date().toISOString();
  try {
    const r = await db.query(
      `UPDATE incidents SET archived_at = ?, archived_note = ?, archived_by = ?
        WHERE incident_id = ? AND archived_at IS NULL`,
      [archivedAt, note ? String(note).slice(0, 300) : null, by ? String(by).slice(0, 100) : null, incidentId]
    );
    if (!r || (r.rowCount !== undefined && r.rowCount === 0)) {
      // Sudah diarsipkan atau tidak ada — ambil state terkini.
      const cur = await db.query('SELECT * FROM incidents WHERE incident_id = ?', [incidentId]);
      return (cur.rows[0] || null) ? parseIncidentRow(cur.rows[0]) : null;
    }
    // Sinkronkan mirror in-memory (device yang sama masih dilacak engine).
    for (const [devId, inc] of memoryIncidents.entries()) {
      if (inc.incidentId === incidentId) {
        inc.archivedAt = archivedAt;
        inc.archivedNote = note ? String(note).slice(0, 300) : null;
        inc.archivedBy = by ? String(by).slice(0, 100) : null;
      }
    }
    const cur = await db.query('SELECT * FROM incidents WHERE incident_id = ?', [incidentId]);
    return cur.rows[0] ? parseIncidentRow(cur.rows[0]) : null;
  } catch (err) {
    console.error('[IncidentManager] Failed to archive incident:', err.message);
    return null;
  }
}

async function unarchiveIncident(incidentId) {
  if (!incidentId) return null;
  try {
    await db.query(
      `UPDATE incidents SET archived_at = NULL, archived_note = NULL, archived_by = NULL
        WHERE incident_id = ? AND archived_at IS NOT NULL`,
      [incidentId]
    );
    for (const [, inc] of memoryIncidents.entries()) {
      if (inc.incidentId === incidentId) {
        inc.archivedAt = null;
        inc.archivedNote = null;
        inc.archivedBy = null;
      }
    }
    const cur = await db.query('SELECT * FROM incidents WHERE incident_id = ?', [incidentId]);
    return cur.rows[0] ? parseIncidentRow(cur.rows[0]) : null;
  } catch (err) {
    console.error('[IncidentManager] Failed to unarchive incident:', err.message);
    return null;
  }
}

async function getIncidentHistory(limit = 100) {
  try {
    const res = await db.query(
      `SELECT * FROM incidents WHERE status = 'resolved' ORDER BY started_at DESC LIMIT ?`,
      [limit]
    );
    return res.rows.map(parseIncidentRow);
  } catch (err) {
    console.error('[IncidentManager] Failed to get incident history:', err.message);
  }

  return Array.from(memoryIncidents.values()).slice(0, limit);
}

function clearIncidentForDevice(deviceId) {
  memoryIncidents.delete(deviceId);
}

module.exports = {
  INCIDENT_STATES,
  STATUS,
  createIncident,
  updateIncidentSeverity,
  closeIncident,
  getActiveIncidentForDevice,
  getAllActiveIncidents,
  getIncidentHistory,
  getArchivedIncidents,
  archiveIncident,
  unarchiveIncident,
  clearIncidentForDevice
};
