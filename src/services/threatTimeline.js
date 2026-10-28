/**
 * Threat Timeline — Correlation Engine
 * ----------------------------------------------------------------------------
 * Mengubah kumpulan baris `device_logs` menjadi SESI incident yang bisa dibaca
 * manusia, tanpa mengubah satu byte pun isi raw log.
 *
 * Model pengelompokan (lihat juga threatRules.js):
 *   - Satu device hanya punya SATU sesi terbuka pada satu waktu.
 *   - Event baru yang masih dalam jendela sesi memperluas sesi itu; bila jeda
 *     melewati jendela, sesi lama ditutup dan sesi baru dibuka.
 *   - Saat sebuah rule terkonfirmasi (mis. 3 login gagal dalam 5 menit),
 *     baris-baris log yang menjadi buktinya di-retro-attach ke sesi tersebut,
 *     sehingga urutan kronologisnya utuh: gagal berulang → berhasil → dst.
 *   - Baris tanpa rule tetap dibiarkan `threat_key = NULL` dan tetap tampil
 *     sebagai event individual (fallback), tidak pernah dibuang.
 *
 * Poros waktu memakai `received_at` (jam server), bukan `device_timestamp`,
 * karena jam perangkat tidak dapat dipercaya: pada data production, satu baris
 * bertanggal perangkat 01:25:37 tercatat diterima 12:29:42 (selisih ~11 jam).
 * Mengurutkan dengan campuran dua jam akan menghasilkan kronologi yang salah;
 * `device_timestamp` tetap ditampilkan dan selisihnya diekspos sebagai
 * `clockDriftMs` supaya bisa dinilai pengguna.
 */

'use strict';

const db = require('../db');
const threatRules = require('./threatRules');
const eventLogger = require('./eventLogger');

const ENABLED = process.env.THREAT_ENABLED !== 'false';
const SESSION_WINDOW_MS = Math.max(60000, parseInt(process.env.THREAT_SESSION_WINDOW_MS || String(15 * 60 * 1000), 10) || 15 * 60 * 1000);
const RESOLVE_AFTER_MS = Math.max(60000, parseInt(process.env.THREAT_RESOLVE_AFTER_MS || String(SESSION_WINDOW_MS), 10) || SESSION_WINDOW_MS);
const BACKFILL_ENABLED = process.env.THREAT_BACKFILL !== 'false';
const RESOLVE_SWEEP_MS = 30000;
const MAX_WINDOW_ROWS = 300;

