/**
 * Syslog source adapter (UDP + TCP).
 * Menerima syslog push dari perangkat (MikroTik /system logging remote,
 * rsyslog/syslog-ng Linux, appliance, dll), mem-parsing per baris, lalu
 * meneruskan ke normalizer → store. Tanpa dependency eksternal.
 */
const dgram = require('dgram');
const net = require('net');
const { parseSyslogLine } = require('../normalizer');

const MAX_MSG = 8192;
const rate = new Map(); // ip -> { count, windowStart, dropped }

function allowIp(ip, burst = 200, perSec = 10) {
  const now = Date.now();
  let r = rate.get(ip);
  if (!r || now - r.windowStart > perSec * 1000) {
    r = { count: 0, windowStart: now, dropped: 0 };
    rate.set(ip, r);
  }
  if (r.count >= burst) {
    r.dropped++;
    if (r.dropped === 1 || r.dropped % 500 === 0) {
      console.warn(`[SyslogSource] rate-limit: drop burst dari ${ip} (${r.dropped} pesan terbuang)`);
    }
    return false;
  }
  r.count++;
  return true;
}

function normIp(ip) {
  return ip ? ip.replace(/^::ffff:/, '') : null;
}

function handleLine(line, meta, onMessage) {
  const text = String(line).trim();
  if (!text || text.length > MAX_MSG) return;
  const norm = parseSyslogLine(text);
  if (!norm) return;
  onMessage({
    ...norm,
    sourceIp: normIp(meta.sourceIp),
    sourceType: 'syslog',
    transport: meta.transport,
    raw: text
  });
}

/** Start UDP + TCP listener. Resolve saat keduanya bind (atau salah satu gagal). */
function start({ port, host, onMessage }) {
  return new Promise((resolve) => {
    const udp = dgram.createSocket('udp4');
    const tcp = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length > MAX_MSG * 4) buf = '';
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          const sourceIp = normIp(socket.remoteAddress);
          if (sourceIp && !allowIp(sourceIp)) continue;
          handleLine(line, { sourceIp, transport: `tcp${port}` }, onMessage);
        }
      });
      socket.on('error', () => {});
    });

    udp.on('message', (msg, rinfo) => {
      const sourceIp = normIp(rinfo.address);
      if (sourceIp && !allowIp(sourceIp)) return;
      const text = msg.toString('utf8');
      // Satu datagram bisa berisi beberapa baris.
      for (const line of text.split('\n')) {
        handleLine(line, { sourceIp, transport: `udp${port}` }, onMessage);
      }
    });
    udp.on('error', (err) => console.warn('[SyslogSource] UDP error:', err.message));

    const report = (failures) => {
      resolve({
        started: failures.length === 0,
        udp: !failures.includes('udp'),
        tcp: !failures.includes('tcp'),
        port,
        failures
      });
    };

    const failures = [];
    tcp.on('error', (err) => {
      console.warn(`[SyslogSource] TCP :${port} gagal bind — ${err.message}`);
      failures.push('tcp');
      if (failures.length === 2) report(failures);
    });
    udp.on('listening', () => {});
    // Sinkronisasi status: cukup laporkan saat keduanya selesai (listening/error).
    let udpDone = false, tcpDone = false;
    const maybeReport = () => { if (udpDone && tcpDone) report(failures); };
    udp.on('listening', () => { udpDone = true; maybeReport(); });
    tcp.on('listening', () => { tcpDone = true; maybeReport(); });

    try {
      udp.bind(port, host);
    } catch (e) {
      udpDone = true;
      failures.push('udp');
      maybeReport();
    }
    tcp.listen(port, host, () => {
      // pastikan flag set (listen callback jg)
      tcpDone = true;
      maybeReport();
    });
  });
}

module.exports = { start };
