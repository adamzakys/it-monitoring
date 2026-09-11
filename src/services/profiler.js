/**
 * Configuration Readiness Profiler
 * ==================================
 * Mendiagnosa status koneksi tiap device melalui 5 layer probe:
 *   1. Network Reachable (ICMP ping)
 *   2. SNMP Polling (UDP 161 — walk sysDescr / ifName)
 *   3. Syslog Forwarding (UDP/TCP 5514 — kirim dummy message)
 *   4. SNMP Trap (UDP 162 — cek apakah trap target sudah ada)
 *   5. Telegraf Agent (cek proses di host via SSH/SNMP uptime match)
 *
 * Gap Analyzer membandingkan hasil probe → produces list of missing configs.
 * Command Generator menghasilkan syntax CLI per-device-type (MikroTik / Linux / Switch).
 *
 * SEMUA IP dan nama device di-inject dinamis dari data device + env SERVER_IP.
 * Tidak pernah menulis langsung ke perangkat — hanya read-only probe + saran perintah.
 */

const { spawn } = require('child_process');
const os = require('os');
const db = require('../db');
const streamService = require('./streamService');

// App server IP untuk disisipkan ke konfigurasi remote destinations
function getAppServerIP() {
  const envIp = process.env.BMS_SERVER_IP;
  if (envIp) return envIp;
  // Autodetect dari network interfaces
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

const APP_IP = getAppServerIP();
const SYSLOG_PORT = parseInt(process.env.SYSLOG_PORT || '5514', 10);
const SNMP_COMMUNITY = 'bms-readonly';

// Jendela "log masih mengalir". Default 5 menit — cukup pendek agar konfigurasi
// yang sudah dihapus (mis. setelah `resetting system configuration`) cepat
// terdeteksi tidak aktif, tapi masih longgar untuk device yang jarang menulis
// log. Override lewat env SYSLOG_FRESH_MS (milidetik).
const SYSLOG_FRESH_MS = Math.max(30000, parseInt(process.env.SYSLOG_FRESH_MS || String(5 * 60 * 1000), 10) || 300000);

/* ==========================================================================
   LAYER 1 — Network Reachability (ICMP Ping)
   ========================================================================== */

function checkPing(ipAddress) {
  return new Promise((resolve) => {
    if (!ipAddress) { resolve({ ok: false, error: 'no_ip_address' }); return; }
    const child = spawn('ping', ['-c', '2', '-W', '2', ipAddress], { timeout: 5000 });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve({ ok: false, error: 'spawn_error' }));
    child.on('close', (code) => {
      if (code !== 0 || !stdout) {
        resolve({ ok: false, error: 'unreachable' });
        return;
      }
      const timeMatch = stdout.match(/time=([0-9.]+)\s*ms/);
      const lossMatch = stdout.match(/([\d.]+)%\s*packet loss/);
      resolve({
        ok: true,
        latency_ms: timeMatch ? parseFloat(timeMatch[1]) : null,
        packet_loss: lossMatch ? parseFloat(lossMatch[1]) : 0
      });
    });
  });
}

/* ==========================================================================
   LAYER 2 — SNMP Polling (Walk sysDescr + ifName)
   ========================================================================== */

function checkSnmp(device) {
  return new Promise(async (resolve) => {
    try {
      // Step 1: Quick sysDescr probe
      const descResult = await realTimeSnmpGet(device, '.1.3.6.1.2.1.1.1.0');
      if (!descResult.ok || !descResult.value) {
        resolve({ ok: false, error: 'snmp_disabled_or_bad_community' });
        return;
      }
      // Step 2: Verify interface discovery works
      const ifNameResult = await realTimeSnmpWalk(device, 'IF-MIB::ifName', ['STRING']);
      resolve({
        ok: true,
        sysDescr: descResult.value,
        interfaceCount: ifNameResult.count || 0,
        sampleInterface: ifNameResult.names && ifNameResult.names.length > 0 ? ifNameResult.names[0] : null
      });
    } catch (e) {
      resolve({ ok: false, error: 'snmp_probe_failed' });
    }
  });
}

