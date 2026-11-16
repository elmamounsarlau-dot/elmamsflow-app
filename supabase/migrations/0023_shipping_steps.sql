-- 0023 · Shipping rates: weight steps
-- Some countries are billed per step (0.01 / 0.1 / 0.5 / 1 kg): the weight is rounded up to the step before pricing.
alter table public.shipping_rates add column if not exists step_kg numeric(10, 3) not null default 0 check (step_kg >= 0);

create or replace function public.shipping_sheet_replace(p_service text, p_type text, p_source text, p_dated date, p_user uuid, p_rows jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'No prices to save.'; end if;
  update shipping_sheets set active = false where service = p_service and product_type = p_type and active;
  insert into shipping_sheets (service, product_type, source, dated, created_by) values (p_service, p_type, nullif(p_source, ''), p_dated, p_user)
    returning id into v_id;
  insert into shipping_rates (sheet_id, country, subregion, transit, w_min, w_max, per_kg, per_parcel, min_kg, step_kg)
  select v_id, r->>'country', nullif(r->>'subregion', ''), nullif(r->>'transit', ''), (r->>'w_min')::numeric, (r->>'w_max')::numeric,
         (r->>'per_kg')::numeric, (r->>'per_parcel')::numeric, coalesce((r->>'min_kg')::numeric, 0), coalesce((r->>'step_kg')::numeric, 0)
  from jsonb_array_elements(p_rows) r;
  update shipping_sheets set rows_count = (select count(*) from shipping_rates where sheet_id = v_id),
    countries = (select count(distinct country) from shipping_rates where sheet_id = v_id) where id = v_id;
  return v_id;
end $$;
revoke all on function public.shipping_sheet_replace from public, anon, authenticated;
grant execute on function public.shipping_sheet_replace to service_role;
