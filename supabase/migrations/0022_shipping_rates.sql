-- 0022 · Shipping rates
-- The partner's price sheets (country × weight bracket) are pasted by staff each week. Clients get a calculator that
-- shows only final prices (partner cost + margin); they never read these tables. Products get a shipping type and
-- packed size so the calculator can work out volumetric weight.

create table if not exists public.shipping_settings (
  id boolean primary key default true check (id),
  margin_pct numeric(6, 2) not null default 20 check (margin_pct between 0 and 500),
  margin_fixed numeric(10, 2) not null default 0 check (margin_fixed between 0 and 1000),
  packaging_g integer not null default 150 check (packaging_g between 0 and 5000),
  volume_factor integer not null default 8000 check (volume_factor between 1000 and 20000),
  remind_days integer not null default 7 check (remind_days between 1 and 90),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);
insert into public.shipping_settings (id) values (true) on conflict do nothing;

create table if not exists public.shipping_sheets (
  id uuid primary key default gen_random_uuid(),
  service text not null check (service in ('economic', 'expedited')),
  product_type text not null check (product_type in ('general', 'battery', 'clothing', 'cosmetics')),
  source text,                                  -- staff note, e.g. "ST · YunExpress priority, general goods"
  dated date,                                   -- the date printed on the partner's sheet
  active boolean not null default true,
  rows_count integer not null default 0,
  countries integer not null default 0,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
create unique index if not exists shipping_sheets_one_active on public.shipping_sheets (service, product_type) where active;

create table if not exists public.shipping_rates (
  id bigserial primary key,
  sheet_id uuid not null references public.shipping_sheets (id) on delete cascade,
  country text not null check (country ~ '^[A-Z]{2}$'),
  subregion text,
  transit text,
  w_min numeric(10, 3) not null check (w_min >= 0),
  w_max numeric(10, 3) not null,
  per_kg numeric(10, 3) not null check (per_kg >= 0),
  per_parcel numeric(10, 3) not null check (per_parcel >= 0),
  min_kg numeric(10, 3) not null default 0 check (min_kg >= 0),
  check (w_max > w_min)
);
create index if not exists shipping_rates_sheet_country on public.shipping_rates (sheet_id, country);

-- A client can get its own margin (empty = the default above).
alter table public.organizations add column if not exists shipping_margin_pct numeric(6, 2) check (shipping_margin_pct is null or shipping_margin_pct between 0 and 500);
alter table public.organizations add column if not exists shipping_margin_fixed numeric(10, 2) check (shipping_margin_fixed is null or shipping_margin_fixed between 0 and 1000);

-- What a product needs for a quote: its shipping type and packed size (mm). Weight already exists (weight_g).
alter table public.products add column if not exists ship_type text not null default 'general';
alter table public.products drop constraint if exists products_ship_type_check;
alter table public.products add constraint products_ship_type_check check (ship_type in ('general', 'battery', 'clothing', 'cosmetics'));
alter table public.products add column if not exists length_mm integer check (length_mm is null or length_mm between 1 and 3000);
alter table public.products add column if not exists width_mm integer check (width_mm is null or width_mm between 1 and 3000);
alter table public.products add column if not exists height_mm integer check (height_mm is null or height_mm between 1 and 3000);

-- Server only: partner costs never reach the browser.
alter table public.shipping_settings enable row level security;
alter table public.shipping_sheets enable row level security;
alter table public.shipping_rates enable row level security;
revoke all on public.shipping_settings, public.shipping_sheets, public.shipping_rates from anon, authenticated;
grant all on public.shipping_settings, public.shipping_sheets, public.shipping_rates to service_role;
grant usage, select on sequence public.shipping_rates_id_seq to service_role;

-- Replace the active sheet for one service + product type in one step (old one kept, switched off).
create or replace function public.shipping_sheet_replace(p_service text, p_type text, p_source text, p_dated date, p_user uuid, p_rows jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No prices to save.'; end if;
  update shipping_sheets set active = false where service = p_service and product_type = p_type and active;
  insert into shipping_sheets (service, product_type, source, dated, created_by) values (p_service, p_type, nullif(p_source, ''), p_dated, p_user)
    returning id into v_id;
  insert into shipping_rates (sheet_id, country, subregion, transit, w_min, w_max, per_kg, per_parcel, min_kg)
  select v_id, r->>'country', nullif(r->>'subregion', ''), nullif(r->>'transit', ''), (r->>'w_min')::numeric, (r->>'w_max')::numeric,
         (r->>'per_kg')::numeric, (r->>'per_parcel')::numeric, coalesce((r->>'min_kg')::numeric, 0)
  from jsonb_array_elements(p_rows) r;
  update shipping_sheets set rows_count = (select count(*) from shipping_rates where sheet_id = v_id),
    countries = (select count(distinct country) from shipping_rates where sheet_id = v_id) where id = v_id;
  return v_id;
end $$;
revoke all on function public.shipping_sheet_replace from public, anon, authenticated;
grant execute on function public.shipping_sheet_replace to service_role;
