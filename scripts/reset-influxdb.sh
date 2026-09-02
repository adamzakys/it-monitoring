#!/bin/bash
# ============================================================================
# ITNETMON InfluxDB Re-Token Helper (Robust)
# ----------------------------------------------------------------------------
# Jika token InfluxDB di .env sudah invalid, script ini akan:
# 1. Test apakah setup sudah pernah dilakukan (allowed=false)
# 2. Jika ya: minta password user existing, sign in, lalu create token baru
# 3. Jika belum: initial setup dengan user/password baru
# 4. Update token ke .env
#
# Cara pakai (HARUS dari terminal TTY interaktif):
#   cd /home/urzection/Documents/it-monitoring
#   ./scripts/reset-influxdb.sh
# ============================================================================

set -e

if [ ! -t 0 ]; then
  echo "[FATAL] Script harus dijalankan dari terminal interaktif (TTY)."
  exit 2
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "[FATAL] sudo tidak tersedia."
  exit 2
fi

if ! sudo -v 2>/dev/null; then
  echo "[FATAL] sudo authentication gagal."
  exit 2
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# Load existing InfluxDB config
INFLUX_URL=$(grep -E "^INFLUX_URL=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "http://127.0.0.1:8086")
INFLUX_ORG=$(grep -E "^INFLUX_ORG=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "itnetmon")
INFLUX_BUCKET=$(grep -E "^INFLUX_BUCKET=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "itnetmon_metrics")

echo "=========================================="
echo "ITNETMON InfluxDB Re-Token Helper"
echo "=========================================="
echo
echo "Target InfluxDB:"
echo "  URL:    $INFLUX_URL"
echo "  Org:    $INFLUX_ORG"
echo "  Bucket: $INFLUX_BUCKET"
echo
echo "Skrip ini akan MENDAPATKAN TOKEN BARU yang valid untuk InfluxDB ini."
echo "Time-series data historis TIDAK dihapus (token-based access only)."
echo

# ----------------------------------------------------------------------------
# Step 1: Check onboarding state
# ----------------------------------------------------------------------------
echo "[STEP 1] Cek status onboarding InfluxDB..."
SETUP_STATE=$(curl -s "$INFLUX_URL/api/v2/setup" 2>/dev/null)
SETUP_ALLOWED=$(echo "$SETUP_STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('allowed', False))" 2>/dev/null || echo "false")

if [ "$SETUP_ALLOWED" = "True" ] || [ "$SETUP_ALLOWED" = "true" ]; then
  echo "[INFO] Onboarding BELUM dilakukan. Akan initial setup."
  echo
  read -p "Admin username [admin]: " ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-admin}
  read -s -p "Admin password (min 8 chars): " ADMIN_PASS
  echo
  read -s -p "Confirm password: " ADMIN_PASS2
  echo
  if [ "$ADMIN_PASS" != "$ADMIN_PASS2" ]; then
    echo "[FATAL] Password tidak cocok"
    exit 1
  fi
  if [ ${#ADMIN_PASS} -lt 8 ]; then
    echo "[FATAL] Password minimal 8 karakter"
    exit 1
  fi

  # Get org & bucket from existing .env, or use defaults
  ORG_NAME="$INFLUX_ORG"
  BUCKET_NAME="$INFLUX_BUCKET"
  RETENTION_SECONDS=2592000  # 30 days

  echo "[INFO] Setup dengan user=$ADMIN_USER org=$ORG_NAME bucket=$BUCKET_NAME ..."
  SETUP_RESPONSE=$(curl -s -X POST "$INFLUX_URL/api/v2/setup" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"$ADMIN_USER\",
      \"password\": \"$ADMIN_PASS\",
      \"org\": \"$ORG_NAME\",
      \"bucket\": \"$BUCKET_NAME\",
      \"retentionPeriodSeconds\": $RETENTION_SECONDS
    }")
  echo "Response:"
  echo "$SETUP_RESPONSE" | python3 -m json.tool 2>&1 | head -25

  NEW_TOKEN=$(echo "$SETUP_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('auth',{}).get('token',''))" 2>/dev/null)

  if [ -z "$NEW_TOKEN" ]; then
    echo
    echo "[FATAL] Setup gagal atau token tidak ada di response."
    echo "Response lengkap: $SETUP_RESPONSE"
    exit 1
  fi
else
  echo "[INFO] Onboarding SUDAH dilakukan. Akan sign-in dengan user existing + create token baru."
  echo
  read -p "InfluxDB admin username (yang dibuat saat setup awal): " ADMIN_USER
  if [ -z "$ADMIN_USER" ]; then
    echo "[FATAL] Username tidak boleh kosong"
    exit 1
  fi
  read -s -p "Admin password: " ADMIN_PASS
  echo

  # 1. Sign in untuk dapat session
  echo "[INFO] Signing in as $ADMIN_USER..."
  SIGNIN_RESPONSE=$(curl -s -i -X POST "$INFLUX_URL/api/v2/auth/signin" \
    -H "Content-Type: application/json" \
    -d "{\"username\": \"$ADMIN_USER\", \"password\": \"$ADMIN_PASS\"")

  # Extract Set-Cookie header
  SESSION_COOKIE=$(echo "$SIGNIN_RESPONSE" | grep -i "^Set-Cookie:" | head -1 | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)

  if [ -z "$SESSION_COOKIE" ]; then
    echo
    echo "[FATAL] Login gagal. Username/password salah."
    echo
    echo "Response: $(echo "$SIGNIN_RESPONSE" | head -5)"
    echo
    echo "=========================================="
    echo "FULL RESET OPTION"
    echo "=========================================="
    echo "Karena password admin tidak diketahui, Anda butuh FULL RESET:"
    echo "  1. Stop InfluxDB:       sudo systemctl stop influxdb"
    echo "  2. Hapus semua data:   sudo rm -rf /var/lib/influxdb/*"
    echo "  3. Start InfluxDB:      sudo systemctl start influxdb"
    echo "  4. Tunggu ~5 detik"
    echo "  5. Jalankan script ini lagi — onboarding akan BELUM dilakukan"
    echo "     sehingga step 'yes' akan membuat user baru"
    echo
    echo "ATAU coba dengan sudo bash untuk auto-cleanup:"
    echo "  sudo bash -c 'systemctl stop influxdb && rm -rf /var/lib/influxdb/* && systemctl start influxdb && sleep 5'"
    echo "  (lalu jalankan script ini lagi)"
    exit 1
  fi
  echo "[OK] Login berhasil."

  # 2. Verify session dengan /api/v2/me
  ME=$(curl -s -H "Cookie: $SESSION_COOKIE" "$INFLUX_URL/api/v2/me")
  echo "[OK] Session valid: $(echo "$ME" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('username','?'))" 2>/dev/null)"

  # 3. Get org ID
  ORG_RESP=$(curl -s -H "Cookie: $SESSION_COOKIE" "$INFLUX_URL/api/v2/orgs?org=$INFLUX_ORG")
  ORG_ID=$(echo "$ORG_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); orgs=d.get('orgs',[]); print(orgs[0]['id']) if orgs else print('')" 2>/dev/null)
  if [ -z "$ORG_ID" ]; then
    echo "[FATAL] Org '$INFLUX_ORG' tidak ditemukan."
    echo "Available orgs:"
    curl -s -H "Cookie: $SESSION_COOKIE" "$INFLUX_URL/api/v2/orgs" | python3 -m json.tool
    exit 1
  fi
  echo "[OK] Org '$INFLUX_ORG' ID: $ORG_ID"

  # 4. Create new authorization (token) with all permissions
  echo "[INFO] Creating new operator token..."
  AUTH_RESPONSE=$(curl -s -X POST "$INFLUX_URL/api/v2/authorizations" \
    -H "Cookie: $SESSION_COOKIE" \
    -H "Content-Type: application/json" \
    -d "{
      \"orgID\": \"$ORG_ID\",
      \"description\": \"ITNETMON Operator Token (auto-generated $(date -u +%Y-%m-%dT%H:%M:%SZ))\",
      \"permissions\": [
        {\"action\": \"read\",  \"resource\": {\"type\": \"buckets\"}},
        {\"action\": \"write\", \"resource\": {\"type\": \"buckets\"}},
        {\"action\": \"read\",  \"resource\": {\"type\": \"orgs\"}},
        {\"action\": \"write\", \"resource\": {\"type\": \"orgs\"}},
        {\"action\": \"read\",  \"resource\": {\"type\": \"telegrafs\"}},
        {\"action\": \"write\", \"resource\": {\"type\": \"telegrafs\"}},
        {\"action\": \"read\",  \"resource\": {\"type\": \"authorizations\"}},
        {\"action\": \"write\", \"resource\": {\"type\": \"authorizations\"}}
      ]
    }")

  NEW_TOKEN=$(echo "$AUTH_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
  if [ -z "$NEW_TOKEN" ]; then
    echo "[FATAL] Create token gagal."
    echo "Response: $AUTH_RESPONSE"
    exit 1
  fi
  echo "[OK] Token baru dibuat."
fi

echo
echo "=========================================="
echo "[OK] TOKEN BARU:"
echo "      $NEW_TOKEN"
echo "=========================================="
echo

# ----------------------------------------------------------------------------
# Update .env
# ----------------------------------------------------------------------------
echo "[STEP 2] Update .env dengan token baru..."
cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d_%H%M%S)"

if grep -q "^INFLUX_TOKEN=" "$ENV_FILE"; then
  # Use python for safe replacement to avoid sed escaping issues
  python3 -c "
import re
with open('$ENV_FILE', 'r') as f: content = f.read()
new_content = re.sub(r'^INFLUX_TOKEN=.*$', 'INFLUX_TOKEN=$NEW_TOKEN', content, flags=re.MULTILINE)
with open('$ENV_FILE', 'w') as f: f.write(new_content)
"
  echo "[OK] INFLUX_TOKEN replaced"
else
  echo "INFLUX_TOKEN=$NEW_TOKEN" >> "$ENV_FILE"
  echo "[OK] INFLUX_TOKEN appended"
fi

# Verify
echo
echo "Verify .env:"
grep "^INFLUX_" "$ENV_FILE" | head -5

# ----------------------------------------------------------------------------
# Test new token
# ----------------------------------------------------------------------------
echo
echo "[STEP 3] Test token baru..."
TEST=$(curl -s -H "Authorization: Token $NEW_TOKEN" "$INFLUX_URL/api/v2/me")
# InfluxDB returns {"id":"...","name":"admin",...} (field 'name', not 'username')
# So check for both "name" or "username" to be robust
if echo "$TEST" | grep -qE '"(name|username)"'; then
  USERNAME=$(echo "$TEST" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('username') or d.get('name') or '?')" 2>/dev/null)
  echo "[OK] Token valid: user=$USERNAME"
else
  echo "[WARN] Token tidak valid? Response: $TEST"
fi

echo
echo "=========================================="
echo "[OK] InfluxDB re-token selesai!"
echo "=========================================="
echo
echo "Next steps:"
echo "  1. Restart server ITNETMON:  pkill -f 'node.*server.js' && cd $PROJECT_DIR && npm start"
echo "  2. Restart Telegraf:         $PROJECT_DIR/scripts/restart-telegraf.sh"
echo "  3. Verify di dashboard:      http://localhost:3000 → Settings"
echo
