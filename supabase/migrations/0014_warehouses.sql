-- =====================================================================
-- 0014 — Stock per warehouse (Guangzhou, Ningbo, and any future warehouse)
--
--  * Every stock movement belongs to one warehouse. Balances are kept per product AND per warehouse.
--  * Inbounds name the warehouse that receives them; orders name the warehouse that ships them.
--    An order can only ship from stock physically at its own warehouse.
--  * Transfers between warehouses are documented (who, why, what, sent / received) and move stock
--    in two steps: out of the sender when dispatched, into the receiver when counted on arrival.
--
--  Existing stock: nothing is guessed. Every movement recorded before this migration is placed in a
--  holding location "Unallocated (before warehouses)". Totals don't change. The owner then moves units
--  to Guangzhou or Ningbo with an *allocation* that records the evidence (warehouse count, message).
--  Until allocated, those units can't ship.
-- =====================================================================

-- ---------- Warehouses ----------
create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{2,10}$'),
  name text not null,
  city text,
  province text,
  country text not null default 'CN',
  kind text not null default 'physical' check (kind in ('physical', 'holding')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.warehouses enable row level security;
drop policy if exists warehouse_read on public.warehouses;
create policy warehouse_read on public.warehouses for select using (auth.uid() is not null);
-- Changes go through the server (owner only).

insert into public.warehouses (code, name, city, province, kind) values
  ('GZ', 'Guangzhou', 'Guangzhou', 'Guangdong', 'physical'),
  ('NB', 'Ningbo', 'Ningbo', 'Zhejiang', 'physical'),
  ('UNALLOC', 'Unallocated (before warehouses)', null, null, 'holding')
on conflict (code) do nothing;

create or replace function public.holding_warehouse() returns uuid language sql stable as $$
  select id from public.warehouses where code = 'UNALLOC'
$$;

-- ---------- Warehouse on movements, inbounds, orders, clients ----------
alter table public.stock_moves add column if not exists warehouse_id uuid references public.warehouses (id);
update public.stock_moves set warehouse_id = public.holding_warehouse() where warehouse_id is null;
alter table public.stock_moves alter column warehouse_id set not null;
create index if not exists stock_moves_product_wh on public.stock_moves (product_id, warehouse_id);

alter table public.inbounds add column if not exists warehouse_id uuid references public.warehouses (id);
update public.inbounds set warehouse_id = public.holding_warehouse() where status = 'received' and warehouse_id is null;

alter table public.orders add column if not exists warehouse_id uuid references public.warehouses (id);
update public.orders set warehouse_id = public.holding_warehouse() where stock_out and warehouse_id is null;

alter table public.organizations add column if not exists default_warehouse_id uuid references public.warehouses (id);

alter table public.stock_moves drop constraint if exists stock_moves_type_check;
alter table public.stock_moves add constraint stock_moves_type_check
  check (type in ('inbound', 'order', 'adjust', 'count', 'quarantine', 'release', 'transfer_out', 'transfer_in'));

-- New orders take their client's default warehouse unless one is given.
create or replace function public.orders_default_warehouse() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.warehouse_id is null then
    select default_warehouse_id into new.warehouse_id from organizations where id = new.org_id;
  end if;
  return new;
end $$;
drop trigger if exists orders_default_warehouse on public.orders;
create trigger orders_default_warehouse before insert on public.orders
  for each row execute function public.orders_default_warehouse();

-- ---------- Balances ----------
-- Physical units = inbound, order, adjust, count and transfers; quarantine is a part of them set aside.
create or replace function public._on_hand(p_product uuid) returns integer language sql stable as $$
  select coalesce(sum(qty), 0)::int from stock_moves
  where product_id = p_product and type in ('inbound', 'order', 'adjust', 'count', 'transfer_out', 'transfer_in')
$$;
create or replace function public._on_hand_wh(p_product uuid, p_wh uuid) returns integer language sql stable as $$
  select coalesce(sum(qty), 0)::int from stock_moves
  where product_id = p_product and warehouse_id = p_wh and type in ('inbound', 'order', 'adjust', 'count', 'transfer_out', 'transfer_in')
$$;
create or replace function public._quarantined_wh(p_product uuid, p_wh uuid) returns integer language sql stable as $$
  select coalesce(sum(qty), 0)::int from stock_moves where product_id = p_product and warehouse_id = p_wh and type in ('quarantine', 'release')
$$;
-- Units promised to open orders assigned to this warehouse.
create or replace function public._reserved_wh(p_product uuid, p_wh uuid) returns integer language sql stable as $$
  select coalesce(sum(i.qty), 0)::int from order_items i join orders o on o.id = i.order_id
  where i.product_id = p_product and o.warehouse_id = p_wh and o.status in ('new', 'on_hold', 'packed')
$$;
revoke all on function public._on_hand_wh, public._quarantined_wh, public._reserved_wh from public, anon;

-- ---------- Transfers ----------
create sequence if not exists public.transfer_seq start 1;
create table if not exists public.transfers (
  id uuid primary key default gen_random_uuid(),
  ref text not null default ('TR-' || lpad(nextval('public.transfer_seq')::text, 4, '0')) unique,
  org_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null default 'transfer' check (kind in ('transfer', 'allocation')),
  from_warehouse_id uuid not null references public.warehouses (id),
  to_warehouse_id uuid not null references public.warehouses (id),
  status text not null default 'requested' check (status in ('requested', 'in_transit', 'received', 'cancelled')),
  reason text not null check (length(trim(reason)) > 0),
  evidence text,
  carrier text,
  tracking text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  dispatched_by uuid references auth.users (id),
  dispatched_at timestamptz,
  received_by uuid references auth.users (id),
  received_at timestamptz,
  check (from_warehouse_id <> to_warehouse_id)
);
create table if not exists public.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers (id) on delete cascade,
  product_id uuid not null references public.products (id),
  qty integer not null check (qty > 0),
  received integer not null default 0 check (received >= 0)
);
alter table public.stock_moves add column if not exists transfer_id uuid references public.transfers (id);
alter table public.transfers enable row level security;
alter table public.transfer_items enable row level security;
drop policy if exists transfer_read on public.transfers;
create policy transfer_read on public.transfers for select using (public.can_see(org_id));
drop policy if exists transfer_item_read on public.transfer_items;
create policy transfer_item_read on public.transfer_items for select using (
  exists (select 1 from transfers t where t.id = transfer_id and public.can_see(t.org_id)));
