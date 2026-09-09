/**
 * ITNETMON Topology Discovery Service
 * ----------------------------------------------------------------------------
 * Melakukan SNMP walk untuk LLDP-MIB, CDP, dan MNDP ke setiap device,
 * lalu menyimpan hasilnya ke tabel `device_links` (PostgreSQL).
 *
 * Strategy:
 * 1. SNMP walk LLDP-MIB::lldpRemTable → lldpRemChassisId, lldpRemSysName, dll
 * 2. SNMP walk CDP-CACHE (Cisco): .1.3.6.1.4.1.9.9.23.1.2.1.1.x
 * 3. SNMP walk MNDP (Mikrotik): .1.3.6.1.4.1.14988 (best-effort)
 * 4. Untuk setiap neighbor, resolve target_device_id via:
 *    - Match 1: target_chassis_id (MAC) → Mikrotik ARP table → IP → devices
 *    - Match 2: target_sys_name → lowercased substring match → devices.name
 * 5. Fallback: target_device_id = NULL (unmanaged node)
 *
 * Schedule: setInterval 5 menit + manual trigger via API.
 */

const { spawn } = require('child_process');

// Phase 1: strict target validator. Mirrors the one in routes/api.js.
// OIDs are validated by being internal constants (see OID table below).
const RE_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
const RE_IPV6 = /^(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}$|^(?:[0-9A-Fa-f]{1,4}:){1,7}:$|^::1?$|^(?:[0-9A-Fa-f]{1,4}:){1,6}(?:\d{1,3}\.){3}\d{1,3}$/;
const RE_HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*\.?$/;
const RE_COMMUNITY = /^[A-Za-z0-9_\-]{1,32}$/;
function _isValidTarget(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  return RE_IPV4.test(value) || RE_IPV6.test(value) || RE_HOSTNAME.test(value);
}
function _isValidCommunity(value) {
  return typeof value === 'string' && RE_COMMUNITY.test(value);
}

let db = null;
let discoveryTimer = null;
let isRunning = false;

// OID constants (numeric — portable, no MIB dependency)
const OID = {
  // LLDP-MIB: lldpRemTable
  lldpRemChassisId: '.1.0.8802.1.1.2.1.4.1.1.5',  // LLDP-MIB::lldpRemChassisId
  lldpRemPortId: '.1.0.8802.1.1.2.1.4.1.1.7',      // LLDP-MIB::lldpRemPortId
  lldpRemPortDesc: '.1.0.8802.1.1.2.1.4.1.1.8',    // LLDP-MIB::lldpRemPortDesc
  lldpRemSysName: '.1.0.8802.1.1.2.1.4.1.1.9',     // LLDP-MIB::lldpRemSysName
  lldpRemSysDesc: '.1.0.8802.1.1.2.1.4.1.1.10',    // LLDP-MIB::lldpRemSysDesc

  // LLDP-MIB: lldpRemManAddrTable — Management Address TLV.
  // Standard place where a neighbor advertises its IP. Previously never
  // walked, which is why unmanaged nodes always showed IP "unknown".
  lldpRemManAddrSubtree: '.1.0.8802.1.1.2.1.4.2',   // whole table (probe)
  lldpRemManAddrIfSubtype: '.1.0.8802.1.1.2.1.4.2.1.1', // lldpRemManAddrIfSubtype
  lldpRemManAddrIfId: '.1.0.8802.1.1.2.1.4.2.1.2',      // lldpRemManAddrIfId
  lldpRemManAddr: '.1.0.8802.1.1.2.1.4.2.1.4',          // lldpRemManAddr (addr octets)

  // CDP (Cisco): cdpCacheTable
  cdpCacheAddr: '.1.3.6.1.4.1.9.9.23.1.2.1.1.4',   // cdpCacheAddress (IPv4)
  cdpCacheDeviceId: '.1.3.6.1.4.1.9.9.23.1.2.1.1.6', // cdpCacheDeviceId
  cdpCacheDevicePort: '.1.3.6.1.4.1.9.9.23.1.2.1.1.7', // cdpCacheDevicePort
  cdpCachePlatform: '.1.3.6.1.4.1.9.9.23.1.2.1.1.8',  // cdpCachePlatform

  // IP-MIB ARP (ipNetToMediaTable)
  // IMPORTANT: Mikrotik only returns full data when walking the whole subtree
  // (1.3.6.1.2.1.4.22). Walking individual siblings returns incomplete data.
  // We walk the whole subtree and filter by field suffix.
  ipNetToMediaSubtree: '.1.3.6.1.2.1.4.22',         // whole ARP table subtree
  ipNetToMediaIfIndex: '.1.3.6.1.2.1.4.22.1.1.1',  // field index in table
  ipNetToMediaPhysAddress: '.1.3.6.1.2.1.4.22.1.1.2', // MAC address
  ipNetToMediaNetAddress: '.1.3.6.1.2.1.4.22.1.1.3'   // IP address
};

