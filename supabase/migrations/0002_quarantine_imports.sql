-- =====================================================================
-- 0002 — Quarantine, negative-stock protection, CSV imports
-- =====================================================================

-- New movement types: quarantine / release (stock set aside), count (physical count result).
alter table public.stock_moves drop constraint if exists stock_moves_type_check;
alter table public.stock_moves add constraint stock_moves_type_check
  check (type in ('inbound', 'order', 'adjust', 'count', 'quarantine', 'release'));

-- Where a movement came from: typed in the app, imported from a CSV, or confirmed by the warehouse.
alter table public.stock_moves add column if not exists source text not null default 'manual'
  check (source in ('manual', 'csv', 'warehouse'));
alter table public.stock_moves add column if not exists import_id uuid;

-- Stock per product.
--   on_hand     = units physically held (received − shipped ± corrections)
--   quarantined = part of on_hand set aside (damaged, under check); not sellable
--   reserved    = units promised to open orders
--   available   = on_hand − quarantined − reserved
drop view if exists public.product_stock;
create view public.product_stock with (security_invoker = true) as
select p.*,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id and m.type in ('inbound', 'order', 'adjust', 'count')), 0)::int as on_hand,
  coalesce((select sum(i.qty) from order_items i join orders o on o.id = i.order_id
            where i.product_id = p.id and o.status in ('new', 'on_hold', 'packed')), 0)::int as reserved,
  coalesce((select sum(greatest(a.expected - a.received, 0)) from inbound_items a join inbounds b on b.id = a.inbound_id
            where a.product_id = p.id and b.status <> 'received'), 0)::int as incoming,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id and m.type in ('quarantine', 'release')), 0)::int as quarantined,
  (select max(m.created_at) from stock_moves m where m.product_id = p.id) as last_movement_at
from products p;

-- Internal helpers (balances for one product; caller must hold the product lock).
create or replace function public._on_hand(p_product uuid) returns integer language sql stable as $$
  select coalesce(sum(qty), 0)::int from stock_moves where product_id = p_product and type in ('inbound', 'order', 'adjust', 'count')
$$;
create or replace function public._quarantined(p_product uuid) returns integer language sql stable as $$
  select coalesce(sum(qty), 0)::int from stock_moves where product_id = p_product and type in ('quarantine', 'release')
$$;

