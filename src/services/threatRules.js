/**
 * Threat Timeline — Rule Engine (lapis 3)
 * ----------------------------------------------------------------------------
 * Lapisan data log di sistem ini:
 *   Lapis 1 — `logCollector/normalizer.js`  : baris mentah perangkat → model kanonik
 *   Lapis 2 — `logCollector/rules.js`       : satu log → satu Event (legacy, tidak diubah)
 *   Lapis 3 — berkas ini                    : banyak log → satu sesi Threat Timeline
 *
 * Berkas ini SENGAJA bebas dari UI, Express, dan database: seluruh isinya
 * predicate murni sehingga bisa diuji dan dipakai engine mana pun.
 *
 * Setiap rule minimal memiliki: identifier, kondisi pencocokan, jendela waktu,
 * severity, nama incident, dan prioritas (sesuai kebutuhan Rule Engine).
 */

'use strict';

const CATEGORY = {
  AUTH: 'auth',
  USER: 'user',
  FIREWALL: 'firewall',
  CONFIG: 'config',
  NTP: 'ntp',
  DHCP: 'dhcp',
  INTERFACE: 'interface',
  REBOOT: 'reboot',
  SERVICE: 'service',
  STORAGE: 'storage',
  SYSTEM: 'system',
  OTHER: 'other'
};

// Urutan keparahan (indeks kecil = lebih parah) — sama dengan normalizer.SEVERITIES.
const SEVERITY_ORDER = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];