-- Written only by the functions below.

-- ---------- Balance views (after transfers exist) ----------
drop view if exists public.product_stock;
create view public.product_stock with (security_invoker = true) as
select p.*,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id and m.type in ('inbound', 'order', 'adjust', 'count', 'transfer_out', 'transfer_in')), 0)::int as on_hand,
  coalesce((select sum(i.qty) from order_items i join orders o on o.id = i.order_id
            where i.product_id = p.id and o.status in ('new', 'on_hold', 'packed')), 0)::int as reserved,
  coalesce((select sum(greatest(a.expected - a.received, 0)) from inbound_items a join inbounds b on b.id = a.inbound_id
            where a.product_id = p.id and b.status <> 'received'), 0)::int as incoming,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id and m.type in ('quarantine', 'release')), 0)::int as quarantined,
  (select max(m.created_at) from stock_moves m where m.product_id = p.id) as last_movement_at,
  coalesce((select sum(ti.qty) from transfer_items ti join transfers t on t.id = ti.transfer_id
            where ti.product_id = p.id and t.status = 'in_transit'), 0)::int as in_transfer,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id and m.warehouse_id = public.holding_warehouse()
            and m.type in ('inbound', 'order', 'adjust', 'count', 'transfer_out', 'transfer_in')), 0)::int as unallocated
from products p;

-- One row per product and warehouse that has (or had) stock or orders there.
create or replace view public.warehouse_stock with (security_invoker = true) as
with pw as (
  select distinct product_id, warehouse_id from stock_moves
  union
  select i.product_id, o.warehouse_id from order_items i join orders o on o.id = i.order_id
  where o.warehouse_id is not null and o.status in ('new', 'on_hold', 'packed')
)
select p.id as product_id, p.org_id, p.sku, p.name, w.id as warehouse_id, w.code as warehouse_code, w.name as warehouse_name, w.kind as warehouse_kind,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id and m.warehouse_id = w.id
            and m.type in ('inbound', 'order', 'adjust', 'count', 'transfer_out', 'transfer_in')), 0)::int as on_hand,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id and m.warehouse_id = w.id and m.type in ('quarantine', 'release')), 0)::int as quarantined,
  coalesce((select sum(i.qty) from order_items i join orders o on o.id = i.order_id
            where i.product_id = p.id and o.warehouse_id = w.id and o.status in ('new', 'on_hold', 'packed')), 0)::int as reserved