async function realTimeSnmpGet(device, oid) {
  return new Promise((resolve) => {
    const ip = device.ip_address;
    const community = device.snmp_community || 'public';
    const port = device.snmp_port || 161;
    const version = device.snmp_version || '2c';
    const child = spawn(
      'snmpget',
      ['-v' + version, '-c', community, '-t', '3', '-r', '0', `${ip}:${port}`, oid],
      { timeout: 8000, maxBuffer: 8192 }
    );
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve({ ok: false, value: null }));
    child.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) { resolve({ ok: false, value: null }); return; }
      // Extract value after type separator
      let value = stdout.trim();
      const eqIdx = value.indexOf('=');
      if (eqIdx >= 0) value = value.substring(eqIdx + 1).trim();
      // Strip type prefix like "STRING: " or "Octet String: "
      const colonSpace = value.indexOf(': ');
      if (colonSpace >= 0) value = value.substring(colonSpace + 2);
      else {
        const spaceIdx = value.indexOf(' ');
        if (spaceIdx >= 0) value = value.substring(spaceIdx + 1);
      }
      resolve({ ok: true, value });
    });
  });
}

async function realTimeSnmpWalk(device, baseOid, valuePrefixes) {
  return new Promise((resolve) => {
    const ip = device.ip_address;
    const community = device.snmp_community || 'public';
    const port = device.snmp_port || 161;
    const version = device.snmp_version || '2c';
    const child = spawn(
      'snmpwalk',
      ['-v' + version, '-c', community, '-t', '5', '-r', '0', `${ip}:${port}`, baseOid],
      { timeout: 12000, maxBuffer: 1024 * 1024 }
    );
    let stdout = '';
    const names = [];
    let count = 0;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // Count and extract STRING values
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        count++;
        for (const prefix of (valuePrefixes || ['STRING'])) {
          const m = line.match(new RegExp(`${prefix}:\\s*(\\S+)`));
          if (m && names.length < 10) names.push(m[1]);
        }
      }
    });
    child.on('error', () => resolve({ ok: false, count: 0, names: [] }));
    child.on('close', () => resolve({ ok: count > 0, count, names }));
  });
}

/* ==========================================================================
   LAYER 3 — Syslog Forwarding (Send test message to app's syslog receiver)
   ========================================================================== */

/**
 * Syslog Forwarding check — berdasarkan DATA NYATA yang diterima.
 * BMS adalah syslog SERVER (listen UDP/TCP 5514); perangkat adalah CLIENT
 * yang mengirim log.
 *
 * PENTING: syslog bersifat push & event-driven. "Ada log historis" BUKAN bukti
 * konfigurasi masih aktif. Karena itu `ok` hanya true bila ada log yang masuk
 * dalam jendela pendek (SYSLOG_FRESH_MS, default 5 menit). Untuk kepastian
 * mutlak, gunakan verifikasi aktif (endpoint /syslog-verify).
 */
async function checkSyslog(device) {
  const deviceId = device && device.id;
  if (!deviceId) {
    return { ok: false, error: 'no_device', note: 'Device tidak dikenali.' };
  }

  const windowLabel = `${Math.round(SYSLOG_FRESH_MS / 60000)} menit`;
  try {
    const logStore = require('./logCollector/store');
    const recent = await logStore.getLogs(deviceId, 50, 0);
    const newest = Array.isArray(recent) && recent.length > 0 ? recent[0] : null;

    if (newest) {
      const ts = newest.receivedAt ? new Date(newest.receivedAt).getTime() : 0;
      const ageMs = ts > 0 ? Date.now() - ts : Infinity;
      const fresh = ageMs >= 0 && ageMs < SYSLOG_FRESH_MS;

      if (fresh) {
        return {
          ok: true,
          port: SYSLOG_PORT,
          transport: 'udp/tcp',
          verified: true,
          logCount: recent.length,
          lastLogAt: newest.receivedAt,
          lastLogSourceIp: newest.sourceIp || null,
          freshWindowMs: SYSLOG_FRESH_MS
        };
      }

      // Ada riwayat log, tapi tidak ada yang baru → konfigurasi mungkin sudah
      // dicabut / perangkat berhenti mengirim. JANGAN dianggap OK.
      const unmatched = await logStore.countUnmatchedByIp(device.ip_address, SYSLOG_FRESH_MS);
      return {
        ok: false,
        error: 'stale_logs',
        note: `Log terakhir ${formatAge(ageMs)} lalu — tidak ada log baru dalam ${windowLabel}.`,
        lastLogAt: newest.receivedAt,
        lastLogSourceIp: newest.sourceIp || null,
        staleCount: recent.length,
        unmatchedByIp: unmatched,
        freshWindowMs: SYSLOG_FRESH_MS
      };
    }

    // Tidak ada log sama sekali untuk device ini. Cek apakah ada log "nyasar"
    // dari IP perangkat yang gagal di-resolve ke inventory.
    const unmatched = await logStore.countUnmatchedByIp(device.ip_address, SYSLOG_FRESH_MS);
    return {
      ok: false,
      error: 'no_logs_received',
      note: unmatched > 0
        ? `Ada ${unmatched} log dari ${device.ip_address} tetapi tidak cocok dengan device ini (periksa IP inventory).`
        : `Belum ada log diterima. Pastikan device mengirim syslog ke ${APP_IP}:${SYSLOG_PORT}.`,
      unmatchedByIp: unmatched,
      freshWindowMs: SYSLOG_FRESH_MS
    };
  } catch (e) {
    return { ok: false, error: 'check_failed', note: e.message };
  }
}

