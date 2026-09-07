const db = require('../db');

const EVENT_TYPES = {
  ONLINE: 'ONLINE',
  WARNING: 'WARNING',
  OFFLINE: 'OFFLINE',
  LATENCY_HIGH: 'LATENCY_HIGH',
  PACKET_LOSS_HIGH: 'PACKET_LOSS_HIGH',
  CPU_HIGH: 'CPU_HIGH',
  MEMORY_HIGH: 'MEMORY_HIGH',
  STORAGE_HIGH: 'STORAGE_HIGH'
};

const SEVERITY_MAP = {
  ONLINE: 'info',
  WARNING: 'warning',
  OFFLINE: 'critical',
  LATENCY_HIGH: 'warning',
  PACKET_LOSS_HIGH: 'warning',
  CPU_HIGH: 'warning',
  MEMORY_HIGH: 'warning',
  STORAGE_HIGH: 'warning'
};

const eventInMemory = [];

const lastEventState = new Map();

function getEventSeverity(eventType) {
  return SEVERITY_MAP[eventType] || 'info';
}

function shouldEmitEvent(deviceId, eventType, value) {
  const key = `${deviceId}:${eventType}`;
  const last = lastEventState.get(key);

  if (!last) return true;

  if (last === eventType && eventType !== 'ONLINE' && eventType !== 'OFFLINE' && eventType !== 'WARNING') {
    return false;
  }

  if (last === eventType) {
    return false;
  }

  return true;
}

async function emitEvent(deviceId, deviceName, eventType, value = null, source = 'polling') {
  if (!shouldEmitEvent(deviceId, eventType, value)) {
    return null;
  }

  const key = `${deviceId}:${eventType}`;
  lastEventState.set(key, eventType);

  const event = {
    deviceId,
    deviceName,
    eventType,
    severity: getEventSeverity(eventType),
    value,
    timestamp: new Date().toISOString(),
    source
  };

  eventInMemory.unshift(event);
  if (eventInMemory.length > 1000) {
    eventInMemory.pop();
  }

  if (db.isPostgresConnected()) {
    try {
      await db.query(
        `INSERT INTO events (device_id, device_name, event_type, severity, value, source, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [deviceId, deviceName, eventType, event.severity, value, source, event.timestamp]
      );
    } catch (err) {
      console.error('[EventLogger] Failed to persist event:', err.message);
    }
  }

  return event;
}

async function getEvents(limit = 100) {
  if (db.isPostgresConnected()) {
    try {
      const res = await db.query(
        `SELECT * FROM events ORDER BY timestamp DESC LIMIT $1`,
        [limit]
      );
      return res.rows;
    } catch (err) {
      console.error('[EventLogger] Failed to fetch events:', err.message);
    }
  }
  return eventInMemory.slice(0, limit);
}

function clearStateForDevice(deviceId) {
  for (const key of lastEventState.keys()) {
    if (key.startsWith(`${deviceId}:`)) {
      lastEventState.delete(key);
    }
  }
}

module.exports = {
  EVENT_TYPES,
  emitEvent,
  getEvents,
  shouldEmitEvent,
  clearStateForDevice
};