from pw join products p on p.id = pw.product_id join warehouses w on w.id = pw.warehouse_id;


-- Products stay inside their client (extends 0010's rule to transfer lines).
create or replace function public.check_product_org() returns trigger
language plpgsql security definer set search_path = public as $$
declare parent_org uuid; product_org uuid;
begin
  select org_id into product_org from products where id = new.product_id;
  if tg_table_name = 'order_items' then
    select org_id into parent_org from orders where id = new.order_id;
  elsif tg_table_name = 'inbound_items' then
    select org_id into parent_org from inbounds where id = new.inbound_id;
  elsif tg_table_name = 'transfer_items' then
    select org_id into parent_org from transfers where id = new.transfer_id;
  else
    parent_org := new.org_id;
  end if;
  if product_org is null or parent_org is distinct from product_org then
    raise exception 'This product belongs to another client.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists transfer_items_product_org on public.transfer_items;
create trigger transfer_items_product_org before insert or update of product_id, transfer_id on public.transfer_items
  for each row execute function public.check_product_org();

-- A warehouse that can hold, receive and ship stock.
create or replace function public._physical_wh(p_wh uuid) returns warehouses
language plpgsql stable security definer set search_path = public as $$
declare w warehouses;
begin
  select * into w from warehouses where id = p_wh;
  if not found then raise exception 'Choose a warehouse.'; end if;
  if w.kind <> 'physical' then raise exception '% is not a real warehouse. Allocate the stock to Guangzhou or Ningbo first.', w.name; end if;
  if not w.active then raise exception 'The % warehouse is closed.', w.name; end if;
  return w;
end $$;
revoke all on function public._physical_wh from public, anon;

-- ---------- Receiving ----------
drop function if exists public.count_inbound(uuid, jsonb);
create or replace function public.count_inbound(p_inbound uuid, p_counts jsonb, p_warehouse uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare b inbounds; it record; total integer := 0; q integer; w warehouses;
begin
  if not public.staff_has('inbounds.receive') then raise exception 'not allowed'; end if;
  select * into b from inbounds where id = p_inbound for update;
  if not found or b.status = 'received' then raise exception 'inbound not found or already available'; end if;
  w := public._physical_wh(coalesce(p_warehouse, b.warehouse_id));
  for it in select * from inbound_items where inbound_id = p_inbound loop
    q := greatest(coalesce((p_counts ->> it.id::text)::int, 0), 0);
    update inbound_items set received = q where id = it.id;
    total := total + q;
  end loop;
  update inbounds set status = 'counted', warehouse_id = w.id where id = p_inbound;
  insert into activity_log (org_id, user_id, action, detail) values (b.org_id, auth.uid(), 'inbound_counted', b.ref || ' · ' || total || ' units counted at ' || w.name);
end $$;

drop function if exists public.receive_inbound(uuid, jsonb);
create or replace function public.receive_inbound(p_inbound uuid, p_counts jsonb, p_warehouse uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare b inbounds; it record; q integer; total integer := 0; w warehouses;
begin
  if not public.staff_has('inbounds.receive') then raise exception 'not allowed'; end if;
  select * into b from inbounds where id = p_inbound for update;
  if not found or b.status = 'received' then raise exception 'inbound not found or already received'; end if;
  w := public._physical_wh(coalesce(p_warehouse, b.warehouse_id));
  for it in select * from inbound_items where inbound_id = p_inbound order by product_id loop
    q := greatest(coalesce((p_counts ->> it.id::text)::int, 0), 0);
    update inbound_items set received = q where id = it.id;
    if q > 0 then
      insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, user_id)
      values (it.product_id, b.org_id, w.id, q, 'inbound', b.ref, auth.uid());
      total := total + q;
    end if;
  end loop;
  update inbounds set status = 'received', received_at = now(), warehouse_id = w.id where id = p_inbound;
  insert into activity_log (org_id, user_id, action, detail) values (b.org_id, auth.uid(), 'inbound_received', b.ref || ' · ' || total || ' units at ' || w.name);
end $$;

-- ---------- Shipping: only from stock at the order's own warehouse ----------
create or replace function public.set_order_status(
  p_order uuid, p_status text, p_carrier text default null, p_tracking text default null,
  p_weight integer default null, p_hold_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare o orders; ship boolean := public.staff_has('orders.warehouse'); hold boolean := public.staff_has('orders.hold');
        it record; sellable integer; w warehouses;
begin
  if not (ship or hold) then raise exception 'not allowed'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if not ship and p_status not in ('new', 'on_hold') then
    raise exception 'your role can only put orders on hold or release them';
  end if;
  if o.status in ('shipped', 'delivered') and p_status not in ('shipped', 'delivered') then
    raise exception 'this order already left the warehouse';
  end if;
  if o.status = 'cancelled' then raise exception 'this order is cancelled'; end if;
  if o.status = 'on_hold' and p_status in ('packed', 'shipped', 'delivered') then
    raise exception 'This order is on hold (%). Release it first.', coalesce(o.hold_reason, 'no reason given');
  end if;
  if p_weight is not null and p_weight < 0 then raise exception 'Weight can''t be negative.'; end if;

  if p_status in ('packed', 'shipped', 'delivered') and not o.stock_out then
    if o.warehouse_id is null then raise exception 'Choose the warehouse that ships this order first.'; end if;
    w := public._physical_wh(o.warehouse_id);
  end if;

  if p_status in ('shipped', 'delivered') and not o.stock_out then
    for it in
      select i.product_id, sum(i.qty)::int as qty, p.sku
      from order_items i join products p on p.id = i.product_id
      where i.order_id = o.id group by i.product_id, p.sku order by i.product_id
    loop
      perform 1 from products where id = it.product_id for update;
      sellable := public._on_hand_wh(it.product_id, w.id) - public._quarantined_wh(it.product_id, w.id);
      if sellable < it.qty then
        raise exception 'Not enough stock of % in %: % on the shelf there, this order needs %. Transfer stock or ship from another warehouse.', it.sku, w.name, greatest(sellable, 0), it.qty;
      end if;
    end loop;
  end if;

  update orders set
    status = p_status,
    carrier = coalesce(p_carrier, carrier),
    tracking = coalesce(nullif(regexp_replace(coalesce(p_tracking, ''), '[^A-Za-z0-9]', '', 'g'), ''), tracking),
    weight_g = coalesce(p_weight, weight_g),
    hold_reason = case when p_status = 'on_hold' then coalesce(p_hold_reason, hold_reason) else null end,
    shipped_at = case when p_status in ('shipped', 'delivered') then coalesce(shipped_at, now()) else shipped_at end,
    delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) when p_status = 'shipped' then null else delivered_at end
  where id = p_order;

  if p_status in ('shipped', 'delivered') and not o.stock_out then
    insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, user_id)
    select i.product_id, o.org_id, w.id, -i.qty, 'order', o.number, auth.uid() from order_items i where i.order_id = o.id;
    update orders set stock_out = true where id = p_order;
  end if;

  insert into activity_log (org_id, user_id, action, detail)
  values (o.org_id, auth.uid(), 'order_updated', '#' || o.number || ' → ' || p_status || coalesce(' · ' || w.code, ''));
end $$;

-- Choose (or change) the warehouse that ships orders not yet packed. Returns how many changed.
create or replace function public.assign_order_warehouse(p_orders uuid[], p_warehouse uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare o orders; n integer := 0; w warehouses;
begin
  if not public.staff_has('orders.warehouse') then raise exception 'not allowed'; end if;
  w := public._physical_wh(p_warehouse);
  for o in select * from orders where id = any(p_orders) order by id for update loop
    if o.status not in ('new', 'on_hold') or o.warehouse_id is not distinct from w.id then continue; end if;
    update orders set warehouse_id = w.id where id = o.id;
    insert into activity_log (org_id, user_id, action, detail) values (o.org_id, auth.uid(), 'order_warehouse', '#' || o.number || ' → ' || w.name);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- Corrections, quarantine, counts — always at one warehouse ----------
drop function if exists public.adjust_stock(uuid, integer, text);
create or replace function public.adjust_stock(p_product uuid, p_qty integer, p_reason text, p_warehouse uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p products; onh integer; qua integer; w warehouses;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  select * into p from products where id = p_product for update;
  if not found or p_qty = 0 then raise exception 'invalid adjustment'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  select * into w from warehouses where id = p_warehouse;
  if not found then raise exception 'Choose a warehouse.'; end if;
  if w.kind = 'holding' and p_qty > 0 then raise exception 'Stock can''t be added to the unallocated pool; add it at the warehouse that holds it.'; end if;
  onh := public._on_hand_wh(p.id, w.id); qua := public._quarantined_wh(p.id, w.id);
  if onh + p_qty < 0 then raise exception 'Stock in % cannot go below zero (on hand there is %).', w.name, onh; end if;
  if onh + p_qty < qua then
    raise exception 'This would leave % units in %, below the % in quarantine there.', onh + p_qty, w.name, qua;
  end if;
  insert into stock_moves (product_id, org_id, warehouse_id, qty, type, note, user_id) values (p.id, p.org_id, w.id, p_qty, 'adjust', p_reason, auth.uid());
  insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_adjusted', p.sku || ' ' || p_qty || ' · ' || w.code || ' · ' || p_reason);
end $$;

drop function if exists public.quarantine_stock(uuid, integer, text);
create or replace function public.quarantine_stock(p_product uuid, p_qty integer, p_reason text, p_warehouse uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p products; onh integer; qua integer; w warehouses;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  if p_qty <= 0 then raise exception 'Quantity must be more than zero.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  select * into p from products where id = p_product for update;
  if not found then raise exception 'product not found'; end if;
  w := public._physical_wh(p_warehouse);
  onh := public._on_hand_wh(p.id, w.id); qua := public._quarantined_wh(p.id, w.id);
  if qua + p_qty > onh then raise exception 'Only % units can be quarantined in % (on hand % − already quarantined %).', onh - qua, w.name, onh, qua; end if;
  insert into stock_moves (product_id, org_id, warehouse_id, qty, type, note, user_id) values (p.id, p.org_id, w.id, p_qty, 'quarantine', p_reason, auth.uid());
  insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_quarantined', p.sku || ' ' || p_qty || ' · ' || w.code || ' · ' || p_reason);
end $$;

drop function if exists public.release_stock(uuid, integer, text, boolean);
create or replace function public.release_stock(p_product uuid, p_qty integer, p_reason text, p_write_off boolean, p_warehouse uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p products; qua integer; w warehouses;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  if p_qty <= 0 then raise exception 'Quantity must be more than zero.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  select * into p from products where id = p_product for update;
  if not found then raise exception 'product not found'; end if;
  select * into w from warehouses where id = p_warehouse;
  if not found then raise exception 'Choose a warehouse.'; end if;
  qua := public._quarantined_wh(p.id, w.id);
  if p_qty > qua then raise exception 'Only % units are in quarantine in %.', qua, w.name; end if;
  insert into stock_moves (product_id, org_id, warehouse_id, qty, type, note, user_id) values (p.id, p.org_id, w.id, -p_qty, 'release', p_reason, auth.uid());
  if p_write_off then
    insert into stock_moves (product_id, org_id, warehouse_id, qty, type, note, user_id) values (p.id, p.org_id, w.id, -p_qty, 'adjust', 'Written off from quarantine · ' || p_reason, auth.uid());
  end if;
  insert into activity_log (org_id, user_id, action, detail)
  values (p.org_id, auth.uid(), case when p_write_off then 'stock_written_off' else 'stock_released' end, p.sku || ' ' || p_qty || ' · ' || w.code || ' · ' || p_reason);
end $$;

drop function if exists public.apply_stock_count(jsonb, text, text, date, text);
create or replace function public.apply_stock_count(p_rows jsonb, p_file text, p_hash text, p_confirmed_on date, p_confirmed_by text, p_warehouse uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare imp uuid; r jsonb; p products; onh integer; qua integer; counted integer; delta integer; changed integer := 0; same integer := 0; w warehouses;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  w := public._physical_wh(p_warehouse);
  if exists (select 1 from imports where kind = 'stock_count' and org_id is null and file_hash = p_hash) then
    raise exception 'This exact file was already imported. Nothing was changed.';
  end if;
  insert into imports (kind, file_name, file_hash, rows, confirmed_on, confirmed_by, created_by)
  values ('stock_count', p_file, p_hash, jsonb_array_length(p_rows), p_confirmed_on, p_confirmed_by, auth.uid()) returning id into imp;
  for r in select * from jsonb_array_elements(p_rows) order by (value ->> 'product_id') loop
    select * into p from products where id = (r ->> 'product_id')::uuid for update;
    if not found then raise exception 'Unknown product in row: %', r; end if;
    counted := (r ->> 'counted')::int;
    if counted is null or counted < 0 then raise exception 'Invalid count for %: %', p.sku, r ->> 'counted'; end if;
    onh := public._on_hand_wh(p.id, w.id); qua := public._quarantined_wh(p.id, w.id);
    if counted < qua then raise exception '% counted % units in % but % are in quarantine there.', p.sku, counted, w.name, qua; end if;
    delta := counted - onh;
    if delta = 0 then
      same := same + 1;
    else
      insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, note, user_id, source, import_id)
      values (p.id, p.org_id, w.id, delta, 'count', p_file,
              'Warehouse count ' || w.code || ' ' || coalesce(to_char(p_confirmed_on, 'YYYY-MM-DD'), '') || coalesce(' · ' || nullif(p_confirmed_by, ''), '') || coalesce(' · ' || nullif(r ->> 'note', ''), ''),
              auth.uid(), 'csv', imp);
      changed := changed + 1;
      insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_counted', p.sku || ' ' || w.code || ' ' || onh || ' → ' || counted || ' (CSV)');
    end if;
  end loop;
  update imports set summary = jsonb_build_object('changed', changed, 'unchanged', same, 'warehouse', w.code) where id = imp;
  return jsonb_build_object('import_id', imp, 'changed', changed, 'unchanged', same);
end $$;

-- ---------- Reconciliation (owner) — now at a warehouse ----------
drop function if exists public.reconcile_stock(uuid, integer, text, text, text);
create or replace function public.reconcile_stock(p_product uuid, p_qty integer, p_reason text, p_evidence text, p_ref text, p_warehouse uuid)
returns void language plpgsql security definer set search_path = public as $$
declare p products; onh integer; qua integer; w warehouses;
begin
  if coalesce(public.staff_role(), '') <> 'owner' then raise exception 'Only the owner can approve a reconciliation.'; end if;
  if p_qty = 0 then raise exception 'Nothing to reconcile.'; end if;
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_evidence), '') = '' then
    raise exception 'A reconciliation needs a reason and the evidence it is based on.';
  end if;
  select * into p from products where id = p_product for update;
  if not found then raise exception 'product not found'; end if;
  select * into w from warehouses where id = p_warehouse;
  if not found then raise exception 'Choose a warehouse.'; end if;
  onh := public._on_hand_wh(p.id, w.id); qua := public._quarantined_wh(p.id, w.id);
  if onh + p_qty < 0 then raise exception 'This would leave % units in %.', onh + p_qty, w.name; end if;
  if onh + p_qty < qua then raise exception 'This would leave fewer units in % than the % in quarantine there.', w.name, qua; end if;
  insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, note, user_id, source, evidence, approved_by)
  values (p.id, p.org_id, w.id, p_qty, 'adjust', nullif(trim(p_ref), ''), 'Reconciliation · ' || trim(p_reason), auth.uid(), 'reconciliation', trim(p_evidence), auth.uid());
  insert into activity_log (org_id, user_id, action, detail)
  values (p.org_id, auth.uid(), 'stock_reconciled', p.sku || ' ' || w.code || ' ' || case when p_qty > 0 then '+' else '' end || p_qty || ' · ' || trim(p_reason));
end $$;

create or replace function public.reverse_shipment(p_order uuid, p_reason text, p_evidence text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; m record;
begin
  if coalesce(public.staff_role(), '') <> 'owner' then raise exception 'Only the owner can reverse a shipment.'; end if;
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_evidence), '') = '' then
    raise exception 'Reversing a shipment needs a reason and the evidence it is based on.';
  end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if o.status not in ('shipped', 'delivered') or not o.stock_out then raise exception 'Only a shipped order can be reversed.'; end if;
  -- Put back exactly what the shipment took, at the warehouse it was taken from.
  for m in select product_id, warehouse_id, -sum(qty)::int as qty from stock_moves
           where type = 'order' and ref = o.number and org_id = o.org_id group by product_id, warehouse_id order by product_id loop
    perform 1 from products where id = m.product_id for update;
    insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, note, user_id, source, evidence, approved_by)
    values (m.product_id, o.org_id, m.warehouse_id, m.qty, 'adjust', o.number, 'Shipment reversed · ' || trim(p_reason), auth.uid(), 'reconciliation', trim(p_evidence), auth.uid());
  end loop;
  update orders set status = 'cancelled', stock_out = false, hold_reason = 'Shipment reversed: ' || trim(p_reason) where id = o.id;
  insert into activity_log (org_id, user_id, action, detail)
  values (o.org_id, auth.uid(), 'shipment_reversed', '#' || o.number || ' · ' || trim(p_reason));
