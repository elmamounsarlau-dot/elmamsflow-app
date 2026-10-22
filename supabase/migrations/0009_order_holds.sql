-- Orders: remember why and since when an order is on hold, so the Orders page can group problems,
-- and let clients hold / release their own orders before the warehouse starts on them.

alter table public.orders add column if not exists held_at timestamptz;
alter table public.orders add column if not exists hold_kind text;

create or replace function public.orders_hold_meta() returns trigger
language plpgsql as $$
begin
  if new.status = 'on_hold' then
    if tg_op = 'INSERT' or old.status is distinct from 'on_hold' then new.held_at := now(); end if;
    new.hold_kind := case
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

drop trigger if exists orders_hold_meta on public.orders;
create trigger orders_hold_meta before insert or update of status, hold_reason on public.orders
  for each row execute function public.orders_hold_meta();

update public.orders set hold_reason = hold_reason where status = 'on_hold';
update public.orders set held_at = created_at where status = 'on_hold' and held_at is null;
create index if not exists orders_hold_kind on public.orders (org_id, hold_kind) where hold_kind is not null;

-- Hold (only orders not started yet) or release (clients: only their own manual holds). Returns how many changed.
create or replace function public.hold_orders(p_orders uuid[], p_hold boolean, p_reason text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare o orders; n integer := 0; staff boolean := public.staff_has('orders.hold');
begin
  for o in select * from orders where id = any(p_orders) for update loop
    if not (staff or public.has_perm(o.org_id, 'orders.create')) then continue; end if;
    if p_hold then
      if o.status <> 'new' then continue; end if;
      update orders set status = 'on_hold', hold_reason = coalesce(nullif(trim(p_reason), ''), 'Held on request') where id = o.id;
    else
      if o.status <> 'on_hold' or (coalesce(o.hold_kind, 'manual') <> 'manual' and not staff) then continue; end if;
      update orders set status = 'new', hold_reason = null where id = o.id;
    end if;
    insert into activity_log (org_id, user_id, action, detail)
      values (o.org_id, auth.uid(), case when p_hold then 'order_held' else 'order_released' end, '#' || o.number);
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function public.hold_orders(uuid[], boolean, text) to authenticated;
