const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const db = require('./db');
const apiRoutes = require('./routes/api');
const telegrafManager = require('./services/telegrafManager');
const topologyDiscovery = require('./services/topologyDiscovery');
const { initStreamService } = require('./services/streamService');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api', apiRoutes);

// Fallback for SPA routing
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start Server & Services
async function bootstrap() {
  // 1. Initialize DB (PostgreSQL or fallback)
  await db.initDB();

  // 1b. Cleanup orphan telegraf configs (config lama yang device-nya sudah dihapus)
  // agar Telegraf agent tidak stuck baca config outdated
  try {
    let activeDeviceIds = [];
    if (db.isPostgresConnected()) {
      const r = await db.query('SELECT id FROM devices');
      activeDeviceIds = r.rows.map(row => row.id);
    } else {
      activeDeviceIds = db.getMemoryStore().devices.map(d => d.id);
    }
    const removed = telegrafManager.cleanupOrphanConfigs(activeDeviceIds);
    if (removed > 0) {
      console.log(`[Bootstrap] Cleaned up ${removed} orphan Telegraf config(s).`);
    }
  } catch (e) {
    console.warn('[Bootstrap] cleanupOrphanConfigs error:', e.message);
  }

  // 1c. Sync 00-output.conf dengan token dari .env (penting setelah InfluxDB re-onboard)
  try {
    telegrafManager.refreshOutputConfig();
  } catch (e) {
    console.warn('[Bootstrap] refreshOutputConfig error:', e.message);
  }

  // 2. Initialize WebSocket Real-Time Streaming (1s interval)
  initStreamService(server);

  // 2b. Initialize Topology Discovery (LLDP/CDP periodic)
  try {
    topologyDiscovery.init({ db });
    // Schedule periodic discovery (5 min) + initial run after 30s
    topologyDiscovery.scheduleDiscovery(5);
    console.log('[Bootstrap] Topology discovery scheduled every 5 minutes');
  } catch (e) {
    console.warn('[Bootstrap] topologyDiscovery init error:', e.message);
  }

  // 3. Listen on PORT
  server.listen(PORT, () => {
    console.log(`
=========================================================
  🚀 ITNETMON Dynamic Engine is ONLINE
  🌐 Dashboard UI : http://localhost:${PORT}
  📡 WebSocket WS  : ws://localhost:${PORT}/ws/metrics
  📊 Database      : ${db.isPostgresConnected() ? 'PostgreSQL (Active)' : 'Resilient Memory Mode'}
=========================================================
    `);
  });
}

bootstrap().catch(err => {
  console.error('[FATAL SERVER ERROR]', err);
});
