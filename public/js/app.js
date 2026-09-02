/**
 * BMS IT Monitoring - Real-time network monitoring and observability platform
 * Core Frontend Application Logic
 */

// Global Application State
const state = {
  devices: [],
  selectedDeviceId: 1,
  selectedInterface: 'ether1-WAN',
  activeFilter: 'all',
  searchQuery: '',
  alerts: [],
  ws: null,
  charts: {
    traffic: null,
    donut: null,
    detailThroughput: null,
    detailRtt: null,
    detailLoss: null
  },
  chartBuffer: {
    labels: Array(60).fill(''),
    inData: Array(60).fill(0),
    outData: Array(60).fill(0)
  },
  detailData: null,
  detailPollingTimer: null,
  topologyNetwork: null,
  topologyData: null,
  topologyRefreshTimer: null
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  initCharts();
  setupEventListeners();
  await loadInitialData();
  connectWebSocket();
}

/**
 * Loads KPI and Devices data from REST API
 */
async function loadInitialData() {
  try {
    const [kpiRes, devRes, alertRes, feedRes] = await Promise.all([
      fetch('/api/kpi').then(r => r.json()),
      fetch('/api/devices').then(r => r.json()),
      fetch('/api/alerts').then(r => r.json()),
      fetch('/api/live-feed').then(r => r.json())
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
      renderAlertFeed();
    }
    if (feedRes.success) {
      updateLiveFeedPill(feedRes);
    }

    // Fallback: untuk device yang belum punya interface (Telegraf belum jalan
    // atau belum selesai SNMP walk), ambil via direct SNMP walk real-time.
    // Berjalan async parallel agar tidak block UI.
    enrichDevicesWithRealtimeSnmp();
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

    // Only feed chart if it matches currently selected device and interface
    if (msg.deviceId === state.selectedDeviceId && msg.interfaceName === state.selectedInterface) {
      const inVal = typeof msg.inMbps === 'number' ? msg.inMbps.toFixed(2) : '0.00';
      const outVal = typeof msg.outMbps === 'number' ? msg.outMbps.toFixed(2) : '0.00';
      document.getElementById('live-in-rate').textContent = `${inVal} Mbps`;
      document.getElementById('live-out-rate').textContent = `${outVal} Mbps`;

      // Update Sliding Window Buffer (60 points FIFO)
      state.chartBuffer.labels.shift();
      state.chartBuffer.labels.push(msg.timestamp);

      state.chartBuffer.inData.shift();
      state.chartBuffer.inData.push(msg.inMbps || 0);

      state.chartBuffer.outData.shift();
      state.chartBuffer.outData.push(msg.outMbps || 0);

      // Ultra-lightweight chart update
      state.charts.traffic.update('none');
    }
  } else if (msg.type === 'NEW_ALERT') {
    state.alerts.unshift(msg.alert);
    renderAlertFeed();
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
  } else if (msg.type === 'METRIC_TICK') {
    // Tick per detik: perbarui pill live dengan latency terkini
    const allDevs = state.devices || [];
    const total = allDevs.length;
    const online = allDevs.filter(d => d.status === 'online').length;
    updateLiveFeedPill({
      total,
      online,
      avg_latency_ms: msg.latency,
      server_time: msg.fullTime
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
      '</div>' +
      '<div class="card-title">' + escapeHtml(dev.name) + '</div>' +
      '<div class="card-ip">' + escapeHtml(dev.ip_address) + '</div>' +
      '<div class="card-type">' + escapeHtml(typeLabel) + '</div>' +
      '<div class="card-stats-row">' +
        '<div class="stat-item"><span class="stat-label">Response Time</span><span class="stat-val" id="card-lat-' + dev.id + '">' + latText + '</span></div>' +
        '<div class="stat-item"><span class="stat-label">Packet Loss</span><span class="stat-val" id="card-loss-' + dev.id + '" style="color:' + lossColor + '">' + lossText + '</span></div>' +
        '<div class="stat-item"><span class="stat-label">Interfaces</span><span class="stat-val">' + ifaceText + '</span></div>' +
      '</div>' +
      '<div class="card-detail-cta"><a href="#" class="card-detail-link" data-device-id="' + dev.id + '">View details &rarr;</a></div>';

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

  // Update visual card border, background, and dot
  if (card) {
    card.classList.remove('fault-offline', 'fault-warning');
    if (devStatus === 'offline') card.classList.add('fault-offline');
    else if (devStatus === 'warning') card.classList.add('fault-warning');

    const dot = card.querySelector('.status-dot');
    if (dot) {
      dot.className = `status-dot ${devStatus}`;
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
  state.selectedDeviceId = deviceId;
  const dev = state.devices.find(d => d.id === deviceId);

  // Update card border highlights
  document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
  const targetCard = document.getElementById(`dev-card-${deviceId}`);
  if (targetCard) targetCard.classList.add('selected');

  // Reset chart buffer so previous device's line doesn't connect
  state.chartBuffer.labels = Array(60).fill('');
  state.chartBuffer.inData = Array(60).fill(0);
  state.chartBuffer.outData = Array(60).fill(0);

  if (state.charts.traffic) {
    state.charts.traffic.data.labels = state.chartBuffer.labels;
    state.charts.traffic.data.datasets[0].data = state.chartBuffer.inData;
    state.charts.traffic.data.datasets[1].data = state.chartBuffer.outData;
    state.charts.traffic.update('none');
  }

  document.getElementById('live-in-rate').textContent = '0.00 Mbps';
  document.getElementById('live-out-rate').textContent = '0.00 Mbps';

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
  backdrop.classList.add('active');
  document.body.style.overflow = 'hidden';

  // Show loading state in header
  const dev = state.devices.find(d => d.id === deviceId);
  document.getElementById('detail-device-name').textContent = dev ? dev.name : `Device #${deviceId}`;
  document.getElementById('detail-device-ip').textContent = dev ? dev.ip_address : '--';
  document.getElementById('detail-device-type').textContent = dev ? dev.device_type : '--';
  setStatusPill('detail-device-status', dev ? dev.status : 'unknown');

  loadDeviceDetail(deviceId);

  // Auto-refresh every 5s while panel is open
  if (state.detailPollingTimer) clearInterval(state.detailPollingTimer);
  state.detailPollingTimer = setInterval(function() { loadDeviceDetail(deviceId, true); }, 5000);
}

function closeDeviceDetail() {
  const backdrop = document.getElementById('device-detail-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('active');
  document.body.style.overflow = '';
  if (state.detailPollingTimer) {
    clearInterval(state.detailPollingTimer);
    state.detailPollingTimer = null;
  }
  // Destroy detail charts so they don't leak memory
  if (state.charts.detailThroughput) { state.charts.detailThroughput.destroy(); state.charts.detailThroughput = null; }
  if (state.charts.detailRtt) { state.charts.detailRtt.destroy(); state.charts.detailRtt = null; }
  if (state.charts.detailLoss) { state.charts.detailLoss.destroy(); state.charts.detailLoss = null; }
  state.detailData = null;
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
    if (!res.success) return;
    state.detailData = res;
    renderDeviceDetail(res, isRefresh);
  } catch (e) {
    console.error('Failed to load device detail:', e);
  }
}

function renderDeviceDetail(data, isRefresh = false) {
  // Header
  document.getElementById('detail-device-name').textContent = data.device.name;
  document.getElementById('detail-device-ip').textContent = data.device.ip_address;
  document.getElementById('detail-device-type').textContent = data.device.device_type;
  setStatusPill('detail-device-status', data.device.status);

  // System summary cards
  // Phase 1.5: Last Seen is now displayed as a relative time
  // (e.g. "5s ago") while the full ISO timestamp is preserved internally
  // and shown in a title attr for hover inspection.
  const lastSeenEl = document.getElementById('detail-last-seen');
  if (lastSeenEl) {
    if (data.device.last_seen) {
      const seenDate = new Date(data.device.last_seen);
      lastSeenEl.textContent = formatTimeAgo(seenDate);
      lastSeenEl.title = seenDate.toLocaleString('id-ID', { hour12: false });
    } else {
      lastSeenEl.textContent = '--';
      lastSeenEl.title = '';
    }
  }
  document.getElementById('detail-poll-interval').textContent = `${data.device.polling_interval || 1}s`;
  document.getElementById('detail-snmp-comm').textContent = data.device.snmp_community || 'public';
  document.getElementById('detail-snmp-port').textContent = `${data.device.snmp_port || 161}/udp`;

  const ifaceCount = (data.interfaces || []).length;
  document.getElementById('detail-iface-count').textContent = `${ifaceCount} interface${ifaceCount !== 1 ? 's' : ''}`;
  document.getElementById('detail-iface-count-info').textContent = `${ifaceCount} detected`;

  // System metrics
  const sys = data.system || {};
  // Phase 1.5: CPU display. On Linux, hrProcessorLoad is often reported as
  // a value between 0 and 100. If the value is missing (N/A), provide a
  // helpful hint instead of a blank field, and treat 0 as a valid reading
  // (do not show N/A when value is exactly 0).
  const cpuEl = document.getElementById('detail-cpu');
  if (cpuEl) {
    if (sys.cpu_load_pct !== null && sys.cpu_load_pct !== undefined) {
      const cpuNum = parseFloat(sys.cpu_load_pct);
      cpuEl.textContent = Number.isFinite(cpuNum) ? `${cpuNum.toFixed(1)}%` : 'N/A';
      cpuEl.title = 'hrProcessorLoad (HOST-RESOURCES-MIB)';
    } else {
      cpuEl.textContent = 'N/A (not reported)';
      cpuEl.title = 'Agent does not report hrProcessorLoad. Configure snmpd extend or install MIB modules.';
    }
  }
  document.getElementById('detail-uptime').textContent = sys.sys_uptime_human || 'N/A';

  // Storage: hrStorageSize and hrStorageUsed are reported in *allocation units*,
  // not raw bytes. The backend returns `alloc_units` per entry; default to
  // 4096 (typical Linux page/block size) when missing for backward compatibility.
  //
  // Phase 1.5: select the entry whose `descr` (hrStorageDescr) is exactly
  // "Physical memory". This is the vendor-neutral way to find RAM across
  // Debian, MikroTik RouterOS, Cisco IOS, etc. Other entries to ignore:
  // "Available memory", "Cached memory", "Memory buffers", "Swap space",
  // "/", "/var", and any filesystem path.
  const memEl = document.getElementById('detail-memory');
  if (sys.storage_entries && sys.storage_entries.length > 0) {
    // Exact match first.
    let primary = sys.storage_entries.find(e =>
      (e.descr || '').trim().toLowerCase() === 'physical memory'
    );
    // Some agents use other phrasings; fall back to a small allowlist.
    // MikroTik RouterOS reports "main memory" (lowercase, single word).
    if (!primary) {
      const alt = sys.storage_entries.find(e => {
        const d = (e.descr || '').trim().toLowerCase();
        return d === 'main memory' || d === 'ram' ||
               d === 'real memory' || d === 'system memory';
      });
      primary = alt;
    }
    if (!primary) {
      // No labelled RAM entry found — fall back to the RAM OID
      // (.1.3.6.1.2.1.25.2.1.2) then to fixed disk, then largest entry.
      const OID_RAM = '.1.3.6.1.2.1.25.2.1.2';
      const OID_FIXED = '.1.3.6.1.2.1.25.2.1.4';
      primary = sys.storage_entries.find(e => e.storage_type === OID_RAM);
      if (!primary) {
        primary = sys.storage_entries.find(e => e.storage_type === OID_FIXED);
      }
      if (!primary) {
        primary = sys.storage_entries[0];
        for (const e of sys.storage_entries) {
          if ((e.size || 0) > (primary.size || 0)) primary = e;
        }
      }
    }
    const allocUnits = primary.alloc_units || 4096;
    let usedBytes = (primary.used || 0) * allocUnits;
    let totalBytes = (primary.size || 0) * allocUnits;
    // Defensive: on some agents (notably Debian snmpd), `hrStorageUsed` for
    // Physical memory can be reported as larger than `hrStorageSize` because
    // the kernel accounts shared memory / buffers in both. When the larger
    // value is non-zero and the smaller is non-zero, treat the larger as
    // total. This is the universally safe interpretation: total >= used.
    if (totalBytes > 0 && usedBytes > 0 && usedBytes > totalBytes) {
      const swap = usedBytes; usedBytes = totalBytes; totalBytes = swap;
    }
    if (totalBytes > 0) {
      const fmt = (b) => {
        if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
        if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
        if (b >= 1024)      return `${(b / 1024).toFixed(0)} KB`;
        return `${b} B`;
      };
      const pct = ((usedBytes / totalBytes) * 100).toFixed(1);
      memEl.textContent = `${fmt(usedBytes)} / ${fmt(totalBytes)} (${pct}%)`;
      memEl.title = `Source: ${primary.descr || primary.storage_type || 'unknown'} (${allocUnits} B/unit)`;
    } else if (usedBytes > 0) {
      const fmt = (b) => {
        if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
        if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
        if (b >= 1024)      return `${(b / 1024).toFixed(0)} KB`;
        return `${b} B`;
      };
      memEl.textContent = `${fmt(usedBytes)} used`;
      memEl.title = `Source: ${primary.descr || primary.storage_type || 'unknown'} (${allocUnits} B/unit)`;
    } else {
      memEl.textContent = 'N/A';
      memEl.title = '';
    }
  } else {
    memEl.textContent = 'N/A';
    memEl.title = '';
  }

  // Show note if system metrics incomplete
  const noteEl = document.getElementById('detail-system-note');
  if (noteEl) {
    const hasSystemData = sys.has_data && (sys.cpu_load_pct !== null || sys.sys_uptime_ticks !== null || (sys.storage_entries || []).length > 0);
    noteEl.style.display = hasSystemData ? 'none' : 'block';
  }

  // Interface table
  renderInterfaceTable(data);

  // Interface selector for throughput chart
  populateDetailIfaceSelect(data);

  // RTT + loss mini-stats
  const ls = data.latency_summary || {};
  document.getElementById('detail-rtt-avg').textContent = `${ls.avg || 0} ms`;
  document.getElementById('detail-rtt-min').textContent = `${ls.min || 0} ms`;
  document.getElementById('detail-rtt-max').textContent = `${ls.max || 0} ms`;
  document.getElementById('detail-rtt-jitter').textContent = `${ls.jitter || 0} ms`;

  const lossS = data.loss_summary || {};
  document.getElementById('detail-loss-avg').textContent = `${lossS.avg || 0} %`;
  document.getElementById('detail-loss-max').textContent = `${lossS.max || 0} %`;
  document.getElementById('detail-loss-samples').textContent = lossS.samples || 0;

  // Charts (init if not yet, otherwise just update)
  if (!isRefresh) {
    initDetailCharts();
  }
  updateDetailCharts(data);
}

function renderInterfaceTable(data) {
  const tbody = document.getElementById('detail-iface-tbody');
  if (!tbody) return;
  const ifaces = data.interfaces || [];
  const ratesByName = {};
  (data.packet_rates || []).forEach(p => { ratesByName[p.interface_name] = p; });
  const errByName = {};
  (data.error_counters || []).forEach(p => { errByName[p.interface_name] = p; });

  if (ifaces.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--text-muted);">No interfaces discovered via SNMP yet</td></tr>`;
    return;
  }

  tbody.innerHTML = ifaces.map(i => {
    const rate = ratesByName[i.interface_name] || {};
    const err = errByName[i.interface_name] || {};
    // Normalize status from realtime-snmp (oper_status=1) or DB (oper_status_label)
    let statusLabel = i.oper_status_label;
    if (!statusLabel && i.oper_status !== undefined && i.oper_status !== null) {
      statusLabel = (i.oper_status === 1) ? 'up' : (i.oper_status === 2 ? 'down' : 'unknown');
    } else if (!statusLabel) {
      statusLabel = i.status || 'up'; // realtime fallback
    }
    const statusClass = statusLabel;
    // Phase 1.5: loopback interfaces report a meaningless speed (often 10
    // Mbps from the agent default). Treat any interface named `lo`, `lo0`,
    // `Loopback*`, or `null0` as virtual and display a dash instead of a
    // misleading physical speed.
    const ifname = (i.interface_name || '').toLowerCase();
    const isVirtual = ifname === 'lo' || ifname === 'lo0' ||
                      ifname.startsWith('lo:') || ifname.startsWith('loopback') ||
                      ifname === 'null0' || ifname.startsWith('null');
    let speedMbps;
    if (isVirtual) {
      speedMbps = '— Virtual';
    } else if (i.speed_mbps && i.speed_mbps > 0) {
      speedMbps = `${i.speed_mbps} Mbps`;
    } else {
      speedMbps = '--';
    }
    return `
      <tr>
        <td>${i.interface_name}</td>
        <td><span class="iface-status ${statusClass}">${statusLabel.toUpperCase()}</span></td>
        <td>${speedMbps}</td>
        <td>${(rate.pps_in || 0).toFixed(0)}</td>
        <td>${(rate.pps_out || 0).toFixed(0)}</td>
        <td style="color:${(err.ifInErrors || 0) > 0 ? 'var(--color-offline)' : 'inherit'}">${err.ifInErrors || 0}</td>
        <td style="color:${(err.ifOutErrors || 0) > 0 ? 'var(--color-offline)' : 'inherit'}">${err.ifOutErrors || 0}</td>
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
  }
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
      labels: [],
      datasets: [
        { label: 'Inbound (Mbps)', data: [], borderColor: '#00f2fe', backgroundColor: gradIn, fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 },
        { label: 'Outbound (Mbps)', data: [], borderColor: '#ff9900', backgroundColor: gradOut, fill: true, tension: 0.3, borderWidth: 2, pointRadius: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#64748b', font: { size: 9 }, callback: (v) => `${v} Mbps` } }
      }
    }
  });

  // 2. RTT min/avg/max
  const rttCtx = document.getElementById('detailRttChart').getContext('2d');
  state.charts.detailRtt = new Chart(rttCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'min', data: [], borderColor: '#10b981', borderWidth: 1.5, pointRadius: 0, tension: 0.3 },
        { label: 'avg', data: [], borderColor: '#2596BE', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false },
        { label: 'max', data: [], borderColor: '#ef4444', borderWidth: 1.5, pointRadius: 0, tension: 0.3 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} ms` } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#64748b', font: { size: 9 }, callback: (v) => `${v} ms` } }
      }
    }
  });

  // 3. Packet Loss (bar)
  const lossCtx = document.getElementById('detailLossChart').getContext('2d');
  state.charts.detailLoss = new Chart(lossCtx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{ label: 'Loss %', data: [], backgroundColor: 'rgba(245, 158, 11, 0.55)', borderColor: '#f59e0b', borderWidth: 1 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `Loss: ${ctx.parsed.y.toFixed(2)}%` } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#64748b', font: { size: 9 }, callback: (v) => `${v}%` } }
      }
    }
  });
}

