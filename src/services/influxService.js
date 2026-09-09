const { InfluxDB } = require('@influxdata/influxdb-client');
require('dotenv').config();

let client = null;
let queryApi = null;

function getClient(overrideConfig = null) {
  const url = overrideConfig?.INFLUX_URL || process.env.INFLUX_URL || 'http://127.0.0.1:8086';
  const token = overrideConfig?.INFLUX_TOKEN || process.env.INFLUX_TOKEN || '';
  const org = overrideConfig?.INFLUX_ORG || process.env.INFLUX_ORG || 'itnetmon';
  const bucket = overrideConfig?.INFLUX_BUCKET || process.env.INFLUX_BUCKET || 'itnetmon_metrics';

  if (!client || overrideConfig) {
    client = new InfluxDB({ url, token, timeout: 2500 });
    queryApi = client.getQueryApi(org);
  }

  return { client, queryApi, url, token, org, bucket };
}

/**
 * Tests connection to InfluxDB v2 instance
 */
async function testConnection(config) {
  const { url, token, org, bucket } = getClient(config);
  try {
    const testClient = new InfluxDB({ url, token, timeout: 2500 });
    const testQueryApi = testClient.getQueryApi(org);
    const fluxQuery = `buckets() |> filter(fn: (r) => r.name == "${bucket}") |> limit(n: 1)`;
    
    await new Promise((resolve, reject) => {
      testQueryApi.queryRows(fluxQuery, {
        next: () => {},
        error: (err) => reject(err),
        complete: () => resolve(true)
      });
    });
    return { success: true, message: `Connected to InfluxDB at ${url} (Bucket '${bucket}' verified)` };
  } catch (err) {
    return { success: false, message: `InfluxDB connection failed: ${err.message}` };
  }
}

/**
 * Fetches 100% REAL live telemetry for a device from InfluxDB:
 * - Ping latency & packet loss
 * - Interface throughput derivative (Mbps In & Out)
 */
async function getLiveTelemetry(deviceId, interfaceName) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);

  const results = {
    in_mbps: 0.0,
    out_mbps: 0.0,
    latency_ms: 0.0,
    packet_loss: 0.0,
    has_data: false
  };

  // 1. Real Ping Query (last 15 seconds)
  const pingQuery = `
    from(bucket: "${bucket}")
      |> range(start: -15s)
      |> filter(fn: (r) => r["_measurement"] == "ping" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["_field"] == "average_response_ms" or r["_field"] == "percent_packet_loss")
      |> last()
  `;

  // 2. Real Interface Traffic Derivative Query (last 30 seconds)
  // Phase 1.5: `derivative` on 1s polled data can produce extreme values
  // if Telegraf has a jittered schedule. We clip absurd values at
  // 100 Gbps (100_000 Mbps) to suppress the visual sawtooth that arises
  // from rollover/duplicate-timestamp artefacts while keeping all
  // legitimate traffic levels intact.
  const trafficQuery = `
    from(bucket: "${bucket}")
      |> range(start: -30s)
      |> filter(fn: (r) => r["_measurement"] == "net_interface" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["interface_name"] == "${interfaceName}")
      |> filter(fn: (r) => r["_field"] == "bytes_in" or r["_field"] == "bytes_out")
      |> derivative(unit: 1s, nonNegative: true)
      |> map(fn: (r) => ({ r with _value: (r._value * 8.0) / 1000000.0 }))
      |> map(fn: (r) => ({ r with _value: if r._value > 100000.0 then 0.0 else r._value }))
      |> last()
  `;

  await Promise.all([
    new Promise((resolve) => {
      queryApi.queryRows(pingQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          results.has_data = true;
          if (o._field === 'average_response_ms') {
            results.latency_ms = parseFloat(parseFloat(o._value).toFixed(2));
          }
          if (o._field === 'percent_packet_loss') {
            results.packet_loss = parseFloat(parseFloat(o._value).toFixed(1));
          }
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    }),
    new Promise((resolve) => {
      queryApi.queryRows(trafficQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          results.has_data = true;
          if (o._field === 'bytes_in') {
            results.in_mbps = parseFloat(parseFloat(o._value).toFixed(3));
          }
          if (o._field === 'bytes_out') {
            results.out_mbps = parseFloat(parseFloat(o._value).toFixed(3));
          }
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    })
  ]);

  return results;
}

/**
 * Fetches all unique interface names for a device in the last 24 hours
 */
async function getDeviceInterfaces(deviceId) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -24h)
      |> filter(fn: (r) => r["_measurement"] == "net_interface" and r["device_id"] == "${devIdStr}")
      |> keep(columns: ["interface_name"])
      |> group()
      |> unique(column: "interface_name")
  `;

  const interfaces = [];
  try {
    await new Promise((resolve, reject) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          if (o.interface_name) {
            interfaces.push(o.interface_name);
          }
        },
        error: (err) => reject(err),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error(`[InfluxService] Error fetching interfaces for device ${deviceId}:`, err.message);
  }
  return interfaces;
}

/**
 * Fetches global 24h aggregate metrics: average latency & packet loss across all devices
 */
async function getGlobal24hSummary() {
  const { queryApi, bucket } = getClient();
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -24h)
      |> filter(fn: (r) => r["_measurement"] == "ping")
      |> filter(fn: (r) => r["_field"] == "average_response_ms" or r["_field"] == "percent_packet_loss")
      |> group(columns: ["_field"])
      |> mean()
  `;

  const result = { avg_latency_ms: 0, avg_packet_loss: 0, has_data: false, samples: 0 };
  const counts = {};

  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          result.has_data = true;
          if (o._field === 'average_response_ms') {
            result.avg_latency_ms = parseFloat(parseFloat(o._value).toFixed(2));
          }
          if (o._field === 'percent_packet_loss') {
            result.avg_packet_loss = parseFloat(parseFloat(o._value).toFixed(3));
          }
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getGlobal24hSummary error:', err.message);
  }

  return result;
}

