begin;
-- =====================================================================
-- 0020 — Partner bridge (ST Fulfill through our own Shopify store), two-way order status,
--        prepaid client balance (top-ups), and goodbye to 17TRACK.
--  * Each client gets a short code (e.g. TOF). Its products go to the bridge store as CODE-SKU.
--  * Orders are copied to the bridge store; whatever the partner does there comes back here and
--    then goes to the client's own store.
--  * Prepaid clients top up a balance; each shipped order is paid from it. At zero, new orders wait.
-- Additive: nothing existing is removed (the 17TRACK columns stay, unused).
-- =====================================================================

-- ---------- Clients: code, how they pay ----------
alter table public.organizations add column if not exists client_code text;
do $$ begin
  alter table public.organizations add constraint organizations_client_code_check check (client_code is null or client_code ~ '^[A-Z][A-Z0-9]{1,5}$');
exception when duplicate_object then null; end $$;
create unique index if not exists organizations_client_code_unique on public.organizations (client_code) where client_code is not null;

-- Existing clients keep monthly invoices; new clients start prepaid (they top up before anything ships).
alter table public.organizations add column if not exists billing_mode text not null default 'invoice';
alter table public.organizations alter column billing_mode set default 'prepaid';
do $$ begin
  alter table public.organizations add constraint organizations_billing_mode_check check (billing_mode in ('invoice', 'prepaid'));
exception when duplicate_object then null; end $$;
-- How far below zero a prepaid client may go before new orders wait (0 = not at all).
alter table public.organizations add column if not exists credit_limit numeric(12, 2) not null default 0 check (credit_limit >= 0);
-- Warn the client when the balance goes under this.
alter table public.organizations add column if not exists low_balance numeric(12, 2) not null default 100 check (low_balance >= 0);
-- When we cancel one of their orders: also refund their customer in their store?
alter table public.organizations add column if not exists cancel_refund boolean not null default false;

-- ---------- Store connections: a client's store, or our bridge store ----------
alter table public.integrations add column if not exists role text not null default 'store';
do $$ begin
  alter table public.integrations add constraint integrations_role_check check (role in ('store', 'bridge'));
exception when duplicate_object then null; end $$;
create unique index if not exists integrations_one_bridge on public.integrations (role) where role = 'bridge' and status <> 'paused';

-- ---------- Products in the bridge store ----------
alter table public.products add column if not exists bridge_ref text;        -- the bridge store's variant id
alter table public.products add column if not exists bridge_sku text;        -- CODE-SKU, exactly as the partner must have it
alter table public.products add column if not exists bridge_synced_at timestamptz;
alter table public.products add column if not exists bridge_error text;

-- ---------- Orders: the bridge copy and what the client's store was told ----------
alter table public.orders add column if not exists bridge_id text;            -- the bridge store's order id
alter table public.orders add column if not exists bridge_name text;          -- e.g. TOF-1001
alter table public.orders add column if not exists bridge_sent_at timestamptz;
alter table public.orders add column if not exists bridge_error text;
alter table public.orders add column if not exists shipment_status text;      -- the carrier's journey, as Shopify reports it
do $$ begin
  alter table public.orders add constraint orders_shipment_status_check check (shipment_status is null or shipment_status in
    ('LABEL_PRINTED', 'LABEL_PURCHASED', 'CONFIRMED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'ATTEMPTED_DELIVERY', 'READY_FOR_PICKUP', 'DELIVERED', 'FAILURE'));
exception when duplicate_object then null; end $$;
alter table public.orders add column if not exists tracking_url text;         -- the carrier's page for this parcel
alter table public.orders add column if not exists store_state text;          -- the last status we gave the client's store
alter table public.orders add column if not exists store_error text;
alter table public.orders add column if not exists cancel_refund boolean;     -- set when the order is cancelled here
create index if not exists orders_bridge on public.orders (bridge_id) where bridge_id is not null;
create index if not exists orders_bridge_waiting on public.orders (bridge_sent_at) where bridge_sent_at is not null and status in ('new', 'packed');

-- Holds: two new kinds. "balance" (prepaid balance too low) and "partner" (the warehouse paused it).
create or replace function public.orders_hold_meta() returns trigger
language plpgsql as $$
begin
  if new.status = 'on_hold' then
    if tg_op = 'INSERT' or old.status is distinct from 'on_hold' then new.held_at := now(); end if;
    new.hold_kind := case
      when new.hold_reason ilike 'balance:%' or new.hold_reason ilike '%top up%' then 'balance'
      when new.hold_reason ilike 'warehouse:%' then 'partner'
      when new.hold_reason ilike '%address%' then 'address'
      when new.hold_reason ilike '%not in elmamsflow%' or new.hold_reason ilike '%unknown%' then 'products'
      when new.hold_reason ilike '%hs code%' or new.hold_reason ilike '%customs%' then 'customs'
      when new.hold_reason ilike '%stock%' then 'stock'
      else 'manual' end;
  else
    new.hold_kind := null;
    new.held_at := null;
  end if;
  return new;
end $$;

-- ---------- Prepaid balance ----------
create table if not exists public.wallet_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- topup: money in (waits for us to confirm) · charge: a shipped order · invoice: the rest of a month (storage, receiving…)
  -- adjust: a correction by us (+ or −) · refund: money back to the client (−)
  kind text not null check (kind in ('topup', 'charge', 'invoice', 'adjust', 'refund')),
  amount numeric(12, 2) not null check (amount <> 0),
  currency text not null check (currency in ('USD', 'EUR', 'GBP')),
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'rejected')),
  order_id uuid references public.orders (id) on delete set null,
  invoice_id uuid references public.invoices (id) on delete set null,
  method text,                 -- how the client paid a top-up (as named in the settings)
  ref text,                    -- the reference the client puts on the payment, e.g. TOF-TOP-0012
  note text,
  detail jsonb,                -- what an order charge is made of
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  confirmed_by uuid references auth.users (id),
  confirmed_at timestamptz,
  check ((kind = 'topup' and amount > 0) or (kind in ('charge', 'invoice', 'refund') and amount < 0) or kind = 'adjust'),
  check (status = 'confirmed' or kind = 'topup')
);
create index if not exists wallet_entries_org on public.wallet_entries (org_id, created_at desc);
-- An order is charged once; a month's invoice is taken from the balance once.
create unique index if not exists wallet_one_charge_per_order on public.wallet_entries (order_id) where kind = 'charge';
create unique index if not exists wallet_one_per_invoice on public.wallet_entries (invoice_id) where kind = 'invoice';
create unique index if not exists wallet_ref_unique on public.wallet_entries (ref) where ref is not null;
alter table public.wallet_entries enable row level security;
drop policy if exists wallet_entries_read on public.wallet_entries;
-- The client's own people who can see invoices, and our finance people.
create policy wallet_entries_read on public.wallet_entries for select using (public.can_finance() or public.has_perm(org_id, 'invoices.view'));
-- Every write goes through the server (it checks who may do what).

