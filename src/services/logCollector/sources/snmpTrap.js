/**
 * SNMP Trap source adapter (opsional).
 * Bila env SNMP_TRAP_ENABLED=true DAN binary `snmptrapd` tersedia: jalankan
 * snmptrapd (stdout, tanpa daemon) & tail hasilnya → normalized log.
 * SNMP trap v1/v2c di-decode oleh snmptrapd itu sendiri (tanpa dependency
 * node baru). Bila salah satu prasyarat tidak ada → status 'unavailable'
 * dgn alasan (jangan pernah fake status).
 */
const { spawn, spawnSync } = require('child_process');

let proc = null;

function binaryAvailable() {
  try {
    const r = spawnSync('which', ['snmptrapd'], { timeout: 3000 });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

/**
 * @returns {{ started:boolean, status:string, reason?:string }}
 */
function start({ onMessage }) {
  if (process.env.SNMP_TRAP_ENABLED !== 'true') {
    return { started: false, status: 'disabled', reason: 'Set SNMP_TRAP_ENABLED=true untuk mengaktifkan receiver SNMP trap' };
  }
  if (!binaryAvailable()) {
    return { started: false, status: 'unavailable', reason: 'Binary snmptrapd (net-snmp) tidak ditemukan di sistem' };
  }

  try {
    proc = spawn('snmptrapd', ['-f', '-Lo', '-m', '', '-M', ''], { timeout: 0 });
    let block = '';
    proc.stdout.on('data', (chunk) => {
      block += chunk.toString('utf8');
      // snmptrapd mencetak satu trap sebagai blok yang diakhiri baris kosong.
      const lines = block.split('\n');
      block = lines.pop(); // simpan sisa yang belum lengkap
      const complete = lines.join('\n');
      if (complete.trim()) {
        const ipMatch = complete.match(/\[udp:([0-9a-fA-F:.]+):\d+\]/);
        onMessage({
          severity: 'warning',
          facility: 'trap',
          program: 'snmp-trap',
          message: complete.trim().slice(0, 4000),
          raw: complete.trim().slice(0, 8192),
          sourceIp: ipMatch ? ipMatch[1].replace(/^::ffff:/, '') : null,
          hostname: null,
          device_timestamp: null,
          sourceType: 'snmp_trap',
          transport: 'udp162'
        });
      }
    });
    proc.stderr.on('data', () => { /* snmptrapd verbose — abaikan */ });
    proc.on('error', (err) => console.warn('[TrapSource] snmptrapd error:', err.message));
    proc.on('exit', (code) => console.warn(`[TrapSource] snmptrapd keluar (${code})`));
    return { started: true, status: 'running', reason: null };
  } catch (e) {
    return { started: false, status: 'unavailable', reason: 'Gagal menjalankan snmptrapd: ' + e.message };
  }
}

function stop() {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    proc = null;
  }
}

module.exports = { start, stop };
