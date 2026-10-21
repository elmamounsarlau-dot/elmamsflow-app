-- =====================================================================
-- Elmamsflow platform — initial schema
-- Organisations (Elmamsflow + each client brand), team members with roles,
-- products, stock, inbounds, orders, support, activity.
-- Row Level Security: every client sees only its own organisation;
-- the Elmamsflow team sees everything its role allows.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Organisations & people ----------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('owner', 'client')),
  name text not null,
  code text unique,
  status text not null default 'active' check (status in ('active', 'paused')),
  country text,
  phone text,
  notes text,
  created_at timestamptz not null default now()
);

create sequence public.client_code_seq start 1001;

create or replace function public.set_client_code() returns trigger language plpgsql as $$
begin
  if new.kind = 'client' and new.code is null then
    new.code := 'EMF-' || nextval('public.client_code_seq');
  end if;
  return new;
end $$;
create trigger organizations_code before insert on public.organizations
  for each row execute function public.set_client_code();

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  status text not null default 'invited' check (status in ('invited', 'active', 'paused')),
  invited_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (org_id, user_id),
  constraint memberships_profile_fkey foreign key (user_id) references public.profiles (id) on delete cascade
);
create index on public.memberships (user_id);

-- Profile row for every new auth user.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Role helpers (used by the security rules) ----------

create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public as $$
  select m.role from memberships m join organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and o.kind = 'owner' and m.status = 'active' and o.status = 'active'
  limit 1
$$;

create or replace function public.is_staff() returns boolean
language sql stable as $$ select public.staff_role() is not null $$;

create or replace function public.member_role(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.role from memberships m join organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and m.org_id = p_org and m.status = 'active' and o.status = 'active'
  limit 1
$$;

create or replace function public.can_see(p_org uuid) returns boolean
language sql stable as $$ select public.is_staff() or public.member_role(p_org) is not null $$;

-- Orders, products, inbounds: who may create them.
create or replace function public.can_operate(p_org uuid) returns boolean
language sql stable as $$
  select coalesce(public.staff_role() in ('owner', 'manager', 'warehouse', 'support'), false)
      or coalesce(public.member_role(p_org) in ('admin', 'operations'), false)
$$;

-- Warehouse floor actions (receive, ship, adjust stock).
create or replace function public.can_warehouse() returns boolean
language sql stable as $$ select coalesce(public.staff_role() in ('owner', 'manager', 'warehouse'), false) $$;

-- ---------- Operations ----------

create table public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  sku text not null,
  name text not null,
  barcode text,
  weight_g integer not null default 0,
  hs_code text,
  customs_value numeric(10, 2) not null default 0,
  origin text not null default 'CN',
  low_stock integer not null default 10,
  created_at timestamptz not null default now(),
  unique (org_id, sku)
);

create table public.stock_moves (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.products (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  qty integer not null,
  type text not null check (type in ('inbound', 'order', 'adjust')),
  ref text,
  note text,
  user_id uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index on public.stock_moves (product_id);

create sequence public.inbound_seq start 1;
create table public.inbounds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  ref text not null default ('IB-' || lpad(nextval('public.inbound_seq')::text, 4, '0')),
  status text not null default 'announced' check (status in ('announced', 'in_transit', 'receiving', 'received')),
  cartons integer not null default 0,
  eta date,
  supplier text,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  received_at timestamptz
);

create table public.inbound_items (
  id uuid primary key default gen_random_uuid(),
  inbound_id uuid not null references public.inbounds (id) on delete cascade,
  product_id uuid not null references public.products (id),
  expected integer not null default 0,
  received integer not null default 0
);

create sequence public.order_seq start 20001;
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  number text not null default ('EM-' || nextval('public.order_seq')::text),
  store_ref text,
  customer text not null,
  email text,
  phone text,
  address text not null,
  city text,
  zip text,
  country text not null,
  service text not null default 'express' check (service in ('express', 'ddp')),
  status text not null default 'new' check (status in ('new', 'on_hold', 'packed', 'shipped', 'delivered', 'cancelled')),
  hold_reason text,
  carrier text,
  tracking text,
  weight_g integer not null default 0,
  stock_out boolean not null default false,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  shipped_at timestamptz,
  delivered_at timestamptz
);
create index on public.orders (org_id, status);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id),
  qty integer not null check (qty > 0)
);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  subject text not null,
  order_ref text,
  status text not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  from_team boolean not null default false,
  body text not null,
  created_at timestamptz not null default now(),
  constraint ticket_messages_user_profile_fkey foreign key (user_id) references public.profiles (id)
);