create sequence if not exists public.wallet_topup_seq;

-- Where clients send top-ups. Changing it here changes the top-up page for everyone.
create table if not exists public.wallet_settings (
  id integer primary key default 1 check (id = 1),
  -- [{"label": "Bank transfer (USD)", "details": "Account name …\nAccount number …"}, {"label": "USDT (TRC20)", "details": "T…"}]
  methods jsonb not null default '[]'::jsonb check (jsonb_typeof(methods) = 'array'),
  min_topup numeric(12, 2) not null default 100 check (min_topup >= 0),
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);
insert into public.wallet_settings (id) values (1) on conflict (id) do nothing;
alter table public.wallet_settings enable row level security;
drop policy if exists wallet_settings_read on public.wallet_settings;
create policy wallet_settings_read on public.wallet_settings for select using (auth.uid() is not null);

-- Confirmed balance of a client, in its price-list currency.
create or replace function public.wallet_balance(p_org uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from wallet_entries where org_id = p_org and status = 'confirmed'
$$;
revoke all on function public.wallet_balance from public, anon;
grant execute on function public.wallet_balance to authenticated, service_role;

-- ---------- The partner (through the bridge store) moves an order ----------
-- Only the server (service role) may call it: execute is revoked from everyone else below.
-- The server calls it after reading the bridge store. Stock leaves the order's warehouse even if
-- our count there is short (the parcel has physically gone); the shortfall is written in the activity log.
create or replace function public.partner_set_status(
  p_order uuid, p_status text, p_carrier text default null, p_tracking text default null, p_hold_reason text default null
) returns text language plpgsql security definer set search_path = public as $$
declare o orders; w warehouses; it record; short text := '';
begin
  if p_status not in ('new', 'on_hold', 'packed', 'shipped', 'delivered', 'cancelled') then raise exception 'unknown status %', p_status; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if o.status = 'cancelled' then return 'cancelled'; end if;
  if o.status in ('shipped', 'delivered') and p_status not in ('shipped', 'delivered') then return 'already_shipped'; end if;
  if o.status = 'delivered' and p_status = 'shipped' and p_tracking is null then return 'same'; end if;
  if o.status = p_status and p_tracking is null and p_hold_reason is null then return 'same'; end if;

  if p_status in ('shipped', 'delivered') and not o.stock_out and o.warehouse_id is not null then
    w := public._physical_wh(o.warehouse_id);
    for it in
      select i.product_id, sum(i.qty)::int as qty, p.sku from order_items i join products p on p.id = i.product_id
      where i.order_id = o.id group by i.product_id, p.sku
    loop
      if public._on_hand_wh(it.product_id, w.id) - public._quarantined_wh(it.product_id, w.id) < it.qty then
        short := short || ' ' || it.sku;
      end if;
    end loop;
  end if;

  update orders set
    status = p_status,
    carrier = coalesce(nullif(p_carrier, ''), carrier),
    tracking = coalesce(nullif(regexp_replace(coalesce(p_tracking, ''), '[^A-Za-z0-9]', '', 'g'), ''), tracking),
    hold_reason = case when p_status = 'on_hold' then coalesce(p_hold_reason, hold_reason, 'Warehouse: paused this order') else null end,
    shipped_at = case when p_status in ('shipped', 'delivered') then coalesce(shipped_at, now()) else shipped_at end,
    delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) else delivered_at end
  where id = p_order;

  if p_status in ('shipped', 'delivered') and not o.stock_out and o.warehouse_id is not null then
    insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref)
    select i.product_id, o.org_id, w.id, -i.qty, 'order', o.number from order_items i where i.order_id = o.id;
    update orders set stock_out = true where id = p_order;
  end if;

  insert into activity_log (org_id, action, detail)
  values (o.org_id, 'order_updated', '#' || o.number || ' → ' || p_status || ' · by the warehouse'
          || case when short <> '' then ' · stock here was short for' || short || ' (count it)' else '' end);
  return 'ok';
end $$;
revoke all on function public.partner_set_status from public, anon, authenticated;
grant execute on function public.partner_set_status to service_role;

commit;