/**
 * Fetches ingestion sample count for the last 24h (one row per ping metric point)
 * Used to compute "Total Ingestion Points" realistically
 */
async function getIngestionCount() {
  const { queryApi, bucket } = getClient();
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -24h)
      |> filter(fn: (r) => r["_measurement"] == "ping" or r["_measurement"] == "net_interface")
      |> count()
  `;

  let count = 0;
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          count += parseInt(o._value, 10) || 0;
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getIngestionCount error:', err.message);
  }
  return count;
}

/**
 * Fetches all current interface deep metrics (oper_status, speed_mbps, latest bytes in/out)
 * Returns array of { interface_name, oper_status, speed_mbps, bytes_in_total, bytes_out_total, has_data }
 */
async function getInterfaceDeepMetrics(deviceId) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -5m)
      |> filter(fn: (r) => r["_measurement"] == "net_interface" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["_field"] == "oper_status" or r["_field"] == "speed_mbps"
                       or r["_field"] == "bytes_in" or r["_field"] == "bytes_out")
      |> last()
      |> group(columns: ["interface_name", "_field"])
      |> last()
  `;

  const grouped = {};
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          const ifname = o.interface_name || 'unknown';
          if (!grouped[ifname]) {
            grouped[ifname] = { interface_name: ifname, has_data: true };
          }
          if (o._field === 'oper_status') {
            grouped[ifname].oper_status = parseInt(o._value, 10);
            grouped[ifname].oper_status_label = mapOperStatus(parseInt(o._value, 10));
          } else if (o._field === 'speed_mbps') {
            grouped[ifname].speed_mbps = parseFloat(o._value);
          } else if (o._field === 'bytes_in') {
            grouped[ifname].bytes_in_total = parseFloat(o._value);
          } else if (o._field === 'bytes_out') {
            grouped[ifname].bytes_out_total = parseFloat(o._value);
          }
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getInterfaceDeepMetrics error:', err.message);
  }

  return Object.values(grouped);
}

function mapOperStatus(code) {
  const map = {
    1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant',
    6: 'notPresent', 7: 'lowerLayerDown'
  };
  return map[code] || 'unknown';
}

/**
 * Fetches RTT history: min/avg/max/std-dev over the last N minutes (default 5)
 * Returns array of { time, min, avg, max, jitter } sorted ascending
 */
