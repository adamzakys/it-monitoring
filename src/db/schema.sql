-- ITNETMON SQLite Database Schema

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interfaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    interface_name VARCHAR(100) NOT NULL,
    interface_index INT,
    mac_address VARCHAR(50),
    speed_bps BIGINT DEFAULT 1000000000,
    status VARCHAR(20) DEFAULT 'up',
    in_octets_rate FLOAT DEFAULT 0,
    out_octets_rate FLOAT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_device_interface UNIQUE (device_id, interface_name)
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(150) NOT NULL,
    target VARCHAR(100) NOT NULL,
    severity VARCHAR(20) DEFAULT 'warning',
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_uptime (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL UNIQUE,
    total_checks INT DEFAULT 0,
    successful_checks INT DEFAULT 0,
    uptime_percentage NUMERIC(5,2) DEFAULT 100.00
);

CREATE TABLE IF NOT EXISTS app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    device_name VARCHAR(100),
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info',
    value FLOAT,
    source VARCHAR(20) DEFAULT 'polling',
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id VARCHAR(50) NOT NULL UNIQUE,
    device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    device_name VARCHAR(100),
    current_severity VARCHAR(20) DEFAULT 'warning',
    status VARCHAR(20) DEFAULT 'active',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    duration_ms BIGINT,
    root_cause TEXT,
    evidence TEXT,
    status_history TEXT DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_incidents_device_id ON incidents(device_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_started_at ON incidents(started_at DESC);

CREATE TABLE IF NOT EXISTS device_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    correlated_at TIMESTAMP,
    device_timestamp TIMESTAMP,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    topics TEXT,
    category VARCHAR(40),
    threat_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_logs_device_id ON device_logs(device_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_device_logs_received_at ON device_logs(received_at);
CREATE INDEX IF NOT EXISTS idx_device_logs_threat ON device_logs (threat_key, id);
CREATE INDEX IF NOT EXISTS idx_device_logs_dev_time ON device_logs (device_id, received_at DESC);

CREATE TABLE IF NOT EXISTS device_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_device_id INT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    source_interface VARCHAR(100),
    target_chassis_id VARCHAR(50),
    target_sys_name VARCHAR(255),
    target_port_id VARCHAR(100),
    target_port_desc VARCHAR(255),
    target_ip VARCHAR(45),
    manual_ipv4 TEXT NULL,
    target_device_id INT REFERENCES devices(id) ON DELETE SET NULL,
    protocol VARCHAR(10) DEFAULT 'lldp',
    discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    stale BOOLEAN DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_device_link_key
  ON device_links (source_device_id, source_interface, COALESCE(target_chassis_id, ''));

CREATE INDEX IF NOT EXISTS idx_links_source ON device_links(source_device_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON device_links(target_device_id);
CREATE INDEX IF NOT EXISTS idx_links_stale ON device_links(stale);
CREATE INDEX IF NOT EXISTS idx_links_last_seen ON device_links(last_seen);

CREATE TABLE IF NOT EXISTS threat_incidents (
    threat_key      TEXT PRIMARY KEY,
    device_id       INTEGER REFERENCES devices(id) ON DELETE CASCADE,
    device_name     VARCHAR(100),
    title           VARCHAR(200) NOT NULL,
    severity        VARCHAR(20) DEFAULT 'warning',
    status          VARCHAR(20) DEFAULT 'open',
    category        VARCHAR(40),
    topics          TEXT,
    matched_rules   TEXT DEFAULT '[]',
    started_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_event_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    event_count     INTEGER DEFAULT 0,
    first_log_id    BIGINT,
    last_log_id     BIGINT,
    acked_at        TIMESTAMP,
    acked_by        VARCHAR(100),
    resolved_at     TIMESTAMP,
    auto_resolved   BOOLEAN DEFAULT 0,
    evidence        TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_threat_status ON threat_incidents (status, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_threat_device ON threat_incidents (device_id, started_at DESC);