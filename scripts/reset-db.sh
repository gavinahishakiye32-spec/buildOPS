#!/usr/bin/env bash
#
# Reset the development database to empty and let the API rebuild it.
#
# The API owns the schema: it runs `migrationsRun` on boot, so dropping the
# database and restarting is enough to get every migration applied again in
# order. Nothing else needs to be applied by hand.
#
#   ./scripts/reset-db.sh              # back up, drop, recreate, restart the API
#   ./scripts/reset-db.sh --no-backup  # same, without writing a dump
#   ./scripts/reset-db.sh --no-start   # reset the database, leave the API alone
#   ./scripts/reset-db.sh --help
#
# Destructive: every row in the database named by DB_DATABASE is lost. A dump is
# written to .resets/ first unless --no-backup is passed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP=1
START=1

for arg in "$@"; do
  case "$arg" in
    --no-backup) BACKUP=0 ;;
    --no-start) START=0 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ── configuration ────────────────────────────────────────────────────────────

if [[ ! -f .env ]]; then
  echo "No .env in $ROOT — the API reads its database config from there." >&2
  exit 1
fi

# Read one key out of .env without sourcing the file: it holds values (a
# password, a URL) that are not valid shell, and sourcing it would run them.
env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env | tail -1
}

DB_HOST="$(env_value DB_HOST)"
DB_PORT="$(env_value DB_PORT)"
DB_USERNAME="$(env_value DB_USERNAME)"
DB_PASSWORD="$(env_value DB_PASSWORD)"
DB_NAME="$(env_value DB_DATABASE)"
PORT="$(env_value PORT)"
export PGPASSWORD="$DB_PASSWORD"

for pair in "DB_HOST:$DB_HOST" "DB_PORT:$DB_PORT" "DB_USERNAME:$DB_USERNAME" "DB_NAME:$DB_NAME"; do
  if [[ -z "${pair#*:}" ]]; then
    echo "${pair%%:*} is not set in .env." >&2
    exit 1
  fi
done

command -v psql >/dev/null || { echo "psql not found — install the postgres client." >&2; exit 1; }

psql_admin() {
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d postgres -v ON_ERROR_STOP=1 "$@"
}

echo "→ database: $DB_NAME on $DB_HOST:$DB_PORT"

# ── 1. back it up ─────────────────────────────────────────────────────────────

if [[ "$BACKUP" == 1 ]] && command -v pg_dump >/dev/null; then
  mkdir -p .resets
  DUMP=".resets/${DB_NAME}-$(date +%Y%m%d-%H%M%S).dump"
  if pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_NAME" -Fc -f "$DUMP"; then
    echo "→ backed up to $DUMP"
    echo "  restore with: pg_restore -h $DB_HOST -p $DB_PORT -U $DB_USERNAME -d $DB_NAME --clean '$DUMP'"
  else
    echo "  (pg_dump failed — continuing without a backup)" >&2
  fi
fi

# ── 2. drop and recreate ──────────────────────────────────────────────────────

# The running API holds a connection pool, and PostgreSQL refuses to drop a
# database that still has sessions on it. Terminating them is what lets this run
# while `npm run start:dev` is up; TypeORM reconnects on the next request.
psql_admin -q -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null

psql_admin -q -c "DROP DATABASE IF EXISTS \"${DB_NAME}\";"
psql_admin -q -c "CREATE DATABASE \"${DB_NAME}\";"
echo "→ dropped and recreated $DB_NAME (empty)"

# ── 3. restart the API so the migrations run ──────────────────────────────────

if [[ "$START" == 0 ]]; then
  echo "→ --no-start: start the API yourself to apply the migrations."
  exit 0
fi

# Stopped first so the old process cannot reconnect to the new database and
# re-run anything against it.
pkill -f "nest start" 2>/dev/null || true
sleep 2

LOG=".resets/api.log"
mkdir -p .resets
setsid nohup npm run start:dev > "$LOG" 2>&1 < /dev/null &
echo "→ starting the API (log: $LOG)"

# ── 4. wait for it, and confirm the schema came back ──────────────────────────

BASE="http://localhost:${PORT:-3000}/api/v1"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$BASE/plans" 2>/dev/null; then break; fi
  sleep 1
done

if ! curl -fsS -o /dev/null "$BASE/plans" 2>/dev/null; then
  echo "The API did not come up. See $LOG — the migrations most likely failed." >&2
  exit 1
fi

echo "→ API up on :$PORT"

psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_NAME" -tAc \
  "SELECT 'migrations applied: ' || count(*) FROM migrations;" 2>/dev/null | sed 's/^/  /' || true
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_NAME" -tAc \
  "SELECT 'tables: ' || count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | sed 's/^/  /' || true
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USERNAME" -d "$DB_NAME" -tAc \
  "SELECT 'plans seeded: ' || count(*) FROM plans;" 2>/dev/null | sed 's/^/  /' || true

echo
echo "Done. Sign up again — any session token you hold now points at a deleted user."