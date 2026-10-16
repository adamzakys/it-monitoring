# BMS IT Monitoring - Real-Time Network Monitoring Platform

**BMS IT Monitoring** adalah sistem monitoring infrastruktur jaringan dinamis berbasis API yang dikembangkan untuk **PT. Berlian Manyar Sejahtera**. Sistem memadukan manajemen inventaris perangkat jaringan, generator konfigurasi Telegraf otomatis, penyimpanan time-series InfluxDB v2, dan visualisasi dashboard NOC (Network Operations Center) 5-zona secara **real-time (1 detik per titik metrik)** menggunakan Full-Stack JavaScript (Node.js/Express) dan PostgreSQL.

---

## 🌟 Fitur Utama & Arsitektur

### 1. Dashboard NOC 5-Zona Modern
- **Zona 1 (Left Sidebar)**: Navigasi modular (Dashboard, Devices, Map Topology, Alerts dengan badge counter dinamis, Reports SLA, Settings) dan profil operator.
- **Zona 2 (Header & KPI Summary)**: Indikator Uptime 30 Hari + SVG Sparkline, status komunikasi WebSocket real-time, dan 4 kartu agregat (Total Devices, Online, Degraded/Warning, Offline).
- **Zona 3 (Center Stage Device Grid)**: Grid inventaris dinamis dengan dot status, warna border kontras saat *fault*, serta seleksi perangkat interaktif (klik kartu langsung mengubah grafik ke router tersebut).
- **Zona 4 (Analytics Bawah)**: Dual-Line Area Chart *sliding window* 60 detik (Inbound Cyan, Outbound Orange) dan Donut Chart distribusi kesehatan node.
- **Zona 5 (Right Sidebar Event Stream)**: Feed kronologis insiden langsung via WebSocket dengan tombol *Collapse/Expand* dan proteksi *alert flapping*.

### 2. Telegraf Dynamic Poller Engine
- Menghasilkan file konfigurasi modular per perangkat (`telegraf.d/device_<id>.conf`).
- Melakukan polling ICMP ping dan SNMP table (`IF-MIB::ifXTable` 64-bit counter `ifHCInOctets`/`ifHCOutOctets`) dengan interval 1 detik.
- Menjalankan graceful reload (`systemctl reload telegraf`) tanpa memutus monitoring perangkat lain.

### 3. Time-Series InfluxDB v2 & Dynamic Rate Calculation
- Menghitung kalkulasi throughput (Mbps In/Out) dan persentase packet loss secara akurat.
- Konfigurasi InfluxDB (URL, Token, Org, Bucket) dapat diatur secara dinamis via `.env` atau menu *Settings* di browser.

### 4. Resilient Dual-Mode Architecture
- Terhubung secara otomatis ke PostgreSQL saat database aktif.
- Jika PostgreSQL atau router fisik belum aktif saat pengujian awal, engine otomatis berjalan dalam **Resilient Memory Mode** dengan simulated dynamic telemetry sehingga seluruh UI dan grafik tetap bergerak hidup untuk evaluasi visual.

---

## 🛠️ Teknologi yang Digunakan

| Layer | Teknologi |
|-------|-----------|
| Backend | Node.js, Express, PostgreSQL (`pg`) |
| Realtime | WebSocket (`ws`) |
| Time-Series DB | InfluxDB v2 (`@influxdata/influxdb-client`) |
| Polling Agent | Telegraf (ICMP ping + SNMP `IF-MIB::ifXTable`) |
| Frontend | Vanilla JS, Chart.js, vis-network, Tailwind CSS |
| Environment | dotenv |

---

## 📥 Panduan Instalasi dari Awal (Step-by-Step)

Panduan berikut membahas instalasi lengkap mulai dari nol pada server/laptop Anda.

### Syarat Sistem (Prasyarat)

Pastikan berikut sudah terinstal:

- **Node.js** ≥ 18 (disarankan v20+)
- **npm** (bawaan Node.js)
- **PostgreSQL** ≥ 13
- **InfluxDB v2** (untuk penyimpanan metrik time-series)
- **Telegraf** (agent pengumpul metrik SNMP/ICMP)
- **SNMP tools** (`snmp`, `snmpd`, `net-snmp-utils`) untuk pengujian target
- **Git**