end $$;

-- ---------- Transfers ----------
-- p_items: [{"product_id": uuid, "qty": int}]
create or replace function public.create_transfer(p_org uuid, p_from uuid, p_to uuid, p_items jsonb, p_reason text, p_kind text default 'transfer', p_evidence text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare t transfers; f warehouses; d warehouses; r jsonb; q integer;
begin
  if p_kind not in ('transfer', 'allocation') then raise exception 'unknown transfer kind'; end if;
  if p_kind = 'allocation' and coalesce(public.staff_role(), '') <> 'owner' then raise exception 'Only the owner can allocate unallocated stock.'; end if;
  if p_kind = 'transfer' and not public.can_warehouse() then raise exception 'not allowed'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A transfer needs a reason.'; end if;
  if p_kind = 'allocation' and coalesce(trim(p_evidence), '') = '' then raise exception 'An allocation needs the evidence of where the units physically are (count, warehouse message).'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one product.'; end if;
  select * into f from warehouses where id = p_from;
  if not found then raise exception 'Choose the warehouse the stock leaves.'; end if;
  d := public._physical_wh(p_to);
  if p_kind = 'allocation' and f.kind <> 'holding' then raise exception 'An allocation moves unallocated stock to a warehouse.'; end if;
  if p_kind = 'transfer' then perform public._physical_wh(p_from); end if;
  insert into transfers (org_id, kind, from_warehouse_id, to_warehouse_id, reason, evidence, created_by)
  values (p_org, p_kind, f.id, d.id, trim(p_reason), nullif(trim(coalesce(p_evidence, '')), ''), auth.uid()) returning * into t;
  for r in select * from jsonb_array_elements(p_items) loop
    q := (r ->> 'qty')::int;
    if q is null or q <= 0 then raise exception 'Quantities must be more than zero.'; end if;
    insert into transfer_items (transfer_id, product_id, qty) values (t.id, (r ->> 'product_id')::uuid, q);
  end loop;
  insert into activity_log (org_id, user_id, action, detail) values (p_org, auth.uid(), 'transfer_created', t.ref || ' · ' || f.code || ' → ' || d.code);
  if p_kind = 'allocation' then
    perform public.dispatch_transfer(t.id, null, null);
    perform public.receive_transfer(t.id, null);
  end if;
  return t.id;
end $$;

-- Stock leaves the sending warehouse. Units reserved by orders there, or in quarantine, can't be sent.
create or replace function public.dispatch_transfer(p_transfer uuid, p_carrier text, p_tracking text) returns void
language plpgsql security definer set search_path = public as $$
declare t transfers; it record; free integer; f warehouses;
begin
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'transfer not found'; end if;
  if t.kind = 'allocation' then
    if coalesce(public.staff_role(), '') <> 'owner' then raise exception 'not allowed'; end if;
  elsif not public.can_warehouse() then raise exception 'not allowed'; end if;
  if t.status <> 'requested' then raise exception 'This transfer was already sent.'; end if;
  select * into f from warehouses where id = t.from_warehouse_id;
  for it in select ti.product_id, sum(ti.qty)::int as qty, p.sku from transfer_items ti join products p on p.id = ti.product_id
            where ti.transfer_id = t.id group by ti.product_id, p.sku order by ti.product_id loop
    perform 1 from products where id = it.product_id for update;
    free := public._on_hand_wh(it.product_id, f.id) - public._quarantined_wh(it.product_id, f.id) - public._reserved_wh(it.product_id, f.id);
    if free < it.qty then
      raise exception 'Only % units of % are free to send from % (the rest is reserved for orders there or in quarantine).', greatest(free, 0), it.sku, f.name;
    end if;
  end loop;
  insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, note, user_id, transfer_id, source, evidence, approved_by)
  select ti.product_id, t.org_id, f.id, -ti.qty, 'transfer_out', t.ref, t.reason, auth.uid(), t.id,
         case when t.kind = 'allocation' then 'reconciliation' else 'manual' end,
         t.evidence, case when t.kind = 'allocation' then auth.uid() end
  from transfer_items ti where ti.transfer_id = t.id;
  update transfers set status = 'in_transit', carrier = nullif(trim(coalesce(p_carrier, '')), ''), tracking = nullif(trim(coalesce(p_tracking, '')), ''),
    dispatched_by = auth.uid(), dispatched_at = now() where id = t.id;
  insert into activity_log (org_id, user_id, action, detail) values (t.org_id, auth.uid(), 'transfer_dispatched', t.ref);
