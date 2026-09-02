const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

const confDir = process.env.TELEGRAF_CONF_DIR || './telegraf.d';
const reloadCmd = process.env.TELEGRAF_RELOAD_CMD || 'echo "Reloading Telegraf"';

// Ensure config directory exists and has InfluxDB v2 output configured
function ensureConfDir() {
  const resolvedPath = path.resolve(confDir);
  if (!fs.existsSync(resolvedPath)) {
    try {
      fs.mkdirSync(resolvedPath, { recursive: true });
      console.log(`[TelegrafManager] Created config directory: ${resolvedPath}`);
    } catch (err) {
      console.warn(`[TelegrafManager] Could not create directory ${resolvedPath}: ${err.message}`);
    }
  }

  // Ensure 00-output.conf exists with current InfluxDB v2 credentials
  const outputConfPath = path.join(resolvedPath, '00-output.conf');
  const influxUrl = process.env.INFLUX_URL || 'http://127.0.0.1:8086';
  const influxToken = process.env.INFLUX_TOKEN || '';
  const influxOrg = process.env.INFLUX_ORG || 'itnetmon';
  const influxBucket = process.env.INFLUX_BUCKET || 'itnetmon_metrics';

  const outputConfig = `# ITNETMON Global Telegraf Output to InfluxDB v2
[agent]
  interval = "1s"
  round_interval = true
  metric_batch_size = 1000
  metric_buffer_limit = 10000
  collection_jitter = "0s"
  flush_interval = "1s"
  flush_jitter = "0s"
  precision = "1s"

[[outputs.influxdb_v2]]
  urls = ["${influxUrl}"]
  token = "${influxToken}"
  organization = "${influxOrg}"
  bucket = "${influxBucket}"
`;

  // Detect token drift: kalau token di .env berbeda dari token di file,
  // rewrite supaya telegraf agent selalu pakai token terbaru
  let needRewrite = true;
  try {
    if (fs.existsSync(outputConfPath)) {
      const existing = fs.readFileSync(outputConfPath, 'utf8');
      if (existing.includes(`token = "${influxToken}"`)) {
        needRewrite = false;
      }
    }
  } catch (e) { /* ignore */ }

  if (needRewrite) {
    try {
      fs.writeFileSync(outputConfPath, outputConfig, 'utf8');
      if (influxToken) {
        console.log(`[TelegrafManager] 00-output.conf token updated`);
      } else {
        console.log(`[TelegrafManager] 00-output.conf created (empty token - set INFLUX_TOKEN)`);
      }
    } catch (e) {
      console.warn(`[TelegrafManager] Warning writing 00-output.conf: ${e.message}`);
    }
  }

  return resolvedPath;
}

/**
 * Force rewrite 00-output.conf dengan token saat ini.
 * Panggil setelah token rotation / InfluxDB re-onboard.
 */
function refreshOutputConfig() {
  return ensureConfDir();
}

/**
 * Generates Telegraf configuration content for a specific network device
 */