function init(deps) {
  db = deps.db;
}

/**
 * SNMP walk wrapper — returns parsed output as array of { oid, value }
 * Phase 1: uses spawn() with arg array. The OID is restricted to internal
 * constants (validated by the OID constant table above) and the target
 * IP/hostname is validated by _isValidTarget() before invocation.
 */
function snmpWalk(ip, oid, community = 'public', timeoutMs = 5000) {
  // Phase 1: defend against malformed or hostile input. OIDs are passed
  // by the caller — we trust only the constants in the OID table at the
  // top of this file (numeric only, single dot-separated integers).
  if (!_isValidTarget(ip) || !_isValidCommunity(community)) {
    return Promise.resolve([]);
  }
  // OID must be a numeric string (e.g. ".1.3.6.1.4.1" or "1.3.6.1.4.1").
  // This blocks any textual MIB names like "IF-MIB::ifXTable" from being
  // passed by future call sites that might trust user input.
  if (typeof oid !== 'string' || !/^\.?[0-9]+(?:\.[0-9]+)*$/.test(oid)) {
    return Promise.resolve([]);
  }
  return new Promise((resolve) => {
    const child = spawn(
      'snmpwalk',
      ['-v2c', '-c', community, '-t', String(Math.floor(timeoutMs / 1000)), '-r', '0', ip, oid],
      { timeout: timeoutMs + 2000, maxBuffer: 1024 * 1024 }
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      // Preserve the previous `head -200` line cap by truncating here.
      // We do not stream-pipe to head; instead we count lines and stop.
      const text = chunk.toString();
      const lines = text.split('\n');
      if (stdout === '') {
        // First chunk: take up to 200 lines.
        if (lines.length > 200) {
          stdout = lines.slice(0, 200).join('\n');
          // Stop reading further by killing the process — head -200 semantics.
          try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        } else {
          stdout = text;
        }
      }
      // Subsequent chunks are dropped because we've already capped to 200.
    });
    child.on('error', () => {
      resolve([]);
    });
    child.on('close', () => {
      const results = [];
      const lines = stdout.split('\n');
      for (const line of lines) {
        // Format: "OID.1.2.3 = TYPE: value" or "IF-MIB::ifName.1 = STRING: ether1"
        // Take everything before " = "
        const eqIdx = line.indexOf(' = ');
        if (eqIdx === -1) continue;
        const leftSide = line.substring(0, eqIdx);
        const rightSide = line.substring(eqIdx + 3);

        // Extract last numeric OID suffix (index) for matching
        const match = leftSide.match(/\.(\d+)$/);
        const index = match ? match[1] : '0';

        // Extract value (after type like "STRING: " or "INTEGER: " or "Hex-STRING: ")
        let value = rightSide;
        const colonIdx = rightSide.indexOf(': ');
        if (colonIdx !== -1) {
          value = rightSide.substring(colonIdx + 2).trim();
        } else {
          // Hex-STRING or raw value
          const spaceIdx = rightSide.indexOf(' ');
          if (spaceIdx !== -1) {
            value = rightSide.substring(spaceIdx + 1).trim();
          }
        }

        // Strip surrounding quotes if present (Mikrotik returns STRING: "value" with quotes)
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          value = value.substring(1, value.length - 1);
        }
        // Also strip single quotes for safety
        if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
          value = value.substring(1, value.length - 1);
        }

        // Clean hex strings: convert "AA:BB:CC:..." to MAC-like lowercase
        if (value.match(/^[0-9A-F]{2}( [0-9A-F]{2})+$/i)) {
          value = value.replace(/ /g, ':').toLowerCase();
        } else if (value.match(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/i)) {
          // Already colon-separated, just lowercase
          value = value.toLowerCase();
        }

        results.push({ oid: leftSide, index, value, raw: line });
      }
      resolve(results);
    });
  });
}

