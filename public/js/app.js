/**
 * BMS IT Monitoring - Real-time network monitoring and observability platform
 * Core Frontend Application Logic
 */

// Global Application State
const state = {
  devices: [],
  selectedDeviceId: null,
  selectedInterface: '',
  activeFilter: 'all',
  searchQuery: '',
  alerts: [],
  activeIncidents: [],
  incidentHistory: [],
  ws: null,
  charts: {
    traffic: null,
    donut: null,
    detailThroughput: null,
    detailRtt: null,
    detailLoss: null
  },
  // Single shared sliding-window traffic buffer (max 60 pts). Both the
  // right-side "Real-Time Throughput Stream" and the DIC "Live Traffic"
  // chart read from these exact arrays — one source of truth, appended per
  // WS tick. The window grows up to 60 points, then appends+shifts; it is
  // never pre-filled with zeros or nulls (those made charts look "empty").
  chartBuffer: {
    labels: [],
    inData: [],
    outData: []
  },
  // QoS sliding buffers (RTT min/avg/max + packet loss), fed per tick and
  // only reseeded from the backend when the WS stream is stale.
  detailRttBuffer: { labels: [], min: [], avg: [], max: [] },
  detailLossBuffer: { labels: [], values: [] },
  detailLastTickAt: 0,
  // Last time the SHARED traffic buffer received a realtime tick. A single
  // 5s fallback poller (see startTrafficPolling) refills from the backend
  // only when this goes stale — traffic display never freezes, even if the
  // WebSocket stream stalls.
  lastTrafficTickAt: 0,
  trafficPollTimer: null,
  trafficPollInFlight: false,
  alertDedup: new Set(), // key: "deviceId:type:severity"
  detailData: null,
  detailDeviceId: null,
  detailPollingTimer: null,
  topologyNetwork: null,
  topologyData: null,
  topologyRefreshTimer: null,
  activePanelTab: 'incidents',
  incidentSearch: '',
  incidentSevFilter: 'all',
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  initCharts();
  setupEventListeners();
  await loadInitialData();
  connectWebSocket();
  // Single traffic scheduler (5s). Guarantees the Real-Time Throughput and
  // Live Traffic windows keep moving even when the WS stream stalls/drops.
  startTrafficPolling();
}

/**
 * Loads KPI and Devices data from REST API
 */
async function loadInitialData() {
  try {
    const [kpiRes, devRes, alertRes, feedRes, incidentRes] = await Promise.all([
      fetch('/api/kpi').then(r => r.json()),
      fetch('/api/devices').then(r => r.json()),
      fetch('/api/alerts').then(r => r.json()),
      fetch('/api/live-feed').then(r => r.json()),
      fetch('/api/incidents').then(r => r.json()).catch(() => ({ success: false, active: [], history: [] }))
    ]);

    if (kpiRes.success) updateKpis(kpiRes);
    if (devRes.success) {
      state.devices = devRes.devices;
      renderDeviceGrid();
      updateDonutChart();
      updateInterfaceDropdown();
    }
    if (alertRes.success) {
      state.alerts = alertRes.alerts;
    }
    if (incidentRes.success) {
      state.activeIncidents = incidentRes.active || [];
      state.incidentHistory = incidentRes.history || [];
      renderIncidentFeed(state.incidentSearch, state.incidentSevFilter);
    }
    if (feedRes.success) {
      updateLiveFeedPill(feedRes);
    }

    // Fallback: untuk device yang belum punya interface (Telegraf belum jalan
    // atau belum selesai SNMP walk), ambil via direct SNMP walk real-time.
    // Berjalan async parallel agar tidak block UI.
    enrichDevicesWithRealtimeSnmp();

    // Pastikan stream realtime punya target: jika device terpilih sudah tidak
    // ada (mis. default id lama), pilih device pertama agar Right Analytics
    // Throughput langsung bergerak tanpa harus klik kartu dulu.
    ensureStreamSelection();
  } catch (err) {
    console.error('Initial data loading failed:', err);
  }
}

/**
 * Untuk device yang belum punya interface, query SNMP walk real-time
 * sebagai fallback agar UI tidak kosong. Update state.devices in-place
 * lalu re-render dropdown + grid (jika sedang terbuka).
 */
async function enrichDevicesWithRealtimeSnmp() {
  let needsRender = false;
  for (const dev of state.devices) {
    if (dev.ip_address && (!dev.interfaces || dev.interfaces.length === 0)) {
      try {
        const res = await fetch(`/api/devices/${dev.id}/interfaces-realtime`).then(r => r.json());
        if (res.success && res.interfaces && res.interfaces.length > 0) {
          dev.interfaces = res.interfaces.map(i => ({
            id: null,
            device_id: dev.id,
            interface_name: i.interface_name,
            status: i.oper_status === 1 ? 'up' : 'down',
            speed_bps: (i.speed_mbps || 0) * 1000000,
            in_octets_rate: i.bytes_in || 0,
            out_octets_rate: i.bytes_out || 0,
            source: 'snmpwalk'
          }));
          needsRender = true;
        }
      } catch (e) {
        // silent - device SNMP unreachable
      }
    }
  }
  if (needsRender) {
    renderDeviceGrid();
    updateInterfaceDropdown();
  }
}

/**
 * Initializes High-Performance Chart.js Canvases
 */
function initCharts() {
  // Restore chart buffer from localStorage if available
  try {
    const saved = localStorage.getItem('bms_chart_buffer');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.labels && parsed.inData && parsed.outData) {
        // Normalize legacy buffers: drop empty-label prefixes, cap at 60.
        let labels = Array.isArray(parsed.labels) ? parsed.labels.slice() : [];
        let inData = Array.isArray(parsed.inData) ? parsed.inData.slice() : [];
        let outData = Array.isArray(parsed.outData) ? parsed.outData.slice() : [];
        while (labels.length > 0 && labels[0] === '') { labels.shift(); inData.shift(); outData.shift(); }
        if (labels.length > 60) {
          labels = labels.slice(-60);
          inData = inData.slice(-60);
          outData = outData.slice(-60);
        }
        if (labels.length > 0) {
          state.chartBuffer.labels = labels;
          state.chartBuffer.inData = inData;
          state.chartBuffer.outData = outData;
        }
      }
    }
  } catch (e) { /* ignore corrupt data */ }

  // 1. Traffic Dual-Line Area Chart
  const trafficCtx = document.getElementById('trafficAreaChart').getContext('2d');
  
  // Neon Cyan gradient for Inbound
  const gradIn = trafficCtx.createLinearGradient(0, 0, 0, 240);
  gradIn.addColorStop(0, 'rgba(0, 242, 254, 0.35)');
  gradIn.addColorStop(1, 'rgba(0, 242, 254, 0.0)');

  // Neon Orange gradient for Outbound
  const gradOut = trafficCtx.createLinearGradient(0, 0, 0, 240);
  gradOut.addColorStop(0, 'rgba(255, 153, 0, 0.35)');
  gradOut.addColorStop(1, 'rgba(255, 153, 0, 0.0)');

  state.charts.traffic = new Chart(trafficCtx, {
    type: 'line',
    data: {
      labels: state.chartBuffer.labels,
      datasets: [
        {
          label: 'Inbound (Download)',
          data: state.chartBuffer.inData,
          borderColor: '#00f2fe',
          backgroundColor: gradIn,
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        },
        {
          label: 'Outbound (Upload)',
          data: state.chartBuffer.outData,
          borderColor: '#ff9900',
          backgroundColor: gradOut,
          fill: true,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // Disabled for ultra-smooth 1s realtime sliding performance
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} Mbps`
          }
        }
      },
      scales: {
        x: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: {
            color: '#64748b',
            font: { size: 10 },
            maxTicksLimit: 8
          }
        },
        y: {
          display: true,
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.06)' },
          ticks: {
            color: '#64748b',
            font: { size: 10 },
            callback: (v) => `${v} Mbps`
          }
        }
      }
    }
  });

  // 2. Status Donut Chart
  const donutCtx = document.getElementById('statusDonutChart').getContext('2d');
  state.charts.donut = new Chart(donutCtx, {
    type: 'doughnut',
    data: {
      labels: ['Online', 'Warning', 'Offline'],
      datasets: [{
        data: [0, 0, 0],
        backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
        borderWidth: 0,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '76%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.raw} devices`
          }
        }
      }
    }
  });
}

let reconnectTimer = null;

/**
 * Establishes Persistent WebSocket Connection with Auto-Reconnect
 */
function connectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (state.ws) {
    if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) {
      return;
    }
    try { state.ws.close(); } catch(e) {}
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/metrics`;

  const pill = document.getElementById('ws-status-pill');
  const statusText = document.getElementById('ws-status-text');

  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    pill.classList.add('disconnected');
    statusText.textContent = 'Disconnected';
    reconnectTimer = setTimeout(connectWebSocket, 3000);
    return;
  }

  state.ws.onopen = () => {
    pill.classList.remove('disconnected');
    statusText.textContent = 'Live 1s Feed';
    subscribeSelectedStream();
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsMessage(data);
    } catch (e) {
      console.error('WS Parse Error:', e);
    }
  };

  state.ws.onclose = () => {
    pill.classList.add('disconnected');
    statusText.textContent = 'Reconnecting...';
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(connectWebSocket, 3000);
    }
  };

  state.ws.onerror = () => {
    pill.classList.add('disconnected');
    statusText.textContent = 'Offline';
  };
}

function subscribeSelectedStream() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      action: 'subscribe',
      deviceId: state.selectedDeviceId,
      interfaceName: state.selectedInterface
    }));
  }
}

/**
 * Handles incoming WebSocket stream packages
 */
function handleWsMessage(msg) {
  if (msg.type === 'DEVICE_TELEMETRY') {
    // Update card latency, packet loss, dot, and fault styles
    updateCardTelemetry(msg.deviceId, msg.latency, msg.packetLoss, msg.status);
  } else if (msg.type === 'METRIC_TICK') {
    // Update card telemetry
    updateCardTelemetry(msg.deviceId, msg.latency, msg.packetLoss, msg.status);

    // Feed the shared 60pt sliding window ONLY for the subscribed
    // device+interface — this moves BOTH the right Analytics Throughput
    // chart and the DIC Live Traffic chart (same arrays, no reset).
    if (msg.deviceId === state.selectedDeviceId && msg.interfaceName === state.selectedInterface) {
      const inVal = formatMbps(msg.inMbps);
      const outVal = formatMbps(msg.outMbps);
      document.getElementById('live-in-rate').textContent = `${inVal}`;
      document.getElementById('live-out-rate').textContent = `${outVal}`;
      pushTrafficPoint(msg.timestamp || formatChartTime(new Date()), msg.inMbps || 0, msg.outMbps || 0);
    }

    // While the Device Detail panel is open, feed this tick into its
    // QoS charts (RTT/loss) + health summary (device must match).
    feedDetailRealtimeTick(msg);

    // Keep the live feed pill + quick stats current on every tick.
    const allDevs = state.devices || [];
    updateLiveFeedPill({
      total: allDevs.length,
      online: allDevs.filter(d => d.status === 'online').length,
      avg_latency_ms: msg.latency,
      server_time: msg.fullTime
    });
    if (state.activePanelTab === 'quickstats') updateQuickStats();
  } else if (msg.type === 'NEW_ALERT') {
    const alert = msg.alert;
    // Deduplicate: skip if same device+type+severity appeared in last 5 minutes
    const dedupKey = `${alert.device_id || alert.deviceId}:${alert.type || ''}:${alert.severity}`;
    const now = Date.now();
    if (state.alertDedup.has(dedupKey)) return;
    state.alertDedup.delete(dedupKey);
    state.alertDedup.add(dedupKey);
    setTimeout(() => state.alertDedup.delete(dedupKey), 5 * 60 * 1000);
    state.alerts.unshift(alert);
    if (state.activePanelTab === 'alerts') {
      renderAlertFeed(state.incidentSearch, state.incidentSevFilter);
    } else if (state.activePanelTab === 'incidents') {
      updateIncidentBadge();
    }
  } else if (msg.type === 'INCIDENT_CREATED') {
    const incident = msg.incident;
    if (incident && incident.incidentId) {
      const exists = state.activeIncidents.find(i => i.incidentId === incident.incidentId);
      if (!exists) {
        state.activeIncidents.unshift(incident);
      }
      if (state.activePanelTab === 'incidents') {
        renderIncidentFeed(state.incidentSearch, state.incidentSevFilter);
      } else {
        updateIncidentBadge();
      }
    }
  } else if (msg.type === 'INCIDENT_UPDATED') {
    const incident = msg.incident;
    if (incident && incident.incidentId) {
      const idx = state.activeIncidents.findIndex(i => i.incidentId === incident.incidentId);
      if (idx >= 0) {
        state.activeIncidents[idx] = incident;
      }
      if (state.activePanelTab === 'incidents') {
        renderIncidentFeed(state.incidentSearch, state.incidentSevFilter);
      }
    }
  } else if (msg.type === 'INCIDENT_RESOLVED') {
    const incident = msg.incident;
    if (incident && incident.incidentId) {
      state.activeIncidents = state.activeIncidents.filter(i => i.incidentId !== incident.incidentId);
      const existsInHistory = state.incidentHistory.find(i => i.incidentId === incident.incidentId);
      if (!existsInHistory) {
        state.incidentHistory.unshift(incident);
      }
      if (state.activePanelTab === 'incidents') {
        renderIncidentFeed(state.incidentSearch, state.incidentSevFilter);
      } else {
        updateIncidentBadge();
      }
    }
  } else if (msg.type === 'INIT_SYNC') {
    // Sinkronisasi awal saat WS connect - hitung ulang ringkasan live
    const devs = msg.devices || [];
    const total = devs.length;
    const online = devs.filter(d => d.status === 'online').length;
    const avgLat = total === 0 ? 0
      : parseFloat((devs.reduce((s, d) => s + (parseFloat(d.ping_latency) || 0), 0) / total).toFixed(2));
    updateLiveFeedPill({
      total,
      online,
      avg_latency_ms: avgLat,
      server_time: msg.timestamp
    });
  }
}

/**
 * Updates KPI Summary Cards (Zona 2) + render SLA sparkline riil
 */
function updateKpis(kpi) {
  document.getElementById('kpi-total').textContent = kpi.total_devices;
  document.getElementById('kpi-online').textContent = kpi.online_count;
  document.getElementById('kpi-warning').textContent = kpi.warning_count;
  document.getElementById('kpi-offline').textContent = kpi.offline_count;

  const uptimeEl = document.getElementById('uptime-text');
  if (uptimeEl) {
    const pct = parseFloat(kpi.uptime_30d);
    uptimeEl.textContent = `${isFinite(pct) ? pct.toFixed(2) : '100.00'}%`;
    // Color: hijau jika >=99, kuning jika >=95, merah di bawahnya
    uptimeEl.style.color = pct >= 99 ? 'var(--color-online)' : (pct >= 95 ? 'var(--color-warning)' : 'var(--color-offline)');
  }

  // Render sparkline riil dari trendline API
  renderSparkline(kpi.trendline || []);
}

/**
 * Render SVG sparkline untuk 30-day SLA trend.
 * points = array of percentage values (e.g. [99.8, 99.9, 100, ...])
 */
function renderSparkline(points) {
  const poly = document.getElementById('sparkline-polyline');
  if (!poly || !Array.isArray(points) || points.length === 0) return;

  const width = 60;
  const height = 20;

  // Normalize y-coordinates: map pct range [min..100] -> [height-2 .. 2]
  const min = Math.min(...points, 95);
  const max = Math.max(...points, 100);
  const range = Math.max(max - min, 0.01);

  const stepX = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((v, i) => {
    const x = i * stepX;
    const norm = (v - min) / range;       // 0..1
    const y = height - 2 - norm * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  poly.setAttribute('points', coords.join(' '));

  // Color the line based on the latest value
  const last = points[points.length - 1];
  const color = last >= 99 ? '#10b981' : (last >= 95 ? '#f59e0b' : '#ef4444');
  poly.setAttribute('stroke', color);
}

/**
 * Update "Live 1s Feed" pill dengan info real-time:
 * jumlah device online, total, dan timestamp tick terakhir.
 */
function updateLiveFeedPill(data) {
  const text = document.getElementById('ws-status-text');
  if (!text) return;
  const online = data.online ?? 0;
  const total = data.total ?? 0;
  const avgLat = data.avg_latency_ms ?? 0;
  const tickTime = data.server_time
    ? new Date(data.server_time).toLocaleTimeString('id-ID', { hour12: false })
    : new Date().toLocaleTimeString('id-ID', { hour12: false });
  text.textContent = `Live 1s • ${online}/${total} • ${avgLat}ms • ${tickTime}`;
}

/**
 * Updates Donut Chart and center count (Zona 4)
 */
function updateDonutChart() {
  const online = state.devices.filter(d => d.status === 'online').length;
  const warning = state.devices.filter(d => d.status === 'warning').length;
  const offline = state.devices.filter(d => d.status === 'offline').length;
  const total = state.devices.length;

  const donutEl = document.getElementById('donut-total-count');
  if (donutEl) donutEl.textContent = total;

  const onEl = document.getElementById('donut-online-count');
  const warnEl = document.getElementById('donut-warning-count');
  const offEl = document.getElementById('donut-offline-count');
  if (onEl) onEl.textContent = online;
  if (warnEl) warnEl.textContent = warning;
  if (offEl) offEl.textContent = offline;

  if (state.charts.donut) {
    state.charts.donut.data.datasets[0].data = [online, warning, offline];
    state.charts.donut.update();
  }
}

function refreshKpiCounters() {
  let online = 0, warning = 0, offline = 0;
  state.devices.forEach(d => {
    if (d.status === 'offline') offline++;
    else if (d.status === 'warning') warning++;
    else online++;
  });

  const onEl = document.getElementById('kpi-online');
  const warnEl = document.getElementById('kpi-warning');
  const offEl = document.getElementById('kpi-offline');

  if (onEl) onEl.textContent = online;
  if (warnEl) warnEl.textContent = warning;
  if (offEl) offEl.textContent = offline;

  updateDonutChart();
}

/**
 * Renders Node Matrix Grid (Zona 3)
 */
function renderDeviceGrid() {
  const container = document.getElementById('device-cards-grid');
  if (!container) return;
  container.innerHTML = '';

  const filtered = state.devices.filter(function (dev) {
    const matchesFilter = state.activeFilter === 'all' || dev.status === state.activeFilter;
    const matchesSearch = (dev.name || '').toLowerCase().indexOf((state.searchQuery || '').toLowerCase()) !== -1 ||
                          (dev.ip_address || '').indexOf(state.searchQuery || '') !== -1;
    return matchesFilter && matchesSearch;
  });

  filtered.forEach(function (dev) {
    const card = document.createElement('div');
    const isSelected = dev.id === state.selectedDeviceId;
    const faultClass = dev.status === 'offline' ? 'fault-offline' : (dev.status === 'warning' ? 'fault-warning' : '');

    card.className = 'device-card ' + (isSelected ? 'selected ' : '') + faultClass;
    card.id = 'dev-card-' + dev.id;

    let lossColor = 'inherit';
    const lossVal = parseFloat(dev.packet_loss);
    if (Number.isFinite(lossVal)) {
      if (lossVal >= 100) lossColor = 'var(--color-offline)';
      else if (lossVal > 0) lossColor = 'var(--color-warning)';
    }

    const latText = formatMetric(dev.ping_latency, 'ms', '--');
    const lossText = formatMetric(dev.packet_loss, '%', '--');
    const ifaceCount = ((dev.interfaces || []).length);
    const ifaceText = ifaceCount === 0 ? '--' : (ifaceCount === 1 ? '1 port' : ifaceCount + ' ports');
    const dotClass = 'status-dot ' + (dev.status || 'unknown');
    const statusText = (dev.status || 'unknown');
    const typeLabel = (dev.device_type || 'device');

    card.innerHTML =
      '<div class="card-top">' +
        '<div class="status-dot-wrap"><span class="' + dotClass + '"></span><span class="status-text ' + statusText + '">' + statusText + '</span></div>' +
        '<a href="#" class="card-detail-link card-detail-top" data-device-id="' + dev.id + '">View details &rarr;</a>' +
      '</div>' +
      '<div class="card-title">' + escapeHtml(dev.name) + '</div>' +
      '<div class="card-ip">' + escapeHtml(dev.ip_address) + '</div>' +
      '<div class="card-type">' + escapeHtml(typeLabel) + '</div>' +
      '<div class="card-stats-row">' +
        '<div class="stat-item"><span class="stat-label">Response Time</span><span class="stat-val" id="card-lat-' + dev.id + '">' + latText + '</span></div>' +
        '<div class="stat-item"><span class="stat-label">Packet Loss</span><span class="stat-val" id="card-loss-' + dev.id + '" style="color:' + lossColor + '">' + lossText + '</span></div>' +
        '<div class="stat-item"><span class="stat-label">Interfaces</span><span class="stat-val">' + ifaceText + '</span></div>' +
      '</div>';

    card.addEventListener('click', function (e) {
      // If the click was on the detail link, ignore here and let the link handle it
      if (e.target && e.target.classList && e.target.classList.contains('card-detail-link')) return;
      selectDevice(dev.id);
    });

    const detailLink = card.querySelector('.card-detail-link');
    if (detailLink) {
      detailLink.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openDeviceDetail(dev.id);
      });
    }

    container.appendChild(card);
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateCardTelemetry(deviceId, latency, loss, status) {
  const card = document.getElementById(`dev-card-${deviceId}`);
  const latEl = document.getElementById(`card-lat-${deviceId}`);
  const lossEl = document.getElementById(`card-loss-${deviceId}`);

  if (latEl) latEl.textContent = formatMetric(latency, 'ms', '--');
  if (lossEl) {
    lossEl.textContent = formatMetric(loss, '%', '--');
    lossEl.style.color = loss >= 100 ? 'var(--color-offline)' : (loss > 0 ? 'var(--color-warning)' : 'inherit');
  }

  // Calculate computed status
  const devStatus = status || (loss >= 100 || (latency === 0 && loss > 0) ? 'offline' : (loss > 2 || latency > 45 ? 'warning' : 'online'));

  // Update in state.devices array
  const dObj = state.devices.find(d => d.id === deviceId);
  if (dObj) {
    dObj.status = devStatus;
    dObj.ping_latency = latency;
    dObj.packet_loss = loss;
  }

  // Update visual card border, background, dot, and status text
  if (card) {
    card.classList.remove('fault-offline', 'fault-warning');
    if (devStatus === 'offline') card.classList.add('fault-offline');
    else if (devStatus === 'warning') card.classList.add('fault-warning');

    const dot = card.querySelector('.status-dot');
    if (dot) {
      dot.className = `status-dot ${devStatus}`;
    }

    const statusTextEl = card.querySelector('.status-text');
    if (statusTextEl) {
      statusTextEl.className = `status-text ${devStatus}`;
      statusTextEl.textContent = devStatus;
    }
  }

  // Update Top KPIs & Donut
  refreshKpiCounters();
}

/**
 * Handles Selecting Device (Clicking Node Card)
 * - Update card highlight
 * - Switch Real-Time Throughput Stream chart on main dashboard to this device
 * - DO NOT auto-open deep-dive panel; user must click "View Detail" CTA
 */
function selectDevice(deviceId) {
  const deviceChanged = state.selectedDeviceId !== deviceId;
  state.selectedDeviceId = deviceId;
  const dev = state.devices.find(d => d.id === deviceId);

  // Update card border highlights
  document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
  const targetCard = document.getElementById(`dev-card-${deviceId}`);
  if (targetCard) targetCard.classList.add('selected');

  if (deviceChanged) {
    // Switching device → clear the shared window so the previous device's
    // line never bleeds into the new one. Same device (e.g. opening its
    // detail panel) keeps the already-painted buffer — no needless reset.
    resetTrafficBuffer();
    document.getElementById('live-in-rate').textContent = '0.00 Mbps';
    document.getElementById('live-out-rate').textContent = '0.00 Mbps';
  }

  if (dev) {
    document.getElementById('traffic-chart-title').textContent = `Real-Time Throughput Stream: ${dev.name}`;
    updateInterfaceDropdown();
    subscribeSelectedStream();
  }
}

/**
 * Open Device Deep-Dive panel — dipanggil dari CTA "View Detail" di device card
 * atau dari link "View Full Incident Log" yang relevan.
 */
function openDeviceDetailFromCard(deviceId, evt) {
  if (evt) {
    evt.stopPropagation();
    evt.preventDefault();
  }
  openDeviceDetail(deviceId);
}

function updateInterfaceDropdown() {
  const dev = state.devices.find(d => d.id === state.selectedDeviceId);
  const select = document.getElementById('chart-interface-select');
  if (!dev || !select) return;

  const ifaces = dev.interfaces || [];

  select.innerHTML = '';
  if (ifaces.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No interfaces detected (SNMP offline)';
    opt.selected = true;
    select.appendChild(opt);
    select.disabled = true;
    state.selectedInterface = '';
  } else {
    select.disabled = false;
    ifaces.forEach((i, idx) => {
      const opt = document.createElement('option');
      opt.value = i.interface_name;
      opt.textContent = i.interface_name;
      if (idx === 0) opt.selected = true;
      select.appendChild(opt);
    });
    state.selectedInterface = select.value;
  }
}

/* ============================================================================
   DEVICE DEEP-DIVE PANEL
   ============================================================================ */

function openDeviceDetail(deviceId) {
  const backdrop = document.getElementById('device-detail-backdrop');
  if (!backdrop) return;
  const mainViewport = document.querySelector('.main-viewport');
  if (mainViewport) mainViewport.classList.add('device-detail-open');
  backdrop.classList.add('active');
  document.body.style.overflow = 'hidden';

  state.detailDeviceId = deviceId;
  // Reset QoS sliding buffers + any leftover chart overlays from a previous
  // device. The traffic buffer is shared: it is only cleared when the device
  // actually changes (see selectDevice) so re-opening the same device keeps
  // the already-painted realtime window.
  state.detailRttBuffer = { labels: [], min: [], avg: [], max: [] };
  state.detailLossBuffer = { labels: [], values: [] };
  clearDetailChartOverlays();

  // Show loading state in header
  const dev = state.devices.find(d => d.id === deviceId);
  document.getElementById('detail-device-name').textContent = dev ? dev.name : `Device #${deviceId}`;
  document.getElementById('detail-device-ip').textContent = dev ? dev.ip_address : '--';
  document.getElementById('detail-device-type').textContent = dev ? dev.device_type : '--';
  document.getElementById('detail-device-vendor').textContent = dev ? (dev.vendor || '—') : '—';
  document.getElementById('detail-device-model').textContent = dev ? (dev.model || '—') : '—';
  setStatusPill('detail-device-status', dev ? dev.status : 'unknown');
  const liveInd = document.getElementById('detail-live-indicator');
  if (liveInd) {
    liveInd.className = 'status-pill';
    liveInd.textContent = 'LIVE';
  }
  // Interfaces table back to loading until the deep-dive payload arrives
  const ifaceTbody = document.getElementById('detail-iface-tbody');
  if (ifaceTbody) ifaceTbody.innerHTML = '<tr><td colspan="6" class="dic-empty-cell">Loading…</td></tr>';
  const eventsList = document.getElementById('detail-events-list');
  if (eventsList) eventsList.innerHTML = '<div class="dic-empty-state">Loading events...</div>';

  // Route the realtime 1s WebSocket stream to this device + its first interface
  // so the Live Traffic chart keeps flowing while the panel is open.
  if (dev) selectDevice(deviceId);

  loadDeviceDetail(deviceId);

  // Auto-refresh every 5s while panel is open
  if (state.detailPollingTimer) clearInterval(state.detailPollingTimer);
  state.detailPollingTimer = setInterval(function() { loadDeviceDetail(deviceId, true); }, 5000);

  // Add escape key handler
  if (!state.detailEscapeHandler) {
    state.detailEscapeHandler = (e) => {
      if (e.key === 'Escape') closeDeviceDetail();
    };
    document.addEventListener('keydown', state.detailEscapeHandler);
  }
}