function updateDetailCharts(data) {
  const selIface = document.getElementById('detail-interface-select')?.value;
  if (!selIface) return;

  // Re-query throughput history for selected interface from a fresh fetch
  // (we use the latency/loss histories that were already returned by deep-dive,
  // but throughput per-interface 5m history requires a second call).
  fetchThroughputHistory(data.device.id, selIface).then(points => {
    if (state.charts.detailThroughput && points) {
      state.charts.detailThroughput.data.labels = points.labels;
      state.charts.detailThroughput.data.datasets[0].data = points.inMbps;
      state.charts.detailThroughput.data.datasets[1].data = points.outMbps;
      state.charts.detailThroughput.update('none');
    }
  });

  if (state.charts.detailRtt) {
    const lat = data.latency_history || [];
    state.charts.detailRtt.data.labels = lat.map(p => formatChartTime(p.time));
    state.charts.detailRtt.data.datasets[0].data = lat.map(p => p.min);
    state.charts.detailRtt.data.datasets[1].data = lat.map(p => p.avg);
    state.charts.detailRtt.data.datasets[2].data = lat.map(p => p.max);
    state.charts.detailRtt.update('none');
  }

  if (state.charts.detailLoss) {
    const loss = data.loss_history || [];
    state.charts.detailLoss.data.labels = loss.map(p => formatChartTime(p.time));
    state.charts.detailLoss.data.datasets[0].data = loss.map(p => p.value);
    state.charts.detailLoss.update('none');
  }
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
function renderAlertFeed() {
  const container = document.getElementById('stream-log-container');
  container.innerHTML = '';

  state.alerts.slice(0, 15).forEach(alert => {
    const item = document.createElement('div');
    item.className = 'stream-item';

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

    container.appendChild(item);
  });

  updateAlertCounter();
}

function updateAlertCounter() {
  const count = state.alerts.filter(a => a.status === 'active').length;
  document.getElementById('stream-badge-count').textContent = count;
  document.getElementById('nav-alert-counter').textContent = count;
  const floatCount = document.getElementById('floating-alert-count');
  if (floatCount) floatCount.textContent = count;
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
 * Format nilai metrik. Tampilkan placeholder (default '--') saat nilai
 * kosong/0/NaN agar tidak误导 (mis. latency 0 padahal tidak ada data).
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

  // Interface Select in Chart
  document.getElementById('chart-interface-select').addEventListener('change', (e) => {
    state.selectedInterface = e.target.value;
    state.chartBuffer.labels = Array(60).fill('');
    state.chartBuffer.inData = Array(60).fill(0);
    state.chartBuffer.outData = Array(60).fill(0);
    if (state.charts.traffic) {
      state.charts.traffic.update('none');
    }
    document.getElementById('live-in-rate').textContent = '0.00 Mbps';
    document.getElementById('live-out-rate').textContent = '0.00 Mbps';
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
  document.getElementById('device-detail-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'device-detail-backdrop') closeDeviceDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const backdrop = document.getElementById('device-detail-backdrop');
      if (backdrop && backdrop.classList.contains('active')) closeDeviceDetail();
    }
  });

  // Detail interface selector → refresh throughput chart for that interface
  document.getElementById('detail-interface-select')?.addEventListener('change', () => {
    if (state.detailData) updateDetailCharts(state.detailData);
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
      <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:20px;">
        <table style="width:100%; border-collapse:collapse; font-size:0.85rem; text-align:left;">
          <thead>
            <tr style="border-bottom:1px solid var(--border-subtle); color:var(--text-muted);">
              <th style="padding:10px;">Severity</th>
              <th>Incident</th>
              <th>Target Node</th>
              <th>Time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${state.alerts.map(a => `
              <tr style="border-bottom:1px solid var(--border-subtle);">
                <td style="padding:12px 10px;"><span class="brand-badge" style="background:${a.severity==='critical'?'rgba(239,68,68,0.2)':(a.severity==='warning'?'rgba(245,158,11,0.2)':'rgba(16,185,129,0.2)')}; color:${a.severity==='critical'?'#ef4444':(a.severity==='warning'?'#f59e0b':'#10b981')}">${a.severity.toUpperCase()}</span></td>
                <td style="font-weight:600;">${a.title}</td>
                <td style="font-family:var(--font-mono); color:var(--text-muted);">${a.target}</td>
                <td>${formatTimeAgo(new Date(a.created_at))}</td>
                <td><span style="color:var(--color-online);">Active</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
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
      const pct = parseFloat(res.sla_30d);
      slaText.textContent = `${isFinite(pct) ? pct.toFixed(2) : '100.00'}%`;
      slaText.style.color = pct >= 99 ? 'var(--color-online)' : (pct >= 95 ? 'var(--color-warning)' : 'var(--color-offline)');
    }
    if (sourceEl) {
      const fromDb = res.daily_breakdown && res.daily_breakdown.length > 0;
      sourceEl.textContent = fromDb
        ? `Aggregated from ${res.daily_breakdown.length} day(s) of daily_uptime records in PostgreSQL`
        : 'Calculated from current device status (history not yet populated)';
    }
    if (ingestionEl) {
      ingestionEl.textContent = Number(res.total_ingestion_24h).toLocaleString('id-ID');
    }
    if (ingestionSrc) {
      ingestionSrc.textContent = res.influx_has_data
        ? 'Source: InfluxDB count() over last 24h'
        : 'Source: estimate from device count × fields (InfluxDB empty)';
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
        tableEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">No daily_uptime history available yet. Seed data will appear after first PostgreSQL connection.</div>';
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
