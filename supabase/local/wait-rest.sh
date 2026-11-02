#!/usr/bin/env bash
# After up.sh rebuilds the database, PostgREST reconnects with a back-off; wait until it answers again (max 60 s).
for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "${LOCAL_REST_URL:-http://127.0.0.1:3001}/" || true)
  if [ "$code" = 200 ]; then
    # PostgREST may have read the schema while the migrations were still running: make it read it again.
    psql -X -q -d "${LOCAL_DB:-elm_local}" -c "notify pgrst, 'reload schema'" >/dev/null 2>&1 || true
    sleep 1.5
    exit 0
  fi
  sleep 0.5
done
echo "PostgREST did not come back after the database rebuild" >&2; exit 1