function toggleSection(contentId, iconId) {
  const content = document.getElementById(contentId);
  const icon = iconId ? document.getElementById(iconId) : null;
  if (!content) return;

  const isCollapsed = content.classList.contains('collapsed');
  if (isCollapsed) {
    content.classList.remove('collapsed');
    if (icon) icon.classList.remove('collapsed');
  } else {
    content.classList.add('collapsed');
    if (icon) icon.classList.add('collapsed');
  }
}

function closeDeviceDetail() {
  const backdrop = document.getElementById('device-detail-backdrop');
  if (!backdrop) return;
  const mainViewport = document.querySelector('.main-viewport');
  if (mainViewport) mainViewport.classList.remove('device-detail-open');
  backdrop.classList.remove('active');
  document.body.style.overflow = '';
  if (state.detailPollingTimer) {
    clearInterval(state.detailPollingTimer);
    state.detailPollingTimer = null;
  }
  if (state.charts.detailThroughput) { state.charts.detailThroughput.destroy(); state.charts.detailThroughput = null; }
  if (state.charts.detailRtt) { state.charts.detailRtt.destroy(); state.charts.detailRtt = null; }
  if (state.charts.detailLoss) { state.charts.detailLoss.destroy(); state.charts.detailLoss = null; }
  state.detailData = null;
  state.detailDeviceId = null;
  state.detailRttBuffer = { labels: [], min: [], avg: [], max: [] };
  state.detailLossBuffer = { labels: [], values: [] };
  state.detailLastTickAt = 0;

  // Remove escape key handler
  if (state.detailEscapeHandler) {
    document.removeEventListener('keydown', state.detailEscapeHandler);
    state.detailEscapeHandler = null;
  }
}

function setStatusPill(elementId, status) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.className = `status-pill ${status || 'unknown'}`;
  el.textContent = (status || 'unknown').toUpperCase();
}

async function loadDeviceDetail(deviceId, isRefresh = false) {
  try {
    const res = await fetch(`/api/devices/${deviceId}/deep-dive`).then(r => r.json());
    if (!res.success) {
      showDetailLoadError(`Failed to load runtime data: ${res.error || 'unknown error'}`);
      return;
    }
    state.detailData = res;
    renderDeviceDetail(res, isRefresh);
  } catch (e) {
    console.error('Failed to load device detail:', e);
    showDetailLoadError('Failed to load runtime data');
  }
}

/**
 * Surface a clear error in every runtime panel instead of leaving the
 * static "Loading…"/"No ..." placeholders when the deep-dive fetch fails.
 */
function showDetailLoadError(message) {
  const ifaceTbody = document.getElementById('detail-iface-tbody');
  if (ifaceTbody) {
    ifaceTbody.innerHTML = `<tr><td colspan="6" class="dic-empty-cell">${escapeHtml(message)}</td></tr>`;
  }
  const eventsList = document.getElementById('detail-events-list');
  if (eventsList) eventsList.innerHTML = `<div class="dic-empty-state">${escapeHtml(message)}</div>`;
  const historyList = document.getElementById('detail-history-list');
  if (historyList) historyList.innerHTML = `<div class="dic-empty-state">${escapeHtml(message)}</div>`;
  ['detailThroughputChart', 'detailRttChart', 'detailLossChart'].forEach(id => setDetailChartEmpty(id, 'error'));
}

function renderDeviceDetail(data, isRefresh = false) {
  const sys = data.system || {};
  const latencySummary = data.latency_summary || {};
  const lossSummary = data.loss_summary || {};

  // Header
  document.getElementById('detail-device-name').textContent = data.device.name;
  document.getElementById('detail-device-ip').textContent = data.device.ip_address;
  document.getElementById('detail-device-type').textContent = data.device.device_type || '--';
  document.getElementById('detail-device-vendor').textContent = data.device.vendor || '—';
  document.getElementById('detail-device-model').textContent = data.device.model || '—';
  setStatusPill('detail-device-status', data.device.status);

  // Device Overview
  const ifaceCount = (data.interfaces || []).length;
  document.getElementById('detail-overview-name').textContent = data.device.name;
  document.getElementById('detail-overview-ip').textContent = data.device.ip_address;
  document.getElementById('detail-overview-type').textContent = data.device.device_type || '--';
  document.getElementById('detail-overview-vendor').textContent = data.device.vendor || '—';
  document.getElementById('detail-overview-model').textContent = data.device.model || '—';
  document.getElementById('detail-overview-ros').textContent = data.device.routeros_version || '—';
  document.getElementById('detail-overview-polling').textContent = `${data.device.polling_interval || 1}s`;
  document.getElementById('detail-overview-interfaces').textContent = `${ifaceCount} interface${ifaceCount !== 1 ? 's' : ''}`;
  const lastSeenEl = document.getElementById('detail-overview-lastseen');
  if (lastSeenEl && data.device.last_seen) {
    const seenDate = new Date(data.device.last_seen);
    lastSeenEl.textContent = formatTimeAgo(seenDate);
    lastSeenEl.title = seenDate.toLocaleString('id-ID', { hour12: false });
  } else {
    lastSeenEl.textContent = '--';
  }

  // Current Health - Status / Latency / Packet Loss / Uptime only.
  // CPU & Memory moved to System Resources (single source of truth).
  setStatusPill('detail-health-status', data.device.status);
  document.getElementById('detail-health-latency').textContent = latencySummary.avg ? `${latencySummary.avg} ms` : '--';
  document.getElementById('detail-health-loss').textContent = lossSummary.avg ? `${lossSummary.avg}%` : '--';
  document.getElementById('detail-health-uptime').textContent = sys.sys_uptime_human || '--';

  // Updated timestamp
  const updatedAt = document.getElementById('detail-updated-at');
  if (updatedAt) {
    updatedAt.textContent = 'Updated ' + new Date().toLocaleTimeString('id-ID', { hour12: false });
  }
  const qualityUpdated = document.getElementById('detail-quality-updated');
  if (qualityUpdated) {
    qualityUpdated.textContent = data.generated_at ? `Updated ${formatTimeAgo(new Date(data.generated_at))}` : '--';
  }

  // System Resources section
  const sysCpuEl = document.getElementById('detail-sys-cpu');
  const sysCpuBar = document.getElementById('detail-sys-cpu-bar');
  if (sysCpuEl && sys.cpu_load_pct !== null && sys.cpu_load_pct !== undefined) {
    const cpuVal = parseFloat(sys.cpu_load_pct).toFixed(1);
    sysCpuEl.textContent = `${cpuVal}%`;
    if (sysCpuBar) sysCpuBar.style.width = `${cpuVal}%`;
  } else if (sysCpuEl) {
    sysCpuEl.textContent = '--';
    if (sysCpuBar) sysCpuBar.style.width = '0%';
  }

  const sysMemEl = document.getElementById('detail-sys-memory');
  const sysMemBar = document.getElementById('detail-sys-memory-bar');
  if (sysMemEl && sys.storage_entries && sys.storage_entries.length > 0) {
    const usage = decodeStorageUsage(findRamEntry(sys.storage_entries));
    if (usage) {
      sysMemEl.textContent = `${usage.usedGB} / ${usage.totalGB} GB (${usage.pct}%)`;
      if (sysMemBar) sysMemBar.style.width = `${usage.pct}%`;
    } else {
      sysMemEl.textContent = '--';
      if (sysMemBar) sysMemBar.style.width = '0%';
    }
  } else if (sysMemEl) {
    sysMemEl.textContent = '--';
    if (sysMemBar) sysMemBar.style.width = '0%';
  }

  const sysStorEl = document.getElementById('detail-sys-storage');
  const sysStorBar = document.getElementById('detail-sys-storage-bar');
  if (sysStorEl && sys.storage_entries && sys.storage_entries.length > 0) {
    const ram = findRamEntry(sys.storage_entries);
    const storageEntry = (sys.storage_entries || []).find(e => e !== ram);
    const usage = decodeStorageUsage(storageEntry);
    if (usage) {
      sysStorEl.textContent = `${usage.usedGB} / ${usage.totalGB} GB (${usage.pct}%)`;
      if (sysStorBar) sysStorBar.style.width = `${usage.pct}%`;
    } else {
      sysStorEl.textContent = '--';
      if (sysStorBar) sysStorBar.style.width = '0%';
    }
  } else if (sysStorEl) {
    sysStorEl.textContent = '--';
    if (sysStorBar) sysStorBar.style.width = '0%';
  }

  // Temperature: no runtime source exists yet in the deep-dive payload —
  // keep the row visible with a placeholder instead of faking a value.
  const sysTempEl = document.getElementById('detail-sys-temp');
  const sysTempBar = document.getElementById('detail-sys-temp-bar');
  const tempVal = sys.temperature_c != null ? sys.temperature_c : (sys.temperature != null ? sys.temperature : null);
  if (sysTempEl) {
    if (tempVal != null) {
      sysTempEl.textContent = `${Number(tempVal).toFixed(1)}°C`;
      if (sysTempBar) sysTempBar.style.width = `${Math.min(Math.max(Number(tempVal), 0), 100)}%`;
    } else {
      sysTempEl.textContent = '--';
      if (sysTempBar) sysTempBar.style.width = '0%';
    }
  }

  // Traffic freshness
  const trafficFreshness = document.getElementById('detail-traffic-freshness');
  if (trafficFreshness && data.generated_at) {
    const genDate = new Date(data.generated_at);
    trafficFreshness.textContent = `Source: ${data.data_source === 'realtime-snmp' ? 'Direct SNMP' : 'InfluxDB'} • Updated ${formatTimeAgo(genDate)}`;
  }

  // Interface table
  renderInterfaceTable(data);

  // Interface selector for throughput chart
  populateDetailIfaceSelect(data);

  // Charts (init if not yet, otherwise just update)
  if (!isRefresh) {
    initDetailCharts();
  }
  updateDetailCharts(data);

  // Load events for this device
  loadDeviceEvents(data.device.id);

  // Check for active incident
  updateDetailIncidentSection(data.device.id);

  // Load incident history
  loadDeviceHistory(data.device.id);
}

