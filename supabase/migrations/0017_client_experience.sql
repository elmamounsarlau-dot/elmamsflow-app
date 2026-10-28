-- =====================================================================
-- 0017 — Client experience
--  * Company profile on each client (legal name, billing address, VAT, invoice email, logo)
--  * Every order ships DDP (Express and DDP are the same service here)
--  * Quarantine decisions: the brand asks (restock / dispose / return to supplier), the team applies
--  * Product photos, bundles & kits (a product made of other products; orders ship the components)
--  * Support tickets: a category and attachments
-- Additive: nothing existing is removed.
-- =====================================================================

-- ---------- Company profile ----------
alter table public.organizations add column if not exists legal_name text;
alter table public.organizations add column if not exists billing_address text;
alter table public.organizations add column if not exists vat_number text;
alter table public.organizations add column if not exists invoice_email text;
alter table public.organizations add column if not exists website text;
alter table public.organizations add column if not exists logo_path text;

-- ---------- DDP for every order ----------
alter table public.orders alter column service set default 'ddp';
update public.orders set service = 'ddp' where service <> 'ddp' and status in ('new', 'on_hold', 'packed');

-- ---------- Quarantine decisions ----------
create table if not exists public.quarantine_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  warehouse_id uuid not null references public.warehouses (id),
  qty integer not null check (qty > 0),
  decision text not null check (decision in ('restock', 'dispose', 'return')),
  note text,
  status text not null default 'requested' check (status in ('requested', 'done', 'declined')),
  requested_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  handled_by uuid references auth.users (id),
  handled_at timestamptz,
  handled_note text
);
create index if not exists quarantine_requests_open on public.quarantine_requests (status, created_at) where status = 'requested';
alter table public.quarantine_requests enable row level security;
drop policy if exists qr_read on public.quarantine_requests;
create policy qr_read on public.quarantine_requests for select using (public.can_see(org_id));