function buildTelegrafConfig(device) {
  const sanitizedName = device.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const snmpPort = device.snmp_port || 161;
  const community = device.snmp_community || 'public';
  const interval = `${device.polling_interval || 1}s`;

  return `# =====================================================================
# ITNETMON Dynamic Poller Config for Device: ${device.name} (ID: ${device.id})
# Auto-generated at: ${new Date().toISOString()}
# OID strategy:
#   - IF-MIB OIDs use textual names (Telegraf auto-walks table correctly)
#   - DISMAN-EVENT-MIB & HOST-RESOURCES-MIB use numeric OIDs (more portable,
#     avoids dependency on MIB file loading order in gosmi)
# =====================================================================

# 1. ICMP Ping Poller (1s interval)
[[inputs.ping]]
  interval = "${interval}"
  urls = ["${device.ip_address}"]
  count = 1
  ping_interval = 1.0
  timeout = 0.8
  deadline = 1
  binary = "ping"
  [inputs.ping.tags]
    device_id = "${device.id}"
    device_name = "${sanitizedName}"
    device_ip = "${device.ip_address}"

# 2. SNMP Table Poller (IF-MIB 64-bit HC Counters)
[[inputs.snmp]]
  interval = "${interval}"
  agents = ["udp://${device.ip_address}:${snmpPort}"]
  version = 2
  community = "${community}"
  timeout = "800ms"
  retries = 1

  # Path ke MIB files untuk resolve IF-MIB textual OIDs
  path = ["/usr/share/snmp/mibs"]

  [inputs.snmp.tags]
    device_id = "${device.id}"
    device_name = "${sanitizedName}"
    device_ip = "${device.ip_address}"

  # Walk interface table dynamically (textual OID — Telegraf handles table walking)
  [[inputs.snmp.table]]
    oid = "IF-MIB::ifXTable"
    name = "net_interface"
    inherit_tags = ["device_id", "device_name", "device_ip"]

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifName"
      name = "interface_name"
      is_tag = true

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifHCInOctets"
      name = "bytes_in"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifHCOutOctets"
      name = "bytes_out"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifHCInUcastPkts"
      name = "ifHCInUcastPkts"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifHCOutUcastPkts"
      name = "ifHCOutUcastPkts"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifInErrors"
      name = "ifInErrors"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifOutErrors"
      name = "ifOutErrors"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifInDiscards"
      name = "ifInDiscards"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifOutDiscards"
      name = "ifOutDiscards"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifOperStatus"
      name = "oper_status"

    [[inputs.snmp.table.field]]
      oid = "IF-MIB::ifHighSpeed"
      name = "speed_mbps"

  # 3. System Uptime — sysUpTime.0 (centi-seconds, divide by 100 → seconds)
  # Numeric OID: .1.3.6.1.2.1.1.3.0 (DISMAN-EVENT-MIB::sysUpTime.0)
  [[inputs.snmp.field]]
    oid = ".1.3.6.1.2.1.1.3.0"
    name = "uptime_ticks"

  # 4. Host Resources MIB — CPU Load
  # Numeric OID: .1.3.6.1.2.1.25.3.3 (HOST-RESOURCES-MIB::hrProcessorTable)
  [[inputs.snmp.table]]
    oid = ".1.3.6.1.2.1.25.3.3"
    name = "system_cpu"
    inherit_tags = ["device_id", "device_name", "device_ip"]

    [[inputs.snmp.table.field]]
      oid = ".1.3.6.1.2.1.25.3.3.1.2"
      name = "cpu_load_pct"

  # 5. Host Resources MIB — Memory/Storage
  # Numeric OID: .1.3.6.1.2.1.25.2.3 (HOST-RESOURCES-MIB::hrStorageTable)
  # hrStorageSize and hrStorageUsed are reported in *allocation units* (the size
  # of one allocation block, usually 4096 bytes on Linux). We also collect
  # hrStorageAllocationUnits and hrStorageDescr so the backend can convert
  # to bytes and identify "Physical memory" reliably across vendors.
  [[inputs.snmp.table]]
    oid = ".1.3.6.1.2.1.25.2.3"
    name = "system_storage"
    inherit_tags = ["device_id", "device_name", "device_ip"]

    [[inputs.snmp.table.field]]
      oid = ".1.3.6.1.2.1.25.2.3.1.2"
      name = "storage_type"
      is_tag = true

    # Phase 1.5: collect the human-readable description ("Physical memory",
    # "Swap space", "/", etc.) as a tag so the backend can identify the
    # physical-RAM entry unambiguously across vendors.
    [[inputs.snmp.table.field]]
      oid = ".1.3.6.1.2.1.25.2.3.1.3"
      name = "storage_descr"
      is_tag = true

    [[inputs.snmp.table.field]]
      oid = ".1.3.6.1.2.1.25.2.3.1.4"
      name = "storage_alloc_units"

    [[inputs.snmp.table.field]]
      oid = ".1.3.6.1.2.1.25.2.3.1.5"
      name = "storage_used"

    [[inputs.snmp.table.field]]
      oid = ".1.3.6.1.2.1.25.2.3.1.6"
      name = "storage_size"
`;
}

/**
 * Writes or updates the device's Telegraf .conf file
 */
function syncDeviceConfig(device) {
  const dir = ensureConfDir();
  const filePath = path.join(dir, `device_${device.id}.conf`);
  const content = buildTelegrafConfig(device);

  try {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[TelegrafManager] Config synced for ${device.name} -> ${filePath}`);
    triggerReload();
    return { success: true, filePath };
  } catch (err) {
    console.error(`[TelegrafManager] Failed to write config: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Removes the device's Telegraf .conf file
 */
function removeDeviceConfig(deviceId) {
  const dir = ensureConfDir();
  const filePath = path.join(dir, `device_${deviceId}.conf`);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[TelegrafManager] Config removed for device ${deviceId}`);
      triggerReload();
    }
    return { success: true };
  } catch (err) {
    console.error(`[TelegrafManager] Failed to delete config: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Executes Telegraf reload dengan urutan fallback:
 * 1) SIGHUP ke PID telegraf yang sedang running (graceful, tanpa putus koneksi)
 * 2) `systemctl reload telegraf` (jika ada systemd unit)
 * 3) Custom command dari env TELEGRAF_RELOAD_CMD
 * 4) Fallback echo warning
 */
