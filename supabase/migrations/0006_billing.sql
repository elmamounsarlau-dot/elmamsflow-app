-- =====================================================================
-- 0006 — Billing: a price list per client, monthly invoices, payments
-- =====================================================================

-- What each client pays. One price list per client workspace, in USD, EUR or GBP.
create table if not exists public.rate_cards (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  currency text not null default 'USD' check (currency in ('USD', 'EUR', 'GBP')),
  pick_pack_order numeric(10, 2) not null default 0,       -- per order shipped (first item)
  pick_pack_extra_unit numeric(10, 2) not null default 0,  -- each extra item in the same order
  packaging_order numeric(10, 2) not null default 0,       -- box / mailer per order
  shipping_base numeric(10, 2) not null default 0,         -- per parcel
  shipping_per_kg numeric(10, 2) not null default 0,       -- per kg shipped
  ddp_order numeric(10, 2) not null default 0,             -- customs handling for DDP orders
  receiving_carton numeric(10, 2) not null default 0,      -- per carton received
  receiving_unit numeric(10, 3) not null default 0,        -- per unit counted in
  storage_unit_month numeric(10, 3) not null default 0,    -- per unit stored per month (charged daily)
  monthly_minimum numeric(10, 2) not null default 0,       -- minimum invoice per month
  payment_terms_days integer not null default 14,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);
alter table public.rate_cards enable row level security;
drop policy if exists rate_read on public.rate_cards;
create policy rate_read on public.rate_cards for select using (public.has_perm(org_id, 'invoices.view'));

create sequence if not exists public.invoice_seq start 1001;
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  number text not null unique default ('INV-' || nextval('public.invoice_seq')::text),
  period_start date not null,
  period_end date not null,
  currency text not null check (currency in ('USD', 'EUR', 'GBP')),
  status text not null default 'draft' check (status in ('draft', 'open', 'paid', 'void')),
  total numeric(12, 2) not null default 0,
  issued_at timestamptz,
  due_date date,
  paid_at timestamptz,
  paid_method text check (paid_method in ('bank', 'card', 'other')),
  paid_ref text,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists invoices_org on public.invoices (org_id, status);
-- One live invoice per client per month (a voided one can be replaced).
create unique index if not exists invoices_one_per_month on public.invoices (org_id, period_start) where status <> 'void';

create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  category text not null check (category in ('fulfillment', 'packaging', 'shipping', 'customs', 'receiving', 'storage', 'other')),
  description text not null,
  qty numeric(14, 3) not null default 1,
  unit_price numeric(12, 3) not null default 0,
  amount numeric(12, 2) not null default 0,
  position integer not null default 0
);

alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
-- Elmamsflow staff with billing access see everything; clients see their issued invoices (never drafts).
drop policy if exists invoice_read on public.invoices;
create policy invoice_read on public.invoices for select using (
  public.staff_has('invoices.view') or (status <> 'draft' and public.has_perm(org_id, 'invoices.view'))
);
drop policy if exists invoice_line_read on public.invoice_lines;
create policy invoice_line_read on public.invoice_lines for select using (
  exists (select 1 from public.invoices i where i.id = invoice_id)
);

-- Your company details printed on every invoice, and where clients pay.
create table if not exists public.billing_settings (
  id integer primary key default 1 check (id = 1),
  company text,
  address text,
  tax_id text,
  email text,
  bank_usd text,
  bank_eur text,
  bank_gbp text,
  footer text,
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id, company) values (1, 'EL MAMOUN SHIPPING & TRADING SARL-AU') on conflict (id) do nothing;
alter table public.billing_settings enable row level security;
drop policy if exists billing_settings_read on public.billing_settings;
create policy billing_settings_read on public.billing_settings for select using (auth.uid() is not null);

-- New permission "billing.manage" (price lists, invoices, payments) for Manager and Finance.
update public.roles r set perms = array_append(perms, 'billing.manage')
from public.organizations o
where o.id = r.org_id and o.kind = 'owner' and r.key in ('manager', 'finance') and not ('billing.manage' = any (r.perms));
