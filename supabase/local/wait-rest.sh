#!/usr/bin/env bash
# After up.sh rebuilds the database, PostgREST reconnects with a back-off; wait until it answers again (max 60 s).
for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "${LOCAL_REST_URL:-http://127.0.0.1:3001}/" || true)
  [ "$code" = 200 ] && exit 0
  sleep 0.5
done
echo "PostgREST did not come back after the database rebuild" >&2; exit 1