function triggerReload() {
  // 1. Cari PID Telegraf yang sedang running
  const { execSync } = require('child_process');
  let telegrafPid = null;
  try {
    const out = execSync('pgrep -f "telegraf --config-directory"', { encoding: 'utf8', timeout: 2000 });
    const pids = out.trim().split('\n').filter(Boolean).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
    // Skip 'sudo' wrapper PIDs, ambil yang terakhir (biasanya binary telegraf asli)
    telegrafPid = pids[pids.length - 1] || null;
  } catch (e) { /* pgrep not found or no match */ }

  if (telegrafPid) {
    try {
      execSync(`sudo kill -HUP ${telegrafPid}`, { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
      console.log(`[TelegrafManager] SIGHUP sent to Telegraf PID ${telegrafPid} - config reloaded.`);
      return;
    } catch (e) {
      console.warn(`[TelegrafManager] SIGHUP via sudo failed (${e.message?.split('\n')[0] || 'unknown'}). Trying next method...`);
    }
    // Coba tanpa sudo kalau user sudah يملك permission
    try {
      process.kill(telegrafPid, 'SIGHUP');
      console.log(`[TelegrafManager] SIGHUP sent to Telegraf PID ${telegrafPid} (direct).`);
      return;
    } catch (e) {
      console.warn(`[TelegrafManager] Direct SIGHUP failed: ${e.message}. Trying systemctl...`);
    }
  }

  // 2. systemctl reload (legacy / systemd environments)
  const reloadCmd = process.env.TELEGRAF_RELOAD_CMD || 'echo "Reloading Telegraf"';
  exec(reloadCmd, (error, stdout, stderr) => {
    if (error) {
      console.warn(`[TelegrafManager] Reload command notice: ${error.message}`);
      console.warn('[TelegrafManager] Auto-reload failed. To pick up new config, run:');
      console.warn('[TelegrafManager]   sudo kill -HUP ' + (telegrafPid || '<telegraf-pid>'));
      console.warn('[TelegrafManager] Or use the helper script:');
      console.warn('[TelegrafManager]   ./scripts/restart-telegraf.sh');
      return;
    }
    console.log(`[TelegrafManager] Reload executed: ${stdout || 'OK'}`);
  });
}

/**
 * Menghapus file telegraf.d/device_<id>.conf yang device_id-nya tidak ada
 * di daftar device aktif. Mencegah config yatim/outsync.
 */
function cleanupOrphanConfigs(activeDeviceIds) {
  const dir = ensureConfDir();
  const activeSet = new Set(activeDeviceIds.map(id => parseInt(id, 10)));
  let removed = 0;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const m = file.match(/^device_(\d+)\.conf$/);
      if (m) {
        const id = parseInt(m[1], 10);
        if (!activeSet.has(id)) {
          try {
            fs.unlinkSync(path.join(dir, file));
            removed++;
            console.log(`[TelegrafManager] Removed orphan config: ${file} (device ${id} not in DB)`);
          } catch (e) {
            console.warn(`[TelegrafManager] Failed to remove ${file}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[TelegrafManager] cleanupOrphanConfigs error: ${e.message}`);
  }
  if (removed > 0) {
    triggerReload();
  }
  return removed;
}

/**
 * Regenerate SEMUA config telegraf dari daftar device aktif.
 * Berguna setelah delete/add banyak device untuk sinkronisasi total.
 */
function regenerateAllConfigs(devices) {
  const results = [];
  for (const dev of devices) {
    try {
      const r = syncDeviceConfig(dev);
      results.push({ id: dev.id, name: dev.name, ...r });
    } catch (e) {
      results.push({ id: dev.id, name: dev.name, success: false, error: e.message });
    }
  }
  triggerReload();
  return results;
}

module.exports = {
  syncDeviceConfig,
  removeDeviceConfig,
  triggerReload,
  buildTelegrafConfig,
  cleanupOrphanConfigs,
  regenerateAllConfigs,
  refreshOutputConfig
};