function severityRank(sev) {
  const i = SEVERITY_ORDER.indexOf(String(sev || '').toLowerCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/** Ambil severity yang paling parah dari daftar. */
function worstSeverity(list) {
  let best = null;
  for (const s of list) {
    if (!s) continue;
    if (best === null || severityRank(s) < severityRank(best)) best = s;
  }
  return best;
}

/** Naikkan severity a → b bila b lebih parah. */
function escalateSeverity(a, b) {
  const rankA = a ? severityRank(a) : Infinity;
  const rankB = b ? severityRank(b) : Infinity;
  if (rankA === Infinity) return b || null;
  if (rankB === Infinity) return a;
  return rankB < rankA ? b : a;
}

/** Bandingkan dua severity tingkat-insiden (info < warning < critical). */
const INCIDENT_SEVERITY_ORDER = { info: 0, warning: 1, critical: 2 };
function escalateIncidentSeverity(a = 'warning', b = 'warning') {
  const ra = INCIDENT_SEVERITY_ORDER[a] ?? 1;
  const rb = INCIDENT_SEVERITY_ORDER[b] ?? 1;
  return rb > ra ? b : a;
}

// ---------------------------------------------------------------------------
// Pola pencocokan (vendor-agnostik)
// ---------------------------------------------------------------------------

const RE = {
  // Frase spesifik saja. Pola longgar seperti `auth(entication)? (error|fail)`
  // pernah menangkap log aplikasi (grafana "Failed to install plugin") sebagai
  // kegagalan autentikasi.
  authFail: /(login fail(?:ure|ed)?|failed (?:password|login|publickey)|authentication fail(?:ure|ed)?|invalid user\b|access denied|wrong password|bad password|too many authentication failures|user .* not found)/i,
  // Catatan: "session opened" sengaja TIDAK dipakai — di Linux baris itu juga
  // muncul untuk sesi cron (`pam_unix(cron:session)`), yang bukan login.
  authOpen: /(accepted (?:password|publickey|keyboard-interactive)|logged in|login ok|login success|successful login|authentication succeeded|user .* logged in|privileged access granted)/i,
  // Login istimewa / di luar jalur normal: kanal manajemen RouterOS (Winbox,
  // Telnet, MAC-telnet) dan eskalasi `su`. Sengaja TIDAK memakai sekadar
  // "session opened for user root" agar login root rutin via SSH tidak
  // dianggap ancaman; yang dicari adalah kanal atau eskalasi yang berbeda.
  specialLogin: /(logged in\s+(?:from\s+\S+\s+)?via\s+(?:winbox|telnet|mac-telnet|ftp|web|api|serial|console)|\bsu:\s+session opened|pam_unix\(su:session\):\s+session opened for user root|privileged (?:access|mode) (?:granted|enabled))/i,
  // Log terstruktur aplikasi (logger=/level=) bukan peristiwa akses perangkat.
  appStructuredLog: /\b(?:logger|level)=(?:error|warn|warning|fatal)\b/i,
  userMgmt: /(user (?:add|added|remove|removed|chang|creat|delet|enabl|disabl|renam)|group (?:add|added|remove|removed|chang|creat|delet)|password (?:set|chang|reset|updat)|new user|deleted user|account (?:add|added|remov|creat|delet)|privilege level|set user|new group)/i,
  // Harus spesifik firewall. Pola generik "rule added" pernah menangkap
  // "log rule added by ..." (perubahan konfigurasi logging) sebagai firewall.
  firewall: /(firewall|iptables|nftables|\bnft\b|\bufw\b|address-list|filter rule|nat rule|mangle rule|raw rule|\bpf\b|drop(?:ped)? packet|deny(?:ing)? connection|forward drop|input drop)/i,
  config: /((?:configuration|config|settings|preferences)[^.]{0,40}\b(?:chang|sav|restor|modif|updat|load|reset|commit)|(?:chang|sav|modif|restor|updat)\w{0,12}\s+(?:the\s+)?(?:configuration|config|settings|script)|\bconfiguration (?:changed|saved|restored)\b|(?:log\s+)?rule (?:add|added|remove|removed|chang|changed|set) by|(?:script|schedule|action|policy|profile|ip pool|address-list|interface|queue|route) (?:add|added|remove|removed|chang|changed|set|enabled|disabled) by|backup (?:sav|load|creat|done)|restore (?:from )?backup|new script|script (?:add|added|remove|removed|chang|updat))/i,
  // Kategori (luas) — dipakai deriveCategory.
  ntp: /(ntp|timesyncd|chrony|chronyd|time (?:change|changed|set|sync|adjust|step)|clock (?:change|changed|set|step)|timezone|time zone|date (?:change|changed|updated)|synchroniz|drift)/i,
  // Rule (sempit) — hanya PERUBAHAN waktu, bukan sinkronisasi rutin.
  ntChange: /(\bntp\b[^.]{0,40}(?:chang|step|adjust|jump|drift|mismatch)|\btime change\b|\bclock (?:change|changed|set|step|stepped|adjust)|\bsystem time (?:changed|adjusted|jumped|stepped)|\bdate (?:change|changed|set))/i,
  dhcp: /(dhcp|lease|dnsmasq|address .{0,20}(?:assigned|renew|released|offered|declin)|bound to|deconfigur|pool exhausted|no free leases)/i,
  ifaceDown: /(link down|link is down|carrier lost|lost carrier|interface .{0,30}down|is down|no link|link failed|disconnect(?:ed)? )/i,
  ifaceUp: /(link up|link is up|carrier up|interface .{0,30}up|is up|link established|link ok|reconnect(?:ed)? )/i,
  iface: /(link (?:up|down)|interface .{0,30}(?:up|down)|carrier (?:lost|down|up)|lost carrier|wireless.{0,30}(?:connect|disconnect|associat|deauth|roam|registr)|pppoe|ppp .{0,20}(?:up|down)|ether\d|\bwlan\d)/i,
  // `restart`/`shutdown` telanjang sengaja dihapus: keduanya menangkap shutdown
  // tingkat aplikasi (mis. ModemManager) yang bukan reboot perangkat.
  reboot: /(reboot|rebooting|rebooted|shutting down|system boot|booting|startup finished|powered on|power on|powered off|halting|sysupTime)/i,
  storage: /(disk|storage|filesystem|no space left|i\/o error|raid|smart (?:error|failure)|read-only file system|volume .{0,20}(?:full|fail))/i,
  service: /(systemd|systemctl|\.service|unit |service |daemon|failed to (?:start|stop)|start(?:ed|ing) |stopp(?:ed|ing) |reload(?:ed|ing) |cron|anacron|logrotate)/i
};

/** Loopback bukan indikator gangguan tautan. */
const RE_LOOPBACK = /\b(lo|loopback)\b/i;

function isIfaceDown(message) {
  const m = String(message || '');
  return !RE_LOOPBACK.test(m) && RE.ifaceDown.test(m);
}

function isIfaceUp(message) {
  const m = String(message || '');
  return !RE_LOOPBACK.test(m) && RE.ifaceUp.test(m);
}

/** Kegagalan autentikasi asli (bukan log terstruktur aplikasi). */
function isAuthFailure(message) {
  const m = String(message || '');
  return RE.authFail.test(m) && !RE.appStructuredLog.test(m);
}

/** Login/autentikasi berhasil. */
function isAuthSuccess(message) {
  const m = String(message || '');
  return RE.authOpen.test(m) && !RE.appStructuredLog.test(m);
}

// Topik RouterOS → kategori (dipakai bila pola pesan tidak menentukan).
const TOPIC_CATEGORY = {
  account: CATEGORY.AUTH,
  auth: CATEGORY.AUTH,
  login: CATEGORY.AUTH,
  firewall: CATEGORY.FIREWALL,
  dhcp: CATEGORY.DHCP,
  ntp: CATEGORY.NTP,
  clock: CATEGORY.NTP,
  interface: CATEGORY.INTERFACE,
  wireless: CATEGORY.INTERFACE,
  ppp: CATEGORY.INTERFACE,
  script: CATEGORY.CONFIG,
  system: CATEGORY.SYSTEM
};

// Program / daemon → kategori (sisi Linux: program adalah sumber paling andal).
const PROGRAM_CATEGORY = [
  [/^(sshd|sshd-session|ssh|sudo|su|login|systemd-logind|polkitd|pam|winbox|ftp|telnet|dropbear)/i, CATEGORY.AUTH],
  [/^(chrony|chronyd|ntpd|ntpdate|systemd-timesyncd)/i, CATEGORY.NTP],
  [/^(dhcpd|dhclient|dnsmasq|udhcpd)/i, CATEGORY.DHCP],
  [/^(iptables|nft|firewalld|ufw|pf)/i, CATEGORY.FIREWALL],
  [/^(useradd|usermod|userdel|groupadd|groupmod|groupdel|passwd|adduser|deluser)/i, CATEGORY.USER],
  [/^(kernel|systemd|init|shutdown|reboot)/i, CATEGORY.SYSTEM],
  [/^(cron|crond|anacron|atd|systemd-cron)/i, CATEGORY.SERVICE],
  [/^(smartd|mdadm|lvm|zfs)/i, CATEGORY.STORAGE]
];

// Facility syslog → kategori (hanya untuk facility yang jelas).
const FACILITY_CATEGORY = {
  auth: CATEGORY.AUTH,
  authpriv: CATEGORY.AUTH,
  ntp: CATEGORY.NTP,
  cron: CATEGORY.SERVICE,
  kern: CATEGORY.SYSTEM,
  daemon: CATEGORY.SERVICE
};

const TOPIC_TOKEN_RE = /^[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*)+$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Ambil daftar topic apa adanya dari raw_message.
 * Dipakai untuk baris lama yang kolom `topics`-nya belum ada (backfill), tanpa
 * mengubah isi raw_message itu sendiri.
 * @returns {string[]}
 */
function deriveTopicsFromRaw(raw) {
  if (!raw) return [];
  const body = String(raw).replace(/\0/g, '').replace(/^<\d{1,3}>\s*/, '').trim();
  if (!body) return [];
  const tokens = body.split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return [];

  // Lewati header waktu (RFC5424 ISO atau RFC3164 "Sep  9 08:34:50").
  let i = 0;
  if (ISO_TS_RE.test(tokens[0])) {
    i = 1;
  } else if (/^[A-Z][a-z]{2}$/.test(tokens[0]) && /^\d{1,2}$/.test(tokens[1] || '') &&
             /^\d{2}:\d{2}:\d{2}$/.test(tokens[2] || '')) {
    i = 3;
  }

  // RouterOS menaruh topics di slot hostname (tanpa hostname) atau mengulangnya
  // di awal pesan. Cari di 3 token pertama setelah header.
  for (let k = i; k < Math.min(tokens.length, i + 3); k++) {
    const cleaned = tokens[k].replace(/[^a-z0-9,]/gi, '');
    if (TOPIC_TOKEN_RE.test(cleaned)) return cleaned.split(',');
  }
  return [];
}

/** Normalisasi topics dari berbagai bentuk (array, string koma, null). */
function normalizeTopics(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  return String(input).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * Turunkan kategori dari (pola pesan ∪ topics ∪ program ∪ facility).
 * Pola pesan diperiksa lebih dulu karena paling spesifik: pada RouterOS,
 * topics selalu berisi "system" sehingga tidak bisa dipakai sendirian.
 */
function deriveCategory(norm) {
  const message = String((norm && norm.message) || '');
  const severity = String((norm && norm.severity) || '').toLowerCase();
  const program = String((norm && norm.program) || '').trim();
  const facility = String((norm && norm.facility) || '').trim().toLowerCase();
  const topics = normalizeTopics(norm && norm.topics);

  if (isAuthFailure(message) || isAuthSuccess(message)) return CATEGORY.AUTH;
  if (RE.userMgmt.test(message)) return CATEGORY.USER;
  if (RE.firewall.test(message)) return CATEGORY.FIREWALL;
  if (RE.config.test(message)) return CATEGORY.CONFIG;
  if (RE.ntp.test(message)) return CATEGORY.NTP;
  if (RE.dhcp.test(message)) return CATEGORY.DHCP;
  if (RE.iface.test(message)) return CATEGORY.INTERFACE;
  if (RE.reboot.test(message)) return CATEGORY.REBOOT;
  if (RE.storage.test(message)) return CATEGORY.STORAGE;
  if (RE.service.test(message) || RE.service.test(program)) return CATEGORY.SERVICE;
  if (severity === 'critical' || severity === 'alert' || severity === 'emergency') return CATEGORY.SYSTEM;

  for (const t of topics) {
    if (TOPIC_CATEGORY[t]) return TOPIC_CATEGORY[t];
  }
  for (const [re, cat] of PROGRAM_CATEGORY) {
    if (re.test(program)) return cat;
  }
  if (FACILITY_CATEGORY[facility]) return FACILITY_CATEGORY[facility];
  return CATEGORY.OTHER;
}

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

/**
 * Rule akumulatif: dihitung berapa kali pola muncul dalam jendela waktu.
 * minEvents = 1 → satu kejadian sudah cukup membuka/mengeskalasi sesi.
 */
const ACCUMULATIVE_RULES = [
  {
    id: 'auth-bruteforce',
    kind: 'accumulative',
    title: 'Repeated authentication failures',
    category: CATEGORY.AUTH,
    priority: 90,
    severity: 'critical',
    windowMs: 5 * 60 * 1000,
    minEvents: 3,
    match: (n) => isAuthFailure(n.message)
  },
  {
    id: 'auth-success-after-failures',
    kind: 'sequence',
    title: 'Successful login after repeated failures',
    category: CATEGORY.AUTH,
    priority: 95,
    severity: 'critical',
    windowMs: 10 * 60 * 1000,
    minEvents: 1,
    trigger: (n) => isAuthSuccess(n.message),
    requires: { pattern: isAuthFailure, minBefore: 3, maxAgeMs: 10 * 60 * 1000 }
  },
  {
    id: 'user-management-change',
    kind: 'accumulative',
    title: 'User management change',
    category: CATEGORY.USER,
    priority: 85,
    severity: 'warning',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    match: (n) => RE.userMgmt.test(n.message || '')
  },
  {
    id: 'firewall-change',
    kind: 'accumulative',
    title: 'Firewall rule change',
    category: CATEGORY.FIREWALL,
    priority: 82,
    severity: 'warning',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    match: (n) => RE.firewall.test(n.message || '')
  },
  {
    id: 'ntp-change',
    kind: 'accumulative',
    title: 'System time (NTP) changed',
    category: CATEGORY.NTP,
    priority: 80,
    severity: 'warning',
    windowMs: 10 * 60 * 1000,
    minEvents: 1,
    // Sempit: hanya perubahan waktu. Sinkronisasi rutin ("Contacted time
    // server", "Initial clock synchronization") tidak boleh membuka sesi.
    match: (n) => RE.ntChange.test(n.message || '')
  },
  {
    id: 'device-reboot',
    kind: 'accumulative',
    title: 'Device reboot detected',
    category: CATEGORY.REBOOT,
    priority: 88,
    severity: 'critical',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    match: (n) => RE.reboot.test(n.message || '')
  },
  {
    id: 'special-login-detected',
    kind: 'accumulative',
    title: 'Privileged or out-of-band login detected',
    category: CATEGORY.AUTH,
    priority: 78,
    severity: 'warning',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    match: (n) => RE.specialLogin.test(n.message || '')
  },
  {
    id: 'interface-flap',
    kind: 'sequence',
    title: 'Interface down then up',
    category: CATEGORY.INTERFACE,
    priority: 75,
    severity: 'warning',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    // Predikat (bukan regex) supaya loopback `lo link up` tidak dihitung.
    trigger: (n) => isIfaceUp(n.message),
    requires: { pattern: isIfaceDown, minBefore: 1, maxAgeMs: 5 * 60 * 1000 }
  },
  {
    id: 'config-change',
    kind: 'accumulative',
    title: 'Configuration changed',
    category: CATEGORY.CONFIG,
    priority: 70,
    severity: 'warning',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    match: (n) => RE.config.test(n.message || '')
  },
  {
    id: 'dhcp-change',
    kind: 'accumulative',
    title: 'DHCP lease or configuration change',
    category: CATEGORY.DHCP,
    priority: 60,
    severity: 'warning',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    match: (n) => RE.dhcp.test(n.message || '')
  },
  {
    // Jaring pengaman vendor-agnostik: satu log critical tetap menjadi sesi
    // threat, sehingga log parah tidak pernah hilang dari timeline.
    id: 'critical-severity',
    kind: 'accumulative',
    title: 'Critical severity log',
    category: CATEGORY.SYSTEM,
    priority: 40,
    severity: 'critical',
    windowMs: 5 * 60 * 1000,
    minEvents: 1,
    match: (n) => severityRank(n.severity) <= severityRank('critical')
  }
];

const RULES = ACCUMULATIVE_RULES;

function getRule(id) {
  return RULES.find(r => r.id === id) || null;
}

/** Rule akumulatif yang polanya cocok dengan log ini. */
function matchAccumulative(norm) {
  return RULES.filter(r => r.kind === 'accumulative' && r.match(norm));
}

/** Rule sequence yang pemicunya cocok dengan log ini. */
function matchSequenceTriggers(norm) {
  return RULES.filter(r => r.kind === 'sequence' && r.trigger(norm));
}

/** Jendela waktu efektif untuk satu himpunan rule. */
function effectiveWindowMs(rules, fallbackMs) {
  let max = fallbackMs;
  for (const r of rules) {
    if (r.windowMs && r.windowMs > max) max = r.windowMs;
  }
  return max;
}

/** Rule dengan prioritas tertinggi (penentu judul sesi). */
function highestPriority(rules) {
  return rules.reduce((best, r) => (!best || r.priority > best.priority ? r : best), null);
}

module.exports = {
  CATEGORY,
  RULES,
  RE,
  severityRank,
  worstSeverity,
  escalateSeverity,
  escalateIncidentSeverity,
  deriveTopicsFromRaw,
  normalizeTopics,
  deriveCategory,
  isAuthFailure,
  isAuthSuccess,
  isIfaceDown,
  isIfaceUp,
  getRule,
  matchAccumulative,
  matchSequenceTriggers,
  effectiveWindowMs,
  highestPriority
};
