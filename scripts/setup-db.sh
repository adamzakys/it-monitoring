#!/usr/bin/env bash
# ITNETMON Database Setup Script
set -e

DB_NAME=${PG_DATABASE:-itnetmon}
DB_USER=${PG_USER:-postgres}
DB_HOST=${PG_HOST:-127.0.0.1}
DB_PORT=${PG_PORT:-5432}

echo "=== ITNETMON PostgreSQL Setup ==="
echo "Target: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

# Check if database exists, create if not
if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -lqt | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
    echo "[OK] Database '$DB_NAME' already exists."
else
    echo "[INFO] Creating database '$DB_NAME'..."
    createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" || true
fi

echo "[INFO] Applying schema..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$(dirname "$0")/../src/db/schema.sql"

echo "=== Setup Completed Successfully ==="