end $$;

-- Stock arrives: what was counted goes in; anything missing is recorded as lost in transit.
-- p_counts: {"<transfer_item id>": int}; null = everything arrived.
create or replace function public.receive_transfer(p_transfer uuid, p_counts jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare t transfers; it record; q integer; short integer := 0;
begin
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'transfer not found'; end if;
  if t.kind = 'allocation' then
    if coalesce(public.staff_role(), '') <> 'owner' then raise exception 'not allowed'; end if;
  elsif not public.staff_has('inbounds.receive') then raise exception 'not allowed'; end if;
  if t.status <> 'in_transit' then raise exception 'Only a transfer on its way can be received.'; end if;
  perform public._physical_wh(t.to_warehouse_id);
  for it in select * from transfer_items where transfer_id = t.id order by product_id loop
    q := case when p_counts is null then it.qty else greatest(coalesce((p_counts ->> it.id::text)::int, 0), 0) end;
    if q > it.qty then raise exception 'More units counted than were sent (% > %).', q, it.qty; end if;
    perform 1 from products where id = it.product_id for update;
    update transfer_items set received = q where id = it.id;
    if q > 0 then
      insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, note, user_id, transfer_id, source, evidence, approved_by)
      values (it.product_id, t.org_id, t.to_warehouse_id, q, 'transfer_in', t.ref, t.reason, auth.uid(), t.id,
              case when t.kind = 'allocation' then 'reconciliation' else 'warehouse' end, t.evidence, case when t.kind = 'allocation' then auth.uid() end);
    end if;
    short := short + (it.qty - q);
  end loop;
  update transfers set status = 'received', received_by = auth.uid(), received_at = now() where id = t.id;
  insert into activity_log (org_id, user_id, action, detail)
  values (t.org_id, auth.uid(), 'transfer_received', t.ref || case when short > 0 then ' · ' || short || ' units missing on arrival' else '' end);