-- Stock correction (replaces 0001): never below what is quarantined.
create or replace function public.adjust_stock(p_product uuid, p_qty integer, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p products; onh integer; qua integer;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  select * into p from products where id = p_product for update;
  if not found or p_qty = 0 then raise exception 'invalid adjustment'; end if;
  onh := public._on_hand(p.id); qua := public._quarantined(p.id);
  if onh + p_qty < 0 then raise exception 'Stock cannot go below zero (on hand is %).', onh; end if;
  if onh + p_qty < qua then
    raise exception 'This would leave % units on hand, below the % in quarantine. Release or write off quarantine first.', onh + p_qty, qua;
  end if;
  insert into stock_moves (product_id, org_id, qty, type, note, user_id) values (p.id, p.org_id, p_qty, 'adjust', p_reason, auth.uid());
  insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_adjusted', p.sku || ' ' || p_qty || ' · ' || p_reason);
end $$;

-- Move sellable units into quarantine.
create or replace function public.quarantine_stock(p_product uuid, p_qty integer, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p products; onh integer; qua integer;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  if p_qty <= 0 then raise exception 'Quantity must be more than zero.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  select * into p from products where id = p_product for update;
  if not found then raise exception 'product not found'; end if;
  onh := public._on_hand(p.id); qua := public._quarantined(p.id);
  if qua + p_qty > onh then raise exception 'Only % units can be quarantined (on hand % − already quarantined %).', onh - qua, onh, qua; end if;
  insert into stock_moves (product_id, org_id, qty, type, note, user_id) values (p.id, p.org_id, p_qty, 'quarantine', p_reason, auth.uid());
  insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_quarantined', p.sku || ' ' || p_qty || ' · ' || p_reason);
end $$;

-- Take units out of quarantine: back to sellable stock, or written off (removed from stock).
create or replace function public.release_stock(p_product uuid, p_qty integer, p_reason text, p_write_off boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare p products; qua integer;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  if p_qty <= 0 then raise exception 'Quantity must be more than zero.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
  select * into p from products where id = p_product for update;
  if not found then raise exception 'product not found'; end if;
  qua := public._quarantined(p.id);
  if p_qty > qua then raise exception 'Only % units are in quarantine.', qua; end if;
  insert into stock_moves (product_id, org_id, qty, type, note, user_id) values (p.id, p.org_id, -p_qty, 'release', p_reason, auth.uid());
  if p_write_off then
    insert into stock_moves (product_id, org_id, qty, type, note, user_id) values (p.id, p.org_id, -p_qty, 'adjust', 'Written off from quarantine · ' || p_reason, auth.uid());
  end if;
  insert into activity_log (org_id, user_id, action, detail)
  values (p.org_id, auth.uid(), case when p_write_off then 'stock_written_off' else 'stock_released' end, p.sku || ' ' || p_qty || ' · ' || p_reason);
end $$;

-- ---------- CSV imports ----------

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('stock_count', 'products')),
  org_id uuid references public.organizations (id) on delete cascade,
  file_name text,
  file_hash text not null,
  rows integer not null default 0,
  summary jsonb,
  confirmed_on date,
  confirmed_by text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (kind, file_hash)
);
alter table public.imports enable row level security;
create policy import_read on public.imports for select using (public.is_staff() or (org_id is not null and public.member_role(org_id) is not null));

alter table public.stock_moves add constraint stock_moves_import_fkey foreign key (import_id) references public.imports (id);

-- Apply a warehouse stock count from CSV: each row sets the counted on-hand quantity for a SKU.
-- One transaction: either every row is applied or none. The same file can never be applied twice.
-- p_rows: [{ "product_id": uuid, "counted": int, "note": text }]
create or replace function public.apply_stock_count(p_rows jsonb, p_file text, p_hash text, p_confirmed_on date, p_confirmed_by text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare imp uuid; r jsonb; p products; onh integer; qua integer; counted integer; delta integer; changed integer := 0; same integer := 0;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  if exists (select 1 from imports where kind = 'stock_count' and file_hash = p_hash) then
    raise exception 'This exact file was already imported. Nothing was changed.';
  end if;
  insert into imports (kind, file_name, file_hash, rows, confirmed_on, confirmed_by, created_by)
  values ('stock_count', p_file, p_hash, jsonb_array_length(p_rows), p_confirmed_on, p_confirmed_by, auth.uid()) returning id into imp;

  for r in select * from jsonb_array_elements(p_rows) loop
    select * into p from products where id = (r ->> 'product_id')::uuid for update;
    if not found then raise exception 'Unknown product in row: %', r; end if;
    counted := (r ->> 'counted')::int;
    if counted is null or counted < 0 then raise exception 'Invalid count for %: %', p.sku, r ->> 'counted'; end if;
    onh := public._on_hand(p.id); qua := public._quarantined(p.id);
    if counted < qua then raise exception '% counted % units but % are in quarantine. Release or write off quarantine first.', p.sku, counted, qua; end if;
    delta := counted - onh;
    if delta = 0 then
      same := same + 1;
    else
      insert into stock_moves (product_id, org_id, qty, type, ref, note, user_id, source, import_id)
      values (p.id, p.org_id, delta, 'count', p_file,
              'Warehouse count ' || coalesce(to_char(p_confirmed_on, 'YYYY-MM-DD'), '') || coalesce(' · ' || nullif(p_confirmed_by, ''), '') || coalesce(' · ' || nullif(r ->> 'note', ''), ''),
              auth.uid(), 'csv', imp);
      changed := changed + 1;
      insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_counted', p.sku || ' ' || onh || ' → ' || counted || ' (CSV)');
    end if;
  end loop;

  update imports set summary = jsonb_build_object('changed', changed, 'unchanged', same) where id = imp;
  return jsonb_build_object('import_id', imp, 'changed', changed, 'unchanged', same);
end $$;

-- Record a product import (the products themselves are inserted by the app under the normal rules).
create or replace function public.record_import(p_kind text, p_org uuid, p_file text, p_hash text, p_rows integer, p_summary jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare imp uuid;
begin
  if not (public.is_staff() or public.can_operate(p_org)) then raise exception 'not allowed'; end if;
  if exists (select 1 from imports where kind = p_kind and file_hash = p_hash) then
    raise exception 'This exact file was already imported. Nothing was changed.';
  end if;
  insert into imports (kind, org_id, file_name, file_hash, rows, summary, created_by)
  values (p_kind, p_org, p_file, p_hash, p_rows, p_summary, auth.uid()) returning id into imp;
  return imp;
end $$;

revoke all on function public.quarantine_stock, public.release_stock, public.apply_stock_count, public.record_import, public._on_hand, public._quarantined from public, anon;
grant execute on function public.adjust_stock, public.quarantine_stock, public.release_stock, public.apply_stock_count, public.record_import to authenticated;
