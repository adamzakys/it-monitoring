# BMS IT Monitoring - Real-Time Network Monitoring Platform

**BMS IT Monitoring** adalah sistem monitoring infrastruktur jaringan dinamis berbasis API untuk **PT. Berlian Manyar Sejahtera**. Sistem memadukan manajemen inventaris perangkat, generator konfigurasi Telegraf otomatis, penyimpanan time-series InfluxDB v2, dan visualisasi dashboard NOC (Network Operations Center) 5-zona secara **real-time (1 detik per titik metrik)** menggunakan Full-Stack JavaScript (Node.js/Express) dan **SQLite** (via `better-sqlite3`).

---

## 📥 Instalasi dari Awal (Langkah demi Langkah)

Panduan ini untuk penginstalan baru (fresh install), mulai dari mengunduh repositori hingga aplikasi berjalan.

### Langkah 1: Unduh / Klon Repositori

```bash
# Clone repositori
git clone <url-repositori-anda>
cd it-monitoring
```

### Langkah 2: Instal Prasyarat Sistem

Sebelum menjalankan aplikasi, pastikan komponen berikut sudah terinstal di server / laptop Anda:

| Prasyarat | Versi Minimum | Keterangan |
|-----------|---------------|------------|
| Node.js | ≥ 18 (disarankan v20+) | Runtime backend |
| npm | bawaan Node.js | Manajemen paket |
| SQLite | dibawa `better-sqlite3` (npm) | Database relasional — file `data/itnetmon.db` auto-create, **no setup manual** |
| InfluxDB v2 | terbaru | Time-series database untuk metrik |
| Telegraf | terbaru | Agent polling ICMP + SNMP |
| SNMP tools | `net-snmp-utils` | Untuk pengujian target perangkat |
| Git | terbaru | Untuk clone repositori |
| sudo | — | Diperlukan untuk manajemen service sistem |

**Contoh instalasi di Debian / Ubuntu:**

```bash
sudo apt update
sudo apt install -y nodejs npm influxdb telegraf snmp git sudo
```

