/**
 * Rule korelasi log → Event (LAPISAN 2).
 * Prinsip: tidak semua log menjadi Event. Rule di bawah bekerja di atas field
 * TER-NORMALISASI (severity/program/message), bukan format vendor. Event hasil
 * korelasi ditulis dgn events.source='syslog' — TIDAK pernah otomatis menjadi
 * Incident (Incident tetap dari health engine).
 * Menambah vendor baru = menambah rule; struktur inti tidak berubah.
 */

const eventLogger = require('../eventLogger');

const RULES = [
  {
    id: 'link-down',
    name: 'Link / Interface down',
    eventType: eventLogger.EVENT_TYPES.WARNING,
    test: (n) => (/link|interface|ether/i.test(n.message || '')) && (/down|not ready|lost/i.test(n.message || ''))
  },
  {
    id: 'link-up',
    name: 'Link / Interface up',
    eventType: eventLogger.EVENT_TYPES.WARNING,
    test: (n) => (/link|interface|ether/i.test(n.message || '')) && (/up\b|link up|running/i.test(n.message || ''))
  },
  {
    id: 'dhcp-ppp-error',
    name: 'DHCP / PPP / routing error',
    eventType: eventLogger.EVENT_TYPES.WARNING,
    test: (n) => {
      const sevOrder = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
      const severe = sevOrder.indexOf(n.severity) >= sevOrder.indexOf('error');
      return /(dhcp|ppp|ospf|bgp|vpn|ipsec)/i.test(n.message || '') && (severe || n.severity === 'error');
    }
  },
  {
    id: 'auth-failure',
    name: 'Authentication failure',
    eventType: eventLogger.EVENT_TYPES.WARNING,
    test: (n) => /(login|password|auth|ssh)/i.test(n.message || '') &&
      /(failed|invalid|denied|failure|rejected)/i.test(n.message || '')
  },
  {
    id: 'reboot',
    name: 'Device reboot / boot',
    eventType: eventLogger.EVENT_TYPES.WARNING,
    test: (n) => /(reboot|router was rebooted|system boot|booting)/i.test(n.message || '')
  },
  {
    id: 'critical-syslog',
    name: 'Critical system message',
    eventType: eventLogger.EVENT_TYPES.WARNING,
    test: (n) => {
      const sevOrder = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
      return sevOrder.indexOf(n.severity) >= sevOrder.indexOf('critical');
    }
  }
];

/** Evaluasi semua rule terhadap satu log ternormalisasi; null bila tidak ada match. */
function evaluate(norm) {
  for (const rule of RULES) {
    if (rule.test(norm)) return rule;
  }
  return null;
}

module.exports = { evaluate, RULES };