async function getLatencyHistory(deviceId, minutes = 5) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${minutes}m)
      |> filter(fn: (r) => r["_measurement"] == "ping" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["_field"] == "average_response_ms" or r["_field"] == "minimum_response_ms"
                       or r["_field"] == "maximum_response_ms" or r["_field"] == "standard_deviation_ms")
      |> aggregateWindow(every: 5s, fn: mean, createEmpty: false)
      |> group(columns: ["_field"])
  `;

  const byField = { average_response_ms: [], minimum_response_ms: [], maximum_response_ms: [], standard_deviation_ms: [] };
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          const f = o._field;
          if (byField[f]) {
            byField[f].push({
              time: o._time,
              value: parseFloat(o._value) || 0
            });
          }
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getLatencyHistory error:', err.message);
  }

  // Merge by time index. Use avg timeline as base.
  const base = byField.average_response_ms;
  if (base.length === 0) return [];

  const indexed = {};
  byField.minimum_response_ms.forEach(p => { indexed[p.time] = indexed[p.time] || {}; indexed[p.time].min = p.value; });
  byField.maximum_response_ms.forEach(p => { indexed[p.time] = indexed[p.time] || {}; indexed[p.time].max = p.value; });
  byField.standard_deviation_ms.forEach(p => { indexed[p.time] = indexed[p.time] || {}; indexed[p.time].jitter = p.value; });
  byField.average_response_ms.forEach(p => { indexed[p.time] = indexed[p.time] || {}; indexed[p.time].avg = p.value; });

  return base.map(p => {
    const rec = indexed[p.time] || {};
    return {
      time: p.time,
      min: rec.min !== undefined ? rec.min : rec.avg,
      avg: rec.avg,
      max: rec.max !== undefined ? rec.max : rec.avg,
      jitter: rec.jitter || 0
    };
  }).sort((a, b) => new Date(a.time) - new Date(b.time));
}

/**
 * Fetches packet loss % history (default 5m, 5s windows)
 */
async function getPacketLossHistory(deviceId, minutes = 5) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${minutes}m)
      |> filter(fn: (r) => r["_measurement"] == "ping" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["_field"] == "percent_packet_loss")
      |> aggregateWindow(every: 5s, fn: mean, createEmpty: false)
  `;

  const points = [];
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          points.push({ time: o._time, value: parseFloat(o._value) || 0 });
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getPacketLossHistory error:', err.message);
  }

  return points.sort((a, b) => new Date(a.time) - new Date(b.time));
}

/**
 * Fetches the CURRENT traffic rate (Mbps in/out) for every interface of a
 * device (1-minute derivative of the byte counters, nonNegative).
 * Returns array of { interface_name, in_mbps, out_mbps }.
 *
 * This is the per-interface equivalent of getLiveTelemetry() and feeds the
 * Interface Summary table (RX Mbps / TX Mbps columns). The previous version
 * derived unicast packet rates (pps) which no consumer used, while the UI
 * expected Mbps — so the RX/TX columns were always "--".
 */
async function getInterfaceThroughputRates(deviceId, minutes = 5) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${minutes}m)
      |> filter(fn: (r) => r["_measurement"] == "net_interface" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["_field"] == "bytes_in" or r["_field"] == "bytes_out")
      |> derivative(unit: 1s, nonNegative: true)
      |> map(fn: (r) => ({ r with _value: (r._value * 8.0) / 1000000.0 }))
      |> map(fn: (r) => ({ r with _value: if r._value > 100000.0 then 0.0 else r._value }))
      |> last()
  `;

  const byIface = {};
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          const ifname = o.interface_name || 'unknown';
          if (!byIface[ifname]) byIface[ifname] = { interface_name: ifname };
          if (o._field === 'bytes_in') byIface[ifname].in_mbps = parseFloat(parseFloat(o._value).toFixed(3)) || 0;
          if (o._field === 'bytes_out') byIface[ifname].out_mbps = parseFloat(parseFloat(o._value).toFixed(3)) || 0;
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getInterfaceThroughputRates error:', err.message);
  }
  return Object.values(byIface);
}

/**
 * Fetches system metrics from sysUpTime / hrProcessorLoad / hrStorage if available
 */
async function getSystemMetrics(deviceId) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -5m)
      |> filter(fn: (r) => r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["_measurement"] == "system"
                       or r["_measurement"] == "system_cpu"
                       or r["_measurement"] == "system_storage"
                       or r["_measurement"] == "net_interface")
      |> last()
  `;

  const result = { has_data: false, sys_uptime_ticks: null, cpu_load_pct: null, memory_used: null, memory_total: null, storage_entries: [] };
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          result.has_data = true;
          if (o._measurement === 'system' && o._field === 'uptime_ticks') {
            result.sys_uptime_ticks = parseInt(o._value, 10) || 0;
          }
          if (o._measurement === 'system_cpu' && o._field === 'cpu_load_pct') {
            result.cpu_load_pct = parseFloat(o._value) || 0;
          }
          if (o._measurement === 'system_storage') {
            if (o._field === 'storage_descr') {
              const existing = result.storage_entries.find(e => e.storage_type === o.storage_type);
              if (existing) existing.descr = String(o._value || '');
              else result.storage_entries.push({ storage_type: o.storage_type, descr: String(o._value || ''), used: 0, size: 0, alloc_units: 0 });
            }
            if (o._field === 'storage_alloc_units') {
              const existing = result.storage_entries.find(e => e.storage_type === o.storage_type);
              if (existing) existing.alloc_units = parseInt(o._value, 10) || 0;
              else result.storage_entries.push({ storage_type: o.storage_type, descr: '', used: 0, size: 0, alloc_units: parseInt(o._value, 10) || 0 });
            }
            if (o._field === 'storage_used') {
              const existing = result.storage_entries.find(e => e.storage_type === o.storage_type);
              if (existing) existing.used = parseFloat(o._value) || 0;
              else result.storage_entries.push({ storage_type: o.storage_type, descr: '', used: parseFloat(o._value) || 0, size: 0, alloc_units: 0 });
            }
            if (o._field === 'storage_size') {
              const existing = result.storage_entries.find(e => e.storage_type === o.storage_type);
              if (existing) existing.size = parseFloat(o._value) || 0;
              else result.storage_entries.push({ storage_type: o.storage_type, descr: '', used: 0, size: parseFloat(o._value) || 0, alloc_units: 0 });
            }
          }
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getSystemMetrics error:', err.message);
  }
  return result;
}

