-- ITNETMON PostgreSQL Database Schema

CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    device_type VARCHAR(50) DEFAULT 'router',
    snmp_community VARCHAR(100) DEFAULT 'public',
    snmp_version VARCHAR(10) DEFAULT '2c',
    snmp_port INT DEFAULT 161,
    polling_interval INT DEFAULT 1,
    status VARCHAR(20) DEFAULT 'online',
    ping_latency FLOAT DEFAULT 0,
    packet_loss FLOAT DEFAULT 0,
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interfaces (
    id SERIAL PRIMARY KEY,
    device_id INT REFERENCES devices(id) ON DELETE CASCADE,
    interface_name VARCHAR(100) NOT NULL,
    interface_index INT,
    mac_address VARCHAR(50),
    speed_bps BIGINT DEFAULT 1000000000,
    status VARCHAR(20) DEFAULT 'up',
    in_octets_rate FLOAT DEFAULT 0,
    out_octets_rate FLOAT DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT unique_device_interface UNIQUE (device_id, interface_name)
);

CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(150) NOT NULL,
    target VARCHAR(100) NOT NULL,
    severity VARCHAR(20) DEFAULT 'warning',
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS daily_uptime (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    total_checks INT DEFAULT 0,
    successful_checks INT DEFAULT 0,
    uptime_percentage NUMERIC(5,2) DEFAULT 100.00
);

CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    device_name VARCHAR(100),
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info',
    value FLOAT,
    source VARCHAR(20) DEFAULT 'polling',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

