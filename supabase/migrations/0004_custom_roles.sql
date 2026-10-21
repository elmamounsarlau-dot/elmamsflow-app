-- =====================================================================
-- 0004 — Roles you can adjust: change what each role can do, add your own roles
-- =====================================================================
-- Every organisation has its own list of roles. Elmamsflow (the owner organisation) has the
-- staff roles; each client workspace has its own client roles. The defaults are created for
-- you and can be changed; "Owner" and a client's "Admin" always keep every permission.

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  key text not null,
  label text not null,
  about text,
  perms text[] not null default '{}',
  locked boolean not null default false,   -- Owner / Admin: always every permission, cannot be deleted
  system boolean not null default false,   -- a default role (can be adjusted, not deleted)
  position integer not null default 100,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);
alter table public.roles enable row level security;
drop policy if exists role_read on public.roles;
create policy role_read on public.roles for select using (public.can_see(org_id));
-- Changes go through the server only (after its own permission checks).

-- Default roles for a new organisation.
create or replace function public.seed_roles(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  select kind into k from organizations where id = p_org;
  if k = 'owner' then
    insert into roles (org_id, key, label, about, perms, locked, system, position) values
      (p_org, 'owner', 'Owner', 'Everything, including the team and every client.',
        array['clients.view','clients.manage','team.manage','orders.create','orders.warehouse','orders.hold','products.edit','stock.adjust','inbounds.create','inbounds.receive','support.reply','activity.view','invoices.view'], true, true, 1),
      (p_org, 'manager', 'Manager', 'Runs clients, orders, stock and the team (except owners).',
        array['clients.view','clients.manage','team.manage','orders.create','orders.warehouse','orders.hold','products.edit','stock.adjust','inbounds.create','inbounds.receive','support.reply','activity.view','invoices.view'], false, true, 2),
      (p_org, 'warehouse', 'Warehouse', 'Receives stock, packs and ships orders, adjusts counts.',
        array['orders.warehouse','orders.hold','stock.adjust','inbounds.receive','products.edit'], false, true, 3),
      (p_org, 'support', 'Customer service', 'Answers tickets, puts orders on hold or releases them.',
        array['clients.view','orders.hold','support.reply','orders.create','products.edit','inbounds.create'], false, true, 4),
      (p_org, 'finance', 'Finance', 'Sees clients and orders; billing when it arrives.',
        array['clients.view','activity.view','invoices.view'], false, true, 5)
    on conflict (org_id, key) do nothing;
  else
    insert into roles (org_id, key, label, about, perms, locked, system, position) values
      (p_org, 'admin', 'Admin', 'Everything in the workspace, including the team.',
        array['team.manage','orders.create','products.edit','inbounds.create','support.reply','activity.view','invoices.view'], true, true, 1),
      (p_org, 'operations', 'Operations', 'Orders, products, inbounds and support.',
        array['orders.create','products.edit','inbounds.create','support.reply'], false, true, 2),
      (p_org, 'support', 'Customer support', 'Orders, tracking and support tickets. Read only for stock.',
        array['support.reply'], false, true, 3),
      (p_org, 'finance', 'Finance', 'Invoices and reports. Read only for orders.',
        array['invoices.view','activity.view'], false, true, 4)
    on conflict (org_id, key) do nothing;
  end if;
end $$;
revoke all on function public.seed_roles from public, anon, authenticated;

create or replace function public.organizations_seed_roles() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.seed_roles(new.id); return new; end $$;
drop trigger if exists organizations_roles on public.organizations;
create trigger organizations_roles after insert on public.organizations
  for each row execute function public.organizations_seed_roles();

-- Existing organisations get their defaults now.
select public.seed_roles(id) from public.organizations;

-- ---------- Permission checks (used by every rule below) ----------

-- Does the signed-in Elmamsflow team member have this permission?
create or replace function public.staff_has(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    join organizations o on o.id = m.org_id and o.kind = 'owner' and o.status = 'active'
    join roles r on r.org_id = m.org_id and r.key = m.role
    where m.user_id = auth.uid() and m.status = 'active' and (r.locked or p_perm = any (r.perms))
  )
$$;

-- Does the signed-in person have this permission in this client workspace (or as staff)?
create or replace function public.has_perm(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.staff_has(p_perm) or exists (
    select 1 from memberships m
    join organizations o on o.id = m.org_id and o.status = 'active'
    join roles r on r.org_id = m.org_id and r.key = m.role
    where m.user_id = auth.uid() and m.org_id = p_org and m.status = 'active' and (r.locked or p_perm = any (r.perms))
  )
$$;

-- The older helpers now read the role table instead of fixed role names.
create or replace function public.can_operate(p_org uuid) returns boolean
language sql stable as $$
  select public.has_perm(p_org, 'orders.create') or public.has_perm(p_org, 'products.edit') or public.has_perm(p_org, 'inbounds.create')
$$;
create or replace function public.can_warehouse() returns boolean
language sql stable as $$ select public.staff_has('stock.adjust') $$;

-- ---------- Rules per permission ----------

drop policy if exists product_insert on public.products;
drop policy if exists product_update on public.products;
create policy product_insert on public.products for insert with check (public.has_perm(org_id, 'products.edit'));
create policy product_update on public.products for update using (public.has_perm(org_id, 'products.edit')) with check (public.has_perm(org_id, 'products.edit'));

drop policy if exists inbound_insert on public.inbounds;
drop policy if exists inbound_update on public.inbounds;
drop policy if exists inbound_item_insert on public.inbound_items;
create policy inbound_insert on public.inbounds for insert with check (public.has_perm(org_id, 'inbounds.create'));
create policy inbound_update on public.inbounds for update using (public.staff_has('inbounds.receive')) with check (public.staff_has('inbounds.receive'));
create policy inbound_item_insert on public.inbound_items for insert with check (
  exists (select 1 from inbounds b where b.id = inbound_id and public.has_perm(b.org_id, 'inbounds.create') and b.status = 'announced'));

drop policy if exists order_insert on public.orders;
drop policy if exists order_item_insert on public.order_items;
create policy order_insert on public.orders for insert with check (public.has_perm(org_id, 'orders.create') and status in ('new', 'on_hold'));
create policy order_item_insert on public.order_items for insert with check (
  exists (select 1 from orders o where o.id = order_id and public.has_perm(o.org_id, 'orders.create') and o.status in ('new', 'on_hold')));

-- Order status: "Pack and ship" can do everything; "Hold or release" only on hold / back to new.
create or replace function public.set_order_status(
  p_order uuid, p_status text, p_carrier text default null, p_tracking text default null,
  p_weight integer default null, p_hold_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare o orders; ship boolean := public.staff_has('orders.warehouse'); hold boolean := public.staff_has('orders.hold');
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

create or replace function public.cancel_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  select * into o from orders where id = p_order for update;
  if not found or not public.has_perm(o.org_id, 'orders.create') then raise exception 'not allowed'; end if;
  if o.status not in ('new', 'on_hold') then raise exception 'this order can no longer be cancelled'; end if;
  update orders set status = 'cancelled' where id = p_order;
  insert into activity_log (org_id, user_id, action, detail) values (o.org_id, auth.uid(), 'order_cancelled', '#' || o.number);
end $$;

create or replace function public.receive_inbound(p_inbound uuid, p_counts jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare b inbounds; it record; q integer; total integer := 0;
begin
  if not public.staff_has('inbounds.receive') then raise exception 'not allowed'; end if;
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

revoke all on function public.staff_has, public.has_perm from public, anon;
grant execute on function public.staff_has, public.has_perm to authenticated;