/**
 * Extract a full OID suffix after a given base OID.
 * Example: extractOidSuffix('.1.3.6.1.2.1.4.22.1.1.2.1.192.168.128.104', '1.3.6.1.2.1.4.22.1.1.2') → '1.192.168.128.104'
 */
function extractOidSuffix(oid, baseOid) {
  if (!oid || !baseOid) return '';
  const normalized = oid.startsWith('.') ? oid : '.' + oid;
  const normalizedBase = baseOid.startsWith('.') ? baseOid : '.' + baseOid;
  if (normalized.startsWith(normalizedBase + '.')) {
    return normalized.substring(normalizedBase.length + 1);
  }
  return '';
}

/**
 * Get ARP table from Mikrotik device to resolve MAC → IP.
 * Returns Map<macLowercase, ipString>
 *
 * ipNetToMediaTable OID: .1.3.6.1.2.1.4.22.1.1.<field>.<ifIndex>.<ipAddress>
 * Example: .1.3.6.1.2.1.4.22.1.1.2.1.192.168.128.104
 *   - field=2: ipNetToMediaPhysAddress (MAC)
 *   - ifIndex=1: interface index
 *   - ipAddress=192.168.128.104: full IP dotted
 * We need to extract BOTH ifIndex and ipAddress as composite key.
 */
async function getArpTable(device) {
  if (!device.ip_address) return new Map();

  // Walk the whole ipNetToMedia subtree (Mikrotik only returns complete data this way)
  const allEntries = await snmpWalk(device.ip_address, OID.ipNetToMediaSubtree, device.snmp_community || 'public');

  // OID pattern from snmpwalk: "IP-MIB::ipNetToMediaXXX.<ifIndex>.<ipAddress>"
  // where XXX is one of: IfIndex, PhysAddress, NetAddress, Type
  // OR (if numeric OID): ".1.3.6.1.2.1.4.22.1.1.<field>.<ifIndex>.<ipAddress>"
  // The instance part (ifIndex.ip) is common across all 4 fields for one entry.
  const byKey = {};

  for (const r of allEntries) {
    const oid = r.oid;
    let field = null;
    let instance = null;

    // Try textual OID first (Debian returns "IP-MIB::ipNetToMedia...")
    if (oid.includes('ipNetToMediaPhysAddress')) {
      field = '2';
    } else if (oid.includes('ipNetToMediaNetAddress')) {
      field = '3';
    } else if (oid.includes('ipNetToMediaIfIndex')) {
      field = '1';
    } else if (oid.includes('ipNetToMediaType')) {
      field = '4';
    }

    if (field) {
      // Extract instance: everything after the last OID name segment
      // "IP-MIB::ipNetToMediaPhysAddress.2.192.168.128.233" → "2.192.168.128.233"
      const match = oid.match(/ipNetToMedia\w+\.(.+)$/);
      if (match) {
        instance = match[1];
      }
    } else {
      // Try numeric OID (Mikrotik): ".0.8802..." or ".1.3.6.1.2.1.4.22.1.1.<field>..."
      // For Mikrotik, the OID was returned as "iso.0.8802..." but here we have ipNetToMedia so
      // the format is "IP-MIB::ipNetToMedia..." not numeric.
      // If we hit a numeric OID for ipNetToMedia, try to parse suffix.
      // Field digit is the segment right after ".22.1.1."
      let oidNorm = oid;
      if (oidNorm.startsWith('iso.')) oidNorm = '.' + oidNorm.substring(4);
      const idx = oidNorm.lastIndexOf('.22.1.1.');
      if (idx >= 0) {
        const after = oidNorm.substring(idx + 8); // skip ".22.1.1." (8 chars)
        const firstDot = after.indexOf('.');
        if (firstDot > 0) {
          field = after.substring(0, firstDot);
          instance = after.substring(firstDot + 1);
        }
      }
    }

    if (!field || !instance) continue;

    // Parse instance: "2.192.168.128.233" → ifIndex=2, IP=192.168.128.233
    const firstDot = instance.indexOf('.');
    if (firstDot < 0) continue;
    const ifIndex = instance.substring(0, firstDot);
    const ip = instance.substring(firstDot + 1);

    const key = ifIndex + '.' + ip;
    if (!byKey[key]) byKey[key] = { ifIndex, ip };
    if (field === '2') byKey[key].mac = r.value;
    else if (field === '3') byKey[key].ip = r.value;
  }

  const arpMap = new Map();
  for (const k of Object.keys(byKey)) {
    const e = byKey[k];
    if (e.mac && e.ip) {
      const macNormal = e.mac.toLowerCase().replace(/[:-]/g, ':');
      arpMap.set(macNormal, e.ip);
    }
  }
  return arpMap;
}

