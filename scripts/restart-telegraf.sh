#!/bin/bash
# ============================================================================
# ITNETMON Telegraf Restart Helper (Robust)
# ----------------------------------------------------------------------------
# Hot-restart Telegraf agent untuk membaca konfigurasi terbaru dari
# ./telegraf.d (HOST-RESOURCES-MIB, DISMAN-EVENT-MIB, ifInErrors, dll).
#
# Cara pakai (PENTING: harus di TTY interaktif karena sudo butuh password):
#   cd /home/urzection/Documents/it-monitoring
#   ./scripts/restart-telegraf.sh
#
# Troubleshoot:
#   - "sudo unable to read password" → run di TTY, BUKAN dari background/script
#   - "Telegraf not running" setelah [OK] → cek /tmp/telegraf.log
#   - NOPASSWD setup: sudo visudo → tambahkan baris:
#       urzection ALL=(root) NOPASSWD: /usr/bin/kill, /usr/local/bin/telegraf
# ============================================================================

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TELEGRAF_CONF_DIR="$PROJECT_DIR/telegraf.d"
TELEGRAF_BIN="/usr/local/bin/telegraf"
LOG_FILE="/tmp/telegraf.log"

# ----------------------------------------------------------------------------
# Preflight: cek TTY & sudo availability
# ----------------------------------------------------------------------------
if [ ! -t 0 ]; then
  echo "[FATAL] Script harus dijalankan dari terminal interaktif (TTY)."
  echo "        sudo butuh TTY untuk membaca password."
  echo "        Buka terminal baru dan jalankan script langsung dari sana."
  exit 2
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "[FATAL] sudo tidak terinstall. Install dengan: sudo apt install sudo"
  exit 2
fi

# Test sudo (akan prompt password jika perlu)
if ! sudo -v 2>/dev/null; then
  echo "[FATAL] sudo authentication gagal atau tidak tersedia."
  echo "        Opsi:"
  echo "        1) Masukkan password sudo yang benar"
  echo "        2) Setup NOPASSWD: edit /etc/sudoers via 'sudo visudo'"
  echo "           tambahkan:  $USER ALL=(root) NOPASSWD: /usr/bin/kill, $TELEGRAF_BIN"
  exit 2
fi

# ----------------------------------------------------------------------------
# Step 1: Kill Telegraf lama (jika ada)
# ----------------------------------------------------------------------------
TELEGRAF_PID=$(pgrep -f "telegraf --config-directory" 2>/dev/null | tail -1 || true)

if [ -n "$TELEGRAF_PID" ]; then
  echo "[INFO] Ditemukan proses Telegraf lama PID=$TELEGRAF_PID, mengirim SIGTERM..."
  sudo kill -TERM "$TELEGRAF_PID" 2>/dev/null || true

  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! sudo kill -0 "$TELEGRAF_PID" 2>/dev/null; then
      echo "[OK] Telegraf lama berhasil dihentikan."
      break
    fi
    sleep 1
  done

  if sudo kill -0 "$TELEGRAF_PID" 2>/dev/null; then
    echo "[WARN] SIGTERM tidak responsif, mengirim SIGKILL..."
    sudo kill -9 "$TELEGRAF_PID" 2>/dev/null || true
    sleep 1
  fi
else
  echo "[INFO] Tidak ada proses Telegraf lama yang sedang berjalan."
fi

# ----------------------------------------------------------------------------
# Step 2: Verify Telegraf binary & config exist
# ----------------------------------------------------------------------------
if [ ! -x "$TELEGRAF_BIN" ]; then
  echo "[FATAL] Telegraf binary tidak ditemukan di $TELEGRAF_BIN"
  echo "        Cek instalasi: which telegraf"
  exit 2
fi

if [ ! -d "$TELEGRAF_CONF_DIR" ]; then
  echo "[FATAL] Config directory tidak ada: $TELEGRAF_CONF_DIR"
  exit 2
fi

# ----------------------------------------------------------------------------
# Step 3: Start Telegraf dengan config terbaru
# ----------------------------------------------------------------------------
echo "[INFO] Memulai Telegraf dari $TELEGRAF_CONF_DIR ..."
cd "$PROJECT_DIR"
: > "$LOG_FILE"  # truncate log
sudo nohup "$TELEGRAF_BIN" --config-directory "$TELEGRAF_CONF_DIR" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
disown
echo "[INFO] PID baru (sementara): $NEW_PID"

# ----------------------------------------------------------------------------
# Step 4: VERIFIKASI REAL - bukan cuma PID exist
# ----------------------------------------------------------------------------
echo "[INFO] Verifikasi Telegraf benar-benar jalan..."
TELEGRAF_REAL_PID=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  # Cari PID yang memiliki comm="telegraf" (bukan sudo wrapper)
  TELEGRAF_REAL_PID=$(pgrep -f "telegraf --config-directory" 2>/dev/null | while read p; do
    if [ -r "/proc/$p/comm" ] && [ "$(cat /proc/$p/comm 2>/dev/null)" = "telegraf" ]; then
      echo "$p"
      break
    fi
  done | head -1)

  if [ -n "$TELEGRAF_REAL_PID" ]; then
    # Double check masih hidup
    if sudo kill -0 "$TELEGRAF_REAL_PID" 2>/dev/null; then
      break
    fi
  fi
done

echo
if [ -n "$TELEGRAF_REAL_PID" ]; then
  echo "============================================================"
  echo "[OK] Telegraf berhasil direstart."
  echo "     Real PID: $TELEGRAF_REAL_PID (binary telegraf)"
  echo "     Config:   $TELEGRAF_CONF_DIR"
  echo "     Log:      $LOG_FILE"
  echo "     Monitor:  tail -f $LOG_FILE"
  echo "============================================================"
  echo
  echo "Config yang dimuat:"
  ls -la "$TELEGRAF_CONF_DIR"/*.conf 2>/dev/null | awk '{print "  - " $9 " (" $5 " bytes)"}'
  echo
  echo "[INFO] SNMP/ICMP butuh ~5-10 detik untuk first walk."
  echo "[INFO] Cek data InfluxDB setelah 15 detik via dashboard."
else
  echo "============================================================"
  echo "[FATAL] Telegraf GAGAL start."
  echo "============================================================"
  echo
  echo "Log telegraf (kemungkinan error):"
  tail -30 "$LOG_FILE" 2>/dev/null
  echo
  echo "Common causes:"
  echo "  1. Config syntax error di telegraf.d/*.conf"
  echo "  2. InfluxDB tidak reachable (cek INFLUX_URL/TOKEN/ORG/BUCKET di .env)"
  echo "  3. Permission issue (Telegraf run as root, file harus readable)"
  echo
  echo "Test manual:"
  echo "  sudo $TELEGRAF_BIN --config-directory $TELEGRAF_CONF_DIR --test"
  exit 1
fi