---

### Langkah 1: Klon Repositori

```bash
git clone <url-repositori-anda>
cd it-monitoring
```

### Langkah 2: Instal Dependensi Node.js

```bash
npm install
```

### Langkah 3: Siapkan PostgreSQL

Masuk ke PostgreSQL sebagai superuser:

```bash
sudo -u postgres psql
```

Buat database dan user untuk ITNETMON:

```sql
CREATE USER itnetmon WITH PASSWORD 'itnetmon';
CREATE DATABASE itnetmon OWNER itnetmon;
GRANT ALL PRIVILEGES ON DATABASE itnetmon TO itnetmon;
\q
```

Terapkan skema database (tabel devices, interfaces, alerts, events, incidents, device_logs, device_links, threat_incidents, dan lain-lain):

```bash
chmod +x scripts/setup-db.sh
PG_USER=itnetmon PG_PASSWORD=itnetmon PG_HOST=127.0.0.1 PG_PORT=5432 PG_DATABASE=itnetmon ./scripts/setup-db.sh
```

Alternatif jalankan langsung file SQL:

```bash
psql -h 127.0.0.1 -U itnetmon -d itnetmon -f src/db/schema.sql
```

### Langkah 4: Siapkan InfluxDB v2

Pastikan InfluxDB aktif dan ter-aktifkan saat boot:

```bash
sudo systemctl enable --now influxdb
```

Lakukan onboarding (setup awal) melalui browser di `http://localhost:8086`, atau gunakan script bantu interaktif:

```bash
chmod +x scripts/reset-influxdb.sh
./scripts/reset-influxdb.sh
```

Catat **Token**, **Org**, dan **Bucket** yang dihasilkan — informasi ini diperlukan pada file `.env` pada langkah berikutnya.

> Catatan: Jika token InfluxDB sudah tidak valid di masa depan, jalankan kembali `./scripts/reset-influxdb.sh` untuk menghasilkan token baru tanpa menghapus data historis.

### Langkah 5: Siapkan Telegraf

Instal agent Telegraf:

```bash
# Debian / Ubuntu
sudo apt-get update
sudo apt-get install telegraf

# Aktifkan service agar berjalan otomatis
sudo systemctl enable --now telegraf
```

Pastikan folder konfigurasi Telegraf sesuai dengan nilai `TELEGRAF_CONF_DIR` di `.env`:
- Development (default): `./telegraf.d` di dalam folder project
- Production: `/etc/telegraf/telegraf.d`

Restart Telegraf setelah konfigurasi siap:

```bash
./scripts/restart-telegraf.sh
```

### Langkah 6: Konfigurasi Environment (`.env`)

Salin file contoh menjadi file konfigurasi aktual:

```bash
cp .env.example .env
```

Buka file `.env` dengan editor teks dan sesuaikan setiap parameter:

```ini
PORT=3000

# PostgreSQL
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=itnetmon
PG_PASSWORD=itnetmon
PG_DATABASE=itnetmon

# InfluxDB v2
INFLUX_URL=http://127.0.0.1:8086
INFLUX_TOKEN=<token-yang-dapat-pada-langkah-4>
INFLUX_ORG=itnetmon
INFLUX_BUCKET=itnetmon_metrics

# Telegraf Dynamic Configuration Path
# Development: ./telegraf.d
# Production: /etc/telegraf/telegraf.d
TELEGRAF_CONF_DIR=./telegraf.d
TELEGRAF_RELOAD_CMD=sudo systemctl reload telegraf

# Universal Log Pipeline — Syslog Receiver
SYSLOG_PORT=5514
SYSLOG_FRESH_MS=300000

# Live Poller Mode: saat true, backend akan menghasilkan live dynamic telemetry
# jika InfluxDB atau router fisik tidak terjangkau (untuk evaluasi visual)
SIMULATE_METRICS=true
```

Simpan file setelah selesai diedit.

### Langkah 7: Jalankan Server

**Mode produksi:**

```bash
npm start
```

**Mode pengembangan (auto-reload saat ada perubahan file):**

```bash
npm run dev
```

Buka browser dan akses:

