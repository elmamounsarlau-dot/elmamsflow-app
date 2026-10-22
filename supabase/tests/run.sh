#!/usr/bin/env bash
# Database test suite: fresh database, every migration in order, then the checks in tests.sql.
# Usage: PGPORT=5499 supabase/tests/run.sh   (needs a local Postgres you can create databases on)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
db="elm_test_$$"
psql_() { psql -v ON_ERROR_STOP=1 -q -X "$@"; }
createdb "$db"
trap 'dropdb --if-exists "$db" >/dev/null 2>&1 || true' EXIT
psql_ -d "$db" -f "$here/00_supabase_stub.sql" >/dev/null
for m in "$here"/../migrations/*.sql; do
  echo "migrate $(basename "$m")"
  psql_ -d "$db" -f "$m" >/dev/null
done
psql_ -d "$db" -f "$here/tests.sql" >/dev/null
bash "$here/concurrency.sh" "$db"
psql -X -d "$db" -At -F ' | ' -c "select case when ok then 'PASS' else 'FAIL' end, name, coalesce(detail,'') from t.results order by id"
fails=$(psql -X -d "$db" -Atc "select count(*) from t.results where not ok")
total=$(psql -X -d "$db" -Atc "select count(*) from t.results")
echo "-----"
echo "$((total - fails)) passed, $fails failed, $total total"
[ "$fails" = 0 ]