end $$;

create or replace function public.cancel_transfer(p_transfer uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare t transfers;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  select * into t from transfers where id = p_transfer for update;
  if not found then raise exception 'transfer not found'; end if;
  if t.status <> 'requested' then raise exception 'Only a transfer that hasn''t left can be cancelled.'; end if;
  update transfers set status = 'cancelled', reason = t.reason || ' · Cancelled: ' || coalesce(nullif(trim(p_reason), ''), 'no reason') where id = t.id;
  insert into activity_log (org_id, user_id, action, detail) values (t.org_id, auth.uid(), 'transfer_cancelled', t.ref);
end $$;

-- Every stock movement must name a warehouse that exists and is right for its type.
create or replace function public.stock_moves_check_warehouse() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  select kind into k from warehouses where id = new.warehouse_id;
  if k is null then raise exception 'Stock movement without a warehouse.'; end if;
  if k = 'holding' and new.type in ('inbound', 'transfer_in', 'quarantine') then
    raise exception 'Stock can only arrive at a real warehouse.';
  end if;
  return new;
end $$;
drop trigger if exists stock_moves_check_warehouse on public.stock_moves;
create trigger stock_moves_check_warehouse before insert on public.stock_moves
  for each row execute function public.stock_moves_check_warehouse();

revoke all on function public.assign_order_warehouse, public.adjust_stock, public.quarantine_stock, public.release_stock,
  public.apply_stock_count, public.reconcile_stock, public.reverse_shipment, public.create_transfer, public.dispatch_transfer,
  public.receive_transfer, public.cancel_transfer, public.receive_inbound, public.count_inbound from public, anon;
grant execute on function public.assign_order_warehouse, public.adjust_stock, public.quarantine_stock, public.release_stock,
  public.apply_stock_count, public.reconcile_stock, public.reverse_shipment, public.create_transfer, public.dispatch_transfer,
  public.receive_transfer, public.cancel_transfer, public.receive_inbound, public.count_inbound to authenticated;