/**
 * Lenient IPv6 literal check (the const RE_IPV6 only accepts a few shapes
 * and rejects compressed forms like "fe80::8c5a:7798:4cad:9472").
 */
function looksLikeIpv6(value) {
  const s = String(value || '').trim();
  if (!s.includes(':')) return false;
  if (s.includes(':::')) return false;
  const dbl = s.split('::');
  if (dbl.length > 2) return false;
  const ok = dbl.every(side =>
    side.split(':').every(seg =>
      seg === '' || /^[0-9A-Fa-f]{1,4}$/.test(seg) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(seg)
    )
  );
  return ok;
}

/**
 * Decode an SNMP scalar value that may carry an IP address.
 * Accepts:
 *  - plain dotted IPv4 / IPv6 literal ("192.168.1.1", "fe80::1")
 *  - hex pairs ("C0 A8 01 01" or "C0:A8:01:01") → IPv4/IPv6
 * Returns normalized IP string or null.
 */
function decodeSnmpAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (RE_IPV4.test(raw) || looksLikeIpv6(raw)) return raw;

  // Hex-STRING style octets (4 bytes → IPv4, 16 bytes → IPv6)
  if (/^[0-9A-Fa-f]{2}([:\s][0-9A-Fa-f]{2})+$/.test(raw)) {
    const bytes = raw.split(/[:\s]+/).map(b => parseInt(b, 16));
    if (bytes.length === 4) {
      return bytes.join('.');
    }
    if (bytes.length === 16) {
      const groups = [];
      for (let i = 0; i < 16; i += 2) {
        groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
      }
      // RFC 5952-style compression of the longest zero run
      let bestStart = -1;
      let bestLen = 0;
      let curStart = -1;
      let curLen = 0;
      for (let i = 0; i < 8; i++) {
        if (groups[i] === '0') {
          if (curStart === -1) curStart = i;
          curLen++;
          if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        } else {
          curStart = -1;
          curLen = 0;
        }
      }
      let out;
      if (bestLen >= 2) {
        out = groups.slice(0, bestStart).concat([''], groups.slice(bestStart + bestLen)).join(':');
      } else {
        out = groups.join(':');
      }
      return out;
    }
  }
  return null;
}

/**
 * Parse LLDP walk output.
 * Returns array of { index, chassisId, portId, portDesc, sysName, sysDesc, ip }
 * Note: Mikrotik returns OIDs in numeric form (iso.0.8802...) not textual,
 * so we match by numeric suffix, not by string contains.
 * OIDs from snmpWalk may have "iso." prefix that we need to normalize.
 *
 * Also consumes the lldpRemManAddr* walk rows (Management Address TLV) and
 * attaches the advertised IP to the matching remote neighbor, keyed by the
 * same remote index that lldpRemTable uses.
 */
