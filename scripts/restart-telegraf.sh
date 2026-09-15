#!/usr/bin/env bash
# ============================================================================
# ITNETMON Telegraf Restart Helper
# ----------------------------------------------------------------------------
# Telegraf kini dikelola systemd (telegraf.service) dan membaca konfigurasi
# dari /etc/telegraf/telegraf.d (di-generate oleh src/services/telegrafManager.js).
# Script ini hanya membungkus siklus restart standar agar tidak pernah ada dua
# proses telegraf (systemd + nohup manual) yang saling menimpa.
#
# Cara pakai:
#   ./scripts/restart-telegraf.sh
# ============================================================================
set -euo pipefail

CONF_DIR="${TELEGRAF_CONF_DIR:-/etc/telegraf/telegraf.d}"

if ! systemctl is-enabled telegraf >/dev/null 2>&1; then
  echo "[FATAL] Unit telegraf.service tidak enabled. Jalankan: sudo systemctl enable --now telegraf"
  exit 1
fi

echo "=== ITNETMON Telegraf restart ==="
sudo systemctl restart telegraf

systemctl --no-pager --full status telegraf | head -12

echo
echo "Config dimuat dari: $CONF_DIR"
ls -la "$CONF_DIR"/*.conf 2>/dev/null | awk '{print "  - " $9 " (" $5 " bytes)"}'
echo
echo "[OK] Telegraf direstart via systemd."