let resolveTimer = null;
let backfillRunning = false;

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function newThreatKey(deviceId) {
  return `thr-${deviceId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Catat sesi threat ke tabel `events` (Activity Log) dengan severity yang
 * benar. Tanpa ini, seluruh korelasi log akan terpaksa tampil sebagai WARNING
 * karena SEVERITY_MAP lama bersifat tetap per tipe.
 */
function emitThreatEvent(deviceId, deviceName, incident, kind) {
  try {
    const type = kind === 'ack' ? eventLogger.EVENT_TYPES.THREAT_ACKNOWLEDGED
      : kind === 'resolved' ? eventLogger.EVENT_TYPES.THREAT_RESOLVED
        : (incident && incident.severity === 'critical'
          ? eventLogger.EVENT_TYPES.THREAT_CRITICAL
          : eventLogger.EVENT_TYPES.THREAT_WARNING);
    eventLogger
      .emitEvent(deviceId, deviceName || null, type, incident ? incident.eventCount : null, 'syslog')
      .catch(() => {});
  } catch (e) {
    // Pencatatan event bersifat pelengkap — jangan ganggu jalur utama.
  }
}

function toMs(value) {
  if (!value) return Date.now();
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function ruleIncidentSeverity(severity) {
  const rank = threatRules.severityRank(severity);
  return rank <= threatRules.severityRank('error') ? 'critical' : 'warning';
}

/** Norm untuk predicate rule — dari record store (camelCase) atau baris DB. */
function buildNorm(row) {
  return {
    message: row.message || '',
    severity: row.severity || 'info',
    program: row.program || '',
    facility: row.facility || '',
    topics: threatRules.normalizeTopics(row.topics),
    category: row.category || null
  };
}

/** Bentuk publik satu event log (dipakai API; raw_message diteruskan apa adanya). */
function toEvent(row) {
  const deviceTs = row.device_timestamp ? new Date(row.device_timestamp) : null;
  const recvTs = row.received_at ? new Date(row.received_at) : null;
  const driftMs = deviceTs && recvTs && !isNaN(deviceTs.getTime()) && !isNaN(recvTs.getTime())
    ? recvTs.getTime() - deviceTs.getTime()
    : null;
  return {
    id: row.id,
    threatKey: row.threat_key || null,
    receivedAt: row.received_at || null,
    deviceTimestamp: row.device_timestamp || null,
    timeBasis: deviceTs ? 'device' : 'server',
    clockDriftMs: driftMs,
    severity: row.severity || 'info',
    sourceType: row.source_type || null,
    sourceIp: row.source_ip || null,
    transport: row.transport || null,
    facility: row.facility || null,
    program: row.program || null,
    category: row.category || null,
    topics: row.topics || null,
    message: row.message || '',
    rawMessage: row.raw_message || '',
    correlatedEventType: row.correlated_event_type || null
  };
}

function toIncident(row) {
  return {
    threatKey: row.threat_key,
    deviceId: row.device_id,
    deviceName: row.device_name || null,
    title: row.title,
    severity: row.currentSeverity || row.severity || 'warning',
    status: row.status,
    category: row.category || null,
    topics: row.topics || null,
    matchedRules: row.matchedRules || row.matched_rules || [],
    startedAt: row.startedAt || row.started_at,
    lastEventAt: row.lastEventAt || row.last_event_at,
    eventCount: Number(row.eventCount ?? row.event_count ?? 0),
    firstLogId: row.firstLogId ?? row.first_log_id ?? null,
    lastLogId: row.lastLogId ?? row.last_log_id ?? null,
    ackedAt: row.ackedAt || row.acked_at || null,
    ackedBy: row.ackedBy || row.acked_by || null,
    resolvedAt: row.resolvedAt || row.resolved_at || null,
    autoResolved: row.autoResolved ?? row.auto_resolved ?? false,
    evidence: row.evidence || {},
    events: []
  };
}

// ---------------------------------------------------------------------------
// Akses sesi
// ---------------------------------------------------------------------------

function memStore() {
  const store = db.getMemoryStore();
  if (!store.threat_incidents) store.threat_incidents = [];
  return store.threat_incidents;
}

async function getOpenSession(deviceId) {
  const r = await db.query(
    `SELECT * FROM threat_incidents WHERE device_id = ? AND status = 'open'
      ORDER BY last_event_at DESC LIMIT 1`,
    [deviceId]
  );
  return r && r.rows.length ? r.rows[0] : null;
}

async function createSession(deviceId, deviceName, atMs, rule, category, topics) {
  const threatKey = newThreatKey(deviceId);
  const iso = new Date(atMs).toISOString();

  const r = await db.query(
    `INSERT INTO threat_incidents
       (threat_key, device_id, device_name, title, severity, status, category, topics,
        matched_rules, started_at, last_event_at, event_count)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 0)
     RETURNING *`,
    [threatKey, deviceId, deviceName, rule.title, ruleIncidentSeverity(rule.severity),
      category, topics.join(',') || null, JSON.stringify([rule.id]), iso, iso]
  );
  return r.rows[0];
}

async function closeSession(threatKey, auto = true) {
  const r = await db.query(
    `UPDATE threat_incidents
        SET status = 'resolved', resolved_at = datetime('now'), auto_resolved = ?
      WHERE threat_key = ? AND status = 'open'
      RETURNING *`,
    [auto ? 1 : 0, threatKey]
  );
  return r && r.rows.length ? r.rows[0] : null;
}

/**
 * Baris kandidat dalam jendela waktu (sudah termasuk baris yang baru masuk,
 * karena insert-nya sudah selesai sebelum ingest dipanggil).
 */
async function fetchWindowRows(deviceId, fromMs, toMsValue, limit = MAX_WINDOW_ROWS) {
  // julianday(): robusta terhadap duet format timestamp (ISO '...T...Z' dari
  // store.insertLog dan spasi 'YYYY-MM-DD HH:MM:SS' dari DEFAULT CURRENT_TIMESTAMP).
  const r = await db.query(
    `SELECT id, message, severity, program, facility, topics, category,
            raw_message, threat_key, received_at
       FROM device_logs
      WHERE device_id = ? AND julianday(received_at) >= julianday(?) AND julianday(received_at) <= julianday(?)
      ORDER BY received_at ASC, id ASC
      LIMIT ?`,
    // Batas atas +1 ms: `received_at` bertimestamp mikrodetik, sedangkan
    // Date di JavaScript hanya milidetik. Tanpa toleransi ini, baris yang
    // sedang diproses akan terpotong dari jendelanya sendiri sehingga sesi
    // beranggota tunggal berakhir dengan event_count = 0.
    [deviceId, new Date(fromMs).toISOString(), new Date(toMsValue + 1).toISOString(), limit]
  );
  return r ? r.rows : [];
}

async function attachRows(threatKey, ids) {
  const list = [...new Set(ids.filter(id => id != null))];
  if (list.length === 0) return 0;
  const r = await db.query(
    `UPDATE device_logs SET threat_key = ?
      WHERE id = ? AND threat_key IS NULL`,
    [threatKey, list[0]]
  );
  // Note: SQLite doesn't support ANY(array), so we update one at a time or use IN
  if (list.length > 1) {
    const placeholders = list.map(() => '?').join(',');
    await db.query(
      `UPDATE device_logs SET threat_key = ? WHERE id IN (${placeholders}) AND threat_key IS NULL`,
      [threatKey, ...list]
    );
  }
  return list.length;
}

/**
 * Hitung ulang agregat sesi langsung dari data log, sehingga `event_count`,
 * `first_log_id`, dan `last_log_id` dijamin konsisten dengan isi tabel
 * (dipakai sebagai bukti anti-duplikasi).
 */
async function refreshAggregates(threatKey) {
  // SQLite UPDATE…FROM memakai penamaan `AS alias` (PG gaya `UPDATE t` tidak valid).
  const r = await db.query(
    `UPDATE threat_incidents AS t
        SET event_count  = agg.n,
            first_log_id = agg.first_id,
            last_log_id  = agg.last_id,
            last_event_at = COALESCE(agg.last_at, t.last_event_at)
       FROM (
         SELECT count(*) AS n, min(id) AS first_id, max(id) AS last_id,
                max(received_at) AS last_at
           FROM device_logs WHERE threat_key = ?
       ) agg
      WHERE t.threat_key = ?
      RETURNING *`,
    [threatKey, threatKey]
  );
  return r && r.rows.length ? r.rows[0] : null;
}

async function updateSession(threatKey, { rule, category, topics, severity, matchedRules, eventMs }) {
  const r = await db.query(
    `UPDATE threat_incidents
        SET title = ?, category = ?, topics = ?, severity = ?,
            matched_rules = ?
      WHERE threat_key = ?
      RETURNING *`,
    [rule.title, category, topics.join(',') || null, severity, JSON.stringify(matchedRules), threatKey]
  );
  return r && r.rows.length ? r.rows[0] : null;
}

// ---------------------------------------------------------------------------
// Ingest — dipanggil logCollector setelah insertLog
// ---------------------------------------------------------------------------

/**
 * @param {object} log  record hasil `store.insertLog` (butuh id, deviceId,
 *                      receivedAt, message, severity, program, facility,
 *                      topics, category, rawMessage)
 * @param {{silent?:boolean}} opts  silent = jangan broadcast (dipakai backfill)
 * @returns {Promise<null|{threatKey:string, incident:object, event:object}>}
 */
async function ingest(log, opts = {}) {
  if (!ENABLED || !log) return null;
  if (log.deviceId == null) return null; // sesi harus melekat pada device terdaftar

  const eventMs = toMs(log.receivedAt);
  const norm = buildNorm(log);

  const accHits = threatRules.matchAccumulative(norm);
  const seqHits = threatRules.matchSequenceTriggers(norm);
  if (accHits.length === 0 && seqHits.length === 0) return null;

  const windowMs = threatRules.effectiveWindowMs([...accHits, ...seqHits], SESSION_WINDOW_MS);
  const rows = await fetchWindowRows(log.deviceId, eventMs - windowMs, eventMs);

  // Konfirmasi rule: ambang minEvents dihitung dari baris nyata di jendela.
  const confirmed = [];
  const attachIds = new Set();
  for (const rule of accHits) {
    if (rule.minEvents <= 1) {
      confirmed.push(rule);
      for (const row of rows) {
        if (rule.match(buildNorm(row))) attachIds.add(row.id);
      }
      continue;
    }
    const matches = rows.filter(row => rule.match(buildNorm(row)));
    if (matches.length >= rule.minEvents) {
      confirmed.push(rule);
      for (const row of matches) attachIds.add(row.id);
    }
  }
  for (const rule of seqHits) {
    const since = eventMs - (rule.requires.maxAgeMs || windowMs);
    const matches = rows.filter(row => {
      if (toMs(row.received_at) < since) return false;
      const pattern = rule.requires.pattern;
      const msg = row.message || '';
      // `pattern` boleh RegExp atau predikat fungsi (dipakai rule yang butuh
      // pengecualian, mis. mengabaikan loopback).
      return typeof pattern === 'function' ? pattern(msg) : pattern.test(msg);
    });
    if (matches.length >= rule.requires.minBefore) {
      confirmed.push(rule);
      for (const row of matches) attachIds.add(row.id);
    }
  }
  if (confirmed.length === 0) return null; // event individual (fallback), tetap tersimpan

  // Baris yang sedang diproses pasti bagian dari bukti rule yang dikonfirmasi,
  // jadi selalu ikut dilampirkan (tidak bergantung pada pembulatan timestamp).
  if (log.id != null) {
    const selfMatches = confirmed.some(rule =>
      rule.kind === 'sequence' ? rule.trigger(norm) : rule.match(norm));
    if (selfMatches) attachIds.add(log.id);
  }

  const winner = threatRules.highestPriority(confirmed);
  const severity = confirmed.reduce((acc, r) => threatRules.escalateIncidentSeverity(acc, ruleIncidentSeverity(r.severity)), 'warning');
  const topics = [...new Set([
    ...threatRules.normalizeTopics(log.topics),
    ...rows.flatMap(r => threatRules.normalizeTopics(r.topics))
  ])].slice(0, 12);

  // Perluas sesi terbuka bila masih dalam jendela; kalau tidak, tutup dan buka baru.
  let session = await getOpenSession(log.deviceId);
  let created = false;
  let escalated = false;
  if (session && (eventMs - toMs(session.last_event_at || session.lastEventAt)) <= SESSION_WINDOW_MS) {
    const prevRules = Array.isArray(session.matched_rules) ? session.matched_rules
      : Array.isArray(session.matchedRules) ? session.matchedRules : [];
    const union = [...new Set([...prevRules, ...confirmed.map(r => r.id)])];
    const ordered = union
      .map(id => threatRules.getRule(id))
      .filter(Boolean)
      .sort((a, b) => b.priority - a.priority)
      .map(r => r.id);
    const prevSeverity = session.currentSeverity || session.severity || 'warning';
    const nextSeverity = threatRules.escalateIncidentSeverity(prevSeverity, severity);
    escalated = prevSeverity !== 'critical' && nextSeverity === 'critical';
    // Judul & kategori diambil dari rule berprioritas tertinggi di seluruh
    // gabungan rule sesi (bukan hanya rule yang baru cocok), supaya sesi yang
    // dibuka oleh reboot tidak berubah judul saat tersentuh DHCP.
    const unionWinner = threatRules.getRule(ordered[0]) || winner;
    // Eskalasi pola juga dicatat: sesi yang naik dari "Critical severity log"
    // menjadi "Successful login after repeated failures" layak muncul di
    // Activity Log, bukan hanya di timeline.
    if (prevRules[0] && unionWinner && prevRules[0] !== unionWinner.id) escalated = true;
    session = await updateSession(
      session.threat_key || session.threatKey,
      {
        rule: unionWinner,
        category: unionWinner.category,
        topics,
        severity: nextSeverity,
        matchedRules: ordered,
        eventMs
      }
    );
  } else {
    if (session) {
      const closed = await closeSession(session.threat_key || session.threatKey, true);
      if (closed && !opts.silent) {
        emitThreatEvent(closed.device_id, closed.device_name, toIncident(closed), 'resolved');
      }
    }
    session = await createSession(log.deviceId, log.deviceName || null, eventMs, winner, winner.category, topics);
    created = true;
  }

  const threatKey = session.threat_key || session.threatKey;
  const attached = await attachRows(threatKey, [...attachIds]);
  const finalRow = await refreshAggregates(threatKey);
  const incident = toIncident(finalRow || session);

  if (!opts.silent && (created || escalated)) {
    emitThreatEvent(log.deviceId, log.deviceName, incident, 'detected');
  }

  const event = toEvent({
    id: log.id,
    threat_key: threatKey,
    received_at: log.receivedAt,
    device_timestamp: log.deviceTimestamp || log.device_timestamp || null,
    severity: log.severity,
    source_type: log.sourceType || 'syslog',
    source_ip: log.sourceIp || null,
    transport: log.transport || null,
    facility: log.facility,
    program: log.program,
    category: log.category,
    topics: log.topics,
    message: log.message,
    raw_message: log.rawMessage || '',
    correlated_event_type: log.correlatedEventType || null
  });

  const result = { threatKey, created, attached, incident, event };
  if (!opts.silent) {
    try {
      const streamService = require('./streamService');
      streamService.broadcastThreatIncident(log.deviceId, { incident, event });
    } catch (e) {
      console.warn('[ThreatTimeline] broadcast failed:', e.message);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Auto-resolve
// ---------------------------------------------------------------------------

async function resolveStale() {
  if (!ENABLED) return 0;
  const r = await db.query(
    `UPDATE threat_incidents
        SET status = 'resolved', resolved_at = datetime('now'), auto_resolved = 1
      WHERE status = 'open'
        AND julianday(last_event_at) < julianday('now', '-' || ? || ' seconds')
      RETURNING *`,
    // julianday() tidak menerima modifier 'milliseconds' → konversi ke sekond.
    [String(Math.max(1, Math.ceil(RESOLVE_AFTER_MS / 1000)))]
  );
  const rows = r ? r.rows : [];
  for (const row of rows) {
    emitThreatEvent(row.device_id, row.device_name, toIncident(row), 'resolved');
    try {
      const streamService = require('./streamService');
      streamService.broadcastThreatIncident(row.device_id, { incident: toIncident(row), event: null });
    } catch (e) { /* broadcast opsional */ }
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Backfill — menurunkan topics/category untuk baris lama, lalu mengelompokkannya
// ---------------------------------------------------------------------------

/**
 * Baris lama belum punya topics/category (kolom baru). Backfill menurunkannya
 * dari raw_message TANPA mengubah isi raw_message, lalu menjalankan ingest
 * secara kronologis sehingga sesi terbentuk dari data historis nyata.
 */
async function backfill({ batchSize = 200, maxBatches = 50 } = {}) {
  if (!ENABLED || !BACKFILL_ENABLED || backfillRunning) return { processed: 0, skipped: true };
  if (!db.isPostgresConnected()) return { processed: 0, skipped: 'no-postgres' };
  backfillRunning = true;
  let processed = 0;
  try {
    for (let b = 0; b < maxBatches; b++) {
      const r = await db.query(
        `SELECT l.id, l.device_id, d.name AS device_name, l.message, l.severity,
                l.program, l.facility, l.raw_message, l.received_at,
                l.device_timestamp, l.source_ip, l.source_type, l.transport
           FROM device_logs l
           LEFT JOIN devices d ON d.id = l.device_id
          WHERE l.category IS NULL
          ORDER BY l.received_at ASC, l.id ASC
          LIMIT ?`,
        [batchSize]
      );
      const rows = r ? r.rows : [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const topics = threatRules.deriveTopicsFromRaw(row.raw_message);
        const category = threatRules.deriveCategory({
          message: row.message,
          severity: row.severity,
          program: row.program,
          facility: row.facility,
          topics
        });
        await db.query(
          `UPDATE device_logs SET topics = ?, category = ? WHERE id = ?`,
          [topics.join(',') || null, category, row.id]
        );
        await ingest({
          id: row.id,
          deviceId: row.device_id,
          deviceName: row.device_name,
          receivedAt: row.received_at,
          deviceTimestamp: row.device_timestamp,
          message: row.message,
          severity: row.severity,
          program: row.program,
          facility: row.facility,
          sourceIp: row.source_ip,
          sourceType: row.source_type,
          transport: row.transport,
          topics: topics.join(',') || null,
          category,
          rawMessage: row.raw_message
        }, { silent: true });
        processed++;
      }
      if (rows.length < batchSize) break;
    }
  } catch (e) {
    console.warn('[ThreatTimeline] backfill error:', e.message);
  } finally {
    backfillRunning = false;
  }
  if (processed > 0) console.log(`[ThreatTimeline] Backfill selesai: ${processed} baris log dikategorikan & dikelompokkan.`);
  return { processed, skipped: false };
}

// ---------------------------------------------------------------------------
// Query untuk API
// ---------------------------------------------------------------------------

async function getTimelineForDevice(deviceId, { includeResolved = false, incidentLimit = 20, looseLimit = 50 } = {}) {
  if (!db.isPostgresConnected()) {
    const sessions = memStore()
      .filter(s => s.deviceId === deviceId && (includeResolved || s.status !== 'resolved'))
      .sort((a, b) => toMs(b.lastEventAt) - toMs(a.lastEventAt))
      .slice(0, incidentLimit);
    const store = require('./logCollector/store');
    const logs = await store.getLogs(deviceId, 500, 0);
    const incidents = sessions.map(s => {
      const inc = toIncident(s);
      inc.events = (logs || []).filter(l => (l.threatKey || l.threat_key) === inc.threatKey).map(r => toEvent({
        id: r.id, threat_key: inc.threatKey, received_at: r.receivedAt, device_timestamp: r.deviceTimestamp,
        severity: r.severity, source_type: r.sourceType, source_ip: r.sourceIp, transport: r.transport,
        facility: r.facility, program: r.program, category: r.category, topics: r.topics,
        message: r.message, raw_message: r.rawMessage, correlated_event_type: r.correlatedEventType
      }));
      return inc;
    });
    const looseEvents = (logs || [])
      .filter(l => !(l.threatKey || l.threat_key))
      .map(r => toEvent({
        id: r.id, threat_key: null, received_at: r.receivedAt, device_timestamp: r.deviceTimestamp,
        severity: r.severity, source_type: r.sourceType, source_ip: r.sourceIp, transport: r.transport,
        facility: r.facility, program: r.program, category: r.category, topics: r.topics,
        message: r.message, raw_message: r.rawMessage, correlated_event_type: r.correlatedEventType
      }))
      .slice(0, looseLimit);
    return { incidents, looseEvents, source: 'memory' };
  }

  const incRes = await db.query(
    `SELECT * FROM threat_incidents
      WHERE device_id = ? AND (? OR status <> 'resolved')
      ORDER BY (status = 'open') DESC, last_event_at DESC
      LIMIT ?`,
    // better-sqlite3 tidak bind boolean → cast ke 1/0.
    [deviceId, includeResolved ? 1 : 0, incidentLimit]
  );
  const incidents = (incRes ? incRes.rows : []).map(toIncident);

  if (incidents.length > 0) {
    const keys = incidents.map(i => i.threatKey);
    const evRes = await db.query(
      `SELECT * FROM device_logs WHERE threat_key IN (${keys.map(() => '?').join(',')})
        ORDER BY received_at ASC, id ASC`,
      keys
    );
    const byKey = new Map();
    for (const row of (evRes ? evRes.rows : [])) {
      if (!byKey.has(row.threat_key)) byKey.set(row.threat_key, []);
      byKey.get(row.threat_key).push(toEvent(row));
    }
    for (const inc of incidents) inc.events = byKey.get(inc.threatKey) || [];
  }

  const looseRes = await db.query(
    `SELECT * FROM device_logs
      WHERE device_id = ? AND threat_key IS NULL
      ORDER BY received_at DESC, id DESC LIMIT ?`,
    [deviceId, looseLimit]
  );
  const looseEvents = (looseRes ? looseRes.rows : []).map(toEvent).reverse();

  return { incidents, looseEvents, source: 'device_logs' };
}

async function getIncident(threatKey) {
  if (!db.isPostgresConnected()) {
    const row = memStore().find(s => s.threatKey === threatKey);
    return row ? toIncident(row) : null;
  }
  const r = await db.query('SELECT * FROM threat_incidents WHERE threat_key = ?', [threatKey]);
  if (!r || r.rows.length === 0) return null;
  const incident = toIncident(r.rows[0]);
  const evRes = await db.query(
    `SELECT * FROM device_logs WHERE threat_key = ? ORDER BY received_at ASC, id ASC`,
    [threatKey]
  );
  incident.events = (evRes ? evRes.rows : []).map(toEvent);
  return incident;
}

async function ack(threatKey, by) {
  const reviewer = String(by || 'operator').slice(0, 100);
  if (!db.isPostgresConnected()) {
    const row = memStore().find(s => s.threatKey === threatKey);
    if (!row) return null;
    row.status = 'acknowledged';
    row.ackedAt = new Date().toISOString();
    row.ackedBy = reviewer;
    const incident = toIncident(row);
    emitThreatEvent(incident.deviceId, incident.deviceName, incident, 'ack');
    return incident;
  }
  const r = await db.query(
    `UPDATE threat_incidents
        SET status = 'acknowledged', acked_at = datetime('now'), acked_by = ?
      WHERE threat_key = ? AND status = 'open'
      RETURNING *`,
    [reviewer, threatKey]
  );
  if (!r || r.rows.length === 0) return null;
  const incident = toIncident(r.rows[0]);
  emitThreatEvent(incident.deviceId, incident.deviceName, incident, 'ack');
  return incident;
}

async function status() {
  const out = { enabled: ENABLED, sessionWindowMs: SESSION_WINDOW_MS, resolveAfterMs: RESOLVE_AFTER_MS, backfill: !BACKFILL_ENABLED };
  out.mode = 'sqlite';
  let s = null;
  try {
    s = db.query(
      `SELECT
         (SELECT count(*) FROM threat_incidents) AS sessions,
         (SELECT count(*) FROM threat_incidents WHERE status='open') AS open,
         (SELECT count(*) FROM threat_incidents WHERE status='acknowledged') AS acknowledged,
         (SELECT count(*) FROM threat_incidents WHERE status='resolved') AS resolved,
         (SELECT count(*) FROM device_logs WHERE threat_key IS NOT NULL) AS grouped_events,
         (SELECT count(*) FROM device_logs WHERE threat_key IS NULL) AS loose_events,
         (SELECT count(*) FROM device_logs WHERE category IS NULL) AS uncategorized`
    );
  } catch (e) {
    s = null;
  }
  if (s && s.rows.length) Object.assign(out, s.rows[0]);
  return out;
}

// ---------------------------------------------------------------------------
// Inisialisasi
// ---------------------------------------------------------------------------

function initThreatTimeline() {
  if (!ENABLED) {
    console.log('[ThreatTimeline] Nonaktif (THREAT_ENABLED=false).');
    return;
  }
  if (!resolveTimer) {
    resolveTimer = setInterval(() => {
      resolveStale().catch(() => {});
    }, RESOLVE_SWEEP_MS);
    if (resolveTimer.unref) resolveTimer.unref();
  }
  // Backfill dijalankan sekali di latar belakang; idempoten karena hanya
  // memproses baris yang `category`-nya masih NULL.
  setTimeout(() => {
    backfill().catch(e => console.warn('[ThreatTimeline] backfill gagal:', e.message));
  }, 5000);
}

function stop() {
  if (resolveTimer) {
    clearInterval(resolveTimer);
    resolveTimer = null;
  }
}

module.exports = {
  initThreatTimeline,
  stop,
  ingest,
  backfill,
  resolveStale,
  getTimelineForDevice,
  getIncident,
  ack,
  status,
  toEvent,
  SESSION_WINDOW_MS,
  RESOLVE_AFTER_MS
};
