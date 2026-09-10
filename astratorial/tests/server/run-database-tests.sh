#!/usr/bin/env bash
set -euo pipefail
# Requires local PostgreSQL binaries. Never connects to an existing database.
TASK_TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASK_PG_DIR="$(mktemp -d /tmp/astratorial-pg.XXXXXX)"
trap 'pg_ctl -D "$TASK_PG_DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TASK_PG_DIR"' EXIT
initdb -D "$TASK_PG_DIR/data" -A trust --no-locale >/dev/null
pg_ctl -D "$TASK_PG_DIR/data" -l "$TASK_PG_DIR/postgres.log" -o "-k $TASK_PG_DIR -c listen_addresses='' -c unix_socket_permissions=0700" start >/dev/null
psql -h "$TASK_PG_DIR" -d postgres -v ON_ERROR_STOP=1 -q -f "$TASK_TEST_ROOT/tests/server/database-bootstrap.sql" >/dev/null
# pgmq is not bundled with local PostgreSQL: the bootstrap supplies a queue double.
sed '/create extension if not exists pgmq;/d' "$TASK_TEST_ROOT/supabase/migrations/202609100001_astratorial.sql" > "$TASK_PG_DIR/migration.sql"
psql -h "$TASK_PG_DIR" -d postgres -v ON_ERROR_STOP=1 -q -f "$TASK_PG_DIR/migration.sql" >/dev/null
psql -h "$TASK_PG_DIR" -d postgres -v ON_ERROR_STOP=1 -q -f "$TASK_TEST_ROOT/tests/server/database.sql"