function parseLldpWalk(walkResults) {
  // OID pattern in lldpRemTable: ...1.4.1.1.<field>.<index>
  // Field IDs (last digit of lldpRemEntry OID): 5=chassisId, 7=portId,
  // 8=portDesc, 9=sysName, 10=sysDesc
  const FIELD_PATTERN = '.1.4.1.1.';
  // lldpRemManAddrTable pattern: ...1.4.2.1.<field>.<time>.<port>.<remIndex>[.<subtype>.<addr>...]
  const MAN_PATTERN = '.1.4.2.1.';
  const byIndex = {};

  const normalizeOid = (oid) => (oid.startsWith('iso.') ? '.' + oid.substring(4) : oid);

  for (const r of walkResults) {
    if (!byIndex[r.index]) byIndex[r.index] = {};
    let oid = normalizeOid(r.oid);
    const idx = oid.lastIndexOf(FIELD_PATTERN);
    if (idx < 0) continue;
    const fieldSegment = oid.substring(idx + FIELD_PATTERN.length);
    const firstDot = fieldSegment.indexOf('.');
    if (firstDot < 0) continue;
    const fieldId = fieldSegment.substring(0, firstDot);
    switch (fieldId) {
      case '5': byIndex[r.index].chassisId = r.value; break;
      case '7': byIndex[r.index].portId = r.value; break;
      case '8': byIndex[r.index].portDesc = r.value; break;
      case '9': byIndex[r.index].sysName = r.value; break;
      case '10': byIndex[r.index].sysDesc = r.value; break;
    }
  }

  // Second pass: management address (lldpRemManAddrIfId / lldpRemManAddr).
  for (const r of walkResults) {
    let oid = normalizeOid(r.oid);
    const idx = oid.lastIndexOf(MAN_PATTERN);
    if (idx < 0) continue;
    const fieldSegment = oid.substring(idx + MAN_PATTERN.length);
    const parts = fieldSegment.split('.').filter(Boolean);
    const fieldId = parts[0];
    // Only IfId (2) and ManAddr (4) actually carry an address literal/octets.
    if (fieldId !== '2' && fieldId !== '4') continue;
    const ip = decodeSnmpAddress(r.value);
    if (!ip) continue;

    // Instance layout: <timeMark>.<localPort>.<remIndex>[.<addrSubtype>.<addr>...]
    const nums = parts.slice(1).map(Number);
    if (nums.length === 0) continue;
    // Candidate keys in priority order: classic remIndex position, then last.
    const keys = [];
    if (nums.length >= 3) keys.push(String(nums[2]));
    keys.push(String(nums[nums.length - 1]));

    let target = null;
    for (const k of keys) {
      if (byIndex[k]) { target = byIndex[k]; break; }
    }
    if (!target) continue;
    // Prefer IPv4 (matches our device inventory addressing) over IPv6.
    if (!target.ip || RE_IPV4.test(ip)) {
      target.ip = ip;
    }
  }

  return Object.values(byIndex).filter(n => n.chassisId);
}

/**
 * Parse CDP walk output.
 * Returns array of { ip, deviceId, port, platform }
 */
function parseCdpWalk(walkResults) {
  const byIndex = {};
  for (const r of walkResults) {
    if (!byIndex[r.index]) byIndex[r.index] = {};
    if (r.oid.includes('cdpCacheAddress')) byIndex[r.index].ip = r.value;
    else if (r.oid.includes('cdpCacheDeviceId')) byIndex[r.index].deviceId = r.value;
    else if (r.oid.includes('cdpCacheDevicePort')) byIndex[r.index].port = r.value;
    else if (r.oid.includes('cdpCachePlatform')) byIndex[r.index].platform = r.value;
  }
  // CDP cache is indexed, may have separate indexes for different fields.
  // Use deviceId+port as dedup key since IP may use different sub-index
  const byKey = {};
  for (const k of Object.keys(byIndex)) {
    const e = byIndex[k];
    if (e.deviceId && e.port) {
      const key = `${e.deviceId}::${e.port}`;
      byKey[key] = e;
    }
  }
  return Object.values(byKey);
}