/**
 * Fetches all unique interface names for a device in the last 24 hours
 * Lookup by device_id (primary) + fallback by device_ip (handles ID drift) +
 * real-time SNMP walk as last resort (for newly added devices not yet in InfluxDB)
 */
async function getDeviceInterfaces(deviceId, deviceIp = null) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);

  // Primary: by device_id
  let interfaces = await queryInterfacesByTag('device_id', devIdStr, bucket, queryApi);

  // Fallback: by device_ip (handles cases where device was deleted+recreated with new ID)
  if (interfaces.length === 0 && deviceIp) {
    interfaces = await queryInterfacesByTag('device_ip', deviceIp, bucket, queryApi);
    if (interfaces.length > 0) {
      console.log(`[InfluxService] Interfaces for device ${deviceId} not found by ID, found by IP ${deviceIp} (${interfaces.length} interfaces)`);
    }
  }

  // Last resort: real-time SNMP walk (for newly added devices not yet in InfluxDB)
  if (interfaces.length === 0 && deviceIp) {
    try {
      const streamService = require('./streamService');
      const realtime = await streamService.getRealTimeInterfaces({ ip_address: deviceIp });
      if (realtime && realtime.length > 0) {
        interfaces = realtime.map(i => i.interface_name);
        console.log(`[InfluxService] Interfaces for device ${deviceId} not in InfluxDB, got ${interfaces.length} from real-time SNMP walk`);
      }
    } catch (e) {
      // silent - don't break the flow
    }
  }

  return interfaces;
}

async function queryInterfacesByTag(tagName, tagValue, bucket, queryApi) {
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -24h)
      |> filter(fn: (r) => r["_measurement"] == "net_interface" and r["${tagName}"] == "${tagValue}")
      |> keep(columns: ["interface_name"])
      |> group()
      |> unique(column: "interface_name")
  `;

  const interfaces = [];
  try {
    await new Promise((resolve, reject) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          if (o.interface_name) {
            interfaces.push(o.interface_name);
          }
        },
        error: (err) => reject(err),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] Error fetching interfaces by ${tagName}=${tagValue}:', err.message);
  }
  return interfaces;
}

/**
 * Fetches interface error counters (ifInErrors, ifOutErrors, ifInDiscards, ifOutDiscards)
 */
async function getInterfaceErrorCounters(deviceId) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -5m)
      |> filter(fn: (r) => r["_measurement"] == "net_interface" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["_field"] == "ifInErrors" or r["_field"] == "ifOutErrors"
                       or r["_field"] == "ifInDiscards" or r["_field"] == "ifOutDiscards")
      |> last()
  `;

  const byIface = {};
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          const ifname = o.interface_name || 'unknown';
          if (!byIface[ifname]) byIface[ifname] = { interface_name: ifname };
          byIface[ifname][o._field] = parseInt(o._value, 10) || 0;
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getInterfaceErrorCounters error:', err.message);
  }
  return Object.values(byIface);
}

