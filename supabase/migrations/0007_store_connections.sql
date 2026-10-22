-- =====================================================================
-- 0007 — Store connections: Shopify and WooCommerce
-- =====================================================================
-- A client connects their store; paid orders flow in automatically and the
-- tracking number goes back to the store when the parcel ships.

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('shopify', 'woocommerce')),
  store_url text not null,                    -- e.g. mystore.myshopify.com or https://shop.example.com
  name text,                                  -- store name as the platform reports it
  status text not null default 'active' check (status in ('active', 'paused', 'error')),
  secret_enc text not null,                   -- encrypted credentials (never sent to the browser)
  token_enc text,                             -- Shopify: cached 24h access token (encrypted)
  token_expires_at timestamptz,
  settings jsonb not null default '{"auto_import": true, "push_tracking": true}',
  last_sync_at timestamptz,
  last_error text,
  orders_imported integer not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (org_id, kind, store_url)
);
alter table public.integrations enable row level security;
-- No read policy on purpose: the app reads connections on the server only, after its own checks.

create table if not exists public.integration_events (
  id bigint generated always as identity primary key,
  integration_id uuid not null references public.integrations (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null,          -- connected, imported, skipped, cancelled, tracking_pushed, error, products_imported
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists integration_events_recent on public.integration_events (integration_id, created_at desc);
alter table public.integration_events enable row level security;
drop policy if exists integration_events_read on public.integration_events;
create policy integration_events_read on public.integration_events for select using (public.can_see(org_id));

-- Where each order came from, and the store's own id so it's never imported twice.
alter table public.orders add column if not exists source text not null default 'manual';
alter table public.orders add column if not exists integration_id uuid references public.integrations (id) on delete set null;
alter table public.orders add column if not exists external_id text;
alter table public.orders add column if not exists external_lines jsonb;   -- the store's lines, to re-match SKUs later
alter table public.orders add column if not exists pushed_at timestamptz; -- tracking sent back to the store
alter table public.orders add column if not exists push_error text;
create unique index if not exists orders_external_unique on public.orders (integration_id, external_id) where external_id is not null;

-- New permission "Connect stores" for client admins and Elmamsflow owner / managers.
update public.roles r set perms = array_append(perms, 'integrations.manage')
from public.organizations o
where o.id = r.org_id and o.kind = 'owner' and r.key = 'manager' and not ('integrations.manage' = any (r.perms));
