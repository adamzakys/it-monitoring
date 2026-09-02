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
COMMENT ON COLUMN device_links.stale IS 'true jika link tidak muncul di discovery terakhir (auto-cleanup 7 hari)';
