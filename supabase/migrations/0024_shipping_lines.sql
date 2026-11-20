-- 0024 · Shipping lines
-- Every partner line is its own option for clients (Standard, Priority, Express with a local carrier, …) instead of
-- only Economic / Expedited. A line has one price sheet per product type. The carrier (Evri, DHL, USPS…) is kept per row.

create table if not exists public.shipping_lines (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9-]{2,30}$'),
  name text not null check (length(btrim(name)) between 1 and 60),   -- what clients see
  note text,                                                          -- team only: which partner line / tabs
  sort integer not null default 100,
  active boolean not null default true,                               -- off = hidden from clients
  created_at timestamptz not null default now()
);
insert into public.shipping_lines (key, name, note, sort) values
  ('standard', 'Standard', 'ST · YunExpress standard (tabs 1–4)', 10),
  ('priority', 'Priority', 'ST · YunExpress Priority (tabs 5–6)', 20),
  ('express', 'Express', 'ST · YunExpress last-mile service provider (tabs 13–14)', 30),
  ('large', 'Large parcel', 'ST · YunExpress standard large size (tabs 7–8)', 40),
  ('us-remote', 'US remote areas', 'ST · YunExpress America’s remoteness (tabs 9–10)', 50),
  ('courier', 'Courier', 'ST · YunExpress commercial courier (tabs 11–12)', 60)
on conflict (key) do nothing;

alter table public.shipping_sheets add column if not exists line_id uuid references public.shipping_lines (id) on delete cascade;
update public.shipping_sheets s set line_id = (select id from public.shipping_lines where key = case s.service when 'expedited' then 'priority' else 'standard' end)
  where line_id is null;
alter table public.shipping_sheets alter column line_id set not null;
alter table public.shipping_sheets alter column service drop not null;
alter table public.shipping_sheets drop constraint if exists shipping_sheets_service_check;
drop index if exists public.shipping_sheets_one_active;
create unique index if not exists shipping_sheets_one_active_line on public.shipping_sheets (line_id, product_type) where active;

alter table public.shipping_rates add column if not exists carrier text;

alter table public.shipping_lines enable row level security;
revoke all on public.shipping_lines from anon, authenticated;
grant all on public.shipping_lines to service_role;

-- Replace the active sheet of one line + product type in one step (old one kept, switched off).
create or replace function public.shipping_line_sheet_replace(p_line uuid, p_type text, p_source text, p_dated date, p_user uuid, p_rows jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No prices to save.'; end if;
  if not exists (select 1 from shipping_lines where id = p_line) then raise exception 'Unknown shipping line.'; end if;
  update shipping_sheets set active = false where line_id = p_line and product_type = p_type and active;
  insert into shipping_sheets (line_id, product_type, source, dated, created_by) values (p_line, p_type, nullif(p_source, ''), p_dated, p_user)
    returning id into v_id;
  insert into shipping_rates (sheet_id, country, subregion, transit, carrier, w_min, w_max, per_kg, per_parcel, min_kg, step_kg)
  select v_id, r->>'country', nullif(r->>'subregion', ''), nullif(r->>'transit', ''), nullif(r->>'carrier', ''), (r->>'w_min')::numeric,
         (r->>'w_max')::numeric, (r->>'per_kg')::numeric, (r->>'per_parcel')::numeric, coalesce((r->>'min_kg')::numeric, 0), coalesce((r->>'step_kg')::numeric, 0)
  from jsonb_array_elements(p_rows) r;
  update shipping_sheets set rows_count = (select count(*) from shipping_rates where sheet_id = v_id),
    countries = (select count(distinct country) from shipping_rates where sheet_id = v_id) where id = v_id;
  return v_id;
end $$;
revoke all on function public.shipping_line_sheet_replace from public, anon, authenticated;
grant execute on function public.shipping_line_sheet_replace to service_role;

-- The old call (economic / expedited) keeps working: it goes to Standard / Priority.
create or replace function public.shipping_sheet_replace(p_service text, p_type text, p_source text, p_dated date, p_user uuid, p_rows jsonb)
returns uuid language sql security definer set search_path = public as $$
  select public.shipping_line_sheet_replace((select id from shipping_lines where key = case p_service when 'expedited' then 'priority' else 'standard' end),
    p_type, p_source, p_dated, p_user, p_rows);
$$;
revoke all on function public.shipping_sheet_replace from public, anon, authenticated;
grant execute on function public.shipping_sheet_replace to service_role;
