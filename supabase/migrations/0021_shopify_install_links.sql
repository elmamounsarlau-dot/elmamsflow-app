-- 0021 · Shopify install links
-- A client connects its Shopify store by clicking one link (custom-distribution app made by Elmamsflow),
-- instead of creating an app in the Shopify Dev Dashboard. One waiting install per store address.
-- Only the server (service role) reads or writes this table: no client or staff policies.

create table if not exists public.shopify_installs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  shop text not null check (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  client_id text not null,
  secret_enc text not null,                       -- encrypted client secret (never sent to the browser)
  install_link text check (install_link is null or install_link ~ '^https://'),
  status text not null default 'waiting' check (status in ('waiting', 'installed', 'cancelled')),
  integration_id uuid references public.integrations (id) on delete set null,
  last_error text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  installed_at timestamptz
);
create unique index if not exists shopify_installs_one_waiting on public.shopify_installs (shop) where status = 'waiting';
create index if not exists shopify_installs_org on public.shopify_installs (org_id, created_at desc);
alter table public.shopify_installs enable row level security;
revoke all on public.shopify_installs from anon, authenticated;
grant all on public.shopify_installs to service_role;