```
http://localhost:3000
```

### Langkah 8: Verifikasi Instalasi

Pastikan hal berikut terpenuhi:

1. [ ] Dashboard memuat dengan 4 KPI cards terlihat (Total, Online, Warning, Offline)
2. [ ] WebSocket status menunjukkan "Connected" (titik hijau pulse di header)
3. [ ] Minimal 1 device muncul di device grid (jika PostgreSQL belum siap, sistem akan seeding 2 device contoh otomatis dalam Resilient Memory Mode)
4. [ ] Buka menu **Settings** di sidebar untuk mengonfigurasi InfluxDB secara dinamis via browser
5. [ ] Tidak ada error level di console browser (F12 → Console)

---

## 🖥️ Memasukkan Perangkat Pertama

1. Buka dashboard di `http://localhost:3000`
2. Klik tombol **"Add Device"** pada device grid
3. Isi formulir:
   - **Device Name / Label**: misalnya `MikroTik CHR - Edge 01`
   - **IP Address / Host**: misalnya `192.168.131.18`
   - **Device Type**: pilih jenis perangkat (Router, Switch, Server, dll.)
   - **SNMP Community**: default `public`
   - **SNMP Port**: default `161`
   - **Polling Frequency**: default `1 Second`
4. Klik **"Test ICMP & SNMP"** untuk memverifikasi konektivitas sebelum disimpan
5. Klik **"Deploy & Reload Telegraf"**

Sistem akan secara otomatis:
- Melakukan ICMP ping real-time ke target
- Menyimpan perangkat ke PostgreSQL (atau memory store)
- Menghasilkan file konfigurasi Telegraf (`telegraf.d/device_<id>.conf`)
- Melakukan graceful reload Telegraf tanpa memutus monitoring perangkat lain

---

## 📂 Struktur Direktori Proyek

```
it-monitoring/
├── public/                 # Frontend statis
│   ├── css/
│   │   ├── input.css       # Sumber Tailwind v4
│   │   ├── output.css      # Hasil build Tailwind (minified)
│   │   └── style.css       # Design system Dark NOC kustom
│   ├── js/
│   │   └── app.js          # Logic frontend, Chart.js sliding window, WebSocket
│   └── index.html          # Shell UI 5-Zona
├── scripts/
│   ├── setup-db.sh         # Skrip pembantu inisialisasi PostgreSQL
│   ├── restart-telegraf.sh # Restart agent Telegraf via systemd
│   └── reset-influxdb.sh   # Re-token / onboarding InfluxDB v2
├── src/
│   ├── db/
│   │   ├── index.js        # PostgreSQL connection pool & resilient memory fallback
│   │   └── schema.sql      # Skema database relasional lengkap
│   ├── routes/
│   │   └── api.js          # RESTful API router (Devices, KPI, Alerts, Settings, dll.)
│   ├── services/
│   │   ├── influxService.js      # Client InfluxDB v2 & query throughput
│   │   ├── streamService.js      # WebSocket 1s streaming poller & flap guard
│   │   ├── telegrafManager.js    # Generator config Telegraf & graceful reloader
│   │   ├── logCollector/         # Syslog UDP/TCP + SNMP trap receiver
│   │   ├── threatTimeline.js     # Korelasi log → sesi incident (Threat Timeline)
│   │   ├── uptimeService.js      # SLA 30 hari dari data ping InfluxDB
│   │   ├── topologyDiscovery.js  # LLDP/CDP network discovery
│   │   ├── profiler.js           # Configuration Readiness Advisor
│   │   └── ...
│   └── server.js           # Entrypoint Express & HTTP/WebSocket
├── telegraf.d/             # Folder output konfigurasi Telegraf dinamis
├── .env                    # File konfigurasi environment (buat dari .env.example)
├── .env.example            # Contoh environment
├── package.json
├── README.md
└── TESTING.md              # Panduan scenario testing UI
```

---