/** "3m lalu" / "2j lalu" / "5d lalu" untuk pesan status. */
function formatAge(ms) {
  if (!isFinite(ms) || ms < 0) return 'tidak diketahui';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j`;
  return `${Math.floor(h / 24)}d`;
}

/* ==========================================================================
    COMMAND GENERATOR — Dynamic per device type (RouterOS focused)
    ========================================================================== */

/**
 * Sanitize device name untuk CLI yang kompatibel semua platform:
 * - RouterOS tidak support double-quote + spasi → hapus quote, escape spasi
 * - Linux shell normal → tidak masalah
 */
function cliSafeName(name) {
  return String(name || '')
    .replace(/"/g, '')       // Hapus double-quote (breaks RouterOS parsing)
    .replace(/\s+/g, '');    // Hapus spasi jadi tanpa-spasi untuk nama RouterOS
}

function generateCommands(device, gaps) {
  const type = (device.device_type || 'router').toLowerCase();
  const rawName = device.name || 'DEVICE';
  const safeName = cliSafeName(rawName);
  const ip = device.ip_address || 'DEVICE_IP';
  const community = device.snmp_community || SNMP_COMMUNITY;
  const results = [];

  for (const gap of gaps) {
    if (type === 'router') {
      if (gap === 'network') {
        results.push({
          id: 'check_network',
          label: 'Network Reachability Check',
          urgency: 'high',
          description: 'Device belum terdeteksi reachable. Pastikan kabel terhubung dan IP/device aktif.',
          commands: [
            `# Verifikasi connectivity dari server BMS ke ${rawName}:`,
            `ping -c 3 ${ip}`
          ]
        });
      }
      if (gap === 'snmp') {
        results.push({
          id: 'enable_snmp',
          label: 'Enable SNMP v2c Read-Only',
          urgency: 'high',
          description: 'Agar BMS dapat membaca metrik CPU, RAM, Interface, Uptime via SNMP.',
          commands: [
            '# 1. Set nama device (tanpa spasi):',
            `/system identity set name=${safeName}`,
            '# 2. Aktifkan SNMP:',
            '/snmp set enabled=yes',
            '# 3. Tambah alamat akses (allow from all):',
            `/snmp add address=0.0.0.0/0 contact="BMS-NOC" read-access=yes community=${community}`,
            '# 4. Set trap destination (opsional):',
            `/snmp set trap-community=bms-trap`,
            `/snmp set trap-targets=${APP_IP}`
          ]
        });
      }
      if (gap === 'syslog') {
        results.push({
          id: 'enable_syslog',
          label: 'Enable Remote Syslog',
          urgency: 'high',
          description: 'Agar log device masuk real-time ke BMS via UDP/TCP port 5514. PENTING: rule RouterOS cocok berdasarkan TOPIC pesan — rule dengan topics=info TIDAK akan mengirim pesan bertopik script,warning/error.',
          commands: [
            '# 1. Buat logging action remote ke server BMS:',
            `/system/logging/action/add name=${safeName} target=remote remote=${APP_IP} remote-port=${SYSLOG_PORT}`,
            '# 2. Bersihkan rule lama untuk action ini (opsional, hindari kirim ganda):',
            `/system/logging/remove [find action=${safeName}]`,
            '# 3. Tambahkan rule — topics HARUS mencakup topik pesan yang diinginkan:',
            `/system/logging/add topics=info,error,warning,critical,script,account,system action=${safeName}`,
            '# 4. Verifikasi action:',
            `/system/logging/action/print detail where name=${safeName}`,
            '# 5. Verifikasi rule:',
            '/system/logging/print',
            '# 6. Kirim log uji (harus muncul di BMS dalam ±2 detik):',
            '/log warning "BMS-TEST"'
          ]
        });
      }
    } else if (type === 'server' || type === 'linux') {
      if (gap === 'snmp') {
        results.push({
          id: 'install_snmpd',
          label: 'Install & Configure net-snmp',
          urgency: 'high',
          description: 'Agar BMS dapat polling CPU, Memory, Storage via SNMP.',
          commands: [
            '# Debian/Ubuntu:',
            'apt-get update && apt-get install -y snmpd snmp',
            '# Edit /etc/snmp/snmpd.conf:',
            `view   systemonly  included   .1.3.6.1.2.1.1`,
            `view   systemonly  included   .1.3.6.1.2.1.25`,
            `rocommunity ${community} default -V systemonly`,
            `listen 0.0.0.0`,
            '# Restart:',
            'systemctl restart snmpd'
          ]
        });
      }
      if (gap === 'syslog') {
        results.push({
          id: 'config_rsyslog',
          label: 'Configure rsyslog Remote Forwarding',
          urgency: 'high',
          description: 'Agar BMS menerima log sistem secara real-time.',
          commands: [
            '# Buat file /etc/rsyslog.d/99-bms-forward.conf:',
            `*.* @@${APP_IP}:${SYSLOG_PORT}`,
            '# Restart rsyslog:',
            'systemctl restart rsyslog'
          ]
        });
      }
    } else {
      // Generic switch / other devices
      if (gap === 'snmp') {
        results.push({
          id: 'enable_snmp_generic',
          label: 'Enable SNMP',
          urgency: 'high',
          description: 'Aktifkan SNMP versi 2c read-only agar BMS dapat melakukan polling.',
          commands: [
            '# Syntax bervariasi tergantung vendor.',
            '# Contoh umum:',
            `snmp-server community ${community} ro`,
            `snmp-server host ${APP_IP} traps version 2c bms-trap`
          ]
        });
      }
      if (gap === 'syslog') {
        results.push({
          id: 'enable_syslog_generic',
          label: 'Configure Syslog Remote',
          urgency: 'high',
          description: 'Arahkan log device ke server BMS.',
          commands: [
            `logging host ${APP_IP}`,
            `logging trap informational`,
            `logging facility local7`
          ]
        });
      }
    }
  }

  return results;
}

