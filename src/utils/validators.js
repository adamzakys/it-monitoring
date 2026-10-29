// Shared input validators — used by routes/api.js, streamService.js, 
// topologyDiscovery.js, profiler.js
// Single source of truth for all validation patterns.

const RE_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const RE_IPV6 = /^(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}$|^(?:[0-9A-Fa-f]{1,4}:){1,7}:$|^::1?$|^(?:[0-9A-Fa-f]{1,4}:){1,6}(?:\d{1,3}\.){3}\d{1,3}$/;
// RFC 1123 hostname: labels of letters/digits/hyphens, separated by dots.
// Each label 1-63 chars, total <=253, no leading/trailing hyphen in any label.
const RE_HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/;
const RE_PORT = /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;
const RE_COMMUNITY = /^[A-Za-z0-9_\-]{1,32}$/;
// Numeric OID only (e.g. ".1.3.6.1.2.1.1.3.0" or "1.3.6.1.2.1.1.3.0").
// We do NOT permit textual MIB names here because they are not user input
// — they are constants in the codebase.
const RE_SNMP_OID = /^\.?[0-9]+(?:\.[0-9]+)*$/;

function isValidTarget(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  return RE_IPV4.test(value) || RE_IPV6.test(value) || RE_HOSTNAME.test(value);
}

function isValidPort(value) {
  return typeof value === 'string' && RE_PORT.test(value);
}

function isValidCommunity(value) {
  return typeof value === 'string' && RE_COMMUNITY.test(value);
}

function isValidOid(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && RE_SNMP_OID.test(value);
}

module.exports = {
  RE_IPV4,
  RE_IPV6,
  RE_HOSTNAME,
  RE_PORT,
  RE_COMMUNITY,
  RE_SNMP_OID,
  isValidTarget,
  isValidPort,
  isValidCommunity,
  isValidOid
};