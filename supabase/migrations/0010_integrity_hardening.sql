-- =====================================================================
-- 0010 — Integrity and security hardening (from the full audit)
--   1. A product can only be used by its own client (order lines, inbound lines, stock movements).
--   2. Shipping is refused when there aren't enough sellable units on hand (no negative stock).
--   3. A received inbound can't be reopened, so its units can't be posted twice.
--   4. Only the Elmamsflow team can post "team" messages in support tickets.
--   5. No negative weights, values, quantities or cartons; SKUs unique per client whatever the letter case.
--   6. The same CSV file can be imported by two different clients.
-- Safe to run more than once. Existing data was checked before writing this: none of it breaks these rules.
-- =====================================================================

-- ---------- 1. Products stay inside their own client ----------
create or replace function public.check_product_org() returns trigger
language plpgsql security definer set search_path = public as $$
declare parent_org uuid; product_org uuid;
begin
  select org_id into product_org from products where id = new.product_id;
  if tg_table_name = 'order_items' then
    select org_id into parent_org from orders where id = new.order_id;
  elsif tg_table_name = 'inbound_items' then
    select org_id into parent_org from inbounds where id = new.inbound_id;
  else
    parent_org := new.org_id;  -- stock_moves
  end if;
  if product_org is null or parent_org is distinct from product_org then
    raise exception 'This product belongs to another client.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists order_items_product_org on public.order_items;
create trigger order_items_product_org before insert or update of product_id, order_id on public.order_items
  for each row execute function public.check_product_org();
drop trigger if exists inbound_items_product_org on public.inbound_items;
create trigger inbound_items_product_org before insert or update of product_id, inbound_id on public.inbound_items
  for each row execute function public.check_product_org();
drop trigger if exists stock_moves_product_org on public.stock_moves;
create trigger stock_moves_product_org before insert on public.stock_moves
  for each row execute function public.check_product_org();

-- ---------- 2. Shipping needs the units to be physically there ----------
create or replace function public.set_order_status(
  p_order uuid, p_status text, p_carrier text default null, p_tracking text default null,
  p_weight integer default null, p_hold_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare o orders; ship boolean := public.staff_has('orders.warehouse'); hold boolean := public.staff_has('orders.hold'); it record; sellable integer;
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
  if p_weight is not null and p_weight < 0 then raise exception 'Weight can''t be negative.'; end if;

  -- Taking the stock out: lock the products (always in the same order, so two parcels can't race),
  -- and refuse if a line needs more units than are on the shelf and not in quarantine.
  if p_status in ('shipped', 'delivered') and not o.stock_out then
    for it in
      select i.product_id, sum(i.qty)::int as qty, p.sku
      from order_items i join products p on p.id = i.product_id
      where i.order_id = o.id group by i.product_id, p.sku order by i.product_id
    loop
      perform 1 from products where id = it.product_id for update;
      sellable := public._on_hand(it.product_id) - public._quarantined(it.product_id);
      if sellable < it.qty then
        raise exception 'Not enough stock of % to ship: % on the shelf, this order needs %. Receive or correct the stock first.', it.sku, greatest(sellable, 0), it.qty;
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
    insert into stock_moves (product_id, org_id, qty, type, ref, user_id)
    select i.product_id, o.org_id, -i.qty, 'order', o.number, auth.uid() from order_items i where i.order_id = o.id;
    update orders set stock_out = true where id = p_order;
  end if;

  insert into activity_log (org_id, user_id, action, detail)
  values (o.org_id, auth.uid(), 'order_updated', '#' || o.number || ' → ' || p_status);
end $$;

-- Stock corrections lock the same way, so a correction and a parcel can't race each other.
create or replace function public.adjust_stock(p_product uuid, p_qty integer, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p products; onh integer; qua integer;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  select * into p from products where id = p_product for update;
  if not found or p_qty = 0 then raise exception 'invalid adjustment'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  onh := public._on_hand(p.id); qua := public._quarantined(p.id);
  if onh + p_qty < 0 then raise exception 'Stock cannot go below zero (on hand is %).', onh; end if;
  if onh + p_qty < qua then
    raise exception 'This would leave % units on hand, below the % in quarantine. Release or write off quarantine first.', onh + p_qty, qua;
  end if;
  insert into stock_moves (product_id, org_id, qty, type, note, user_id) values (p.id, p.org_id, p_qty, 'adjust', p_reason, auth.uid());
  insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_adjusted', p.sku || ' ' || p_qty || ' · ' || p_reason);
end $$;

-- ---------- 3. A received inbound is final ----------
drop policy if exists inbound_update on public.inbounds;
create policy inbound_update on public.inbounds for update
  using (public.staff_has('inbounds.receive') and status <> 'received')
  with check (public.staff_has('inbounds.receive') and status in ('announced', 'in_transit', 'receiving', 'counted'));

-- ---------- 4. Team messages only from the team ----------
drop policy if exists msg_insert on public.ticket_messages;
create policy msg_insert on public.ticket_messages for insert with check (
  user_id = auth.uid()
  and from_team = public.is_staff()
  and exists (select 1 from tickets t where t.id = ticket_id and public.can_see(t.org_id)));

-- ---------- 5. Values that can't be negative; SKUs unique whatever the case ----------
do $$ begin
  alter table public.products add constraint products_weight_nonneg check (weight_g >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.products add constraint products_value_nonneg check (customs_value >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.products add constraint products_low_stock_nonneg check (low_stock >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.inbound_items add constraint inbound_items_qty_nonneg check (expected >= 0 and received >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.inbounds add constraint inbounds_cartons_nonneg check (cartons >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.orders add constraint orders_weight_nonneg check (weight_g >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.invoice_lines add constraint invoice_lines_qty_nonneg check (qty >= 0);
exception when duplicate_object then null; end $$;
create unique index if not exists products_org_sku_ci on public.products (org_id, upper(sku));

-- ---------- 6. CSV imports: "already imported" is per client ----------
alter table public.imports drop constraint if exists imports_kind_file_hash_key;
create unique index if not exists imports_kind_org_hash on public.imports (kind, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), file_hash);

create or replace function public.record_import(p_kind text, p_org uuid, p_file text, p_hash text, p_rows integer, p_summary jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare imp uuid;
begin
  if not (public.is_staff() or public.can_operate(p_org)) then raise exception 'not allowed'; end if;
  if exists (select 1 from imports where kind = p_kind and org_id is not distinct from p_org and file_hash = p_hash) then
    raise exception 'This exact file was already imported. Nothing was changed.';
  end if;
  insert into imports (kind, org_id, file_name, file_hash, rows, summary, created_by)
  values (p_kind, p_org, p_file, p_hash, p_rows, p_summary, auth.uid()) returning id into imp;
  return imp;
end $$;

-- ---------- 7. Store connections: keep the row when disconnecting ----------
-- (Reconnecting the same store then reuses it, so its orders are never imported a second time.)
alter table public.integrations drop constraint if exists integrations_status_check;
alter table public.integrations add constraint integrations_status_check check (status in ('active', 'paused', 'error', 'disconnected'));