-- The brand decides what happens to its quarantined units (a request; nothing moves yet).
create or replace function public.request_quarantine_decision(p_product uuid, p_warehouse uuid, p_qty integer, p_decision text, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare p products; w warehouses; free integer; rid uuid;
begin
  select * into p from products where id = p_product for update;
  if not found then raise exception 'product not found'; end if;
  if not public.has_perm(p.org_id, 'products.edit') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_decision not in ('restock', 'dispose', 'return') then raise exception 'Choose restock, dispose or return to supplier.'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Quantity must be more than zero.'; end if;
  select * into w from warehouses where id = p_warehouse;
  if not found then raise exception 'Choose a warehouse.'; end if;
  free := public._quarantined_wh(p.id, w.id) - coalesce((select sum(qty) from quarantine_requests
            where product_id = p.id and warehouse_id = w.id and status = 'requested'), 0);
  if p_qty > free then raise exception 'Only % quarantined units in % are still waiting for a decision.', greatest(free, 0), w.name; end if;
  insert into quarantine_requests (org_id, product_id, warehouse_id, qty, decision, note, requested_by)
  values (p.org_id, p.id, w.id, p_qty, p_decision, nullif(trim(coalesce(p_note, '')), ''), auth.uid()) returning id into rid;
  insert into activity_log (org_id, user_id, action, detail)
  values (p.org_id, auth.uid(), 'quarantine_decision', p.sku || ' ' || p_qty || ' · ' || w.code || ' · ' || p_decision);
  return rid;
end $$;

-- The warehouse carries out (or declines) the brand's decision. Restock = back to sellable; dispose / return = units leave stock.
create or replace function public.decide_quarantine(p_request uuid, p_apply boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r quarantine_requests; label text;
begin
  if not public.can_warehouse() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into r from quarantine_requests where id = p_request for update;
  if not found then raise exception 'request not found'; end if;
  if r.status <> 'requested' then raise exception 'This decision was already handled.'; end if;
  label := case r.decision when 'restock' then 'Brand decision: restock' when 'dispose' then 'Brand decision: dispose' else 'Brand decision: returned to supplier' end;
  if p_apply then
    perform public.release_stock(r.product_id, r.qty, label || coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''), r.decision <> 'restock', r.warehouse_id);
  elsif coalesce(trim(p_note), '') = '' then
    raise exception 'Say why the decision is declined.';
  end if;
  update quarantine_requests set status = case when p_apply then 'done' else 'declined' end,
    handled_by = auth.uid(), handled_at = now(), handled_note = nullif(trim(coalesce(p_note, '')), '') where id = r.id;
end $$;

revoke all on function public.request_quarantine_decision, public.decide_quarantine from public, anon;
grant execute on function public.request_quarantine_decision, public.decide_quarantine to authenticated;

-- ---------- Product photos & bundles ----------
alter table public.products add column if not exists photo_path text;
alter table public.products add column if not exists kind text not null default 'item';
alter table public.products drop constraint if exists products_kind_check;
alter table public.products add constraint products_kind_check check (kind in ('item', 'bundle'));

create table if not exists public.bundle_items (
  bundle_id uuid not null references public.products (id) on delete cascade,
  component_id uuid not null references public.products (id),
  qty integer not null check (qty > 0 and qty <= 1000),
  primary key (bundle_id, component_id),
  check (bundle_id <> component_id)
);
alter table public.bundle_items enable row level security;
drop policy if exists bundle_items_read on public.bundle_items;
create policy bundle_items_read on public.bundle_items for select using (
  exists (select 1 from public.products p where p.id = bundle_id and public.can_see(p.org_id)));
drop policy if exists bundle_items_write on public.bundle_items;
create policy bundle_items_write on public.bundle_items for all
  using (exists (select 1 from public.products p where p.id = bundle_id and public.has_perm(p.org_id, 'products.edit')))
  with check (exists (select 1 from public.products p where p.id = bundle_id and public.has_perm(p.org_id, 'products.edit')));

-- A bundle's components belong to the same client and are plain items (no bundle inside a bundle).
create or replace function public.bundle_items_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare b products; c products;
begin
  select * into b from products where id = new.bundle_id;
  select * into c from products where id = new.component_id;
  if b.kind <> 'bundle' then raise exception 'Only a bundle can have components.'; end if;
  if c.kind <> 'item' then raise exception 'A bundle can only contain single products.'; end if;
  if b.org_id <> c.org_id then raise exception 'This product belongs to another client.' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists bundle_items_check on public.bundle_items;
create trigger bundle_items_check before insert or update on public.bundle_items
  for each row execute function public.bundle_items_check();

-- Orders ship components: an order line for a bundle becomes one line per component (qty × bundle qty).
create or replace function public.order_items_expand_bundle() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; c record; n integer := 0;
begin
  select kind into k from products where id = new.product_id;
  if k is distinct from 'bundle' then return new; end if;
  for c in select component_id, qty from bundle_items where bundle_id = new.product_id loop
    insert into order_items (order_id, product_id, qty) values (new.order_id, c.component_id, c.qty * new.qty);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'This bundle has no products in it yet. Add its products first.'; end if;
  return null; -- the bundle line itself is not stored; its components are
end $$;
-- Named to run after order_items_product_org (triggers fire in name order), so the bundle's client is checked first.
drop trigger if exists order_items_zz_expand_bundle on public.order_items;
create trigger order_items_zz_expand_bundle before insert on public.order_items
  for each row execute function public.order_items_expand_bundle();

-- Stock never moves on a bundle itself (it has none); inbounds and stock moves are for single products.
create or replace function public.no_stock_on_bundles() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from products where id = new.product_id and kind = 'bundle') then
    raise exception 'A bundle has no stock of its own: send and count its single products.';
  end if;
  return new;
end $$;
drop trigger if exists stock_moves_no_bundle on public.stock_moves;
create trigger stock_moves_no_bundle before insert on public.stock_moves for each row execute function public.no_stock_on_bundles();
drop trigger if exists inbound_items_no_bundle on public.inbound_items;
create trigger inbound_items_no_bundle before insert on public.inbound_items for each row execute function public.no_stock_on_bundles();

-- ---------- Support: category and attachments ----------
alter table public.tickets add column if not exists category text not null default 'other';
alter table public.tickets drop constraint if exists tickets_category_check;
alter table public.tickets add constraint tickets_category_check check (category in ('order', 'damaged', 'inbound', 'stock', 'billing', 'account', 'other'));

create table if not exists public.ticket_files (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  message_id uuid references public.ticket_messages (id) on delete set null,
  path text not null,
  name text not null,
  type text not null,
  size integer not null,
  uploaded_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
alter table public.ticket_files enable row level security;
drop policy if exists ticket_files_read on public.ticket_files;
create policy ticket_files_read on public.ticket_files for select using (
  exists (select 1 from public.tickets t where t.id = ticket_id and public.can_see(t.org_id)));

-- ---------- Private buckets (Supabase only) ----------
do $b$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
      ('products', 'products', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
      ('tickets', 'tickets', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']),
      ('brand', 'brand', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end $b$;

-- ---------- Stock view: now also carries the photo and the product kind ----------
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
grant select on public.product_stock to authenticated, service_role;
