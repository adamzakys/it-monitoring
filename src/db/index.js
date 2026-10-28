const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DB_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DB_DIR, 'itnetmon.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let db = null;

// Compatibility store. Sebelum migrasi, `settings` & koleksi live disimpan di
// dalam memory store dan di-mutasi oleh route /api/settings (pengaturan InfluxDB
// memang dirancang in-memory: di-reset dari env tiap proses start). Kini database
// SQLite menjadi penyimpanan sebenarnya; objek ini hanya menyediakan default
// settings + koleksi kosong agar call-site lama (settings & fallback memori yang
// tidak lagi aktif) tetap aman dan tidak crash.
const compatStore = {
  devices: [],
  interfaces: [],
  alerts: [],
  device_links: [],
  threat_incidents: [],
  settings: {
    INFLUX_URL: process.env.INFLUX_URL || 'http://127.0.0.1:8086',
    INFLUX_TOKEN: process.env.INFLUX_TOKEN || '',
    INFLUX_ORG: process.env.INFLUX_ORG || 'itnetmon',
    INFLUX_BUCKET: process.env.INFLUX_BUCKET || 'itnetmon_metrics',
    TELEGRAF_CONF_DIR: process.env.TELEGRAF_CONF_DIR || './telegraf.d',
    TELEGRAF_RELOAD_CMD: process.env.TELEGRAF_RELOAD_CMD || 'echo "Reloading Telegraf"'
  }
};

function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  console.log(`[DB] Connected to SQLite at ${DB_PATH}`);

  // Run schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
    console.log('[DB] Database schema verified and initialized.');
  }

  /**
 * Migrasi aditif idempotent: SQLite bukan support `ADD COLUMN IF NOT EXISTS`.
 * Helper memeriksa kolom via PRAGMA sebelum ALTER — aman dijalankan tiap startup.
 */
function ensureColumn(table, column, definition) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = cols.some(c => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[DB] Migration: added column ${table}.${column}`);
    }
  } catch (e) {
    console.warn(`[DB] ensureColumn(${table}.${column}) skip: ${e.message}`);
  }
}

// Seed default devices if empty
  const checkStmt = db.prepare('SELECT COUNT(*) as count FROM devices');
  const checkRes = checkStmt.get();
  if (checkRes.count === 0) {
    console.log('[DB] Seeding initial sample devices...');
    const insertDevice = db.prepare(`
      INSERT INTO devices (name, ip_address, device_type, snmp_community, snmp_version, snmp_port, polling_interval, status, ping_latency, packet_loss)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInterface = db.prepare(`
      INSERT INTO interfaces (device_id, interface_name, status, speed_bps, in_octets_rate, out_octets_rate)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, interface_name) DO NOTHING
    `);

    const seedDevices = [
      {
        name: 'MikroTik CHR (Lab Router)',
        ip_address: '192.168.131.18',
        device_type: 'router',
        snmp_community: 'public',
        snmp_version: '2c',
        snmp_port: 161,
        polling_interval: 1,
        status: 'online',
        ping_latency: 0.2,
        packet_loss: 0.0
      },
      {
        name: 'Debian Linux (Lab Server)',
        ip_address: '192.168.131.2',
        device_type: 'server',
        snmp_community: 'public',
        snmp_version: '2c',
        snmp_port: 161,
        polling_interval: 1,
        status: 'online',
        ping_latency: 0.1,
        packet_loss: 0.0
      }
    ];

    const insertAlert = db.prepare(`
      INSERT INTO alerts (type, title, target, severity, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const seedAlerts = [];

    // Default interface templates for seeded devices (matched by device array index)
    const seedInterfaces = [
      { device_id: 1, interface_name: 'ether1', status: 'up', speed_bps: 1000000000, in_octets_rate: 0, out_octets_rate: 0 },
      { device_id: 2, interface_name: 'enp0s3', status: 'up', speed_bps: 1000000000, in_octets_rate: 0, out_octets_rate: 0 }
    ];

    const tx = db.transaction(() => {
      seedDevices.forEach((dev, idx) => {
        const result = insertDevice.run(
          dev.name, dev.ip_address, dev.device_type, dev.snmp_community,
          dev.snmp_version, dev.snmp_port, dev.polling_interval, dev.status,
          dev.ping_latency, dev.packet_loss
        );
        const newId = result.lastInsertRowid;
        // Match interfaces by array index (idx + 1 since device_id is 1-based in seedInterfaces)
        const matchingIfaces = seedInterfaces.filter(i => i.device_id === idx + 1);
        for (const iface of matchingIfaces) {
          insertInterface.run(newId, iface.interface_name, iface.status, iface.speed_bps, iface.in_octets_rate, iface.out_octets_rate);
        }
      });
      for (const alert of seedAlerts) {
        insertAlert.run(alert.type, alert.title, alert.target, alert.severity, alert.status, alert.created_at);
      }
    });

    tx();
    console.log('[DB] Seed data populated successfully.');
  }

  // Ensure daily_uptime table exists (for SLA calculation)
  // If table is empty, leave it empty - do not generate fake data
  // Frontend will show "Not enough historical data" when no records exist

  // Migrasi per-kolom (idempotent, aditif). Kolom `sort_order` — urutan tampilan
  // device custom (fitur Device Inventory drag & preset).
  ensureColumn('devices', 'sort_order', 'INTEGER DEFAULT 0');
}

function query(sql, params = []) {
  if (!db) {
    throw new Error('Database not initialized. Call initDB() first.');
  }

  const trimmed = sql.trim().toUpperCase();
  const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
  const isPragma = trimmed.startsWith('PRAGMA');
  // MySQL/PG mengembalikan baris hasil RETURNING (INSERT/UPDATE/DELETE).
  // better-sqlite3 bisa membaca RETURNING lewat statement.all(), jadi kita
  // perlakukan statement yang memakai RETURNING seperti query pembaca.
  const hasReturning = /RETURNING/i.test(sql);

  if (isSelect || isPragma || hasReturning) {
    const stmt = db.prepare(sql);
    const rows = params.length ? stmt.all(...params) : stmt.all();
    return { rows };
  } else {
    const stmt = db.prepare(sql);
    const result = params.length ? stmt.run(...params) : stmt.run();
    return {
      rows: [],
      rowCount: result.changes,
      lastInsertRowid: result.lastInsertRowid
    };
  }
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Transaction atomic untuk operasi multi-statement (mis. reorder device).
 * Catatan better-sqlite3 v11: `db.transaction(fn)` mengembalikan transaction
 * FUNCTION (mode default/deferred/immediate/exclusive) yang harus di-invoke;
 * callback `fn` tidak dijalankan langsung. Wrapper ini memanggil transaction
 * function dan return hasilnya, sehingga usage `db.transaction(fn)` langsung.
 */
function transaction(fn) {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  // better-sqlite3 v11: `db.transaction(fn)` mengembalikan transaction function
  // yang harus di-invoke; callback dipanggil tanpa arg useful (this=undefined).
  // Wrapper binds database → `fn(db)` dan invoke transaction function langsung.
  const tx = db.transaction(() => fn(db));
  return tx();
}

module.exports = {
  initDB,
  query,
  transaction,
  isPostgresConnected: () => true, // Kept for compatibility during migration; always true for SQLite
  getMemoryStore: () => compatStore, // Backward-compat: settings in-memory + koleksi kosong
  close
};