function findRamEntry(storageEntries) {
  let primary = storageEntries.find(e =>
    (e.descr || '').trim().toLowerCase() === 'physical memory'
  );
  if (!primary) {
    const alt = storageEntries.find(e => {
      const d = (e.descr || '').trim().toLowerCase();
      return d === 'main memory' || d === 'ram' || d === 'real memory' || d === 'system memory';
    });
    primary = alt;
  }
  if (!primary) {
    const OID_RAM = '.1.3.6.1.2.1.25.2.1.2';
    const OID_FIXED = '.1.3.6.1.2.1.25.2.1.4';
    primary = storageEntries.find(e => e.storage_type === OID_RAM);
    if (!primary) primary = storageEntries.find(e => e.storage_type === OID_FIXED);
    if (!primary) primary = storageEntries[0];
    for (const e of storageEntries) {
      if ((e.size || 0) > (primary.size || 0)) primary = e;
    }
  }
  return primary;
}

/**
 * Decode an hrStorage entry into a sane { usedGB, totalGB, pct }.
 * RouterOS (and some SNMP agents) report hrStorageUsed > hrStorageSize,
 * with the real total carried in "used" and the free space in "size".
 * When that happens the fields are swapped so the math stays sane.
 */
function decodeStorageUsage(entry) {
  if (!entry) return null;
  const allocUnits = entry.alloc_units && entry.alloc_units > 0 ? entry.alloc_units : 4096;
  let totalUnits = entry.size || 0;
  let usedUnits = entry.used || 0;
  if (usedUnits > totalUnits && totalUnits > 0) {
    const freeUnits = totalUnits;
    totalUnits = usedUnits;
    usedUnits = Math.max(totalUnits - freeUnits, 0);
  }
  const totalBytes = totalUnits * allocUnits;
  if (totalBytes <= 0) return null;
  const usedBytes = Math.min(usedUnits * allocUnits, totalBytes);
  return {
    usedGB: (usedBytes / (1024 ** 3)).toFixed(2),
    totalGB: (totalBytes / (1024 ** 3)).toFixed(2),
    pct: ((usedBytes / totalBytes) * 100).toFixed(1)
  };
}

async function loadDeviceEvents(deviceId) {
  const container = document.getElementById('detail-events-list');
  const countEl = document.getElementById('detail-events-count');
  if (!container) return;

  try {
    const params = new URLSearchParams({ deviceId: deviceId, limit: '20' });
    const res = await fetch(`/api/events?${params.toString()}`).then(r => r.json());
    if (!res.success || !res.events || res.events.length === 0) {
      container.innerHTML = '<div class="dic-empty-state">No recent events</div>';
      if (countEl) countEl.textContent = '0';
      return;
    }

    if (countEl) countEl.textContent = `${res.events.length} event${res.events.length !== 1 ? 's' : ''}`;

    container.innerHTML = res.events.map(e => {
      const time = e.timestamp ? new Date(e.timestamp).toLocaleString('id-ID', { hour12: false }) : '--';
      const sevClass = e.severity || 'info';
      // events table has no free-text "message" column: build one from device + type
      const msg = e.message || (e.device_name
        ? `${e.device_name} ${String(e.event_type || 'event').toLowerCase()}`
        : e.event_type || 'Event');
      const relatedIncidentId = e.relatedIncidentId || e.related_incident_id;
      const relatedIncident = relatedIncidentId
        ? state.activeIncidents.find(i => i.incidentId == relatedIncidentId)
        : state.activeIncidents.find(i => i.deviceId == e.device_id);
      return `
        <div class="dic-event-row" data-device-id="${e.device_id}" ${relatedIncident ? `data-incident-id="${relatedIncident.incidentId}"` : ''}>
          <span class="dic-event-time">${time}</span>
          <span class="dic-event-type ${sevClass}">${escapeHtml(e.event_type || 'EVENT')}</span>
          <span class="dic-event-message">${escapeHtml(msg)}</span>
          ${relatedIncident ? '<span class="dic-history-status active">Open Incident</span>' : ''}
        </div>
      `;
    }).join('');

    container.querySelectorAll('.dic-event-row').forEach(row => {
      row.addEventListener('click', () => {
        const incId = row.dataset.incidentId;
        if (incId) {
          openIncidentDrawerById(incId);
          return;
        }
        const devId = row.dataset.deviceId;
        const activeForDevice = state.activeIncidents.find(i => i.deviceId == devId);
        if (activeForDevice) {
          openIncidentDrawerById(activeForDevice.incidentId);
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="dic-empty-state">Failed to load events</div>';
    if (countEl) countEl.textContent = '0';
  }
}

async function updateDetailIncidentSection(deviceId) {
  const rootCauseCard = document.getElementById('detail-rootcause-card');
  const rootCauseContent = document.getElementById('detail-rootcause-content');
  const rootCauseSeverity = document.getElementById('detail-rootcause-severity');
  const timelineCard = document.getElementById('detail-timeline-card');
  const timelineList = document.getElementById('detail-timeline-list');
  const timelineCount = document.getElementById('detail-timeline-count');

  if (!rootCauseCard || !timelineCard || !timelineList || !rootCauseContent) return;

  const activeForDevice = state.activeIncidents.find(i => i.deviceId == deviceId);

  // No active incident → neutral empty states (cards stay visible).
  // Timeline is for the ACTIVE incident only — history lives in the
  // Incident History panel below, never duplicated here.
  if (!activeForDevice) {
    if (rootCauseSeverity) rootCauseSeverity.style.display = 'none';
    rootCauseContent.className = 'dic-rootcause-content';
    rootCauseContent.innerHTML = '<div class="dic-empty-state">No active incident</div>';
    if (timelineCount) timelineCount.textContent = '0';
    timelineList.innerHTML = '<div class="dic-empty-state">No active incident timeline</div>';
    return;
  }

  // Root Cause content (active incident only)
  const sev = activeForDevice.currentSeverity || 'warning';
  rootCauseContent.className = `dic-rootcause-content ${sev === 'critical' ? 'critical' : ''}`;
  const ev = activeForDevice.evidence || {};
  const evidenceParts = [];
  if (ev.maxLatency != null) evidenceParts.push(`Max latency: ${ev.maxLatency} ms`);
  if (ev.maxPacketLoss != null) evidenceParts.push(`Max packet loss: ${ev.maxPacketLoss}%`);
  if (ev.maxInMbps != null) evidenceParts.push(`Peak in: ${ev.maxInMbps} Mbps`);
  if (ev.maxOutMbps != null) evidenceParts.push(`Peak out: ${ev.maxOutMbps} Mbps`);
  const firstDetected = activeForDevice.startedAt
    ? `First detected: ${new Date(activeForDevice.startedAt).toLocaleString('id-ID', { hour12: false })}`
    : '';
  rootCauseContent.innerHTML =
    `<div class="dic-rootcause-message">${escapeHtml(activeForDevice.rootCause?.message || 'Incident')}</div>` +
    (evidenceParts.length > 0 ? `<div class="dic-rootcause-evidence">${escapeHtml(evidenceParts.join(' • '))}</div>` : '') +
    (firstDetected ? `<div class="dic-rootcause-evidence">${escapeHtml(firstDetected)}</div>` : '');
  if (rootCauseSeverity) {
    rootCauseSeverity.className = `alert-severity-badge ${sev}`;
    rootCauseSeverity.textContent = sev.toUpperCase();
    rootCauseSeverity.style.display = 'inline-block';
  }

  // Timeline: statusHistory (newest first), legacy "timeline" key as fallback
  const rawTimeline = activeForDevice.statusHistory || activeForDevice.timeline || [];
  const timeline = [...rawTimeline].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  if (timelineCount) timelineCount.textContent = `${timeline.length} event${timeline.length !== 1 ? 's' : ''}`;
  if (timeline.length === 0) {
    timelineList.innerHTML = '<div class="dic-empty-state">No active incident timeline</div>';
    return;
  }

  timelineList.innerHTML = timeline.map(entry => {
    const entryTime = entry.timestamp ? new Date(entry.timestamp).toLocaleString('id-ID', { hour12: false }) : '--';
    const statusKey = String(entry.status || entry.event || '').toUpperCase();
    const itemClass = statusKey.indexOf('OFFLINE') !== -1 || entry.severity === 'critical'
      ? 'critical'
      : (statusKey.indexOf('WARNING') !== -1 || entry.severity === 'warning'
        ? 'warning'
        : 'ok');
    return `
      <div class="dic-timeline-item ${itemClass}">
        <div class="dic-timeline-content">
          <div class="dic-timeline-status">${escapeHtml(entry.event || entry.status || 'Event')}</div>
          <div class="dic-timeline-time">${entryTime}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadDeviceHistory(deviceId) {
  const container = document.getElementById('detail-history-list');
  const countEl = document.getElementById('detail-history-count');
  if (!container) return;

  try {
    const res = await fetch(`/api/incidents`).then(r => r.json());
    if (!res.success) {
      container.innerHTML = '<div class="dic-empty-state">Failed to load history</div>';
      if (countEl) countEl.textContent = '0';
      return;
    }

    // History = PAST incidents only. The active incident is shown by the
    // Root Cause + Timeline cards above — do not duplicate it in the list.
    const deviceHistory = (res.history || []).filter(i => i.deviceId == deviceId);
    const allHistory = deviceHistory.slice(0, 10);

    if (countEl) countEl.textContent = `${allHistory.length} incident${allHistory.length !== 1 ? 's' : ''}`;

    if (allHistory.length === 0) {
      container.innerHTML = '<div class="dic-empty-state">No incident history</div>';
      return;
    }

    container.innerHTML = allHistory.map(inc => {
      const duration = inc.durationMs ? formatDuration(inc.durationMs) : (inc.status === 'active' ? 'Active' : '--');
      const sevClass = inc.currentSeverity || 'info';
      const statusClass = inc.status === 'resolved' ? 'resolved' : 'active';
      return `
        <div class="dic-history-item" data-incident-id="${inc.incidentId}">
          <span class="dic-history-severity alert-severity-badge ${sevClass}">${(inc.currentSeverity || 'info').toUpperCase()}</span>
          <span class="dic-history-message">${escapeHtml(inc.rootCause?.message || 'Incident')}</span>
          <span class="dic-history-duration">${duration}</span>
          <span class="dic-history-status ${statusClass}">${inc.status || 'active'}</span>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.dic-history-item[data-incident-id]').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset.incidentId;
        if (id) openIncidentDrawerById(id);
      });
    });
  } catch (err) {
    container.innerHTML = '<div class="dic-empty-state">Failed to load history</div>';
    if (countEl) countEl.textContent = '0';
  }
}

function renderInterfaceTable(data) {
  const tbody = document.getElementById('detail-iface-tbody');
  if (!tbody) return;
  const ifaces = data.interfaces || [];
  const ratesByName = {};
  // Current per-interface Mbps snapshot (RX/TX columns). Legacy fallback kept
  // so the table never silently blanks if an older payload arrives.
  (data.interface_rates || data.packet_rates || []).forEach(p => { ratesByName[p.interface_name] = p; });
  const errByName = {};
  (data.error_counters || []).forEach(p => { errByName[p.interface_name] = p; });

  if (ifaces.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:16px; color:var(--text-muted);">No interfaces discovered via SNMP yet</td></tr>`;
    return;
  }

  tbody.innerHTML = ifaces.map(i => {
    const rate = ratesByName[i.interface_name] || {};
    const err = errByName[i.interface_name] || {};
    let statusLabel = i.oper_status_label;
    if (!statusLabel && i.oper_status !== undefined && i.oper_status !== null) {
      statusLabel = (i.oper_status === 1) ? 'up' : (i.oper_status === 2 ? 'down' : 'unknown');
    } else if (!statusLabel) {
      statusLabel = i.status || 'up';
    }
    const statusClass = statusLabel;
    const ifname = (i.interface_name || '').toLowerCase();
    const isVirtual = ifname === 'lo' || ifname === 'lo0' || ifname.startsWith('lo:') || ifname.startsWith('loopback') || ifname === 'null0' || ifname.startsWith('null');
    let speedMbps;
    if (isVirtual) {
      speedMbps = '— Virtual';
    } else if (i.speed_mbps && i.speed_mbps > 0) {
      speedMbps = `${i.speed_mbps} Mbps`;
    } else {
      speedMbps = '--';
    }
    const inMbps = rate.in_mbps != null ? rate.in_mbps.toFixed(2) : '--';
    const outMbps = rate.out_mbps != null ? rate.out_mbps.toFixed(2) : '--';
    const totalErrors = (err.ifInErrors || 0) + (err.ifOutErrors || 0);
    return `
      <tr>
        <td>${i.interface_name}</td>
        <td><span class="iface-status ${statusClass}">${statusLabel.toUpperCase()}</span></td>
        <td>${speedMbps}</td>
        <td style="font-family:var(--font-mono);font-size:0.8rem;">${inMbps}</td>
        <td style="font-family:var(--font-mono);font-size:0.8rem;">${outMbps}</td>
        <td style="color:${totalErrors > 0 ? 'var(--color-offline)' : 'inherit'}">${totalErrors}</td>
      </tr>
    `;
  }).join('');
}

function populateDetailIfaceSelect(data) {
  const sel = document.getElementById('detail-interface-select');
  if (!sel) return;
  const ifaces = data.interfaces || [];
  const previous = sel.value;
  sel.innerHTML = '';
  if (ifaces.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No interfaces';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  ifaces.forEach(i => {
    const o = document.createElement('option');
    o.value = i.interface_name;
    o.textContent = i.interface_name;
    sel.appendChild(o);
  });
  if (previous && ifaces.find(i => i.interface_name === previous)) {
    sel.value = previous;
  } else {
    // Prefer the first real (non-loopback) interface for the traffic chart
    const wired = findFirstWiredInterface(ifaces);
    if (wired) sel.value = wired;
  }

  // Keep the WebSocket stream in sync with the interface shown in the panel
  if (sel.value && isDetailOpen() && state.selectedInterface !== sel.value) {
    state.selectedInterface = sel.value;
    subscribeSelectedStream();
  }
}

function findFirstWiredInterface(ifaces) {
  const preferred = (ifaces || []).find(i => {
    const n = String(i.interface_name || '').toLowerCase();
    return !(n === 'lo' || n === 'lo0' || n.startsWith('lo:') || n.startsWith('loopback') ||
             n === 'null0' || n.startsWith('null') || n === 'unknown');
  });
  return preferred ? preferred.interface_name : (ifaces[0] ? ifaces[0].interface_name : '');
}

function initDetailCharts() {
  // 1. Throughput per-interface (Mbps In vs Out, 5m sliding)
  const tpCtx = document.getElementById('detailThroughputChart').getContext('2d');
  const gradIn = tpCtx.createLinearGradient(0, 0, 0, 220);
  gradIn.addColorStop(0, 'rgba(0, 242, 254, 0.35)');
  gradIn.addColorStop(1, 'rgba(0, 242, 254, 0)');
  const gradOut = tpCtx.createLinearGradient(0, 0, 0, 220);
  gradOut.addColorStop(0, 'rgba(255, 153, 0, 0.35)');
  gradOut.addColorStop(1, 'rgba(255, 153, 0, 0)');

  state.charts.detailThroughput = new Chart(tpCtx, {
    type: 'line',
    data: {
      labels: state.chartBuffer.labels,
      datasets: [
        { label: 'Inbound (Mbps)', data: state.chartBuffer.inData, borderColor: '#00f2fe', backgroundColor: gradIn, fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 },
        { label: 'Outbound (Mbps)', data: state.chartBuffer.outData, borderColor: '#ff9900', backgroundColor: gradOut, fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} Mbps` }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#64748b', font: { size: 9 }, callback: (v) => `${v} Mbps` } }
      }
    }
  });

  // 2. RTT min/avg/max (colors match the panel legend)
  const rttCtx = document.getElementById('detailRttChart').getContext('2d');
  state.charts.detailRtt = new Chart(rttCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'min', data: [], borderColor: '#10b981', borderWidth: 1.5, pointRadius: 0, tension: 0.3, spanGaps: true },
        { label: 'avg', data: [], borderColor: '#00f2fe', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, spanGaps: true },
        { label: 'max', data: [], borderColor: '#ef4444', borderWidth: 1.5, pointRadius: 0, tension: 0.3, spanGaps: true }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} ms` } }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#64748b', font: { size: 9 }, callback: (v) => `${v} ms` } }
      }
    }
  });

  // 3. Packet Loss — time-series LINE chart. Loss spikes are drawn red,
  // healthy 0% segments stay amber. (No bar/histogram.)
  const lossCtx = document.getElementById('detailLossChart').getContext('2d');
  state.charts.detailLoss = new Chart(lossCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Packet Loss',
        data: [],
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.12)',
        fill: true,
        tension: 0,
        borderWidth: 1.5,
        pointRadius: 0,
        spanGaps: false,
        segment: {
          borderColor: (ctx) => (ctx.p0.parsed.y > 0 || ctx.p1.parsed.y > 0) ? '#ef4444' : '#f59e0b'
        },
        pointBackgroundColor: (ctx) => (ctx.raw > 0 ? '#ef4444' : '#f59e0b'),
        pointBorderColor: (ctx) => (ctx.raw > 0 ? '#ef4444' : '#f59e0b')
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false, callbacks: { label: (ctx) => `Loss: ${ctx.parsed.y.toFixed(2)}%` } }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 6 } },
        y: { beginAtZero: true, suggestedMax: 100, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#64748b', font: { size: 9 }, callback: (v) => `${v}%` } }
      }
    }
  });
}

/**
 * Update detail charts from a deep-dive payload WITHOUT recreating datasets:
 * - Live Traffic / Real-Time Throughput read the shared chartBuffer. The
 *   single 5s traffic poller (startTrafficPolling) refills it when the WS
 *   stream is stale; this function NEVER fetches traffic itself, so there is
 *   exactly one writer + one fallback scheduler.
 * - RTT / Packet Loss use their own sliding buffers, seeded from this payload
 *   when empty/stale, otherwise kept alive by the per-second ticks.
 */