## 🔌 API Endpoints (Ringkasan)

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| GET | `/api/kpi` | Ringkasan KPI global (uptime 30 hari, total/online/warning/offline) |
| GET | `/api/devices` | Daftar semua perangkat + interface |
| POST | `/api/devices` | Tambah perangkat baru (auto-generate Telegraf config) |
| PUT | `/api/devices/:id` | Edit perangkat yang sudah ada |
| DELETE | `/api/devices/:id` | Hapus perangkat & konfigurasi Telegraf-nya |
| GET | `/api/devices/:id/deep-dive` | Detail lengkap per perangkat (metrik, sistem, log, incident) |
| GET | `/api/devices/:id/readiness` | Diagnostik siap konfigurasi per perangkat |
| GET | `/api/devices/:id/syslog-status` | Status syslog receiver perangkat |
| GET | `/api/devices/:id/syslog-verify` | Verifikasi log baru setelah trigger |
| GET | `/api/devices/:id/logs` | Audit trail log perangkat (syslog/SNMP trap) |
| GET | `/api/devices/:id/threat-timeline` | Threat Timeline (korelasi log → incident) |
| GET | `/api/alerts` | Daftar alert aktif |
| GET | `/api/events` | Activity events |
| GET | `/api/live-feed` | Snapshot data live (devices, alerts, throughput) |
| POST | `/api/devices/test-connection` | Uji ICMP ping & SNMP probe ke target |
| POST | `/api/telegraf/regenerate-all` | Regenerasi semua konfigurasi Telegraf |
| GET | `/api/telegraf/status` | Status agent Telegraf (PID, config, log) |
| WS | `ws://localhost:3000/ws/metrics` | Streaming metrik real-time 1 detik |

---

## ⚡ Mode Resilient (Tanpa PostgreSQL / Hardware Fisik)

Jika PostgreSQL atau router fisik belum aktif saat pengujian awal, engine otomatis berjalan dalam **Resilient Memory Mode** dengan simulated dynamic telemetry. Seluruh UI dan grafik tetap berjalan untuk evaluasi visual. Saat PostgreSQL tersedia, sistem akan beralih otomatis ke mode database tanpa perlu restart.

---

## 🛠️ Scripts Tersedia (`package.json`)

| Script | Perintah | Keterangan |
|--------|----------|------------|
| Start produksi | `npm start` | Jalankan server (`node src/server.js`) |
| Development | `npm run dev` | Auto-reload saat file berubah (`node --watch`) |
| Build CSS | `npm run css:build` | Build Tailwind CSS (minified) |
| Watch CSS | `npm run css:watch` | Watch Tailwind CSS saat development |

## 🛠️ Script Bash Tambahan (`scripts/`)

| Script | Perintah | Keterangan |
|--------|----------|------------|
| Setup DB | `./scripts/setup-db.sh` | Inisialisasi database PostgreSQL |
| Restart Telegraf | `./scripts/restart-telegraf.sh` | Restart agent Telegraf via systemd |
| Reset InfluxDB | `./scripts/reset-influxdb.sh` | Re-token / onboarding InfluxDB v2 |

---

## 🔧 Troubleshooting

| Masalah | Solusi |
|---------|--------|
| `pgrep: command not found` | Instal paket `procps` (`sudo apt-get install procps`) |
| Telegraf tidak reload otomatis | Pastikan user memiliki izin `sudo` untuk `systemctl reload telegraf`, atau sesuaikan `TELEGRAF_RELOAD_CMD` di `.env` |
| InfluxDB token invalid / 401 | Jalankan `./scripts/reset-influxdb.sh`, lalu restart server ITNETMON |
| Database connection refused | Pastikan PostgreSQL aktif: `sudo systemctl status postgresql`, dan verifikasi kredensial di `.env` |
| WebSocket tidak terhubung | Buka `http://localhost:3000`, periksa console browser (F12), pastikan tidak ada firewall yang blokir port 3000 |
| Data metrik tidak masuk ke InfluxDB | Pastikan Telegraf berjalan (`./scripts/restart-telegraf.sh`) dan `00-output.conf` di-generate dengan token yang benar |
| Port 3000 sudah digunakan | Ubah nilai `PORT` di `.env`, atau hentikan proses yang menggunakan port tersebut |

---

## 📄 Lisensi

MIT License — PT. Berlian Manyar Sejahtera

---

> Panduan testing UI terdapat dalam file terpisah: `TESTING.md`
