/**
 * Log normalizer — mengubah pesan log mentah dari berbagai sumber
 * (syslog RFC3164/5424 — termasuk format remote RouterOS yang TIDAK
 * standar: tanpa hostname, token "topics" seperti system,error,critical
 * diletakkan di posisi hostname atau di awal pesan) ke model internal
 * kanonik:
 *   { severity, facility, program, message, hostname, topics,
 *     device_timestamp }
 * UI dan rule korelasi TIDAK bergantung pada format vendor; raw asli
 * selalu dipertahankan (raw_message) untuk audit — tidak ada info hilang.
 */

const SEVERITIES = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
const FACILITIES = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp',
  'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function canonicalSeverity(numOrName) {
  if (typeof numOrName === 'number') return SEVERITIES[numOrName] || 'info';
  const n = SEVERITIES.indexOf(String(numOrName || '').toLowerCase());
  return n >= 0 ? SEVERITIES[n] : 'info';
}

function canonicalFacility(num) {
  return FACILITIES[num] || ('facility' + num);
}

// Topics RouterOS: "system,error,critical" / "dhcp,info" / "interface,info" ...
const TOPICS_RE = /^[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)+$/i;

/** Severity paling kuat yang terkandung di token topics (atau null). */
function severityFromTopics(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return null;
  let best = null;
  for (const t of topics) {
    const n = SEVERITIES.indexOf(String(t).toLowerCase());
    if (n >= 0) best = best == null ? n : Math.min(best, n);
  }
  return best == null ? null : SEVERITIES[best];
}

/** "Sep  9 08:34:50" (tanpa tahun) → ISO; tahun diinfer dari jam server. */
function parseRfc3164Date(tokens) {
  if (tokens.length < 3) return null;
  const mon = MONTHS[String(tokens[0]).toLowerCase().slice(0, 3)];
  const day = parseInt(tokens[1], 10);
  const tm = String(tokens[2]).match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!mon || !day || !tm) return null;
  const year = new Date().getFullYear();
  const d = new Date(year, mon - 1, day, parseInt(tm[1], 10), parseInt(tm[2], 10), parseInt(tm[3], 10));
  if (d.getTime() - Date.now() > 24 * 3600 * 1000) d.setFullYear(year - 1); // log "masa depan" → tahun lalu
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Parse satu baris syslog → model ternormalisasi (atau null).
 * Tambahan: out.topics = token RouterOS bila dikenali.
 */
function parseSyslogLine(raw) {
  let body = String(raw || '').replace(/\0/g, '').replace(/[\r\n]+$/, '');
  if (!body.trim()) return null;

  let pri = 13; // facility=user, severity=notice
  const priMatch = body.match(/^<(\d{1,3})>(.*)$/s);
  if (priMatch) {
    const p = parseInt(priMatch[1], 10);
    if (isFinite(p) && p >= 0 && p <= 191) pri = p;
    body = priMatch[2];
  }
  const severityNum = pri & 7;
  const facilityNum = pri >> 3;
  const out = {
    severity: SEVERITIES[severityNum] || 'info',
    facility: FACILITIES[facilityNum] || ('facility' + facilityNum),
    hostname: null,
    program: null,
    topics: [],
    message: body.trim(),
    device_timestamp: null
  };
  const tokens = body.split(' ').filter(t => t !== '');
  let i = 0;

  // ---- RFC5424: <PRI>1 TS HOST APP PROCID MSGID SD MSG ----
  if (tokens[0] === '1' && tokens.length >= 4) {
    i = 1;
    try { const ts = new Date(tokens[i]); if (!isNaN(ts.getTime())) out.device_timestamp = ts.toISOString(); } catch (e) { /* null */ }
    i++;
    const host = tokens[i++];
    const app = tokens[i++];
    if (host && host !== '-') out.hostname = host;
    if (app && app !== '-') out.program = app.split('[')[0];
    if (tokens[i] && tokens[i] !== '-') i++; // PROCID
    if (tokens[i] && tokens[i] !== '-') i++; // MSGID
    if (i < tokens.length && tokens[i].startsWith('[')) { // STRUCTURED-DATA
      while (i < tokens.length && !tokens[i].includes(']')) i++;
      i++;
    } else if (i < tokens.length && tokens[i] === '-') { i++; }
    out.message = tokens.slice(i).join(' ').trim();
    return out;
  }

  // ---- Header tanggal opsional (ISO atau RFC3164 tanpa tahun) ----
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  if (ISO_RE.test(tokens[0] || '')) {
    try { const ts = new Date(tokens[0]); if (!isNaN(ts.getTime())) out.device_timestamp = ts.toISOString(); } catch (e) { /* null */ }
    i = 1;
  } else if (/^[A-Z][a-z]{2}$/.test(tokens[0] || '') && tokens[1] && /^\d{1,2}$/.test(tokens[1]) &&
             tokens[2] && /^\d{2}:\d{2}:\d{2}$/.test(tokens[2])) {
    out.device_timestamp = parseRfc3164Date(tokens);
    i = 3;
  }

  // ---- Slot hostname bisa berisi topics RouterOS (tidak ada hostname) ----
  const hostTok = tokens[i];
  if (hostTok && TOPICS_RE.test(hostTok)) {
    out.topics.push(...hostTok.split(','));
    i++;
    out.hostname = null;
  } else if (hostTok) {
    out.hostname = hostTok.replace(/^\[([^\]]+)\]$/, '$1');
    i++;
  }

  // ---- Sisa pesan; sebagian format mengulang topics di awal pesan ----
  let rest = tokens.slice(i).join(' ').trim();
  const dup = rest.match(/^([a-z][a-z0-9]*(?:,[a-z][a-z0-9]*){1,})(?::\s*|\s+)(.*)$/);
  if (dup) {
    out.topics.push(...dup[1].split(','));
    rest = dup[2].trim();
  }

  // Program hanya bila ada pola tag "nama[pid]:" / "nama:" (syslog klasik).
  const progMatch = rest.match(/^([\w@.\/+-]+(?:\[\d+\])?):\s?([\s\S]*)$/);
  if (progMatch) {
    out.program = progMatch[1].split('[')[0];
    rest = progMatch[2].trim() || progMatch[1];
  }
  out.message = rest;

  // ---- Normalisasi RouterOS: facility + severity dari topics ----
  if (out.topics.length > 0) {
    out.facility = out.topics[0];
    if (!out.program) out.program = out.topics[0];
    const tSev = severityFromTopics(out.topics);
    if (tSev && SEVERITIES.indexOf(tSev) < SEVERITIES.indexOf(out.severity)) {
      out.severity = tSev; // topics "error/critical" menguatkan PRI local0.info
    }
  }
  return out;
}

module.exports = { parseSyslogLine, canonicalSeverity, canonicalFacility, SEVERITIES, FACILITIES, severityFromTopics };