function updateDetailCharts(data) {
  const finalIface = document.getElementById('detail-interface-select')?.value || '';
  const wsOpen = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
  const wsFresh = (Date.now() - state.detailLastTickAt) < 8000;
  const live = wsOpen && wsFresh;
  const chartAlive = state.charts.detailThroughput;

  if (finalIface && chartAlive) {
    // Just reflect the shared window's current state; the poller handles
    // backfill whenever the WS is not feeding it.
    setDetailChartEmpty('detailThroughputChart',
      state.chartBuffer.labels.length > 0 ? 'ok' : 'empty');
  } else if (chartAlive) {
    setDetailChartEmpty('detailThroughputChart', 'empty');
  }

  const needQosSeed = !live || state.detailRttBuffer.labels.length === 0;
  if (needQosSeed) {
    seedQosBuffers(data);
  }
  renderQosCharts(data);
}

/* ============================================================
   SHARED SLIDING-WINDOW TRAFFIC PIPELINE
   state.chartBuffer (60 pts) is the single source of truth for BOTH
   the right Analytics "Real-Time Throughput Stream" and the DIC
   "Live Traffic" hero chart. Datasets are persistent; we append +
   shift, never recreate the chart or its arrays.
   ============================================================ */

function ensureStreamSelection() {
  if (!state.devices || state.devices.length === 0) return;
  const exists = state.devices.some(d => d.id === state.selectedDeviceId);
  if (!exists) {
    selectDevice(state.devices[0].id);
  } else {
    subscribeSelectedStream();
  }
}

function resetTrafficBuffer() {
  state.chartBuffer = { labels: [], inData: [], outData: [] };
  rebindTrafficCharts();
}

function rebindTrafficCharts() {
  const b = state.chartBuffer;
  [state.charts.traffic, state.charts.detailThroughput].forEach(ch => {
    if (!ch) return;
    ch.data.labels = b.labels;
    ch.data.datasets[0].data = b.inData;
    ch.data.datasets[1].data = b.outData;
  });
}

function refreshSharedTrafficCharts() {
  rebindTrafficCharts();
  [state.charts.traffic, state.charts.detailThroughput].forEach(ch => {
    if (ch) ch.update('none');
  });
  if (isDetailOpen()) {
    setDetailChartEmpty('detailThroughputChart', state.chartBuffer.labels.length > 0 ? 'ok' : 'empty');
  }
}

/** Append one point (backend timestamp); drop the oldest once >60 — pure FIFO. */
function pushTrafficPoint(label, inMbps, outMbps) {
  state.lastTrafficTickAt = Date.now();
  state.chartBuffer.labels.push(label);
  state.chartBuffer.inData.push(Number(inMbps) || 0);
  state.chartBuffer.outData.push(Number(outMbps) || 0);
  if (state.chartBuffer.labels.length > 60) {
    state.chartBuffer.labels.shift();
    state.chartBuffer.inData.shift();
    state.chartBuffer.outData.shift();
  }

  try {
    localStorage.setItem('bms_chart_buffer', JSON.stringify({
      labels: state.chartBuffer.labels,
      inData: state.chartBuffer.inData,
      outData: state.chartBuffer.outData
    }));
  } catch (e) { /* ignore quota errors */ }

  refreshSharedTrafficCharts();
}

/**
 * Backfill the shared buffer from the interface-history payload
 * (rescue mode: only used while the WS stream is down/stale).
 * Points are inserted chronologically — no empty/null padding.
 */
function seedTrafficBuffer(points) {
  const src = points || {};
  const srcLabels = src.labels || [];
  if (srcLabels.length === 0) {
    if (isDetailOpen()) {
      setDetailChartEmpty('detailThroughputChart',
        state.chartBuffer.labels.length > 0 ? 'ok' : 'empty');
    }
    return; // keep whatever live ticks already painted
  }
  const from = Math.max(0, srcLabels.length - 60);
  state.chartBuffer = {
    labels: srcLabels.slice(from),
    inData: (src.inMbps || []).slice(from).map(v => Number(v) || 0),
    outData: (src.outMbps || []).slice(from).map(v => Number(v) || 0)
  };
  refreshSharedTrafficCharts();
  if (isDetailOpen()) {
    setDetailChartEmpty('detailThroughputChart', 'ok');
  }
}

/**
 * ONE shared traffic scheduler (started once at boot). Every 5s it checks
 * whether the WS stream is still feeding the shared window; when it is not
 * (socket closed or no tick for >8s) it refills the window from the backend
 * interface-history endpoint so Live Traffic / Real-Time Throughput never
 * freeze. When the WS is healthy it does nothing (no duplicate fetches).
 */
function startTrafficPolling() {
  if (state.trafficPollTimer) clearInterval(state.trafficPollTimer);
  state.trafficPollTimer = setInterval(trafficPollTick, 5000);
}

async function trafficPollTick() {
  if (state.trafficPollInFlight) return; // don't stack requests
  const wsOpen = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
  const fresh = (Date.now() - state.lastTrafficTickAt) < 8000;
  if (wsOpen && fresh) return; // realtime already moving the window

  const devId = state.selectedDeviceId;
  const iface = state.selectedInterface;
  if (devId == null || !iface) return;

  state.trafficPollInFlight = true;
  try {
    const points = await fetchThroughputHistory(devId, iface);
    if (!points || !points.labels || points.labels.length === 0) {
      if (isDetailOpen() && state.chartBuffer.labels.length === 0) {
        setDetailChartEmpty('detailThroughputChart', 'empty');
      }
      return;
    }
    seedTrafficBuffer(points);
  } catch (e) {
    /* silent — next poll retries */
  } finally {
    state.trafficPollInFlight = false;
  }
}

/* ============================================================
   QOS SLIDING BUFFERS (RTT min/avg/max + packet loss)
   Seeded once per open / stale WS, then appended per tick.
   ============================================================ */

const QOS_WINDOW = 90;

function seedQosBuffers(data) {
  const rtt = { labels: [], min: [], avg: [], max: [] };
  (data.latency_history || []).forEach(p => {
    if (rtt.labels.length >= QOS_WINDOW) return;
    rtt.labels.push(formatChartTime(p.time));
    rtt.min.push(p.min);
    rtt.avg.push(p.avg);
    rtt.max.push(p.max);
  });
  state.detailRttBuffer = rtt;

  const loss = { labels: [], values: [] };
  (data.loss_history || []).forEach(p => {
    if (loss.labels.length >= QOS_WINDOW) return;
    loss.labels.push(formatChartTime(p.time));
    loss.values.push(p.value);
  });
  state.detailLossBuffer = loss;
}

function renderQosCharts(data) {
  const rttChart = state.charts.detailRtt;
  if (rttChart) {
    const b = state.detailRttBuffer;
    rttChart.data.labels = b.labels;
    rttChart.data.datasets[0].data = b.min;
    rttChart.data.datasets[1].data = b.avg;
    rttChart.data.datasets[2].data = b.max;
    rttChart.update('none');
    setDetailChartEmpty('detailRttChart', b.labels.length > 0 ? 'ok' : 'empty');
  }

  const lossChart = state.charts.detailLoss;
  if (lossChart) {
    const b = state.detailLossBuffer;
    lossChart.data.labels = b.labels;
    lossChart.data.datasets[0].data = b.values;
    lossChart.update('none');
    setDetailChartEmpty('detailLossChart', b.labels.length > 0 ? 'ok' : 'empty');
    // Packet Loss ANGKA + chart baca buffer yang sama: angka mengikuti
    // titik terbaru grafik (bukan rata-rata terpisah).
    const healthLoss = document.getElementById('detail-health-loss');
    if (healthLoss && b.values.length > 0) {
      const v = Number(b.values[b.values.length - 1]);
      healthLoss.textContent = `${v.toFixed(2)}%`;
      healthLoss.style.color = v > 0 ? 'var(--color-warning)' : 'inherit';
    }
  }

  syncLossMaxHeader(data);
}

/** Packet Loss number + chart read the same source: the loss buffer max. */
function syncLossMaxHeader(data) {
  const lossMaxEl = document.getElementById('detail-loss-max');
  if (!lossMaxEl) return;
  const values = state.detailLossBuffer.values || [];
  let max = null;
  if (values.length > 0) {
    max = values.reduce((a, b) => Math.max(a, b), -Infinity);
  }
  if (max == null || !isFinite(max)) {
    max = (data && data.loss_summary && data.loss_summary.max != null) ? data.loss_summary.max : null;
  }
  lossMaxEl.textContent = max != null && isFinite(max) ? String(Number(max).toFixed(2)) : '--';
}

/** Append one 1s tick to the QoS sliding buffers (FIFO, QOS_WINDOW cap). */
function pushQosTick(msg, tickLabel) {
  if (msg.latency != null && (msg.packetLoss == null || Number(msg.packetLoss) < 100)) {
    const val = Number(msg.latency);
    state.detailRttBuffer.labels.push(tickLabel);
    state.detailRttBuffer.min.push(val);
    state.detailRttBuffer.avg.push(val);
    state.detailRttBuffer.max.push(val);
    if (state.detailRttBuffer.labels.length > QOS_WINDOW) {
      state.detailRttBuffer.labels.shift();
      state.detailRttBuffer.min.shift();
      state.detailRttBuffer.avg.shift();
      state.detailRttBuffer.max.shift();
    }
  }
  if (msg.packetLoss != null) {
    state.detailLossBuffer.labels.push(tickLabel);
    state.detailLossBuffer.values.push(Number(msg.packetLoss));
    if (state.detailLossBuffer.labels.length > QOS_WINDOW) {
      state.detailLossBuffer.labels.shift();
      state.detailLossBuffer.values.shift();
    }
  }
  renderQosCharts(null);
}

/**
 * Overlay empty/error state on a chart canvas when there is nothing to plot.
 * state: 'ok' (clear) | 'empty' (no telemetry) | 'error' (fetch failed)
 */
function setDetailChartEmpty(canvasId, chartState) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.closest('.dic-chart-container');
  if (!wrap) return;
  let overlay = wrap.querySelector('.dic-chart-empty');
  if (chartState === 'ok') {
    if (overlay) overlay.remove();
    return;
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'dic-chart-empty';
    wrap.appendChild(overlay);
  }
  overlay.textContent = chartState === 'error' ? 'Failed to load runtime data' : 'No telemetry available';
}

function clearDetailChartOverlays() {
  ['detailThroughputChart', 'detailRttChart', 'detailLossChart'].forEach(canvasId => {
    const canvas = document.getElementById(canvasId);
    if (canvas && canvas.closest) {
      const wrap = canvas.closest('.dic-chart-container');
      if (wrap) {
        const ov = wrap.querySelector('.dic-chart-empty');
        if (ov) ov.remove();
      }
    }
  });
}

function isDetailOpen() {
  const b = document.getElementById('device-detail-backdrop');
  return !!(b && b.classList.contains('active'));
}

/**
 * Feeds a 1s METRIC_TICK into the open Device Detail panel:
 * - Health Summary latency/loss/status (live numbers)
 * - RTT + Packet Loss sliding buffers (one point per second)
 * - Live Traffic hero, when the panel's interface differs from the
 *   dashboard subscription (the main branch already pushes shared ticks)
 */
function feedDetailRealtimeTick(msg) {
  if (!isDetailOpen()) return;
  if (state.detailDeviceId == null || msg.deviceId != state.detailDeviceId) return;

  // Marks the WS stream as fresh so 5s polls skip reseeding the charts.
  state.detailLastTickAt = Date.now();

  // Health Summary live values
  const latEl = document.getElementById('detail-health-latency');
  if (latEl && msg.latency != null) {
    const isDown = msg.packetLoss != null && Number(msg.packetLoss) >= 100;
    latEl.textContent = (!isDown && msg.latency >= 0) ? `${Number(msg.latency).toFixed(2)} ms` : '--';
  }
  const lossEl = document.getElementById('detail-health-loss');
  if (lossEl && msg.packetLoss != null) {
    const loss = Number(msg.packetLoss);
    lossEl.textContent = `${loss.toFixed(2)}%`;
    lossEl.style.color = loss > 0 ? 'var(--color-warning)' : 'inherit';
  }
  if (msg.status) setStatusPill('detail-health-status', msg.status);
  const liveInd = document.getElementById('detail-live-indicator');
  if (liveInd && msg.status) {
    liveInd.className = `status-pill ${msg.status}`;
    liveInd.textContent = (msg.status === 'online' ? '● ONLINE' : msg.status.toUpperCase());
  }

  const tickLabel = msg.timestamp || (msg.fullTime ? formatChartTime(msg.fullTime) : '--');

  // Live Traffic hero: if this tick is for the interface shown in the panel
  // but the dashboard subscription is elsewhere, push it anyway so the hero
  // keeps sliding. (Normal case — same subscription — is handled by
  // pushTrafficPoint in handleWsMessage to avoid double-append.)
  const selMatches = (msg.deviceId === state.selectedDeviceId && msg.interfaceName === state.selectedInterface);
  const ifaceSel = document.getElementById('detail-interface-select');
  if (!selMatches && ifaceSel && ifaceSel.value && state.charts.detailThroughput &&
      msg.interfaceName === ifaceSel.value) {
    pushTrafficPoint(tickLabel, msg.inMbps || 0, msg.outMbps || 0);
  }

  // QoS sliding buffers (RTT + Packet Loss), capped at QOS_WINDOW points.
  pushQosTick(msg, tickLabel);
}

function formatChartTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('id-ID', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Fetches per-interface throughput 5m sliding history from InfluxDB
 * (separate endpoint to keep deep-dive payload size small)
 */
async function fetchThroughputHistory(deviceId, interfaceName) {
  try {
    // We piggyback on the deep-dive response: for now derive 5m throughput
    // by calling getLiveTelemetry would only give latest — instead, we add a dedicated sub-endpoint.
    const res = await fetch(`/api/devices/${deviceId}/interface-history?interface=${encodeURIComponent(interfaceName)}&minutes=5`).then(r => r.json());
    if (!res.success) return null;
    return { labels: res.labels, inMbps: res.in_mbps, outMbps: res.out_mbps };
  } catch (e) {
    return null;
  }
}

/**
 * Renders Right Sidebar Incident Feed (Zona 5)
 */
function renderAlertFeed(searchQuery = '', sevFilter = 'all') {
  const container = document.getElementById('stream-log-container');
  if (!container) return;
  container.innerHTML = '';

  const q = searchQuery.toLowerCase();
  const filtered = state.alerts.filter(a => {
    const matchSev = sevFilter === 'all' || a.severity === sevFilter;
    const matchSearch = !q || (a.title + ' ' + a.target).toLowerCase().includes(q);
    return matchSev && matchSearch;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:24px 12px; color:var(--text-muted); font-size:0.78rem;">No incidents match your filter</div>';
    return;
  }

  filtered.slice(0, 20).forEach(alert => {
    const item = document.createElement('div');
    item.className = 'stream-item';
    item.style.cursor = 'pointer';

    const iconType = alert.severity === 'critical' ? 'critical' : (alert.severity === 'info' ? 'info' : 'warning');
    const timeAgo = formatTimeAgo(new Date(alert.created_at));

    item.innerHTML = `
      <div class="stream-icon ${iconType}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>
      </div>
      <div class="stream-body">
        <div class="stream-event-title">${alert.title}</div>
        <div class="stream-event-target">${alert.target}</div>
        <div class="stream-time-tag">${timeAgo}</div>
      </div>
    `;

    item.addEventListener('click', () => {
      if (alert.incidentId) {
        openIncidentDrawerById(alert.incidentId);
      } else {
        const activeForDevice = state.activeIncidents.find(i => i.deviceId === alert.device_id);
        if (activeForDevice) {
          openIncidentDrawerById(activeForDevice.incidentId);
        } else {
          openIncidentDrawer(alert);
        }
      }
    });

    container.appendChild(item);
  });

  updateAlertCounter();
}

function updateAlertCounter() {
  const count = state.alerts.filter(a => a.status === 'active').length;
  const panelCountEl = document.getElementById('panel-incidents-count');
  const streamBadgeEl = document.getElementById('stream-badge-count');
  const navBadgeEl = document.getElementById('nav-alert-counter');
  const floatCountEl = document.getElementById('floating-alert-count');
  if (panelCountEl) panelCountEl.textContent = count;
  if (streamBadgeEl) streamBadgeEl.textContent = count;
  if (navBadgeEl) navBadgeEl.textContent = count;
  if (floatCountEl) floatCountEl.textContent = count;
}

function renderIncidentFeed(searchQuery = '', sevFilter = 'all') {
  const container = document.getElementById('stream-log-container');
  if (!container) return;
  container.innerHTML = '';

  const q = searchQuery.toLowerCase();
  const filtered = state.activeIncidents.filter(inc => {
    const matchSev = sevFilter === 'all' || inc.currentSeverity === sevFilter;
    const matchSearch = !q || (inc.deviceName || '').toLowerCase().includes(q) ||
                        (inc.incidentId || '').toLowerCase().includes(q);
    return matchSev && matchSearch;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding:24px 12px; color:var(--text-muted); font-size:0.78rem;">No incidents match your filter</div>';
    return;
  }

  filtered.slice(0, 20).forEach(incident => {
    const item = document.createElement('div');
    item.className = 'stream-item';
    item.style.cursor = 'pointer';

    const iconType = incident.currentSeverity === 'critical' ? 'critical' :
                     incident.currentSeverity === 'warning' ? 'warning' : 'info';
    const timeAgo = incident.startedAt ? formatTimeAgo(new Date(incident.startedAt)) : 'Unknown';

    const title = incident.rootCause?.message || `Incident ${incident.incidentId}`;
    const deviceName = incident.deviceName || 'Unknown Device';

    item.innerHTML = `
      <div class="stream-icon ${iconType}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>
      </div>
      <div class="stream-body">
        <div class="stream-event-title">${title}</div>
        <div class="stream-event-target">${deviceName}</div>
        <div class="stream-time-tag">${timeAgo}</div>
      </div>
    `;

    item.addEventListener('click', () => {
      openIncidentDrawerById(incident.incidentId);
    });

    container.appendChild(item);
  });

  const activeCount = state.activeIncidents.length;
  const panelCountEl = document.getElementById('panel-incidents-count');
  const navBadgeEl = document.getElementById('nav-alert-counter');
  if (panelCountEl) panelCountEl.textContent = activeCount;
  if (navBadgeEl) navBadgeEl.textContent = activeCount;
}

function updateIncidentBadge() {
  const activeCount = state.activeIncidents.length;
  const panelCountEl = document.getElementById('panel-incidents-count');
  const navBadgeEl = document.getElementById('nav-alert-counter');
  if (panelCountEl) panelCountEl.textContent = activeCount;
  if (navBadgeEl) navBadgeEl.textContent = activeCount;
}

/* ============================================================================
   INCIDENT DRAWER
   ============================================================================ */

async function openIncidentDrawerById(incidentId) {
  const backdrop = document.getElementById('incident-drawer-backdrop');
  if (!backdrop) return;
  backdrop.classList.add('active');
  document.body.style.overflow = 'hidden';

  try {
    const res = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}`).then(r => r.json());
    if (res.success && res.incident) {
      renderIncidentDrawerContent(res.incident);
    } else {
      renderIncidentDrawerContent({ error: 'Incident not found' });
    }
  } catch (e) {
    renderIncidentDrawerContent({ error: 'Failed to load incident' });
  }
}

function openIncidentDrawer(alert) {
  const backdrop = document.getElementById('incident-drawer-backdrop');
  if (!backdrop) return;
  backdrop.classList.add('active');
  document.body.style.overflow = 'hidden';

  renderIncidentDrawerContent(alert);
}

function closeIncidentDrawer() {
  const backdrop = document.getElementById('incident-drawer-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('active');
  document.body.style.overflow = '';
}

function renderIncidentDrawerContent(data) {
  if (data.error) {
    const titleText = document.getElementById('incident-drawer-title-text');
    if (titleText) titleText.textContent = data.error;
    return;
  }

  const isIncident = data.incidentId != null;
  const titleText = document.getElementById('incident-drawer-title-text');
  const title = isIncident ? (data.rootCause?.message || `Incident ${data.incidentId}`) : (data.title || 'Incident Detail');
  if (titleText) titleText.textContent = title;

  const sevEl = document.getElementById('inc-severity');
  if (sevEl) {
    const sev = isIncident ? (data.currentSeverity || 'unknown') : (data.severity || 'unknown');
    sevEl.textContent = sev.toUpperCase();
    sevEl.style.color = sev === 'critical' ? 'var(--color-offline)' :
                        sev === 'warning' ? 'var(--color-warning)' : 'var(--color-online)';
  }

  const statusEl = document.getElementById('inc-status');
  if (statusEl) {
    statusEl.textContent = (isIncident ? data.status : (data.status || 'active')).toUpperCase();
  }

  const startedEl = document.getElementById('inc-started');
  const startedAt = isIncident ? data.startedAt : data.created_at;
  if (startedEl && startedAt) {
    startedEl.textContent = new Date(startedAt).toLocaleString('id-ID', { hour12: false });
  }

  const endedEl = document.getElementById('inc-ended');
  const endedAt = isIncident ? data.endedAt : data.ended_at;
  if (endedEl) {
    endedEl.textContent = endedAt ? new Date(endedAt).toLocaleString('id-ID', { hour12: false }) : '--';
  }

  const durationEl = document.getElementById('inc-duration');
  if (durationEl) {
    if (data.durationMs) {
      const secs = Math.floor(data.durationMs / 1000);
      const mins = Math.floor(secs / 60);
      const hrs = Math.floor(mins / 60);
      if (hrs > 0) durationEl.textContent = `${hrs}h ${mins % 60}m`;
      else if (mins > 0) durationEl.textContent = `${mins}m ${secs % 60}s`;
      else durationEl.textContent = `${secs}s`;
    } else {
      durationEl.textContent = '--';
    }
  }

  const deviceNameEl = document.getElementById('inc-device-name');
  if (deviceNameEl) {
    deviceNameEl.textContent = isIncident ? (data.deviceName || '--') : (data.target || '--');
  }

  const rcMessageEl = document.getElementById('inc-rc-message');
  if (rcMessageEl) rcMessageEl.textContent = title;

  const evLatencyEl = document.getElementById('inc-ev-latency');
  if (evLatencyEl) evLatencyEl.textContent = data.evidence?.maxLatency != null ? `${data.evidence.maxLatency} ms` : '--';

  const evLossEl = document.getElementById('inc-ev-packet-loss');
  if (evLossEl) evLossEl.textContent = data.evidence?.maxPacketLoss != null ? `${data.evidence.maxPacketLoss}%` : '--';

  const evInEl = document.getElementById('inc-ev-in-mbps');
  if (evInEl) evInEl.textContent = data.evidence?.maxInMbps != null ? `${data.evidence.maxInMbps.toFixed(2)} Mbps` : '--';

  const evOutEl = document.getElementById('inc-ev-out-mbps');
  if (evOutEl) evOutEl.textContent = data.evidence?.maxOutMbps != null ? `${data.evidence.maxOutMbps.toFixed(2)} Mbps` : '--';

  const timelineContainer = document.getElementById('incident-timeline');
  if (timelineContainer) {
    const history = data.statusHistory || [];
    const sevClass = { warning: 'warning', critical: 'critical', offline: 'critical', online: 'online', recovered: 'online' };

    if (history.length === 0) {
      timelineContainer.innerHTML = `
        <div class="incident-timeline-item">
          <span class="incident-timeline-dot warning"></span>
          <span class="incident-timeline-text">Incident created</span>
          <span class="incident-timeline-time">${startedAt ? new Date(startedAt).toLocaleTimeString('id-ID', { hour12: false }) : '--'}</span>
        </div>`;
    } else {
      timelineContainer.innerHTML = history.map((entry, i) => {
        const dotClass = sevClass[entry.status?.toLowerCase()] || 'warning';
        const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('id-ID', { hour12: false }) : '--';
        return `
          <div class="incident-timeline-item">
            <span class="incident-timeline-dot ${dotClass}"></span>
            <span class="incident-timeline-text">${entry.event || entry.status || 'State changed'}</span>
            <span class="incident-timeline-time">${timeStr}</span>
          </div>`;
      }).join('');
    }
  }
}

/**
 * Updates the Quick Stats panel with live operational metrics
 */
function updateQuickStats() {
  const devs = state.devices;

  // Highest latency
  const sortedByLatency = [...devs].sort((a, b) => (b.ping_latency || 0) - (a.ping_latency || 0));
  const worst = sortedByLatency[0];
  const latEl = document.getElementById('qs-highest-latency');
  const latDevEl = document.getElementById('qs-highest-latency-device');
  if (latEl) latEl.textContent = worst ? `${worst.ping_latency || '--'} ms` : '-- ms';
  if (latDevEl) latDevEl.textContent = worst ? worst.name : '--';

  // Offline count
  const offlineCount = devs.filter(d => d.status === 'offline').length;
  const offlineEl = document.getElementById('qs-offline-count');
  const offlineDevsEl = document.getElementById('qs-offline-devices');
  if (offlineEl) offlineEl.textContent = offlineCount;
  if (offlineDevsEl) {
    offlineDevsEl.textContent = offlineCount === 0
      ? 'All operational'
      : `${offlineCount} node${offlineCount > 1 ? 's' : ''} unreachable`;
  }

  // Average packet loss
  const lossValues = devs.map(d => d.packet_loss || 0).filter(v => v > 0);
  const avgLoss = lossValues.length > 0
    ? (lossValues.reduce((s, v) => s + v, 0) / lossValues.length).toFixed(1)
    : '0.0';
  const lossEl = document.getElementById('qs-avg-loss');
  const lossDetailEl = document.getElementById('qs-loss-detail');
  if (lossEl) lossEl.textContent = `${avgLoss}%`;
  if (lossDetailEl) lossDetailEl.textContent = `${lossValues.length} nodes with loss`;

  // Uptime
  const uptimeEl = document.getElementById('qs-uptime');
  const uptimeTextEl = document.getElementById('uptime-text');
  if (uptimeEl && uptimeTextEl) {
    uptimeEl.textContent = uptimeTextEl.textContent || '--';
    const pct = parseFloat(uptimeTextEl?.textContent);
    uptimeEl.style.color = !isNaN(pct) && pct >= 99 ? 'var(--online)' : (!isNaN(pct) && pct >= 95 ? 'var(--warning)' : 'var(--offline)');
  }

  // WebSocket status
  const wsEl = document.getElementById('qs-ws-status');
  const wsDetailEl = document.getElementById('qs-ws-detail');
  const pill = document.getElementById('ws-status-pill');
  if (wsEl) {
    const connected = state.ws && state.ws.readyState === WebSocket.OPEN;
    wsEl.textContent = connected ? 'Connected' : 'Disconnected';
    wsEl.style.color = connected ? 'var(--online)' : 'var(--offline)';
  }
  if (wsDetailEl) {
    const statusText = document.getElementById('ws-status-text');
    wsDetailEl.textContent = statusText ? statusText.textContent : '--';
  }

  // Telegraf status (derived from WS connection — if we have live data, Telegraf is running)
  const telegrafEl = document.getElementById('qs-telegraf-status');
  const telegrafDetailEl = document.getElementById('qs-telegraf-detail');
  const hasLiveData = devs.some(d => d.ping_latency > 0);
  if (telegrafEl) {
    telegrafEl.textContent = hasLiveData ? 'Running' : 'Stopped';
    telegrafEl.style.color = hasLiveData ? 'var(--online)' : 'var(--offline)';
  }
  if (telegrafDetailEl) {
    telegrafDetailEl.textContent = hasLiveData
      ? `${devs.filter(d => d.interfaces && d.interfaces.length > 0).length} devices polled`
      : 'No SNMP data received';
  }

  // Busiest interface — estimate from highest outData in chart
  const busiestEl = document.getElementById('qs-busiest-iface');
  const busiestDevEl = document.getElementById('qs-busiest-iface-device');
  if (busiestEl) busiestEl.textContent = state.selectedInterface || '--';
  if (busiestDevEl) {
    const selDev = devs.find(d => d.id === state.selectedDeviceId);
    busiestDevEl.textContent = selDev ? selDev.name : '--';
  }

  // Last discovery
  const lastDiscEl = document.getElementById('qs-last-discovery');
  const discCountEl = document.getElementById('qs-discovery-count');
  if (lastDiscEl) lastDiscEl.textContent = devs.length > 0 ? `${devs.length} nodes` : '--';
  if (discCountEl) discCountEl.textContent = 'Pool size';
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * Format throughput for the legend: enough decimals so small real traffic
 * (e.g. 0.006 Mbps) is not rounded to a flat "0.00".
 */
function formatMbps(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0.00';
  if (n < 0.01) return n.toFixed(4);
  if (n < 1) return n.toFixed(3);
  return n.toFixed(2);
}

/**
 * Format nilai metrik. Tampilkan placeholder (default '--') saat nilai
 * kosong/0/NaN agar tidak menyesatkan (mis. latency 0 padahal tidak ada data).
 */
function formatMetric(value, unit, placeholder = '--') {
  if (value === null || value === undefined) return placeholder;
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n === 0) return placeholder;
  return `${n} ${unit}`;
}

/**
 * Event Listeners Setup
 */
function setupEventListeners() {
  // Search Filter
  document.getElementById('device-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderDeviceGrid();
  });

  // Status Filter Pills
  document.querySelectorAll('.btn-filter').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.activeFilter = e.target.dataset.filter;
      renderDeviceGrid();
    });
  });

  // Interface Select in Chart (right Analytics Throughput)
  document.getElementById('chart-interface-select').addEventListener('change', (e) => {
    state.selectedInterface = e.target.value;
    resetTrafficBuffer();
    document.getElementById('live-in-rate').textContent = '0.00';
    document.getElementById('live-out-rate').textContent = '0.00';
    subscribeSelectedStream();
  });

  // Sidebar Right Collapse / Expand
  const sidebarRight = document.getElementById('sidebar-right');
  const btnCollapse = document.getElementById('btn-collapse-sidebar');
  const btnExpand = document.getElementById('btn-expand-sidebar');

  btnCollapse.addEventListener('click', () => {
    sidebarRight.classList.add('collapsed');
  });

  btnExpand.addEventListener('click', () => {
    sidebarRight.classList.remove('collapsed');
  });

  // Panel Tab Switching
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.panelTab;
      state.activePanelTab = tabName;
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.panel-tab-content').forEach(c => c.classList.remove('active'));
      const contentEl = document.getElementById(`panel-${tabName}`);
      if (contentEl) contentEl.classList.add('active');

      if (tabName === 'quickstats') updateQuickStats();
    if (tabName === 'incidents') renderIncidentFeed(state.incidentSearch, state.incidentSevFilter);
    if (tabName === 'alerts') renderAlertFeed(state.incidentSearch, state.incidentSevFilter);

      if (tabName === 'analytics') {
        // Charts need a visible container — resize every time the tab opens
        // so the latest sliding-window data is painted (no extra polling).
        setTimeout(() => {
          if (state.charts.traffic) state.charts.traffic.resize();
          if (state.charts.donut) state.charts.donut.resize();
        }, 80);
      }

      sessionStorage.setItem('bms_panel_tab', tabName);
    });
  });

  // Restore last active panel tab
  const savedTab = sessionStorage.getItem('bms_panel_tab');
  if (savedTab) {
    const tabBtn = document.querySelector(`.panel-tab[data-panel-tab="${savedTab}"]`);
    if (tabBtn) tabBtn.click();
  }

  // Incident Search in Panel
  const incidentSearchInput = document.getElementById('incident-search');
  if (incidentSearchInput) {
    incidentSearchInput.addEventListener('input', (e) => {
      state.incidentSearch = e.target.value;
      renderIncidentFeed(state.incidentSearch, state.incidentSevFilter);
    });
  }

  // Severity Filter in Panel
  document.querySelectorAll('.sev-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sev-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.incidentSevFilter = btn.dataset.sev;
      renderIncidentFeed(state.incidentSearch, state.incidentSevFilter);
    });
  });

  // View Full Incident Log — navigate to Alerts page
  const linkViewAll = document.getElementById('link-view-all-alerts');
  if (linkViewAll) {
    linkViewAll.addEventListener('click', (e) => {
      e.preventDefault();
      const alertsNav = document.getElementById('nav-alerts');
      if (alertsNav) alertsNav.click();
      sidebarRight.classList.add('collapsed');
    });
  }

  // Add Device Modal
  const modalDevice = document.getElementById('modal-device');
  document.getElementById('btn-open-add-device').addEventListener('click', () => {
    modalDevice.classList.add('active');
  });

  document.getElementById('modal-device-close').addEventListener('click', () => {
    modalDevice.classList.remove('active');
  });

  // Edit Device Modal
  document.getElementById('modal-edit-close')?.addEventListener('click', () => {
    document.getElementById('modal-device-edit').classList.remove('active');
  });
  document.getElementById('btn-edit-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-device-edit').classList.remove('active');
  });
  document.getElementById('btn-save-edit')?.addEventListener('click', window.saveEditDevice);

  // Test Connection in Modal
  document.getElementById('btn-test-connection').addEventListener('click', async () => {
    const ip = document.getElementById('input-dev-ip').value.trim();
    const resBox = document.getElementById('test-connection-result');
    if (!ip) {
      alert('Please enter an IP address first');
      return;
    }

    resBox.style.display = 'block';
    resBox.style.background = 'rgba(37, 150, 190, 0.1)';
    resBox.style.color = '#2596BE';
    resBox.textContent = 'Testing ICMP ping and SNMP Table query...';

    try {
      const res = await fetch('/api/devices/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip_address: ip })
      }).then(r => r.json());

      if (res.success) {
        resBox.style.background = 'rgba(16, 185, 129, 0.15)';
        resBox.style.color = '#10b981';
        resBox.innerHTML = `✅ Ping OK (${res.ping.latency_ms} ms, ${res.ping.loss}) | SNMP: ${res.snmp.sysDescr}`;
      }
    } catch (err) {
      resBox.style.background = 'rgba(239, 68, 68, 0.15)';
      resBox.style.color = '#ef4444';
      resBox.textContent = 'Connection test failed: ' + err.message;
    }
  });

  // Save Device
  document.getElementById('btn-save-device').addEventListener('click', async () => {
    const name = document.getElementById('input-dev-name').value.trim();
    const ip = document.getElementById('input-dev-ip').value.trim();
    const type = document.getElementById('input-dev-type').value;
    const community = document.getElementById('input-dev-community').value.trim();
    const port = document.getElementById('input-dev-port').value;
    const interval = document.getElementById('input-dev-interval').value;

    if (!name || !ip) {
      alert('Device Name and IP are required.');
      return;
    }

    try {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          ip_address: ip,
          device_type: type,
          snmp_community: community,
          snmp_port: port,
          polling_interval: interval
        })
      }).then(r => r.json());

      if (res.success) {
        modalDevice.classList.remove('active');
        // Push device baru ke state dengan fallback untuk field yang tidak ada
        const newDev = res.device || {};
        // Normalisasi field supaya formatMetric() tidak menampilkan "0" misleading
        if (newDev.ping_latency === undefined) newDev.ping_latency = null;
        if (newDev.packet_loss === undefined) newDev.packet_loss = null;
        if (!newDev.interfaces) newDev.interfaces = [];
        state.devices.push(newDev);
        renderDeviceGrid();
        updateDonutChart();
        refreshKpiCounters();

        // Auto-select device baru & subscribe WS supaya tick langsung masuk
        selectDevice(newDev.id);

        // Regenerate SEMUA telegraf config + cleanup orphan
        // agar device baru langsung di-poll dan device lama yang dihapus tidak menuhin folder
        fetch('/api/telegraf/regenerate-all', { method: 'POST' })
          .then(r => r.json())
          .then(regen => {
            console.log('[Add Device] Telegraf regenerate-all:', regen.message);
          })
          .catch(e => console.warn('[Add Device] regenerate-all error:', e.message));

        // Reload penuh dari API setelah 3s (Telegraf butuh waktu untuk mulai poll
        // setelah regenerate config + SIGHUP, plus SNMP walk pertama agak lambat)
        setTimeout(() => {
          loadInitialData();
        }, 3000);

        // Also reload topology if user is on map view (backend triggers discovery on add)
        setTimeout(() => {
          if (document.getElementById('topology-canvas')) {
            loadTopology(true);
          }
        }, 5000);

        // Tampilkan info progress ke user, bukan alert yg langsung hilang
        const infoBox = document.getElementById('test-connection-result');
        if (infoBox) {
          infoBox.style.display = 'block';
          infoBox.style.background = 'rgba(16,185,129,0.15)';
          infoBox.style.color = '#10b981';
          infoBox.textContent = `Device ${name} ditambahkan. Telegraf config ter-regenerate. Data telemetri akan muncul dalam 2-5 detik...`;
          // Auto-hide info box after 5s
          setTimeout(() => { infoBox.style.display = 'none'; }, 6000);
        }

        // Reset form untuk pemakaian berikutnya
        document.getElementById('input-dev-name').value = '';
        document.getElementById('input-dev-ip').value = '';
        document.getElementById('input-dev-community').value = 'public';
        document.getElementById('input-dev-port').value = '161';
        document.getElementById('input-dev-interval').value = '1';
      } else {
        alert('Failed to save device: ' + res.error);
      }
    } catch (err) {
      alert('Error saving device: ' + err.message);
    }
  });

  // Left Sidebar Navigation switching
  setupNavNavigation();

  // Device Deep-Dive panel close handlers
  document.getElementById('btn-device-detail-close')?.addEventListener('click', closeDeviceDetail);
  document.getElementById('btn-device-detail-x')?.addEventListener('click', closeDeviceDetail);

  // Detail interface selector → re-point the WS stream to the new interface.
  // The shared buffer is cleared so data from the previous interface never
  // mixes with the new one; the first live tick repaints it (~1s).
  document.getElementById('detail-interface-select')?.addEventListener('change', (e) => {
    const iface = e.target && e.target.value;
    if (!iface) return;
    state.selectedInterface = iface;
    // Mirror the choice in the right Analytics dropdown (same data source).
    const dashSel = document.getElementById('chart-interface-select');
    if (dashSel) {
      const optExists = Array.from(dashSel.options).some(o => o.value === iface);
      if (optExists) dashSel.value = iface;
    }
    resetTrafficBuffer();
    subscribeSelectedStream();
    if (state.detailData) updateDetailCharts(state.detailData);
  });

  // Incident Drawer close handlers
  document.getElementById('incident-drawer-close')?.addEventListener('click', closeIncidentDrawer);
  document.getElementById('incident-drawer-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'incident-drawer-backdrop') closeIncidentDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const backdrop = document.getElementById('incident-drawer-backdrop');
      if (backdrop && backdrop.classList.contains('active')) closeIncidentDrawer();
    }
  });
}

/**
 * Manages tab switching between Dashboard, Devices, Map, Alerts, Reports, and Settings
 */
function setupNavNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const dashboardPanel = document.getElementById('dashboard-view-panel');
  const otherPanel = document.getElementById('other-view-panel');
  const viewTitle = document.getElementById('view-title');
  const viewSubtitle = document.getElementById('view-subtitle');

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      navItems.forEach(i => i.classList.remove('active'));
      const target = e.currentTarget;
      target.classList.add('active');

      const view = target.dataset.view;

      // Stop topology auto-refresh when leaving map tab
      if (view !== 'map' && state.topologyRefreshTimer) {
        clearInterval(state.topologyRefreshTimer);
        state.topologyRefreshTimer = null;
      }

      if (view === 'dashboard') {
        dashboardPanel.style.display = 'flex';
        otherPanel.style.display = 'none';
        viewTitle.textContent = 'Network Operations Center Overview';
        viewSubtitle.textContent = 'Dynamic multi-router telemetry stream & auto-discovery matrix (1s resolution)';
      } else {
        dashboardPanel.style.display = 'none';
        otherPanel.style.display = 'flex';
        renderSecondaryView(view, otherPanel, viewTitle, viewSubtitle);

        // Start topology auto-refresh when entering map tab (every 60s)
        if (view === 'map') {
          if (state.topologyRefreshTimer) clearInterval(state.topologyRefreshTimer);
          state.topologyRefreshTimer = setInterval(() => {
            if (document.getElementById('topology-canvas')) {
              loadTopology(true); // force re-render
            } else {
              clearInterval(state.topologyRefreshTimer);
              state.topologyRefreshTimer = null;
            }
          }, 60000); // 60 detik
        }
      }
    });
  });
}

/**
 * Renders the Alerts page table with search, severity filter, duration, and acknowledge.
 */
function renderAlertsPageTable(searchQuery = '', sevFilter = 'all') {
  const tbody = document.getElementById('alerts-page-tbody');
  if (!tbody) return;

  const allIncidents = [...state.activeIncidents, ...state.incidentHistory];
  const q = searchQuery.toLowerCase();
  const filtered = allIncidents.filter(a => {
    const matchSev = sevFilter === 'all' || a.currentSeverity === sevFilter;
    const matchSearch = !q || ((a.deviceName || '') + ' ' + (a.incidentId || '') + ' ' + (a.rootCause?.message || '')).toLowerCase().includes(q);
    return matchSev && matchSearch;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="alerts-empty">No incidents match your filter</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(a => {
    const sevClass = a.currentSeverity || 'info';
    const startTime = new Date(a.startedAt);
    const duration = a.durationMs
      ? formatDuration(a.durationMs)
      : getDuration(startTime);
    const status = a.status || 'active';
    const statusClass = status === 'resolved' ? 'resolved' : 'active';

    return `
      <tr data-incident-id="${a.incidentId}" style="cursor:pointer;">
        <td>
          <span class="alert-severity-badge ${sevClass}">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;"></span>
            ${(a.currentSeverity || 'info').toUpperCase()}
          </span>
        </td>
        <td class="alert-title-cell">
          ${a.rootCause?.message || 'Incident'}
          <span>${a.deviceName || ''}</span>
        </td>
        <td class="alert-device-cell">${a.deviceName || '--'}</td>
        <td class="alert-time-cell">${startTime.toLocaleString('id-ID', { hour12: false })}</td>
        <td class="alert-duration-cell">${duration}</td>
        <td class="alert-status-cell">
          <span class="alert-status-pill ${statusClass}">${status}</span>
        </td>
        <td class="alert-actions-cell">
          <button class="btn-ack" disabled>
            --
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr[data-incident-id]').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.incidentId;
      if (id) openIncidentDrawerById(id);
    });
  });
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '--';
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function getDuration(startTime) {
  const diff = Date.now() - startTime.getTime();
  if (diff < 0) return '--';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function acknowledgeAlert(id) {
  const idx = state.alerts.findIndex(a => a.id === id);
  if (idx !== -1) {
    state.alerts[idx].status = 'acknowledged';
    state.alerts[idx].acknowledged_at = new Date().toISOString();
  }
  const searchInput = document.getElementById('alerts-page-search-input');
  const activeBtn = document.querySelector('.alerts-page-filter .active');
  renderAlertsPageTable(searchInput?.value || '', activeBtn?.dataset.alertsSev || 'all');
}

function renderSecondaryView(view, container, titleEl, subtitleEl) {
  if (view === 'devices') {
    titleEl.textContent = 'Device Inventory & Telegraf Config Manager';
    subtitleEl.textContent = 'Manage device pool, SNMP credentials, and auto-generated Telegraf configurations';
    container.innerHTML = `
      <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h3 style="font-family:var(--font-display);">Registered Target Pool</h3>
          <button class="btn-action" onclick="document.getElementById('modal-device').classList.add('active')">+ Add Device</button>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem; text-align:left;">
          <thead>
            <tr style="border-bottom:1px solid var(--border-subtle); color:var(--text-muted);">
              <th style="padding:10px;">Name</th>
              <th>IP Address</th>
              <th>Type</th>
              <th>SNMP</th>
              <th>Interval</th>
              <th>Status</th>
              <th style="text-align:right; padding-right:10px;">Action</th>
            </tr>
          </thead>
          <tbody>
            ${state.devices.map(d => `
              <tr style="border-bottom:1px solid var(--border-subtle);">
                <td style="padding:12px 10px; font-weight:600;">${d.name}</td>
                <td style="font-family:var(--font-mono); color:var(--text-muted);">${d.ip_address}</td>
                <td>${d.device_type}</td>
                <td>v${d.snmp_version || '2c'} (${d.snmp_community})</td>
                <td>${d.polling_interval}s</td>
                <td><span class="status-dot ${d.status}" style="display:inline-block; margin-right:4px;"></span>${d.status}</td>
                <td style="text-align:right; padding-right:10px;">
                  <button style="background:rgba(37,150,190,0.15); border:1px solid var(--color-brand); color:var(--color-brand); border-radius:4px; padding:4px 10px; font-size:0.72rem; cursor:pointer; margin-right:6px; font-weight:600;" onclick="openEditDeviceModal(${d.id})">✎ Edit</button>
                  <button style="background:rgba(239,68,68,0.2); border:1px solid var(--color-offline); color:var(--color-offline); border-radius:4px; padding:4px 10px; font-size:0.72rem; cursor:pointer; font-weight:600;" onclick="deleteDevice(${d.id})">Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else if (view === 'map') {
    titleEl.textContent = 'Interactive Network Topology Map';
    subtitleEl.textContent = 'LLDP/CDP/MNDP-discovered nodes and connectivity edges';
    container.innerHTML = `
      <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:8px;">
          <div>
            <h3 style="font-family:var(--font-display); font-size:1.05rem; margin:0;">Network Topology Graph</h3>
            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px;" id="topology-stats-text">Loading topology...</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <div class="topology-legend" style="display:flex; gap:12px; font-size:0.7rem; color:var(--text-muted);">
              <span><span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#10b981; margin-right:4px;"></span>Online</span>
              <span><span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#f59e0b; margin-right:4px;"></span>Warning</span>
              <span><span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#ef4444; margin-right:4px;"></span>Offline</span>
              <span><span style="display:inline-block; width:10px; height:10px; border:2px dashed #64748b; background:transparent; margin-right:4px;"></span>Unmanaged</span>
            </div>
            <button class="btn-secondary" id="btn-topology-rescan" style="font-size:0.75rem;">Rescan</button>
          </div>
        </div>
        <div id="topology-canvas" style="width:100%; height:600px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-base); position:relative;">
          <div id="topology-empty" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--text-muted);">
            <div style="font-size:1.1rem; margin-bottom:8px;">No topology data yet</div>
            <div style="font-size:0.85rem;">Click <strong>Rescan</strong> to discover LLDP/CDP neighbors from your devices.</div>
            <div style="font-size:0.75rem; margin-top:12px; opacity:0.7;">Make sure LLDP daemon is enabled on devices (Mikrotik: /ip neighbor discovery-settings; Linux: install lldpd)</div>
          </div>
        </div>
      </div>
    `;
    // Load topology after DOM is ready
    setTimeout(() => loadTopology(), 50);
    // Wire rescan button
    setTimeout(() => {
      const rescanBtn = document.getElementById('btn-topology-rescan');
      if (rescanBtn) rescanBtn.addEventListener('click', handleRescanTopology);
    }, 60);
  } else if (view === 'alerts') {
    titleEl.textContent = 'Incident Auditing & Alarm Center';
    subtitleEl.textContent = 'Historical log of network anomalies, packet loss degradation, and link flaps';
    container.innerHTML = `
      <div class="alerts-page-toolbar">
        <div class="alerts-page-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" id="alerts-page-search-input" placeholder="Search incidents...">
        </div>
        <div class="alerts-page-filter btn-filter-group">
          <button class="btn-filter active" data-alerts-sev="all">All</button>
          <button class="btn-filter" data-alerts-sev="critical">Critical</button>
          <button class="btn-filter" data-alerts-sev="warning">Warning</button>
          <button class="btn-filter" data-alerts-sev="info">Info</button>
        </div>
      </div>
      <div class="alerts-table-wrap">
        <table class="alerts-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Incident / Target</th>
              <th>Node</th>
              <th>First Seen</th>
              <th>Duration</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="alerts-page-tbody">
          </tbody>
        </table>
      </div>
    `;

    // Wire search and severity filter
    setTimeout(() => {
      const searchInput = document.getElementById('alerts-page-search-input');
      if (searchInput) {
        searchInput.addEventListener('input', () => renderAlertsPageTable(searchInput.value, document.querySelector('.alerts-page-filter .active')?.dataset.alertsSev || 'all'));
      }
      document.querySelectorAll('.alerts-page-filter .btn-filter').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.alerts-page-filter .btn-filter').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          renderAlertsPageTable(searchInput?.value || '', btn.dataset.alertsSev);
        });
      });
      renderAlertsPageTable('', 'all');
    }, 0);
  } else if (view === 'reports') {
    titleEl.textContent = 'Performance & Availability Reports';
    subtitleEl.textContent = 'Monthly SLA metrics, availability scores, and exportable traffic summaries';
    container.innerHTML = `
      <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:24px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
          <div>
            <h3 style="font-family:var(--font-display);">30-Day SLA Availability: <span id="reports-sla-text" style="color:var(--color-online);">--</span></h3>
            <p style="font-size:0.8rem; color:var(--text-muted);" id="reports-source">Aggregated from PostgreSQL daily_uptime table</p>
          </div>
          <button class="btn-action" onclick="exportSlaCsv()">Export CSV Report</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
          <div style="background:var(--bg-surface-elevated); padding:16px; border-radius:8px;">
            <div style="font-size:0.75rem; color:var(--text-muted);">Total Ingestion Points (24h)</div>
            <div style="font-size:1.4rem; font-weight:700; font-family:var(--font-display); color:var(--color-brand); margin-top:4px;" id="reports-ingestion">--</div>
            <div style="font-size:0.65rem; color:var(--text-muted); margin-top:4px;" id="reports-ingestion-src">loading…</div>
          </div>
          <div style="background:var(--bg-surface-elevated); padding:16px; border-radius:8px;">
            <div style="font-size:0.75rem; color:var(--text-muted);">Average Latency Across Pool</div>
            <div style="font-size:1.4rem; font-weight:700; font-family:var(--font-display); color:var(--color-online); margin-top:4px;" id="reports-avg-latency">--</div>
            <div style="font-size:0.65rem; color:var(--text-muted); margin-top:4px;" id="reports-latency-src">loading…</div>
          </div>
          <div style="background:var(--bg-surface-elevated); padding:16px; border-radius:8px;">
            <div style="font-size:0.75rem; color:var(--text-muted);">Cumulative Packet Loss</div>
            <div style="font-size:1.4rem; font-weight:700; font-family:var(--font-display); color:var(--color-warning); margin-top:4px;" id="reports-avg-loss">--</div>
            <div style="font-size:0.65rem; color:var(--text-muted); margin-top:4px;" id="reports-loss-src">loading…</div>
          </div>
        </div>

        <h4 style="font-family:var(--font-display); margin:24px 0 12px;">Daily Uptime Breakdown (30 Days)</h4>
        <div id="reports-daily-table" style="max-height:340px; overflow-y:auto; border:1px solid var(--border-subtle); border-radius:8px;">
          <div style="padding:20px; text-align:center; color:var(--text-muted);">Loading historical data…</div>
        </div>
      </div>
    `;
    loadReportsData();
  } else if (view === 'settings') {
    titleEl.textContent = 'System & InfluxDB Configuration';
    subtitleEl.textContent = 'Dynamic Time-Series Database parameters, tokens, and Telegraf poller settings';

    // Initial loading state
    container.innerHTML = `
      <div id="influx-status-card" style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:20px; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="font-family:var(--font-display); font-size:0.95rem;">InfluxDB Connectivity</h3>
          <span id="influx-badge" style="font-size:0.75rem; padding:3px 8px; border-radius:6px; background:rgba(100,100,100,0.15); color:var(--text-muted);">Checking...</span>
        </div>
        <div id="influx-details" style="font-size:0.78rem; color:var(--text-secondary); line-height:1.6;">
          <div>URL: <span id="influx-url">--</span></div>
          <div>Org: <span id="influx-org">--</span> | Bucket: <span id="influx-bucket">--</span></div>
          <div>Token: <span id="influx-token-status">--</span></div>
        </div>
        <div style="display:flex; gap:8px; margin-top:14px;">
          <button class="btn-secondary" onclick="testInfluxConnection()">Test Connection</button>
        </div>
        <div id="influx-hint" style="margin-top:12px; padding:10px; border-radius:6px; font-size:0.75rem; display:none;"></div>
      </div>

      <div id="telegraf-status-card" style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:20px; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="font-family:var(--font-display); font-size:0.95rem;">Telegraf Agent Status</h3>
          <span id="telegraf-badge" style="font-size:0.75rem; padding:3px 8px; border-radius:6px; background:rgba(100,100,100,0.15); color:var(--text-muted);">Checking...</span>
        </div>
        <div id="telegraf-details" style="font-size:0.78rem; color:var(--text-secondary); line-height:1.6;">
          <div>Real PID: <span id="telegraf-pid">--</span></div>
          <div>Config Dir: <span id="telegraf-confdir">--</span></div>
          <div>Last Log: <pre id="telegraf-log" style="background:var(--bg-base); padding:8px; border-radius:4px; font-size:0.7rem; max-height:120px; overflow:auto; margin-top:6px;">--</pre></div>
        </div>
        <div style="display:flex; gap:8px; margin-top:14px;">
          <button class="btn-secondary" onclick="regenerateTelegrafConfigs()">Regenerate All Configs</button>
          <button class="btn-action" onclick="window.open('scripts-not-applicable','_self')" id="telegraf-restart-hint" style="font-size:0.75rem;">View Restart Instructions</button>
        </div>
        <div id="telegraf-hint" style="margin-top:12px; padding:10px; border-radius:6px; font-size:0.75rem; display:none;"></div>
      </div>

      <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:24px; max-width:640px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
          <h3 style="font-family:var(--font-display);">Time-Series Database (InfluxDB v2)</h3>
          <span id="cfg-db-status-badge" style="font-size:0.75rem; padding:3px 8px; border-radius:6px; background:rgba(16,185,129,0.15); color:var(--color-online);">Checking DB...</span>
        </div>

        <div class="form-group" style="margin-bottom:12px;">
          <label>InfluxDB URL (Host &amp; Port)</label>
          <input type="text" id="cfg-influx-url" class="form-control" value="">
        </div>

        <div class="form-group" style="margin-bottom:12px;">
          <label>API Auth Token</label>
          <input type="password" id="cfg-influx-token" class="form-control" value="" autocomplete="off">
          <small id="cfg-influx-token-hint" style="display:none; margin-top:4px; font-size:0.7rem; color:var(--text-muted);"></small>
        </div>

        <div class="form-row" style="margin-bottom:12px;">
          <div class="form-group">
            <label>Organization</label>
            <input type="text" id="cfg-influx-org" class="form-control" value="">
          </div>
          <div class="form-group">
            <label>Bucket</label>
            <input type="text" id="cfg-influx-bucket" class="form-control" value="">
          </div>
        </div>

        <div class="form-group" style="margin-bottom:20px;">
          <label>Telegraf Config Directory</label>
          <input type="text" id="cfg-telegraf-dir" class="form-control" value="">
        </div>

        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button class="btn-secondary" onclick="testInfluxConnection()">Test InfluxDB Connection</button>
          <button class="btn-action" onclick="saveSettings()">Save Settings</button>
        </div>
        <div id="settings-result" style="margin-top:14px; font-size:0.8rem; display:none; padding:10px; border-radius:6px;"></div>
      </div>
    `;

    // Fetch real settings from backend API
    fetch('/api/settings')
      .then(r => r.json())
      .then(res => {
        if (res.success && res.settings) {
          document.getElementById('cfg-influx-url').value = res.settings.INFLUX_URL || 'http://127.0.0.1:8086';
          // Phase 1: the backend never returns the real token; it sends the
          // sentinel '__KEEP_CURRENT__' when a token is loaded. Leave the
          // field empty and add a helper hint to show a masked value.
          const tokenField = document.getElementById('cfg-influx-token');
          const tokenHint = document.getElementById('cfg-influx-token-hint');
          if (tokenField) {
            tokenField.value = '';
            tokenField.placeholder = res.settings.INFLUX_TOKEN === '__KEEP_CURRENT__'
              ? 'Leave empty to keep current token'
              : 'Paste new token to set / rotate';
          }
          if (tokenHint) {
            const len = res.settings.INFLUX_TOKEN_LENGTH;
            if (res.settings.INFLUX_TOKEN === '__KEEP_CURRENT__' && len) {
              tokenHint.textContent = 'A token is currently loaded (' + len + ' characters). Leave the field empty to keep it, or paste a new value to rotate.';
              tokenHint.style.display = 'block';
            } else {
              tokenHint.textContent = 'No token configured yet. Paste a token to enable InfluxDB connectivity.';
              tokenHint.style.display = 'block';
            }
          }
          document.getElementById('cfg-influx-org').value = res.settings.INFLUX_ORG || 'itnetmon';
          document.getElementById('cfg-influx-bucket').value = res.settings.INFLUX_BUCKET || 'itnetmon_metrics';
          document.getElementById('cfg-telegraf-dir').value = res.settings.TELEGRAF_CONF_DIR || './telegraf.d';
          
          const dbBadge = document.getElementById('cfg-db-status-badge');
          if (dbBadge) {
            dbBadge.textContent = res.db_status || 'PostgreSQL Active';
          }
        }
      })
      .catch(e => console.error('Failed to load settings:', e));

    // Load Telegraf agent status
    loadTelegrafStatus();
    // Load InfluxDB connectivity status
    loadInfluxStatus();
  } else if (view === 'activity') {
    titleEl.textContent = 'Activity Log';
    subtitleEl.textContent = 'Real-time device event stream from polling agents';
    container.innerHTML = `
      <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:16px;">
        <div class="alerts-page-toolbar" style="margin-bottom:12px;">
          <div class="alerts-page-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            <input type="text" id="activity-search-input" placeholder="Search events...">
          </div>
          <div style="display:flex; gap:8px;">
            <select id="activity-severity-filter" style="background:var(--bg-surface-elevated); border:1px solid var(--border-subtle); border-radius:6px; padding:4px 8px; font-size:0.75rem; color:var(--text-primary);">
              <option value="all">All Severity</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
            <select id="activity-device-filter" style="background:var(--bg-surface-elevated); border:1px solid var(--border-subtle); border-radius:6px; padding:4px 8px; font-size:0.75rem; color:var(--text-primary);">
              <option value="all">All Devices</option>
            </select>
          </div>
        </div>
        <div class="alerts-table-wrap" style="max-height:calc(100vh - 280px);">
          <table class="alerts-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Device</th>
                <th>Event</th>
                <th>Severity</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody id="activity-tbody">
              <tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted);">Loading activity...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    setTimeout(() => {
      const searchInput = document.getElementById('activity-search-input');
      const sevFilter = document.getElementById('activity-severity-filter');
      const deviceFilter = document.getElementById('activity-device-filter');

      if (searchInput) {
        searchInput.addEventListener('input', () => loadActivityEvents(deviceFilter?.value || 'all', sevFilter?.value || 'all', searchInput.value));
      }
      if (sevFilter) {
        sevFilter.addEventListener('change', () => loadActivityEvents(deviceFilter?.value || 'all', sevFilter.value, searchInput?.value || ''));
      }
      if (deviceFilter) {
        deviceFilter.addEventListener('change', () => loadActivityEvents(deviceFilter.value, sevFilter?.value || 'all', searchInput?.value || ''));
        const devs = state.devices || [];
        deviceFilter.innerHTML = '<option value="all">All Devices</option>' + devs.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
      }

      loadActivityEvents('all', 'all', '');
    }, 0);
  }
}

/**
 * Diagnose InfluxDB connectivity & token validity, update Settings view
 */
async function loadInfluxStatus() {
  const badge = document.getElementById('influx-badge');
  const urlEl = document.getElementById('influx-url');
  const orgEl = document.getElementById('influx-org');
  const bucketEl = document.getElementById('influx-bucket');
  const tokenEl = document.getElementById('influx-token-status');
  const hintEl = document.getElementById('influx-hint');

  try {
    // 1. Get current settings
    const settings = await fetch('/api/settings').then(r => r.json());
    if (settings.success) {
      if (urlEl) urlEl.textContent = settings.settings.INFLUX_URL || '?';
      if (orgEl) orgEl.textContent = settings.settings.INFLUX_ORG || '?';
      if (bucketEl) bucketEl.textContent = settings.settings.INFLUX_BUCKET || '?';
    }

    // 2. Test connection (sends real write to bucket)
    const test = await fetch('/api/settings/test-influx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings.settings || {})
    }).then(r => r.json());

    if (test.success) {
      if (badge) {
        badge.style.background = 'rgba(16,185,129,0.15)';
        badge.style.color = 'var(--color-online)';
        badge.textContent = 'CONNECTED';
      }
      if (tokenEl) {
        tokenEl.innerHTML = '<span style="color:var(--color-online);">Valid (read + write OK)</span>';
      }
      if (hintEl) hintEl.style.display = 'none';
    } else {
      if (badge) {
        badge.style.background = 'rgba(239,68,68,0.15)';
        badge.style.color = 'var(--color-offline)';
        badge.textContent = 'NOT CONNECTED';
      }
      if (tokenEl) {
        tokenEl.innerHTML = `<span style="color:var(--color-offline);">Invalid or unauthorized</span>`;
      }
      if (hintEl) {
        hintEl.style.display = 'block';
        hintEl.style.background = 'rgba(239,68,68,0.08)';
        hintEl.style.color = 'var(--color-offline)';
        hintEl.style.border = '1px solid rgba(239,68,68,0.3)';
        hintEl.innerHTML = `<b>InfluxDB tidak bisa diakses dengan token saat ini.</b><br><br>Error: <code style="color:var(--color-warning);">${test.message || 'unknown'}</code><br><br>Cara fix (jalankan di terminal TTY dengan sudo):<br><code style="display:block; background:var(--bg-base); padding:8px; margin-top:6px; border-radius:4px; color:var(--color-brand);">cd /home/urzection/Documents/it-monitoring<br>./scripts/reset-influxdb.sh</code><br>Script ini akan:<br>1. Stop InfluxDB & backup data lama<br>2. Hapus token lama & create setup baru<br>3. Generate token baru & update ke <code>.env</code><br>4. Auto-restart InfluxDB<br><br><b>PERHATIAN:</b> Semua time-series data historis akan HILANG (tapi device & alert history tetap aman di PostgreSQL).`;
      }
    }
  } catch (e) {
    if (badge) {
      badge.style.background = 'rgba(239,68,68,0.15)';
      badge.style.color = 'var(--color-offline)';
      badge.textContent = 'ERROR';
    }
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.style.background = 'rgba(239,68,68,0.08)';
      hintEl.style.color = 'var(--color-offline)';
      hintEl.textContent = 'Error: ' + e.message;
    }
  }
}

window.loadInfluxStatus = loadInfluxStatus;

/**
 * Load Telegraf agent status dari /api/telegraf/status dan update UI Settings view
 */
async function loadTelegrafStatus() {
  try {
    const res = await fetch('/api/telegraf/status').then(r => r.json());
    if (!res || !res.success) return;

    const badge = document.getElementById('telegraf-badge');
    const pidEl = document.getElementById('telegraf-pid');
    const confdirEl = document.getElementById('telegraf-confdir');
    const logEl = document.getElementById('telegraf-log');
    const hintEl = document.getElementById('telegraf-hint');

    if (badge) {
      if (res.is_running) {
        badge.style.background = 'rgba(16,185,129,0.15)';
        badge.style.color = 'var(--color-online)';
        badge.textContent = 'RUNNING';
      } else {
        badge.style.background = 'rgba(239,68,68,0.15)';
        badge.style.color = 'var(--color-offline)';
        badge.textContent = 'NOT RUNNING';
      }
    }
    if (pidEl) pidEl.textContent = res.real_pid || '(none)';
    if (confdirEl) {
      const cfgs = (res.config_files || []).map(f => f.name).join(', ');
      confdirEl.textContent = res.config_dir + (cfgs ? ' — files: ' + cfgs : '');
    }
    if (logEl) logEl.textContent = (res.last_log || []).join('\n') || '(no log)';

    if (hintEl) {
      if (!res.is_running) {
        hintEl.style.display = 'block';
        hintEl.style.background = 'rgba(239,68,68,0.08)';
        hintEl.style.color = 'var(--color-offline)';
        hintEl.style.border = '1px solid rgba(239,68,68,0.3)';
        hintEl.innerHTML = '<b>Telegraf agent TIDAK berjalan.</b> Interface & throughput tidak akan masuk ke InfluxDB sampai agent distart.<br><br>Cara start (di terminal TTY):<br><code style="display:block; background:var(--bg-base); padding:8px; margin-top:6px; border-radius:4px; color:var(--color-brand);">cd /home/urzection/Documents/it-monitoring<br>./scripts/restart-telegraf.sh</code>';
      } else {
        hintEl.style.display = 'none';
      }
    }
  } catch (e) {
    console.error('loadTelegrafStatus error:', e);
  }
}

window.loadTelegrafStatus = loadTelegrafStatus;

window.regenerateTelegrafConfigs = async function() {
  const hintEl = document.getElementById('telegraf-hint');
  try {
    const res = await fetch('/api/telegraf/regenerate-all', { method: 'POST' }).then(r => r.json());
    if (res.success) {
      if (hintEl) {
        hintEl.style.display = 'block';
        hintEl.style.background = 'rgba(16,185,129,0.15)';
        hintEl.style.color = 'var(--color-online)';
        hintEl.style.border = '1px solid rgba(16,185,129,0.3)';
        hintEl.innerHTML = `<b>${res.message}</b><br>Generated: ${(res.generated||[]).map(g => g.name).join(', ') || 'none'}<br>Orphans removed: ${res.orphans_removed}<br>Telegraf PIDs: ${(res.telegraf_pids||[]).join(', ') || 'NONE'}<br><br>${res.telegraf_pids && res.telegraf_pids.length ? 'Telegraf masih running. Data akan masuk dalam 5-10 detik.' : 'Telegraf tidak jalan. Jalankan ./scripts/restart-telegraf.sh'}`;
      }
    } else {
      if (hintEl) {
        hintEl.style.display = 'block';
        hintEl.style.background = 'rgba(239,68,68,0.15)';
        hintEl.style.color = 'var(--color-offline)';
        hintEl.textContent = 'Regenerate failed: ' + (res.error || 'unknown');
      }
    }
  } catch (e) {
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.style.background = 'rgba(239,68,68,0.15)';
      hintEl.style.color = 'var(--color-offline)';
      hintEl.textContent = 'Error: ' + e.message;
    }
  }
};

// Global helper for delete
window.deleteDevice = async function(id) {
  if (!confirm(`Are you sure you want to delete device ${id}? This will also delete its Telegraf configuration.`)) return;
  try {
    const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (res.success) {
      state.devices = state.devices.filter(d => d.id !== id);
      renderDeviceGrid();
      updateDonutChart();
      // If currently on devices tab, re-render
      const devNav = document.getElementById('nav-devices');
      if (devNav.classList.contains('active')) {
        renderSecondaryView('devices', document.getElementById('other-view-panel'), document.getElementById('view-title'), document.getElementById('view-subtitle'));
      }
    }
  } catch (e) {
    alert('Delete error: ' + e.message);
  }
};

/**
 * Opens the Edit Device modal & pre-fills form with current values
 */
window.openEditDeviceModal = function(id) {
  const dev = state.devices.find(d => d.id === id);
  if (!dev) {
    alert('Device not found in local state');
    return;
  }
  document.getElementById('edit-dev-id').value = dev.id;
  document.getElementById('edit-dev-name').value = dev.name || '';
  document.getElementById('edit-dev-ip').value = dev.ip_address || '';
  document.getElementById('edit-dev-type').value = dev.device_type || 'router';
  document.getElementById('edit-dev-community').value = dev.snmp_community || 'public';
  document.getElementById('edit-dev-port').value = dev.snmp_port || 161;
  document.getElementById('edit-dev-interval').value = String(dev.polling_interval || 1);
  document.getElementById('modal-edit-title').textContent = `Edit Device: ${dev.name}`;
  const resBox = document.getElementById('edit-result');
  resBox.style.display = 'none';
  resBox.textContent = '';
  document.getElementById('modal-device-edit').classList.add('active');
};

/**
 * Save Edit - PATCH/PUT device, refresh grid + table
 */
window.saveEditDevice = async function() {
  const id = parseInt(document.getElementById('edit-dev-id').value, 10);
  const name = document.getElementById('edit-dev-name').value.trim();
  const ip = document.getElementById('edit-dev-ip').value.trim();
  const type = document.getElementById('edit-dev-type').value;
  const community = document.getElementById('edit-dev-community').value.trim();
  const port = document.getElementById('edit-dev-port').value;
  const interval = document.getElementById('edit-dev-interval').value;

  if (!name || !ip) {
    alert('Device Name and IP are required.');
    return;
  }

  const resBox = document.getElementById('edit-result');
  resBox.style.display = 'block';
  resBox.style.background = 'rgba(37,150,190,0.1)';
  resBox.style.color = '#2596BE';
  resBox.textContent = 'Updating device & regenerating Telegraf config...';

  try {
    const res = await fetch(`/api/devices/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, ip_address: ip, device_type: type,
        snmp_community: community, snmp_port: port, polling_interval: interval
      })
    }).then(r => r.json());

    if (res.success) {
      resBox.style.background = 'rgba(16,185,129,0.15)';
      resBox.style.color = '#10b981';
      resBox.textContent = `✅ ${res.message} | Telegraf: ${res.telegraf?.filePath || 'OK'}`;

      // Update state.devices in place
      const idx = state.devices.findIndex(d => d.id === id);
      if (idx >= 0) {
        state.devices[idx] = { ...state.devices[idx], ...res.device };
      }
      renderDeviceGrid();
      updateDonutChart();

      // If currently on devices tab, re-render table
      const devNav = document.getElementById('nav-devices');
      if (devNav && devNav.classList.contains('active')) {
        renderSecondaryView('devices', document.getElementById('other-view-panel'), document.getElementById('view-title'), document.getElementById('view-subtitle'));
      }

      // Close modal after 1.5s
      setTimeout(() => {
        document.getElementById('modal-device-edit').classList.remove('active');
      }, 1500);
    } else {
      resBox.style.background = 'rgba(239,68,68,0.15)';
      resBox.style.color = '#ef4444';
      resBox.textContent = '❌ ' + (res.error || 'Update failed');
    }
  } catch (err) {
    resBox.style.background = 'rgba(239,68,68,0.15)';
    resBox.style.color = '#ef4444';
    resBox.textContent = 'Error: ' + err.message;
  }
};