/* ==========================================================================
   MAIN ENGINE — Run only 3 essential probes: ping, SNMP, syslog
   ========================================================================== */

async function getReadiness(deviceId) {
  let device = null;

  if (db.isPostgresConnected()) {
    const r = await db.query('SELECT * FROM devices WHERE id = $1', [deviceId]);
    device = r.rows[0] || null;
  }
  if (!device) {
    device = db.getMemoryStore().devices.find(d => d.id === deviceId) || null;
  }
  if (!device) {
    return { success: false, error: 'Device not found' };
  }

  const startTime = Date.now();

  // Helper: wrap promise fn with explicit timeout & safe fallback
  const withTimeout = (promiseFn, ms, fallback) =>
    new Promise(resolve => {
      const t = setTimeout(() => resolve(fallback), ms);
      Promise.resolve(promiseFn()).then(v => { clearTimeout(t); resolve(v); })
        .catch(() => { clearTimeout(t); resolve(fallback); });
    });

  // Run ONLY 3 essential probes IN PARALLEL (network, SNMP, syslog)
  const [pingRes, snmpRes, syslogRes] = await Promise.all([
    withTimeout(() => checkPing(device.ip_address), 3000, { ok: false, error: 'timeout' }),
    withTimeout(() => checkSnmp(device), 4000, { ok: false, error: 'timeout' }),
    withTimeout(() => checkSyslog(device), 3000, { ok: false, error: 'timeout' })
  ]);

  const checks = {
    ping: pingRes,
    snmp: snmpRes,
    syslog: syslogRes
  };

  // Analyze gaps — only 3 layers: network, snmp, syslog
  const gaps = [];
  if (!checks.ping.ok) gaps.push('network');
  if (!checks.snmp.ok) gaps.push('snmp');
  if (!checks.syslog.ok) gaps.push('syslog');

  // Generate dynamic commands for each gap
  const recommendations = generateCommands(device, gaps);
  const elapsed = Date.now() - startTime;

  return {
    success: true,
    device_id: device.id,
    device_name: device.name,
    device_ip: device.ip_address,
    checked_at: new Date().toISOString(),
    elapsed_ms: elapsed,
    checks,
    gaps,
    recommendation_count: recommendations.length,
    recommendations
  };
}

module.exports = {
  getReadiness,
  checkPing,
  checkSnmp,
  checkSyslog,
  generateCommands,
  getAppServerIP
};