create table public.activity_log (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id),
  action text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint activity_log_user_profile_fkey foreign key (user_id) references public.profiles (id) on delete set null
);
create index on public.activity_log (org_id, created_at desc);

-- Stock per product (on hand, reserved by open orders, incoming from open inbounds).
create or replace view public.product_stock with (security_invoker = true) as
select p.*,
  coalesce((select sum(m.qty) from stock_moves m where m.product_id = p.id), 0)::int as on_hand,
  coalesce((select sum(i.qty) from order_items i join orders o on o.id = i.order_id
            where i.product_id = p.id and o.status in ('new', 'on_hold', 'packed')), 0)::int as reserved,
  coalesce((select sum(greatest(a.expected - a.received, 0)) from inbound_items a join inbounds b on b.id = a.inbound_id
            where a.product_id = p.id and b.status <> 'received'), 0)::int as incoming
from products p;

-- ---------- Row Level Security ----------

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.products enable row level security;
alter table public.stock_moves enable row level security;
alter table public.inbounds enable row level security;
alter table public.inbound_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;
alter table public.activity_log enable row level security;

-- Organisations: staff see all; members see their own. Changes go through the server (service role).
create policy org_read on public.organizations for select using (public.can_see(id));

-- People: you, your colleagues, and the Elmamsflow team.
create policy profile_read on public.profiles for select using (
  id = auth.uid() or public.is_staff()
  or exists (select 1 from memberships a join memberships b on a.org_id = b.org_id
             where a.user_id = auth.uid() and b.user_id = profiles.id)
);
create policy profile_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy member_read on public.memberships for select using (user_id = auth.uid() or public.can_see(org_id));

-- Products
create policy product_read on public.products for select using (public.can_see(org_id));
create policy product_insert on public.products for insert with check (public.can_operate(org_id));
create policy product_update on public.products for update using (public.can_operate(org_id)) with check (public.can_operate(org_id));

-- Stock moves: read with the product; written only by warehouse functions.
create policy move_read on public.stock_moves for select using (public.can_see(org_id));

-- Inbounds
create policy inbound_read on public.inbounds for select using (public.can_see(org_id));
create policy inbound_insert on public.inbounds for insert with check (public.can_operate(org_id));
create policy inbound_update on public.inbounds for update using (public.can_warehouse()) with check (public.can_warehouse());
create policy inbound_item_read on public.inbound_items for select using (
  exists (select 1 from inbounds b where b.id = inbound_id and public.can_see(b.org_id)));
create policy inbound_item_insert on public.inbound_items for insert with check (
  exists (select 1 from inbounds b where b.id = inbound_id and public.can_operate(b.org_id) and b.status = 'announced'));

-- Orders: clients create; only the warehouse changes status (through functions below).
create policy order_read on public.orders for select using (public.can_see(org_id));
create policy order_insert on public.orders for insert with check (public.can_operate(org_id) and status in ('new', 'on_hold'));
create policy order_item_read on public.order_items for select using (
  exists (select 1 from orders o where o.id = order_id and public.can_see(o.org_id)));
create policy order_item_insert on public.order_items for insert with check (
  exists (select 1 from orders o where o.id = order_id and public.can_operate(o.org_id) and o.status in ('new', 'on_hold')));

-- Support
create policy ticket_read on public.tickets for select using (public.can_see(org_id));
create policy ticket_insert on public.tickets for insert with check (public.can_see(org_id));
create policy ticket_update on public.tickets for update using (public.can_see(org_id)) with check (public.can_see(org_id));
create policy msg_read on public.ticket_messages for select using (
  exists (select 1 from tickets t where t.id = ticket_id and public.can_see(t.org_id)));
create policy msg_insert on public.ticket_messages for insert with check (
  user_id = auth.uid() and exists (select 1 from tickets t where t.id = ticket_id and public.can_see(t.org_id)));

-- Activity
create policy log_read on public.activity_log for select using (
  public.is_staff() or (org_id is not null and public.member_role(org_id) is not null));
