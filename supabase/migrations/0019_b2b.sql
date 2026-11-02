begin;
-- =====================================================================
-- 0019 — B2B: wholesale orders entered by hand (sourcing, shipping, customs), with their own
--        clients, quotes (devis), invoices (facture / international invoice), costs and payments.
--  * Only people with "Price lists, create invoices, record payments" (owner, manager, finance) can see
--    or change any of it. B2B clients are a separate list from the 3PL brands and have no login (yet).
-- Additive: nothing existing is changed or removed.
-- =====================================================================

-- One row: numbering, stages, bank details.
create table if not exists public.b2b_settings (
  id integer primary key default 1 check (id = 1),
  -- the steps an order goes through, in order (the owner can rename / add / remove)
  stages jsonb not null default '["Quote", "Confirmed", "Deposit paid", "In production", "Quality check", "Shipped", "Customs", "Delivered", "Paid & closed"]'::jsonb
    check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) between 1 and 20),
  next_order integer not null default 1 check (next_order > 0),
  next_devis integer not null default 1 check (next_devis > 0),
  next_facture integer not null default 1 check (next_facture > 0),
  next_invoice integer not null default 1 check (next_invoice > 0),
  -- the design used for clients outside Morocco ('a' classic, 'b' modern)
  intl_template text not null default 'a' check (intl_template in ('a', 'b')),
  -- bank details printed on invoices, per currency: {"USD": "Bank … IBAN … SWIFT …", "EUR": "…", "MAD": "…"}
  bank jsonb not null default '{}'::jsonb,
  email text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);