window.testInfluxConnection = async function() {
  const resBox = document.getElementById('settings-result');
  resBox.style.display = 'block';
  resBox.style.background = 'rgba(37,150,190,0.1)';
  resBox.style.color = '#2596BE';
  resBox.textContent = 'Pinging InfluxDB v2 instance...';

  try {
    const res = await fetch('/api/settings/test-influx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        INFLUX_URL: document.getElementById('cfg-influx-url').value,
        INFLUX_TOKEN: document.getElementById('cfg-influx-token').value,
        INFLUX_ORG: document.getElementById('cfg-influx-org').value,
        INFLUX_BUCKET: document.getElementById('cfg-influx-bucket').value
      })
    }).then(r => r.json());

    if (res.success) {
      resBox.style.background = 'rgba(16,185,129,0.15)';
      resBox.style.color = '#10b981';
      resBox.textContent = '✅ ' + res.message;
    } else {
      resBox.style.background = 'rgba(239,68,68,0.15)';
      resBox.style.color = '#ef4444';
      resBox.textContent = '❌ ' + res.message;
    }
  } catch (err) {
    resBox.style.background = 'rgba(239,68,68,0.15)';
    resBox.style.color = '#ef4444';
    resBox.textContent = 'Connection error: ' + err.message;
  }
};