create policy log_insert on public.activity_log for insert with check (
  user_id = auth.uid() and (org_id is null and public.is_staff() or org_id is not null and public.can_see(org_id)));

-- ---------- Warehouse functions (all checks inside) ----------

-- Order status change by the warehouse; takes stock out when the parcel leaves.
create or replace function public.set_order_status(
  p_order uuid, p_status text, p_carrier text default null, p_tracking text default null,
  p_weight integer default null, p_hold_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  if coalesce(public.staff_role() in ('owner', 'manager', 'warehouse', 'support'), false) is not true then
    raise exception 'not allowed';
  end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if public.staff_role() = 'support' and p_status not in ('new', 'on_hold') then
    raise exception 'support can only put orders on hold or release them';
  end if;
  if o.status in ('shipped', 'delivered') and p_status not in ('shipped', 'delivered') then
    raise exception 'this order already left the warehouse';
  end if;
  if o.status = 'cancelled' then raise exception 'this order is cancelled'; end if;

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

-- Client (or team) cancels an order that has not been packed yet.
create or replace function public.cancel_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  select * into o from orders where id = p_order for update;
  if not found or not public.can_operate(o.org_id) then raise exception 'not allowed'; end if;
  if o.status not in ('new', 'on_hold') then raise exception 'this order can no longer be cancelled'; end if;
  update orders set status = 'cancelled' where id = p_order;
  insert into activity_log (org_id, user_id, action, detail) values (o.org_id, auth.uid(), 'order_cancelled', '#' || o.number);
end $$;

-- Warehouse confirms what arrived; units become available.
create or replace function public.receive_inbound(p_inbound uuid, p_counts jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare b inbounds; it record; q integer; total integer := 0;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  select * into b from inbounds where id = p_inbound for update;
  if not found or b.status = 'received' then raise exception 'inbound not found or already received'; end if;
  for it in select * from inbound_items where inbound_id = p_inbound loop
    q := greatest(coalesce((p_counts ->> it.id::text)::int, 0), 0);
    update inbound_items set received = q where id = it.id;
    if q > 0 then
      insert into stock_moves (product_id, org_id, qty, type, ref, user_id) values (it.product_id, b.org_id, q, 'inbound', b.ref, auth.uid());
      total := total + q;
    end if;
  end loop;
  update inbounds set status = 'received', received_at = now() where id = p_inbound;
  insert into activity_log (org_id, user_id, action, detail) values (b.org_id, auth.uid(), 'inbound_received', b.ref || ' · ' || total || ' units');
end $$;

-- Warehouse stock correction.
create or replace function public.adjust_stock(p_product uuid, p_qty integer, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p products;
begin
  if not public.can_warehouse() then raise exception 'not allowed'; end if;
  select * into p from products where id = p_product;
  if not found or p_qty = 0 then raise exception 'invalid adjustment'; end if;
  insert into stock_moves (product_id, org_id, qty, type, note, user_id) values (p.id, p.org_id, p_qty, 'adjust', p_reason, auth.uid());
  insert into activity_log (org_id, user_id, action, detail) values (p.org_id, auth.uid(), 'stock_adjusted', p.sku || ' ' || p_qty || ' · ' || p_reason);
end $$;

revoke all on function public.set_order_status, public.cancel_order, public.receive_inbound, public.adjust_stock from public, anon;
grant execute on function public.set_order_status, public.cancel_order, public.receive_inbound, public.adjust_stock to authenticated;

-- ---------- The Elmamsflow organisation + first owner ----------

insert into public.organizations (kind, name, code) values ('owner', 'Elmamsflow', 'EMF-HQ');

-- Run once from the SQL editor after creating your own user:
--   select public.make_owner('you@yourmail.com');
create or replace function public.make_owner(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid; org uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then return 'No user with that email. Create it first in Authentication → Users.'; end if;
  select id into org from organizations where kind = 'owner' limit 1;
  insert into memberships (org_id, user_id, role, status) values (org, uid, 'owner', 'active')
  on conflict (org_id, user_id) do update set role = 'owner', status = 'active';
  return 'Done: ' || p_email || ' is now the owner.';
end $$;
revoke all on function public.make_owner from public, anon, authenticated;
