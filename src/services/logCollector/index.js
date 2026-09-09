/**
 * Log Collector orchestrator.
 * Alur: source (syslog UDP/TCP, SNMP trap) → parser/normalizer →
 *       store (RAW audit trail + korelasi Event) → WebSocket broadcast.
 * Adapter extensible: tambah source baru = tambah file di ./sources dengan
 * kontrak { start({onMessage}), stop? } — inti tidak berubah.
 */
const syslogSource = require('./sources/syslog');
const snmpTrapSource = require('./sources/snmpTrap');
const store = require('./store');

let syslogHandle = null;
let trapHandle = null;
let retentionTimer = null;
let broadcastFn = null;

const SYSLOG_PORT = parseInt(process.env.SYSLOG_PORT || '5514', 10);
const SYSLOG_HOST = process.env.SYSLOG_HOST || '0.0.0.0';
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);

/**
 * @param {{ broadcast?: (deviceId:number, log:object) => void }} deps
 */
async function initLogCollector({ broadcast } = {}) {
  broadcastFn = broadcast || null;

  // Syslog (UDP + TCP) — sumber utama device logs.
  syslogHandle = await syslogSource.start({
    port: SYSLOG_PORT,
    host: SYSLOG_HOST,
    onMessage: async (msg) => {
      try {
        const dev = await store.resolveDevice(msg.sourceIp, msg.hostname);
        const rec = await store.insertLog({
          ...msg,
          deviceId: dev ? dev.id : null,
          deviceName: dev ? dev.name : null
        });
        // Realtime: broadcast hanya ke subscriber device tsb.
        if (dev && rec && broadcastFn) {
          try { broadcastFn(dev.id, rec); } catch (e) { /* ignore */ }
        }
      } catch (e) {
        console.warn('[LogCollector] onMessage error:', e.message);
      }
    }
  });

  // SNMP Trap — opsional (env SNMP_TRAP_ENABLED=true + snmptrapd).
  try {
    trapHandle = snmpTrapSource.start({
      onMessage: async (msg) => {
        try {
          const dev = await store.resolveDevice(msg.sourceIp, msg.hostname);
          const rec = await store.insertLog({
            ...msg,
            deviceId: dev ? dev.id : null,
            deviceName: dev ? dev.name : null
          });
          if (dev && rec && broadcastFn) {
            try { broadcastFn(dev.id, rec); } catch (e) { /* ignore */ }
          }
        } catch (e) {
          console.warn('[LogCollector] trap onMessage error:', e.message);
        }
      }
    });
  } catch (e) {
    trapHandle = { started: false, status: 'unavailable', reason: e.message };
  }

  // Retensi berkala (default 7 hari).
  retentionTimer = setInterval(() => {
    store.cleanup(LOG_RETENTION_DAYS).catch(() => {});
  }, 24 * 60 * 60 * 1000);
  if (retentionTimer.unref) retentionTimer.unref();

  return {
    syslog: { ...syslogHandle },
    snmpTrap: trapHandle ? { started: trapHandle.started, status: trapHandle.status, reason: trapHandle.reason } : null,
    retentionDays: LOG_RETENTION_DAYS,
    getLogs: store.getLogs,
    status: store.status
  };
}

function stop() {
  if (syslogHandle && syslogHandle.close) syslogHandle.close();
  if (trapHandle && trapHandle.stop) trapHandle.stop();
  if (retentionTimer) clearInterval(retentionTimer);
}

module.exports = { initLogCollector, stop };