insert into public.b2b_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.b2b_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  country text not null default 'MA' check (country ~ '^[A-Z]{2}$'),
  ice text,
  vat_number text,
  address text,
  contact text,
  email text,
  phone text,
  currency text not null default 'MAD' check (currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  notes text,
  archived boolean not null default false,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.b2b_orders (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  client_id uuid not null references public.b2b_clients (id),
  title text not null check (length(trim(title)) > 0),
  stage text not null,
  cancelled boolean not null default false,
  -- what the client pays in, and the taxes on the documents
  currency text not null check (currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  tva_rate numeric(5, 2) not null default 0 check (tva_rate >= 0 and tva_rate <= 100),
  discount numeric(14, 2) not null default 0 check (discount >= 0),
  -- shipment
  incoterm text,
  transport text check (transport is null or transport in ('sea', 'air', 'rail', 'road', 'express')),
  origin text,
  destination text,
  client_ref text,
  container text,
  carrier text,
  tracking text,
  etd date,
  eta date,
  notes text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists b2b_orders_client on public.b2b_orders (client_id);

-- What we sell on the order. A line is priced in any currency (converted with `rate`), or as a % of the lines above it.
create table if not exists public.b2b_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.b2b_orders (id) on delete cascade,
  position integer not null default 0,
  kind text not null default 'goods' check (kind in ('goods', 'freight', 'customs', 'forwarder', 'delivery', 'commission', 'other')),
  description text not null check (length(trim(description)) > 0),
  hs_code text,
  qty numeric(14, 3) check (qty is null or qty > 0),
  unit text,
  unit_price numeric(14, 4) check (unit_price is null or unit_price >= 0),
  price_currency text check (price_currency is null or price_currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  -- 1 unit of price_currency in the order's currency
  rate numeric(14, 6) not null default 1 check (rate > 0),
  pct numeric(7, 3) check (pct is null or (pct >= 0 and pct <= 1000)),
  check ((pct is null) <> (unit_price is null))
);
create index if not exists b2b_lines_order on public.b2b_lines (order_id, position);

-- What the order cost us (factory, freight, customs, forwarder, delivery…).
create table if not exists public.b2b_costs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.b2b_orders (id) on delete cascade,
  category text not null check (category in ('goods', 'freight', 'customs', 'forwarder', 'delivery', 'commission', 'other')),
  payee text not null check (length(trim(payee)) > 0),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null check (currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  paid_on date not null,
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists b2b_costs_order on public.b2b_costs (order_id);
create index if not exists b2b_costs_month on public.b2b_costs (paid_on);

-- What the client paid us.
create table if not exists public.b2b_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.b2b_orders (id) on delete cascade,
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null check (currency in ('USD', 'EUR', 'GBP', 'CNY', 'MAD')),
  paid_on date not null,
  method text not null default 'bank' check (method in ('bank', 'cash', 'cheque', 'other')),
  note text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create index if not exists b2b_payments_order on public.b2b_payments (order_id);

-- Quotes and invoices, frozen when issued (the printed page never changes afterwards).
create table if not exists public.b2b_docs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.b2b_orders (id) on delete cascade,
  kind text not null check (kind in ('devis', 'facture', 'invoice')),
  template text not null check (template in ('ma', 'a', 'b')),
  number text not null,
  issued_on date not null,
  due_on date,
  currency text not null,
  total numeric(14, 2) not null,
  data jsonb not null,
  status text not null default 'issued' check (status in ('issued', 'void')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (kind, number)
);
create index if not exists b2b_docs_order on public.b2b_docs (order_id);
create index if not exists b2b_docs_month on public.b2b_docs (issued_on);

-- The order's story: stage changes and notes.
create table if not exists public.b2b_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.b2b_orders (id) on delete cascade,
  text text not null,
  stage text,
  by_user uuid references auth.users (id),
  at timestamptz not null default now()
);
create index if not exists b2b_events_order on public.b2b_events (order_id, at);

do $p$
declare t text;
begin
  foreach t in array array['b2b_settings', 'b2b_clients', 'b2b_orders', 'b2b_lines', 'b2b_costs', 'b2b_payments', 'b2b_docs', 'b2b_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_finance', t);
    execute format('create policy %I on public.%I for all using (public.can_finance()) with check (public.can_finance())', t || '_finance', t);
  end loop;
end $p$;
-- Settings: one row, never added or removed.
drop policy if exists b2b_settings_finance on public.b2b_settings;
drop policy if exists b2b_settings_read on public.b2b_settings;
create policy b2b_settings_read on public.b2b_settings for select using (public.can_finance());
drop policy if exists b2b_settings_write on public.b2b_settings;
create policy b2b_settings_write on public.b2b_settings for update using (public.can_finance()) with check (public.can_finance());
-- Issued documents are never deleted (void them instead).
drop policy if exists b2b_docs_finance on public.b2b_docs;
drop policy if exists b2b_docs_read on public.b2b_docs;
create policy b2b_docs_read on public.b2b_docs for select using (public.can_finance());
drop policy if exists b2b_docs_insert on public.b2b_docs;
create policy b2b_docs_insert on public.b2b_docs for insert with check (public.can_finance());
drop policy if exists b2b_docs_update on public.b2b_docs;
create policy b2b_docs_update on public.b2b_docs for update using (public.can_finance()) with check (public.can_finance());

-- Take the next number of a kind ('order', 'devis', 'facture', 'invoice'), atomically.
create or replace function public.b2b_take_number(p_kind text) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare n integer;
begin
  if not public.can_finance() and coalesce(current_setting('role', true), 'none') = 'authenticated' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind = 'order' then update public.b2b_settings set next_order = next_order + 1 where id = 1 returning next_order - 1 into n;
  elsif p_kind = 'devis' then update public.b2b_settings set next_devis = next_devis + 1 where id = 1 returning next_devis - 1 into n;
  elsif p_kind = 'facture' then update public.b2b_settings set next_facture = next_facture + 1 where id = 1 returning next_facture - 1 into n;
  elsif p_kind = 'invoice' then update public.b2b_settings set next_invoice = next_invoice + 1 where id = 1 returning next_invoice - 1 into n;
  else raise exception 'unknown kind %', p_kind;
  end if;
  return n;
end $$;
revoke all on function public.b2b_take_number from public, anon;
grant execute on function public.b2b_take_number to authenticated, service_role;

commit;