CREATE TABLE IF NOT EXISTS incidents (
    id SERIAL PRIMARY KEY,
    incident_id VARCHAR(50) NOT NULL UNIQUE,
    device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    device_name VARCHAR(100),
    current_severity VARCHAR(20) DEFAULT 'warning',
    status VARCHAR(20) DEFAULT 'active',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    duration_ms BIGINT,
    root_cause JSONB,
    evidence JSONB,
    status_history JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_incidents_device_id ON incidents(device_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_started_at ON incidents(started_at DESC);

-- =============================================================
-- Device Logs (audit trail normalized — sumber: syslog/SNMP trap/dll)
-- Raw selalu disimpan; kolom correlated_* diisi hanya saat rule korelasi
-- menghasilkan Event (events.source = 'syslog'). Tidak semua log → Event,
-- tidak semua Event → Incident.
-- =============================================================
CREATE TABLE IF NOT EXISTS device_logs (
    id SERIAL PRIMARY KEY,
    device_id INT REFERENCES devices(id) ON DELETE CASCADE,
    source_ip VARCHAR(45),
    source_type VARCHAR(20) DEFAULT 'syslog',
    transport VARCHAR(20),
    facility VARCHAR(20),
    severity VARCHAR(20),
    program VARCHAR(64),
    message TEXT NOT NULL,
    raw_message TEXT,
    correlated_event_type VARCHAR(50),
    correlated_at TIMESTAMP WITH TIME ZONE,
    device_timestamp TIMESTAMP WITH TIME ZONE,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_logs_device_id ON device_logs(device_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_device_logs_received_at ON device_logs(received_at);

-- =============================================================
-- Network Topology Tables (LLDP/CDP/MNDP discovery)
-- =============================================================
CREATE TABLE IF NOT EXISTS device_links (
    id SERIAL PRIMARY KEY,
    source_device_id INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    source_interface VARCHAR(100),
    target_chassis_id VARCHAR(50),
    target_sys_name VARCHAR(255),
    target_port_id VARCHAR(100),
    target_port_desc VARCHAR(255),
    target_ip INET,
    manual_ipv4 TEXT NULL,
    target_device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    protocol VARCHAR(10) DEFAULT 'lldp',
    discovered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    stale BOOLEAN DEFAULT false,
    CONSTRAINT unique_link UNIQUE (source_device_id, source_interface, target_chassis_id)
);

CREATE INDEX IF NOT EXISTS idx_links_source ON device_links(source_device_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON device_links(target_device_id);
CREATE INDEX IF NOT EXISTS idx_links_stale ON device_links(stale);
CREATE INDEX IF NOT EXISTS idx_links_last_seen ON device_links(last_seen);

COMMENT ON TABLE device_links IS 'Network topology edges discovered via LLDP/CDP/MNDP';
COMMENT ON COLUMN device_links.target_device_id IS 'NULL jika neighbor belum di-add ke devices table (unmanaged)';
COMMENT ON COLUMN device_links.stale IS 'true jika link tidak muncul di discovery terakhir; tetap tampil (merah) sampai admin Reset & Rescan';

-- =============================================================
-- Migrations (idempotent)
-- -------------------------------------------------------------
-- CREATE TABLE IF NOT EXISTS tidak menambah kolom ke tabel yang
-- sudah ada. Statement di bawah memastikan database lama ikut
-- ter-upgrade tanpa perlu drop/recreate.
-- =============================================================
ALTER TABLE device_links ADD COLUMN IF NOT EXISTS manual_ipv4 TEXT NULL;

-- CDP menulis target_chassis_id = NULL. Constraint UNIQUE biasa memperlakukan
-- NULL sebagai distinct, sehingga ON CONFLICT tidak pernah match dan baris
-- duplikat menumpuk tiap siklus. Ganti ke unique EXPRESSION index yang
-- menormalkan NULL menjadi '' lebih dulu.
DELETE FROM device_links a USING device_links b
 WHERE a.id < b.id
   AND a.source_device_id = b.source_device_id
   AND a.source_interface IS NOT DISTINCT FROM b.source_interface
   AND COALESCE(a.target_chassis_id, '') = COALESCE(b.target_chassis_id, '');

ALTER TABLE device_links DROP CONSTRAINT IF EXISTS unique_link;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_device_link_key
  ON device_links (source_device_id, source_interface, COALESCE(target_chassis_id, ''));


-- =============================================================
-- BMS Threat Timeline — korelasi log menjadi incident bersesi
-- -------------------------------------------------------------
-- Dipisahkan dari tabel `incidents` (milik health engine: satu kondisi
-- kesehatan aktif per device, dan createIncident menolak incident baru
-- selama masih ada yang active). Threat Timeline mengelompokkan
-- device_logs menjadi sesi korelasi, sehingga satu device boleh punya
-- beberapa sesi berbeda dalam waktu yang sama.
--
-- Aditif & idempotent: aman dijalankan pada database production yang
-- sudah berisi data (initDB menjalankan schema.sql tiap startup).
-- =============================================================
ALTER TABLE device_logs ADD COLUMN IF NOT EXISTS topics TEXT;
ALTER TABLE device_logs ADD COLUMN IF NOT EXISTS category VARCHAR(40);
ALTER TABLE device_logs ADD COLUMN IF NOT EXISTS threat_key TEXT;

CREATE INDEX IF NOT EXISTS idx_device_logs_threat ON device_logs (threat_key, id);
CREATE INDEX IF NOT EXISTS idx_device_logs_dev_time ON device_logs (device_id, received_at DESC);

CREATE TABLE IF NOT EXISTS threat_incidents (
    threat_key      TEXT PRIMARY KEY,
    device_id       INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    device_name     VARCHAR(100),
    title           VARCHAR(200) NOT NULL,
    severity        VARCHAR(20) DEFAULT 'warning',
    status          VARCHAR(20) DEFAULT 'open',
    category        VARCHAR(40),
    topics          TEXT,
    matched_rules   JSONB DEFAULT '[]'::jsonb,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    last_event_at   TIMESTAMPTZ DEFAULT NOW(),
    event_count     INTEGER DEFAULT 0,
    first_log_id    BIGINT,
    last_log_id     BIGINT,
    acked_at        TIMESTAMPTZ,
    acked_by        VARCHAR(100),
    resolved_at     TIMESTAMPTZ,
    auto_resolved   BOOLEAN DEFAULT FALSE,
    evidence        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_threat_status ON threat_incidents (status, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_threat_device ON threat_incidents (device_id, started_at DESC);

COMMENT ON TABLE threat_incidents IS 'Sesi korelasi log — Threat Timeline (terpisah dari incidents: health engine)';
COMMENT ON COLUMN device_logs.threat_key IS 'Logical FK ke threat_incidents.threat_key. NULL = event individual tanpa rule (tetap ditampilkan)';
COMMENT ON COLUMN device_logs.topics IS 'Topic asli perangkat apa adanya (mis. RouterOS: system,error,critical), dipisah koma';
COMMENT ON COLUMN device_logs.category IS 'Kategori turunan vendor-agnostik dari topics+program+pola pesan (mis. auth, config, ntp, firewall)';
