#!/usr/bin/env bash
# Concurrency checks: real parallel sessions against the same rows.
set -euo pipefail
db="$1"
WH="00000000-0000-0000-0000-0000000000a3"
P1="a0000000-0000-0000-0000-000000000001"
q() { psql -X -q -d "$db" -v ON_ERROR_STOP=0 "$@"; }
as_wh="set role authenticated; select set_config('request.jwt.claim.sub', '$WH', false);"
onhand() { psql -X -d "$db" -Atc "select on_hand from public.product_stock where id = '$P1'"; }
record() { psql -X -q -d "$db" -c "select t.ok(\$\$$1\$\$, $2, \$\$$3\$\$)" >/dev/null; }

# 1) Two warehouse sessions each remove 60 units at the same moment from 90 on hand.
#    Only one may succeed; stock must never go below zero.
start=$(onhand)
for i in 1 2; do
  q -c "$as_wh begin; select public.adjust_stock('$P1', -60, 'race $i'); select pg_sleep(1); commit;" >/dev/null 2>&1 &
done
wait
end=$(onhand)
record "concurrency: two simultaneous -60 adjustments from $start never go below zero" "$end >= 0 and $end = $start - 60" "start $start, end $end"

# 2) Two sessions receive the same inbound at the same time: units must be posted once.
psql -X -q -d "$db" -c "insert into public.inbounds (id, org_id, ref) values ('1c000000-0000-0000-0000-0000000000c1', '11111111-1111-1111-1111-111111111111', 'IB-RACE');
  insert into public.inbound_items (id, inbound_id, product_id, expected) values ('1d000000-0000-0000-0000-0000000000c1', '1c000000-0000-0000-0000-0000000000c1', '$P1', 40);" >/dev/null
start=$(onhand)
for i in 1 2; do
  q -c "$as_wh begin; select public.receive_inbound('1c000000-0000-0000-0000-0000000000c1', '{\"1d000000-0000-0000-0000-0000000000c1\": 40}'::jsonb); select pg_sleep(1); commit;" >/dev/null 2>&1 &
done
wait
end=$(onhand)
record "concurrency: simultaneous double receipt posts the units once" "$end = $start + 40" "start $start, end $end"

# 3) Shipping and a stock correction at the same moment must not drive stock negative.
psql -X -q -d "$db" -c "insert into public.orders (id, org_id, customer, address, country) values ('0a000000-0000-0000-0000-0000000000c1', '11111111-1111-1111-1111-111111111111', 'Race', 'x', 'FR');
  insert into public.order_items (order_id, product_id, qty) select '0a000000-0000-0000-0000-0000000000c1', '$P1', on_hand - 5 from public.product_stock where id = '$P1';" >/dev/null
start=$(onhand)
q -c "$as_wh begin; select public.set_order_status('0a000000-0000-0000-0000-0000000000c1', 'shipped', 'X', 'RACE1'); select pg_sleep(1); commit;" >/dev/null 2>&1 &
sleep 0.2
q -c "$as_wh begin; select public.adjust_stock('$P1', -$((start - 2)), 'race correction'); commit;" >/dev/null 2>&1 &
wait
end=$(onhand)
record "concurrency: ship + correction at the same time never go below zero" "$end >= 0" "start $start, end $end"

# 4) The same order shipped by two people at once is deducted once.
psql -X -q -d "$db" -c "select public.adjust_stock('$P1', 20, 'top up') from (select set_config('request.jwt.claim.sub', '$WH', false)) s;
  insert into public.orders (id, org_id, customer, address, country) values ('0a000000-0000-0000-0000-0000000000c2', '11111111-1111-1111-1111-111111111111', 'Race2', 'x', 'FR');
  insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000c2', '$P1', 3);" >/dev/null 2>&1
start=$(onhand)
for i in 1 2; do
  q -c "$as_wh begin; select public.set_order_status('0a000000-0000-0000-0000-0000000000c2', 'shipped', 'X', 'DUP$i'); select pg_sleep(1); commit;" >/dev/null 2>&1 &
done
wait
end=$(onhand)
record "concurrency: same order shipped twice at once is deducted once" "$end = $start - 3" "start $start, end $end"

# 5) Two different orders for the last units of a product, shipped at the same moment: only one may go.
psql -X -q -d "$db" -c "insert into public.orders (id, org_id, customer, address, country) values
    ('0a000000-0000-0000-0000-0000000000c3', '11111111-1111-1111-1111-111111111111', 'Race3', 'x', 'FR'),
    ('0a000000-0000-0000-0000-0000000000c4', '11111111-1111-1111-1111-111111111111', 'Race4', 'x', 'FR');
  insert into public.order_items (order_id, product_id, qty) select o, '$P1', greatest(on_hand - quarantined, 1) from public.product_stock, unnest(array['0a000000-0000-0000-0000-0000000000c3'::uuid, '0a000000-0000-0000-0000-0000000000c4'::uuid]) o where id = '$P1';" >/dev/null
start=$(onhand)
for o in c3 c4; do
  q -c "$as_wh begin; select public.set_order_status('0a000000-0000-0000-0000-0000000000$o', 'shipped', 'X', 'LAST$o'); select pg_sleep(1); commit;" >/dev/null 2>&1 &
done
wait
end=$(onhand)
sell=$(psql -X -d "$db" -Atc "select qty from public.order_items where order_id = '0a000000-0000-0000-0000-0000000000c3'")
record "concurrency: two orders each wanting all $sell sellable units, shipped at once: exactly one ships" "$end = $start - $sell" "start $start, end $end, each order $sell"
