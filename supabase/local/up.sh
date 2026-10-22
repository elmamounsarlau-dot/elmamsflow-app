#!/usr/bin/env bash
# Local test stack for UI / end-to-end checks: Postgres (all migrations + synthetic seed) → PostgREST → gateway.
# Needs: a local Postgres you can create databases on (PGPORT), the postgrest binary (POSTGREST_BIN), node.
# Never point any of this at production.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
db="${LOCAL_DB:-elm_local}"
export LOCAL_JWT_SECRET="${LOCAL_JWT_SECRET:-local-only-jwt-secret-0123456789-abcdef}"
psql_() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

dropdb --if-exists --force "$db" >/dev/null 2>&1 || true
createdb "$db"
psql_ -d "$db" -f "$here/../tests/00_supabase_stub.sql" >/dev/null
for m in "$here"/../migrations/*.sql; do psql_ -d "$db" -f "$m" >/dev/null; done
psql_ -d "$db" -f "$here/seed.sql" >/dev/null
psql_ -d "$db" -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then
  create role authenticator login password 'authenticator' noinherit; end if; end \$\$;
  grant anon, authenticated, service_role to authenticator;" >/dev/null

conf="${POSTGREST_CONF:-/tmp/elm-postgrest.conf}"
cat > "$conf" <<CONF
db-uri = "postgres://authenticator:authenticator@127.0.0.1:${PGPORT:-5432}/$db"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$LOCAL_JWT_SECRET"
server-port = 3001
db-max-rows = 1000
CONF
echo "database $db ready; PostgREST config at $conf"