window.saveSettings = async function() {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      INFLUX_URL: document.getElementById('cfg-influx-url').value,
      INFLUX_TOKEN: document.getElementById('cfg-influx-token').value,
      INFLUX_ORG: document.getElementById('cfg-influx-org').value,
      INFLUX_BUCKET: document.getElementById('cfg-influx-bucket').value,
      TELEGRAF_CONF_DIR: document.getElementById('cfg-telegraf-dir').value
    })
  }).then(r => r.json());

  if (res.success) {
    alert('Settings successfully persisted!');
  }
};

/**
 * Load activity events from /api/events with filters
 */
async function loadActivityEvents(deviceId = 'all', severity = 'all', search = '') {
  const tbody = document.getElementById('activity-tbody');
  if (!tbody) return;

  try {
    const params = new URLSearchParams();
    if (deviceId !== 'all') params.set('deviceId', deviceId);
    if (severity !== 'all') params.set('severity', severity);
    params.set('limit', '100');

    const res = await fetch(`/api/events?${params.toString()}`).then(r => r.json());
    if (!res.success || !res.events) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted);">Failed to load events</td></tr>`;
      return;
    }

    let events = res.events;
    if (search) {
      const q = search.toLowerCase();
      events = events.filter(e =>
        (e.device_name || '').toLowerCase().includes(q) ||
        (e.event_type || '').toLowerCase().includes(q) ||
        (e.severity || '').toLowerCase().includes(q) ||
        (e.value != null ? String(e.value).toLowerCase().includes(q) : false)
      );
    }

    if (events.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted);">No events match your filter</td></tr>`;
      return;
    }

    tbody.innerHTML = events.map(e => {
      const sevClass = e.severity || 'info';
      const time = e.timestamp ? new Date(e.timestamp).toLocaleString('id-ID', { hour12: false }) : '--';
      return `
        <tr data-device-id="${e.device_id}" style="cursor:pointer;">
          <td class="alert-time-cell">${time}</td>
          <td>${e.device_name || 'Unknown'}</td>
          <td>${e.event_type || 'UNKNOWN'}</td>
          <td><span class="alert-severity-badge ${sevClass}">${(e.severity || 'info').toUpperCase()}</span></td>
          <td>${e.value != null ? e.value : '--'}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('tr[data-device-id]').forEach(row => {
      row.addEventListener('click', () => {
        const devId = row.dataset.deviceId;
        const activeForDevice = state.activeIncidents.find(i => i.deviceId == devId);
        if (activeForDevice) {
          openIncidentDrawerById(activeForDevice.incidentId);
        }
      });
    });
  } catch (err) {
    console.error('Failed to load activity events:', err);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted);">Error loading events</td></tr>`;
  }
}