/**
 * Fetches per-interface throughput 5m sliding history (Mbps In/Out, 5s resolution)
 * Returns { labels: [time strings], in_mbps: [...], out_mbps: [...] }
 *
 * Primary: InfluxDB query for 5m history.
 * Fallback: realtime SNMP delta (for newly-added devices without InfluxDB data).
 */
async function getInterfaceThroughputHistory(deviceId, interfaceName, minutes = 5) {
  const { queryApi, bucket } = getClient();
  const devIdStr = String(deviceId);

  // Primary: InfluxDB query
  // Phase 1.5: use `mean` instead of `last` for the 5s window. With 1s polling
  // the 5s window captures exactly 5 counter values; averaging them first
  // and then taking the derivative produces a smooth per-second rate.
  // Previously `last` picked a single value, which produced sawtooth when
  // the selected value happened to be near a counter rollover boundary.
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -${minutes}m)
      |> filter(fn: (r) => r["_measurement"] == "net_interface" and r["device_id"] == "${devIdStr}")
      |> filter(fn: (r) => r["interface_name"] == "${interfaceName}")
      |> filter(fn: (r) => r["_field"] == "bytes_in" or r["_field"] == "bytes_out")
      |> aggregateWindow(every: 5s, fn: mean, createEmpty: false)
      |> derivative(unit: 5s, nonNegative: true)
      |> map(fn: (r) => ({ r with _value: (r._value * 8.0) / 5.0 / 1000000.0 }))
  `;

  const byTime = {};
  try {
    await new Promise((resolve) => {
      queryApi.queryRows(fluxQuery, {
        next: (row, tableMeta) => {
          const o = tableMeta.toObject(row);
          const t = o._time;
          if (!byTime[t]) byTime[t] = { time: t, in: 0, out: 0 };
          if (o._field === 'bytes_in') byTime[t].in = parseFloat(o._value) || 0;
          if (o._field === 'bytes_out') byTime[t].out = parseFloat(o._value) || 0;
        },
        error: () => resolve(),
        complete: () => resolve()
      });
    });
  } catch (err) {
    console.error('[InfluxService] getInterfaceThroughputHistory error:', err.message);
  }

  let sorted = Object.values(byTime).sort((a, b) => new Date(a.time) - new Date(b.time));

  // Fallback: realtime SNMP delta if InfluxDB returned no data
  if (sorted.length === 0) {
    try {
      const streamService = require('./streamService');
      // Need device.ip_address for SNMP walk - fetch from DB
      const db = require('../db');
      let deviceObj = null;
      if (db.isPostgresConnected()) {
        const r = await db.query('SELECT id, ip_address, snmp_community FROM devices WHERE id = $1', [deviceId]);
        deviceObj = r.rows[0];
      } else {
        deviceObj = db.getMemoryStore().devices.find(d => d.id === deviceId);
      }
      if (deviceObj && deviceObj.ip_address) {
        const rtResult = await streamService.getRealTimeInterfaceMbps(deviceObj, interfaceName);
        if (rtResult && (rtResult.inMbps > 0 || rtResult.outMbps > 0 || rtResult.reachable)) {
          const now = new Date();
          // Generate 30 sample points (5s apart) for visualization
          sorted = Array.from({ length: 30 }, (_, i) => {
            const t = new Date(now.getTime() - (29 - i) * 5000);
            return { time: t.toISOString(), in: rtResult.inMbps, out: rtResult.outMbps };
          });
          console.log(`[InfluxService] Throughput history fallback to realtime for device ${deviceId} iface ${interfaceName} (${rtResult.inMbps}/${rtResult.outMbps} Mbps)`);
        }
      }
    } catch (e) {
      // silent
    }
  }

  return {
    labels: sorted.map(p => {
      const d = new Date(p.time);
      return d.toLocaleTimeString('id-ID', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }),
    in_mbps: sorted.map(p => parseFloat(p.in.toFixed(3))),
    out_mbps: sorted.map(p => parseFloat(p.out.toFixed(3)))
  };
}

module.exports = {
  getClient,
  testConnection,
  getLiveTelemetry,
  getDeviceInterfaces,
  getGlobal24hSummary,
  getIngestionCount,
  getInterfaceDeepMetrics,
  getLatencyHistory,
  getPacketLossHistory,
  getInterfaceThroughputRates,
  getSystemMetrics,
  getInterfaceErrorCounters,
  getInterfaceThroughputHistory
};
