-- =====================================================================
-- 0018 — Finance: expenses, repeating expenses, shipping costs per order, reporting currency
--  * Only people with "Price lists, create invoices, record payments" (owner, manager, finance) can see or change any of it.
--  * What a label or the duties cost us is kept OUT of the orders table (clients can read their orders),
--    in order_costs, which clients can never read.
-- Additive: nothing existing is changed or removed.
-- =====================================================================

create or replace function public.can_finance() returns boolean
language sql stable security definer set search_path = public as $$ select public.staff_has('billing.manage') $$;
revoke all on function public.can_finance from public, anon;
grant execute on function public.can_finance to authenticated;

-- One row: how money is reported.
create table if not exists public.finance_settings (
  id integer primary key default 1 check (id = 1),
  report_currency text not null default 'USD' check (report_currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  -- 1 unit of each currency in the reporting currency, e.g. {"EUR": 1.08, "CNY": 0.14}
  fx jsonb not null default '{}'::jsonb,
  -- the currency the team pays carriers and customs in (what the shipper types)
  cost_currency text not null default 'CNY' check (cost_currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  -- put the duties we paid for a client's DDP orders on that client's invoice, at cost
  bill_duties boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);
insert into public.finance_settings (id) values (1) on conflict (id) do nothing;
alter table public.finance_settings enable row level security;
drop policy if exists finance_settings_read on public.finance_settings;
create policy finance_settings_read on public.finance_settings for select using (public.can_finance());
drop policy if exists finance_settings_write on public.finance_settings;
create policy finance_settings_write on public.finance_settings for update using (public.can_finance()) with check (public.can_finance());

-- What one order cost us to ship (label) and in duties (DDP). Written by the server when the team ships.
create table if not exists public.order_costs (
  order_id uuid primary key references public.orders (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  label_cost numeric(12, 2) check (label_cost is null or label_cost >= 0),
  duties_paid numeric(12, 2) check (duties_paid is null or duties_paid >= 0),
  currency text not null check (currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  recorded_by uuid references auth.users (id),
  recorded_at timestamptz not null default now()
);
create index if not exists order_costs_org on public.order_costs (org_id);
alter table public.order_costs enable row level security;
drop policy if exists order_costs_read on public.order_costs;
-- The people who ship see what they typed; finance sees everything. Clients: never.
create policy order_costs_read on public.order_costs for select using (public.can_finance() or public.staff_has('orders.warehouse'));

-- Expenses that come back every month (rent, salaries, software…).
create table if not exists public.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('carrier', 'duties', 'rent', 'salaries', 'packaging', 'software', 'other')),
  payee text not null check (length(trim(payee)) > 0),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  day_of_month integer not null default 1 check (day_of_month between 1 and 28),
  org_id uuid references public.organizations (id) on delete set null,
  note text,
  start_month date not null,
  -- the last month already written into expenses (so a deleted month is never written again)
  generated_until date,
  active boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  spent_on date not null,
  category text not null check (category in ('carrier', 'duties', 'rent', 'salaries', 'packaging', 'software', 'other')),
  payee text not null check (length(trim(payee)) > 0),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null check (currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  org_id uuid references public.organizations (id) on delete set null,
  note text,
  receipt_path text,
  source text not null default 'manual' check (source in ('manual', 'recurring', 'import')),
  recurring_id uuid references public.recurring_expenses (id) on delete set null,
  recurring_month date,
  import_hash text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists expenses_month on public.expenses (spent_on);
create unique index if not exists expenses_recurring_once on public.expenses (recurring_id, recurring_month) where recurring_id is not null;
create unique index if not exists expenses_import_once on public.expenses (import_hash) where import_hash is not null;

alter table public.recurring_expenses enable row level security;
alter table public.expenses enable row level security;
drop policy if exists recurring_all on public.recurring_expenses;
create policy recurring_all on public.recurring_expenses for all using (public.can_finance()) with check (public.can_finance());
drop policy if exists expenses_all on public.expenses;
create policy expenses_all on public.expenses for all using (public.can_finance()) with check (public.can_finance());

-- Receipts: a private bucket, read and written only by the server after its own checks.
do $b$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('finance', 'finance', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
    on conflict (id) do nothing;
  end if;
end $b$;

-- How each person likes their Overview: the quick view or the full view (brands only for now).
alter table public.profiles add column if not exists home_view text check (home_view in ('quick', 'full'));