/**
 * Load data riil untuk Reports view dari endpoint /api/reports/sla
 */
async function loadReportsData() {
  try {
    const res = await fetch('/api/reports/sla').then(r => r.json());
    if (!res.success) return;

    const slaText = document.getElementById('reports-sla-text');
    const sourceEl = document.getElementById('reports-source');
    const ingestionEl = document.getElementById('reports-ingestion');
    const ingestionSrc = document.getElementById('reports-ingestion-src');
    const latEl = document.getElementById('reports-avg-latency');
    const latSrc = document.getElementById('reports-latency-src');
    const lossEl = document.getElementById('reports-avg-loss');
    const lossSrc = document.getElementById('reports-loss-src');

    if (slaText) {
      const fromDb = res.daily_breakdown && res.daily_breakdown.length > 0;
      if (fromDb) {
        const pct = parseFloat(res.sla_30d);
        slaText.textContent = `${isFinite(pct) ? pct.toFixed(2) : '0.00'}%`;
        slaText.style.color = pct >= 99 ? 'var(--color-online)' : (pct >= 95 ? 'var(--color-warning)' : 'var(--color-offline)');
      } else {
        slaText.textContent = 'Not enough historical data';
        slaText.style.color = 'var(--text-muted)';
      }
    }
    if (sourceEl) {
      const fromDb = res.daily_breakdown && res.daily_breakdown.length > 0;
      sourceEl.textContent = fromDb
        ? `Aggregated from ${res.daily_breakdown.length} day(s) of daily_uptime records (sourced from InfluxDB ping probes)`
        : 'History belum terisi — menunggu minimal 1 hari data ping di InfluxDB';
    }
    if (ingestionEl) {
      ingestionEl.textContent = res.influx_has_ingestion
        ? Number(res.total_ingestion_24h).toLocaleString('id-ID')
        : '--';
    }
    if (ingestionSrc) {
      ingestionSrc.textContent = res.influx_has_ingestion
        ? 'Source: InfluxDB count() over last 24h'
        : 'No InfluxDB ingestion data';
    }
    if (latEl) {
      latEl.textContent = `${parseFloat(res.avg_latency_ms).toFixed(2)} ms`;
    }
    if (latSrc) {
      latSrc.textContent = res.influx_has_data
        ? 'Source: InfluxDB mean() over last 24h'
        : 'Source: live devices.ping_latency average';
    }
    if (lossEl) {
      lossEl.textContent = `${parseFloat(res.avg_packet_loss).toFixed(3)} %`;
    }
    if (lossSrc) {
      lossSrc.textContent = res.influx_has_data
        ? 'Source: InfluxDB mean() over last 24h'
        : 'Source: live devices.packet_loss average';
    }

    // Daily table
    const tableEl = document.getElementById('reports-daily-table');
    if (tableEl) {
      if (!res.daily_breakdown || res.daily_breakdown.length === 0) {
        tableEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">Belum ada riwayat harian. Riwayat terisi otomatis dari data ping InfluxDB setelah Telegraf berjalan minimal 1 hari.</div>';
      } else {
        const rows = res.daily_breakdown.map(d => {
          const dt = new Date(d.date);
          const dateLabel = dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
          const pct = parseFloat(d.uptime_percentage);
          const color = pct >= 99 ? 'var(--color-online)' : (pct >= 95 ? 'var(--color-warning)' : 'var(--color-offline)');
          return `
            <tr style="border-bottom:1px solid var(--border-subtle);">
              <td style="padding:10px 14px; font-family:var(--font-mono); font-size:0.8rem;">${dateLabel}</td>
              <td style="padding:10px 14px; font-family:var(--font-mono); font-size:0.8rem; text-align:right;">${d.total_checks.toLocaleString('id-ID')}</td>
              <td style="padding:10px 14px; font-family:var(--font-mono); font-size:0.8rem; text-align:right;">${d.successful_checks.toLocaleString('id-ID')}</td>
              <td style="padding:10px 14px; font-family:var(--font-mono); font-size:0.85rem; text-align:right; color:${color}; font-weight:600;">${pct.toFixed(2)}%</td>
            </tr>
          `;
        }).join('');

        tableEl.innerHTML = `
          <table style="width:100%; border-collapse:collapse; font-size:0.85rem; text-align:left;">
            <thead style="position:sticky; top:0; background:var(--bg-surface); z-index:1;">
              <tr style="border-bottom:1px solid var(--border-subtle); color:var(--text-muted);">
                <th style="padding:10px 14px;">Date</th>
                <th style="padding:10px 14px; text-align:right;">Total Checks</th>
                <th style="padding:10px 14px; text-align:right;">Successful</th>
                <th style="padding:10px 14px; text-align:right;">Uptime</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }
    }
  } catch (err) {
    console.error('Failed to load reports data:', err);
  }
}

window.loadReportsData = loadReportsData;

/**
 * Topology (LLDP/CDP) functions
 * ============================================================================
 */

// Cache for last successful topology fetch
let topologyCache = null;
let topologyFetchInFlight = false;

async function loadTopology(forceRecreate = false) {
  if (topologyFetchInFlight && !forceRecreate) return;
  if (!document.getElementById('topology-canvas')) return;

  topologyFetchInFlight = true;
  const statsEl = document.getElementById('topology-stats-text');
  const emptyEl = document.getElementById('topology-empty');

  try {
    const res = await fetch('/api/topology').then(r => r.json());
    if (!res.success) {
      if (statsEl) statsEl.textContent = 'Error: ' + (res.error || 'unknown');
      return;
    }
    topologyCache = res;
    state.topologyData = res;

    // Update stats text
    const s = res.stats || {};
    const byProto = s.by_protocol || {};
    const protoStr = Object.keys(byProto).map(k => `${k.toUpperCase()}: ${byProto[k]}`).join(' · ') || 'no links';
    if (statsEl) {
      statsEl.innerHTML = `<span style="color:var(--text-primary); font-weight:600;">${s.total_devices} devices</span> · ${s.total_links} links (${protoStr})` +
        (s.unmanaged_nodes > 0 ? ` · <span style="color:#f59e0b;">${s.unmanaged_nodes} unmanaged</span>` : '');
    }

    // Toggle empty state
    if (emptyEl) {
      if (s.total_devices === 0) {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div').textContent = 'No devices registered yet.';
      } else if (s.total_links === 0) {
        emptyEl.style.display = 'flex';
        emptyEl.querySelector('div').textContent = 'No topology data yet';
        emptyEl.querySelectorAll('div')[1].textContent = 'Click Rescan to discover LLDP/CDP neighbors from your devices.';
      } else {
        emptyEl.style.display = 'none';
      }
    }

    // If forceRecreate, destroy existing network first (used after add device)
    if (forceRecreate && state.topologyNetwork) {
      try { state.topologyNetwork.destroy(); } catch (e) { /* ignore */ }
      state.topologyNetwork = null;
    }

    // Init or update Vis.js
    if (res.nodes && res.nodes.length > 0) {
      renderTopologyGraph(res);
    }
  } catch (e) {
    console.error('loadTopology error:', e);
    if (statsEl) statsEl.textContent = 'Error: ' + e.message;
  } finally {
    topologyFetchInFlight = false;
  }
}

function renderTopologyGraph(data) {
  const container = document.getElementById('topology-canvas');
  if (!container || typeof vis === 'undefined') {
    console.warn('Vis.js not loaded or container missing');
    return;
  }

  // Convert API nodes to Vis.js DataSet format
  const visNodes = data.nodes.map(n => {
    const isUnmanaged = (n.type === 'unmanaged') || (typeof n.id === 'string' && String(n.id).startsWith('unmanaged-'));
    return {
      id: n.id,
      label: n.label + (n.ip ? '\n' + n.ip : ''),
      color: {
        background: n.color || '#64748b',
        border: isUnmanaged ? '#94a3b8' : (n.color || '#64748b'),
        highlight: { background: n.color || '#64748b', border: '#ffffff' }
      },
      shape: isUnmanaged ? 'box' : 'dot',
      size: isUnmanaged ? 18 : 22,
      font: { color: '#f8fafc', size: 11, face: 'Inter, sans-serif', multi: true },
      borderWidth: isUnmanaged ? 2 : 1,
      borderDashes: isUnmanaged ? [4, 4] : false,
      title: isUnmanaged
        ? `Unmanaged device\nHostname: ${n.label}\nIP: ${n.ip || 'unknown'}\nClick to add this device`
        : `Device: ${n.label}\nIP: ${n.ip}\nStatus: ${n.status}\nType: ${n.type}\nClick to view details`
    };
  });

  const visEdges = data.edges.map(e => ({
    id: e.id,
    from: e.from,
    to: e.to,
    color: e.color ? { color: e.color, highlight: '#2596BE' } : { color: '#475569', highlight: '#2596BE' },
    dashes: e.dashes || false,
    arrows: { to: { enabled: true, scaleFactor: 0.4 } },
    width: 1.5,
    smooth: { enabled: true, type: 'curvedCW', roundness: 0.15 },
    font: { color: '#94a3b8', size: 9, strokeWidth: 0, align: 'middle' },
    title: `${e.protocol ? e.protocol.toUpperCase() : 'Link'}\n${e.target_sys_name ? `Target: ${e.target_sys_name}` : ''}\n${e.target_port_desc ? `Port: ${e.target_port_desc}` : e.target_interface ? `Port: ${e.target_interface}` : ''}\n${e.target_ip ? `IP: ${e.target_ip}` : ''}`
  }));

  if (state.topologyNetwork) {
    // Update existing network
    state.topologyNetwork.setData({ nodes: new vis.DataSet(visNodes), edges: new vis.DataSet(visEdges) });
  } else {
    // Init new network
    const options = {
      physics: {
        enabled: true,
        stabilization: { iterations: 150 },
        barnesHut: { gravitationalConstant: -8000, springLength: 120, springConstant: 0.04 }
      },
      interaction: { dragNodes: true, zoomView: true, hover: true, tooltipDelay: 150 },
      nodes: { borderWidth: 1, shadow: { enabled: true, color: 'rgba(0,0,0,0.3)', size: 6, x: 0, y: 2 } },
      edges: { smooth: { enabled: true, type: 'curvedCW', roundness: 0.15 }, shadow: false },
      layout: { improvedLayout: true, randomSeed: 42 }
    };

    state.topologyNetwork = new vis.Network(container, {
      nodes: new vis.DataSet(visNodes),
      edges: new vis.DataSet(visEdges)
    }, options);

    // Click handler
    state.topologyNetwork.on('click', function(params) {
      if (params.nodes && params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        if (typeof nodeId === 'string' && String(nodeId).startsWith('unmanaged-')) {
          showUnmanagedDeviceInfo(nodeId);
        } else {
          const numericId = parseInt(nodeId, 10);
          if (!isNaN(numericId)) {
            openDeviceDetail(numericId);
          }
        }
      }
    });

    // Double-click to fit graph
    state.topologyNetwork.on('doubleClick', function() {
      state.topologyNetwork.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
    });
  }
}

function showUnmanagedDeviceInfo(unmanagedId) {
  // Find unmanaged node from cache
  if (!topologyCache) return;
  const node = topologyCache.nodes.find(n => n.id === unmanagedId);
  if (!node) return;

  // Remove existing modal if any
  const existing = document.getElementById('unmanaged-info-modal');
  if (existing) existing.remove();

  // Create simple info popup
  const modal = document.createElement('div');
  modal.id = 'unmanaged-info-modal';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); backdrop-filter:blur(4px); z-index:300; display:flex; align-items:center; justify-content:center;';

  // Find edges that connect to this unmanaged node to show source info
  const connectedEdges = (topologyCache.edges || []).filter(e => e.to === unmanagedId);
  const sourceInfo = connectedEdges.length > 0
    ? connectedEdges.map(e => {
        const srcDev = (topologyCache.nodes || []).find(n => n.id === e.from);
        return `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">→ Connected from: <strong style="color:var(--text-primary);">${srcDev ? srcDev.label : 'unknown'}</strong> via <strong>${e.protocol || 'lldp'}</strong></div>`;
      }).join('')
    : '<div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">No connection info available</div>';

  modal.innerHTML = `
    <div style="background:var(--bg-surface); border:1px solid var(--border-highlight); border-radius:12px; max-width:480px; width:90%; box-shadow:0 20px 40px rgba(0,0,0,0.6); overflow:hidden;">
      <div style="background:var(--bg-surface-elevated); padding:16px 20px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
        <div style="font-family:var(--font-display); font-size:1rem; font-weight:600;">Unmanaged Device</div>
        <button id="unmanaged-close" style="background:transparent; border:none; color:var(--text-muted); font-size:1.4rem; cursor:pointer;">&times;</button>
      </div>
      <div style="padding:20px;">
        <div style="display:grid; grid-template-columns:120px 1fr; gap:10px; font-size:0.85rem;">
          <div style="color:var(--text-muted);">Hostname:</div><div style="font-family:var(--font-mono); color:var(--text-primary); word-break:break-all;">${node.label || 'unknown'}</div>
          <div style="color:var(--text-muted);">IP Address:</div><div style="font-family:var(--font-mono); color:var(--text-primary);">${node.ip || 'unknown'}</div>
          <div style="color:var(--text-muted);">Status:</div><div><span class="status-pill" style="background:rgba(100,116,139,0.15); color:#94a3b8;">UNMANAGED</span></div>
        </div>
        <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border-subtle);">
          ${sourceInfo}
        </div>
        <div style="margin-top:16px; padding:12px; background:rgba(37,150,190,0.05); border:1px solid rgba(37,150,190,0.2); border-radius:6px; font-size:0.75rem; color:var(--text-muted); line-height:1.5;">
          This device was discovered via LLDP/CDP but is not yet registered in BMS IT Monitoring. Add it to start monitoring.
        </div>
      </div>
      <div style="padding:14px 20px; background:rgba(0,0,0,0.2); display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn-secondary" id="unmanaged-cancel" style="font-size:0.8rem;">Close</button>
        <button class="btn-action" id="unmanaged-add" style="font-size:0.8rem;">Add this device</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Wire button handlers
  document.getElementById('unmanaged-close').addEventListener('click', () => modal.remove());
  document.getElementById('unmanaged-cancel').addEventListener('click', () => modal.remove());
  document.getElementById('unmanaged-add').addEventListener('click', () => {
    modal.remove();
    // Pre-fill Add Device modal with this device info
    openAddDevicePrefilled(node);
  });
  // Click backdrop to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

function openAddDevicePrefilled(node) {
  // Show Add Device modal with prefilled values from unmanaged node
  document.getElementById('input-dev-name').value = node.label || '';
  document.getElementById('input-dev-ip').value = node.ip || '';
  document.getElementById('input-dev-type').value = 'router'; // default, user can change
  document.getElementById('input-dev-community').value = 'public';
  document.getElementById('input-dev-port').value = '161';
  document.getElementById('input-dev-interval').value = '1';
  // Clear test result box
  const resBox = document.getElementById('test-connection-result');
  if (resBox) {
    resBox.style.display = 'block';
    resBox.style.background = 'rgba(37,150,190,0.1)';
    resBox.style.color = '#2596BE';
    resBox.innerHTML = `Prefilled from discovered neighbor (${node.label}). Click <strong>Test ICMP & SNMP</strong> to verify, then <strong>Deploy & Reload Telegraf</strong>.`;
  }
  // Open the modal
  document.getElementById('modal-device').classList.add('active');
  // Switch to map tab so user can see the action
  // (don't auto-switch to dashboard - let user see the modal overlay)
}

async function handleRescanTopology() {
  const btn = document.getElementById('btn-topology-rescan');
  const statsEl = document.getElementById('topology-stats-text');
  if (!btn) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Rescanning...';
  btn.style.opacity = '0.6';
  if (statsEl) statsEl.textContent = 'Discovery in progress...';

  try {
    const res = await fetch('/api/topology/discover', { method: 'POST' }).then(r => r.json());
    if (res.success) {
      const stats = res.stats || {};
      const totalLinks = res.totalLinks || 0;
      const elapsed = res.elapsed ? res.elapsed + 's' : '';
      if (statsEl) {
        statsEl.textContent = `✓ Discovery complete: ${totalLinks} links found (${elapsed}). Reloading...`;
        statsEl.style.color = 'var(--color-online)';
      }
      // Wait for backend to commit, then force-reload with network recreation
      setTimeout(() => {
        if (statsEl) statsEl.style.color = '';
        loadTopology(true); // forceRecreate=true to rebuild Vis.js network
      }, 1500);
    } else {
      if (statsEl) {
        statsEl.textContent = '✗ Discovery failed: ' + (res.error || 'unknown');
        statsEl.style.color = 'var(--color-offline)';
      }
    }
  } catch (e) {
    if (statsEl) {
      statsEl.textContent = '✗ Error: ' + e.message;
      statsEl.style.color = 'var(--color-offline)';
    }
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = originalText;
      btn.style.opacity = '';
    }, 2000);
  }
}

window.loadTopology = loadTopology;
window.handleRescanTopology = handleRescanTopology;
window.openAddDevicePrefilled = openAddDevicePrefilled;

/**
 * Export 30-day SLA report sebagai CSV (download dari data yang sudah di-load)
 */
window.exportSlaCsv = async function() {
  try {
    const res = await fetch('/api/reports/sla').then(r => r.json());
    if (!res.success) return;

    const lines = ['Date,Total Checks,Successful Checks,Uptime Percentage'];
    (res.daily_breakdown || []).forEach(d => {
      const date = new Date(d.date).toISOString().split('T')[0];
      lines.push(`${date},${d.total_checks},${d.successful_checks},${d.uptime_percentage}`);
    });
    lines.push('');
    lines.push(`# Summary`);
    lines.push(`# 30-Day SLA,${res.sla_30d}%`);
    lines.push(`# Total Ingestion (24h),${res.total_ingestion_24h}`);
    lines.push(`# Avg Latency (ms),${res.avg_latency_ms}`);
    lines.push(`# Avg Packet Loss (%),${res.avg_packet_loss}`);
    lines.push(`# Generated,${res.generated_at}`);

    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bms-it-monitoring-sla-30d-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
};