> **Catatan Node.js:** Jika versi Node.js bawaan distribusi terlalu lama, gunakan [NodeSource](https://github.com/nodesource/distributions) atau [nvm](https://github.com/nvm-sh/nvm) untuk menginstal Node.js ≥ 18.

### Langkah 3: Instal Dependensi Node.js

Di dalam folder project:

```bash
npm install
```

### Langkah 4: Database SQLite (Automatis)

Aplikasi kini menggunakan **SQLite** sebagai database relasional — **no instalasi atau konfigurasi manual dibutuhkan**:

- File database disimpan di `data/itnetmon.db` (folder `data/` auto-create saat pertama kali server jalan).
- Skema lengkap (tabel `devices`, `interfaces`, `alerts`, `events`, `incidents`, `device_logs`, `device_links`, `threat_incidents`, `app_settings`, `daily_uptime`) auto-applied na startup (`src/db/schema.sql`).
- Jika tabel `devices` kosong, sistem auto-seed 2 device contoh untuk pengujian awal.
- Lokasi database boleh di-override via env `SQLITE_PATH` (lihat `.env.example`).

> Tidak perlu instal PostgreSQL, tidak perlu `CREATE DATABASE`, tidak perlu `psql` — database file hanya file normal yang bisa di-backup dengan copy file.

### Langkah 5: Siapkan InfluxDB v2

Aktifkan dan jalankan service InfluxDB:

```bash
sudo systemctl enable --now influxdb
```

Lakukan onboarding (setup awal) InfluxDB melalui browser di `http://localhost:8086`, atau gunakan script bantu interaktif:

```bash
chmod +x scripts/reset-influxdb.sh
./scripts/reset-influxdb.sh
```

**Catat informasi berikut dari hasil onboarding — dibutuhkan untuk konfigurasi `.env` pada langkah selanjutnya:**
- URL InfluxDB (contoh: `http://127.0.0.1:8086`)
- Token
- Org
- Bucket

### Langkah 6: Siapkan Telegraf

Instalasi Telegraf sudah dilakukan pada Langkah 2. Aktifkan service agar berjalan otomatis:

```bash
sudo systemctl enable --now telegraf
```

Pastikan folder konfigurasi Telegraf sesuai dengan yang akan diatur di `.env`:
- **Development (default):** `./telegraf.d` di dalam folder project
- **Production:** `/etc/telegraf/telegraf.d`

### Langkah 7: Konfigurasi File Environment (`.env`)

Salin file contoh menjadi file konfigurasi aktual:

```bash
cp .env.example .env
```

Buka file `.env` dengan editor teks dan **isi semua parameter yang dibutuhkan**:

```ini
PORT=3000

# SQLite (opsional — default: ./data/itnetmon.db)
# SQLITE_PATH=/path/to/custom.db

# InfluxDB v2 (sesuaikan dengan hasil onboarding Langkah 5)
INFLUX_URL=http://127.0.0.1:8086
INFLUX_TOKEN=<token-dari-influxdb>
INFLUX_ORG=itnetmon
INFLUX_BUCKET=itnetmon_metrics

# Telegraf
TELEGRAF_CONF_DIR=./telegraf.d
TELEGRAF_RELOAD_CMD=sudo systemctl reload telegraf

# Syslog Receiver (opsional, untuk capture log perangkat)
SYSLOG_PORT=5514
SYSLOG_FRESH_MS=300000
```

Simpan file setelah diedit.

### Langkah 8: Jalankan Server

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

### Langkah 9: Verifikasi Instalasi

Pastikan hal berikut terpenuhi:

1. [ ] Dashboard memuat dengan 4 KPI cards terlihat (Total Devices, Online, Warning, Offline)
2. [ ] WebSocket status menunjukkan "Connected" (titik hijau pulse di header)
3. [ ] Minimal 1 device muncul di device grid (sqlite auto-seed 2 device contoh saat tabel kosong)
4. [ ] Buka menu **Settings** di sidebar untuk mengonfigurasi InfluxDB secara dinamis via browser
5. [ ] Tidak ada error level di console browser (F12 → Console)

---

## 🖥️ Menambahkan Perangkat Pertama

Setelah server berjalan, lakukan langkah berikut untuk mulai memantau perangkat jaringan:

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
- Menyimpan perangkat ke database SQLite (`data/itnetmon.db`)
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
│   ├── setup-db.sh         # (legacy) Inisialisasi database PostgreSQL — no longer digunakan, database SQLite auto-create
│   ├── restart-telegraf.sh # Restart agent Telegraf via systemd
│   └── reset-influxdb.sh   # Re-token / onboarding InfluxDB v2
├── src/
│   ├── db/
│   │   ├── index.js        # SQLite connection (better-sqlite3), WAL, schema init & seed
│   │   └── schema.sql      # Skema database relasional lengkap (SQLite sintaks)
│   ├── routes/
│   │   └── api.js          # RESTful API router
│   ├── services/
│   │   ├── influxService.js      # Client InfluxDB v2 & query throughput
│   │   ├── streamService.js      # WebSocket 1s streaming poller & flap guard
│   │   ├── telegrafManager.js    # Generator config Telegraf & graceful reloader
│   │   ├── logCollector/         # Syslog UDP/TCP + SNMP trap receiver
│   │   ├── threatTimeline.js     # Korelasi log → sesi incident
│   │   ├── uptimeService.js      # SLA 30 hari dari data ping InfluxDB
│   │   ├── topologyDiscovery.js  # LLDP/CDP network discovery
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

## 🔧 Aplikasi SQLite Siempre Activa (Tanpa Service Database Eksternal)

Database relasional kini **always active** sebagai file SQLite lokal (`data/itnetmon.db`) — tidak ada dependency service PostgreSQL/MySQL yang harus up. Router fisik / InfluxDB sendiri tetap diperlukan hanya untuk data metrik real-time; jika perangkat belum tersedia, UI tetap berjalan (metrik SNMP fallback kosong, grafik tetap render).

---

## 📜 Scripts Tersedia

### npm scripts (`package.json`)

| Script | Perintah | Keterangan |
|--------|----------|------------|
| Start produksi | `npm start` | Jalankan server (`node src/server.js`) |
| Development | `npm run dev` | Auto-reload saat file berubah (`node --watch`) |
| Build CSS | `npm run css:build` | Build Tailwind CSS (minified) |
| Watch CSS | `npm run css:watch` | Watch Tailwind CSS saat development |

### Bash scripts (`scripts/`)

| Script | Perintah | Keterangan |
|--------|----------|------------|
| Setup DB | `./scripts/setup-db.sh` | (legacy PostgreSQL — tidak dibutuhkan lebih) database SQLite auto-create |
| Restart Telegraf | `./scripts/restart-telegraf.sh` | Restart agent Telegraf via systemd |
| Reset InfluxDB | `./scripts/reset-influxdb.sh` | Re-token / onboarding InfluxDB v2 |

---

## 🔍 Troubleshooting Cepat

| Masalah | Solusi |
|---------|--------|
| `pgrep: command not found` | Instal paket `procps` (`sudo apt-get install procps`) |
| Telegraf tidak reload otomatis | Pastikan user memiliki izin `sudo` untuk `systemctl reload telegraf`, atau sesuaikan `TELEGRAF_RELOAD_CMD` di `.env` |
| InfluxDB token invalid / 401 | Jalankan `./scripts/reset-influxdb.sh`, lalu restart server ITNETMON |
| Database file hilang / corrupt | Stop server, backup `data/itnetmon.db`, delete file (folder `data/` auto-recreate + re-seed 2 device contoh), restart server |
| WebSocket tidak terhubung | Buka `http://localhost:3000`, periksa console browser (F12), pastikan tidak ada firewall yang blokir port 3000 |
| Data metrik tidak masuk ke InfluxDB | Pastikan Telegraf berjalan (`./scripts/restart-telegraf.sh`) dan `00-output.conf` di-generate dengan token yang benar |
| Port 3000 sudah digunakan | Ubah nilai `PORT` di `.env`, atau hentikan proses yang menggunakan port tersebut |

---

## 📄 Lisensi

MIT License — PT. Berlian Manyar Sejahtera

---

> Panduan testing UI terdapat dalam file terpisah: `TESTING.md`
