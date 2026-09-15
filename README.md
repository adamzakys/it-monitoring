# BMS IT Monitoring - Real-Time Network Monitoring Platform

**BMS IT Monitoring** adalah sistem monitoring infrastruktur jaringan dinamis berbasis API yang memadukan manajemen inventaris perangkat, generator konfigurasi Telegraf otomatis, penyimpanan time-series InfluxDB v2, dan visualisasi dashboard NOC interaktif 5-zona secara *real-time* (1 detik per titik metrik) menggunakan Full-Stack JavaScript (Node.js) dan PostgreSQL.

---

## 🌟 Fitur Utama & Arsitektur

1. **Dashboard NOC 5-Zona Modern**:
   - **Zona 1 (Left Sidebar)**: Navigasi modular (Dashboard, Devices, Map Topology, Alerts dengan badge counter dinamis, Reports SLA, Settings) dan profil operator.
   - **Zona 2 (Header & KPI Summary)**: Indikator Uptime 30 Hari + SVG Sparkline, status komunikasi WebSocket real-time, dan 4 kartu agregat (Total Devices, Online, Degraded/Warning, Offline).
   - **Zona 3 (Center Stage Device Grid)**: Grid inventaris dinamis dengan dot status, warna border kontras saat *fault*, serta seleksi perangkat interaktif (klik kartu langsung mengubah grafik ke router tersebut).
   - **Zona 4 (Analytics Bawah)**: Dual-Line Area Chart *sliding window* 60 detik (Inbound Cyan, Outbound Orange) dan Donut Chart distribusi kesehatan node.
   - **Zona 5 (Right Sidebar Event Stream)**: Feed kronologis insiden langsung via WebSocket dengan tombol *Collapse/Expand* dan proteksi *alert flapping*.

2. **Telegraf Dynamic Poller Engine**:
   - Menghasilkan file konfigurasi modular per perangkat (`telegraf.d/device_<id>.conf`).
   - Melakukan polling ICMP ping dan SNMP table (`IF-MIB::ifXTable` 64-bit counter `ifHCInOctets`/`ifHCOutOctets`) dengan interval 1 detik.
   - Menjalankan graceful reload (`systemctl reload telegraf`) tanpa memutus monitoring perangkat lain.

3. **Time-Series InfluxDB v2 & Dynamic Rate Calculation**:
   - Menghitung kalkulasi throughput (Mbps In/Out) dan persentase packet loss secara akurat.
   - Konfigurasi InfluxDB (URL, Token, Org, Bucket) dapat diatur secara dinamis via `.env` atau menu *Settings* di browser.

4. **Resilient Dual-Mode Architecture**:
   - Terhubung secara otomatis ke PostgreSQL saat database aktif.
   - Jika PostgreSQL atau router fisik belum aktif saat pengujian awal, engine otomatis berjalan dalam *Resilient Memory Mode* dengan simulated dynamic telemetry sehingga seluruh UI dan grafik tetap bergerak hidup untuk evaluasi visual.

---

## 🚀 Cara Menjalankan

### 1. Instalasi Dependensi
```bash
npm install
```

### 2. Konfigurasi Lingkungan (`.env`)
Salin file `.env.example` menjadi `.env` dan sesuaikan parameter:
```bash
cp .env.example .env
```
Contoh isi `.env`:
```ini
PORT=3000

# PostgreSQL
PG_HOST=127.0.0.1
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=postgres
PG_DATABASE=itnetmon

# InfluxDB v2
INFLUX_URL=http://192.168.130.48:8086
INFLUX_TOKEN=your-token-here
INFLUX_ORG=itnetmon
INFLUX_BUCKET=itnetmon_metrics

# Telegraf
TELEGRAF_CONF_DIR=./telegraf.d
TELEGRAF_RELOAD_CMD=sudo systemctl reload telegraf
```

### 3. Menjalankan Server
```bash
# Mode Produksi
npm start

# Mode Pengembangan (Auto-reload)
npm run dev
```

Buka browser di: **`http://localhost:3000`**

---

## 📂 Struktur Direktori Proyek

```
it-monitoring/
├── public/
│   ├── css/
│   │   └── style.css          # Design system Dark NOC kustom
│   ├── js/
│   │   └── app.js             # Logic frontend, Chart.js sliding window, WS
│   └── index.html             # Shell UI 5-Zona
├── scripts/
│   └── setup-db.sh            # Skrip pembantu inisialisasi PostgreSQL
├── src/
│   ├── db/
│   │   ├── index.js           # PostgreSQL connection pool & resilient fallback
│   │   └── schema.sql         # Skema database relasional
│   ├── routes/
│   │   └── api.js             # RESTful API router (Devices, KPI, Alerts, Settings)
│   ├── services/
│   │   ├── influxService.js   # Client InfluxDB v2 & query throughput
│   │   ├── streamService.js   # WebSocket 1s streaming poller & flap guard
│   │   └── telegrafManager.js # Generator config Telegraf & graceful reloader
│   └── server.js              # Entrypoint server Express & HTTP/WS
├── telegraf.d/                # Folder output file konfigurasi perangkat dinamis
├── .env                       # File konfigurasi environment
├── package.json
└── README.md
```