/**
 * Resolve neighbor → device_id using multi-strategy matching.
 *
 * Strategy:
 * 1. If chassisId provided: lookup in source device's ARP table (MAC → IP → match devices.ip)
 * 2. If sysName/deviceId: lowercased substring match against devices.name OR devices.ip_address
 * 3. If IP available directly: match devices.ip_address
 *
 * Returns: { targetDeviceId: number|null, targetIp: string|null, targetChassisId: string }
 */
async function matchNeighbor(sourceDevice, allDevices, neighbor, arpMap) {
  const result = {
    targetDeviceId: null,
    targetIp: null,
    targetChassisId: neighbor.chassisId || null,
    targetSysName: neighbor.sysName || neighbor.deviceId || null
  };

  // Normalize chassisId: lowercase, colon-separated, strip any remaining quotes/whitespace
  const normalizeMac = (mac) => {
    if (!mac) return null;
    let s = String(mac).toLowerCase().trim();
    s = s.replace(/^["']+|["']+$/g, ''); // strip surrounding quotes
    s = s.replace(/[\s\-]+/g, ':');         // spaces/dashes → colons
    // Validate: 6 hex octets
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) return null;
    return s;
  };

  const normalizedChassis = normalizeMac(neighbor.chassisId);

  // Strategy 1: MAC → ARP → IP → match
  if (normalizedChassis && arpMap && arpMap.size > 0) {
    const ip = arpMap.get(normalizedChassis);
    if (ip) {
      result.targetIp = ip;
      const matched = allDevices.find(d => d.ip_address === ip);
      if (matched) {
        result.targetDeviceId = matched.id;
        return result;
      }
    }
  }

  // Strategy 2: IP direct (from CDP or LLDP)
  if (neighbor.ip) {
    result.targetIp = neighbor.ip;
    const matched = allDevices.find(d => d.ip_address === neighbor.ip);
    if (matched) {
      result.targetDeviceId = matched.id;
      return result;
    }
  }

  // Strategy 3: hostname/sysName match
  // IMPORTANT: Exclude self (sourceDevice) from matching by exact name
  if (neighbor.sysName || neighbor.deviceId) {
    const name = (neighbor.sysName || neighbor.deviceId || '').toLowerCase().trim();
    if (name) {
      // Try exact match first
      let matched = allDevices.find(d => (d.name || '').toLowerCase() === name);
      if (!matched) {
        // Substring match (forward)
        matched = allDevices.find(d => (d.name || '').toLowerCase().includes(name));
      }
      if (!matched && name.length > 3) {
        // Reverse substring: our device name is part of remote sysName
        matched = allDevices.find(d => name.includes((d.name || '').toLowerCase()));
      }
      // Exclude self (source device) — important for substring matches
      if (matched && matched.id === sourceDevice.id) {
        matched = null;
      }
      if (matched) {
        result.targetDeviceId = matched.id;
        if (!result.targetIp) result.targetIp = matched.ip_address;
      }
    }
  }

  return result;
}

/**
 * Get all devices from DB or memory store
 */
async function getAllDevices() {
  if (db.isPostgresConnected()) {
    const r = await db.query('SELECT * FROM devices ORDER BY id ASC');
    return r.rows;
  }
  return db.getMemoryStore().devices;
}

/**
 * Persist a single link to device_links table.
 */
async function persistLink(link) {
  if (!db.isPostgresConnected()) {
    const store = db.getMemoryStore();
    if (!store.device_links) store.device_links = [];
    // dedup
    const existing = store.device_links.find(l =>
      l.source_device_id === link.source_device_id &&
      l.source_interface === link.source_interface &&
      l.target_chassis_id === link.target_chassis_id
    );
    if (existing) {
      Object.assign(existing, link, { last_seen: new Date().toISOString(), stale: false });
    } else {
      store.device_links.push({
        id: Date.now() + Math.random(),
        ...link,
        discovered_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        stale: false
      });
    }
    return;
  }

  await db.query(
    `INSERT INTO device_links (
      source_device_id, source_interface, target_chassis_id, target_sys_name,
      target_port_id, target_port_desc, target_ip, target_device_id,
      protocol, discovered_at, last_seen, stale
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), false)
    ON CONFLICT (source_device_id, source_interface, target_chassis_id)
    DO UPDATE SET
      target_sys_name = EXCLUDED.target_sys_name,
      target_port_id = EXCLUDED.target_port_id,
      target_port_desc = EXCLUDED.target_port_desc,
      target_ip = EXCLUDED.target_ip,
      target_device_id = EXCLUDED.target_device_id,
      protocol = EXCLUDED.protocol,
      last_seen = NOW(),
      stale = false`,
    [
      link.source_device_id,
      link.source_interface,
      link.target_chassis_id,
      link.target_sys_name,
      link.target_port_id,
      link.target_port_desc,
      link.target_ip,
      link.target_device_id,
      link.protocol
    ]
  );
}

/**
 * Mark all existing links as stale. After new discovery, fresh links are marked fresh.
 * Links that stay stale for too long can be deleted.
 */
async function markAllLinksStale() {
  if (!db.isPostgresConnected()) {
    const store = db.getMemoryStore();
    if (store.device_links) {
      for (const l of store.device_links) l.stale = true;
    }
    return;
  }
  await db.query(`UPDATE device_links SET stale = true WHERE stale = false`);
}

/**
 * Discover topology for all devices.
 * Returns: { totalLinks, byProtocol: { lldp: n, cdp: n, mndp: n }, errors: [...] }
 */
async function discoverTopology() {
  if (isRunning) {
    console.log('[TopologyDiscovery] Already running, skipping (prevent overlap)');
    return { skipped: true };
  }
  isRunning = true;
  const startTime = Date.now();

  console.log('[TopologyDiscovery] Starting topology discovery...');

  let allDevices = [];
  try {
    allDevices = await getAllDevices();
  } catch (e) {
    console.error('[TopologyDiscovery] Failed to load devices:', e.message);
    isRunning = false;
    return { error: e.message };
  }

  if (allDevices.length === 0) {
    console.log('[TopologyDiscovery] No devices registered, skipping');
    isRunning = false;
    return { totalLinks: 0, message: 'no devices' };
  }

  // Mark all existing links as stale first
  await markAllLinksStale();

  // Build a quick lookup of all devices for matching
  const deviceById = new Map();
  for (const d of allDevices) deviceById.set(d.id, d);

  const allLinks = [];
  const errors = [];
  const stats = { lldp: 0, cdp: 0, mndp: 0 };

  for (const device of allDevices) {
    if (!device.ip_address) {
      errors.push({ deviceId: device.id, error: 'no ip_address' });
      continue;
    }

    // Skip obviously offline devices (saves SNMP timeouts)
    if (device.status === 'offline') {
      errors.push({ deviceId: device.id, error: 'device offline, skip' });
      continue;
    }

    // Get ARP table for MAC→IP resolution
    let arpMap = new Map();
    try {
      arpMap = await getArpTable(device);
    } catch (e) {
      // non-fatal
    }

    // Walk LLDP
    try {
      // We need to walk the whole table — run separate walks per field.
      // Includes lldpRemManAddr* (management address = neighbor IP).
      const allLldpResults = [];
      for (const fieldOid of [
        OID.lldpRemChassisId,
        OID.lldpRemPortId,
        OID.lldpRemPortDesc,
        OID.lldpRemSysName,
        OID.lldpRemSysDesc
      ]) {
        const r = await snmpWalk(device.ip_address, fieldOid, device.snmp_community || 'public');
        allLldpResults.push(...r);
      }
      // Management-address TLV (neighbor IP). MikroTik only answers a full
      // subtree walk (per-column walks return nothing), same quirk as ARP.
      const manAddrRows = await snmpWalk(device.ip_address, OID.lldpRemManAddrSubtree, device.snmp_community || 'public');
      allLldpResults.push(...manAddrRows);

      const neighbors = parseLldpWalk(allLldpResults);
      for (const n of neighbors) {
        const matched = await matchNeighbor(device, allDevices, n, arpMap);

        // Self-loop detection: targetDeviceId equals source device id
        if (matched.targetDeviceId && matched.targetDeviceId === device.id) continue;

        const link = {
          source_device_id: device.id,
          source_interface: 'auto', // LLDP doesn't easily map per-interface index
          target_chassis_id: matched.targetChassisId,
          target_sys_name: matched.targetSysName,
          target_port_id: n.portId || null,
          target_port_desc: n.portDesc || null,
          target_ip: matched.targetIp,
          target_device_id: matched.targetDeviceId,
          protocol: 'lldp'
        };
        allLinks.push(link);
        stats.lldp++;
        try {
          await persistLink(link);
        } catch (e) {
          errors.push({ deviceId: device.id, error: 'persist lldp: ' + e.message });
        }
      }
    } catch (e) {
      // LLDP not supported, skip silently
    }

    // Walk CDP (best-effort, only Cisco devices)
    try {
      const allCdpResults = [];
      for (const fieldOid of [
        OID.cdpCacheAddr,
        OID.cdpCacheDeviceId,
        OID.cdpCacheDevicePort,
        OID.cdpCachePlatform
      ]) {
        const r = await snmpWalk(device.ip_address, fieldOid, device.snmp_community || 'public');
        allCdpResults.push(...r);
      }

      const cdpNeighbors = parseCdpWalk(allCdpResults);
      for (const n of cdpNeighbors) {
        const matched = await matchNeighbor(device, allDevices, { ...n, sysName: n.deviceId }, arpMap);
        if (matched.targetDeviceId === device.id) continue;

        const link = {
          source_device_id: device.id,
          source_interface: 'auto',
          target_chassis_id: null,
          target_sys_name: n.deviceId,
          target_port_id: n.port,
          target_port_desc: n.platform,
          target_ip: matched.targetIp,
          target_device_id: matched.targetDeviceId,
          protocol: 'cdp'
        };
        allLinks.push(link);
        stats.cdp++;
        try {
          await persistLink(link);
        } catch (e) {
          errors.push({ deviceId: device.id, error: 'persist cdp: ' + e.message });
        }
      }
    } catch (e) {
      // CDP not supported, skip silently
    }
  }

  // Mark links as stale (in DB) that weren't seen this run — they'll be deleted by cleanup if too old
  // (This is already done by markAllLinksStale() at the start)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[TopologyDiscovery] Discovery complete in ${elapsed}s — ${stats.lldp} LLDP, ${stats.cdp} CDP links, ${errors.length} errors`);

  isRunning = false;
  return { totalLinks: allLinks.length, stats, errors, elapsed };
}

/**
 * Start periodic discovery (every N minutes)
 */
function scheduleDiscovery(intervalMinutes = 5) {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`[TopologyDiscovery] Scheduled every ${intervalMinutes} minutes`);

  // Initial discovery after 30s (let server fully boot first)
  setTimeout(() => {
    discoverTopology().catch(e => console.error('[TopologyDiscovery] Initial error:', e.message));
  }, 30000);

  discoveryTimer = setInterval(() => {
    discoverTopology().catch(e => console.error('[TopologyDiscovery] Periodic error:', e.message));
  }, intervalMs);
}

function stop() {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
    console.log('[TopologyDiscovery] Stopped');
  }
}

module.exports = {
  init,
  discoverTopology,
  scheduleDiscovery,
  stop,
  snmpWalk,
  parseLldpWalk,
  parseCdpWalk,
  matchNeighbor,
  getArpTable
};
