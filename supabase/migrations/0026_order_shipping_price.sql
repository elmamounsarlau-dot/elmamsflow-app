-- 0026 · Shipping is billed per line, to the gram (no more rounding up to the next kg).
-- When an order ships, the server stores the line it is billed on and the client's shipping price for it, so the
-- invoice and the prepaid charge use the same number even if the price sheets change later. ship_price is the client's
-- price in the client's invoice currency. Client prices only:
-- partner costs never go on the order.
alter table public.orders add column if not exists ship_line_id uuid references public.shipping_lines (id) on delete set null;
alter table public.orders add column if not exists ship_price numeric(10, 2) check (ship_price is null or ship_price >= 0);
alter table public.orders add column if not exists ship_kg numeric(10, 3) check (ship_kg is null or ship_kg >= 0);
alter table public.orders add column if not exists ship_priced_at timestamptz;

-- Only the server sets these: a client creating an order from the browser can't choose its own shipping price.
create or replace function public.orders_ship_price_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.ship_line_id := null; new.ship_price := null; new.ship_kg := null; new.ship_priced_at := null;
    else
      new.ship_line_id := old.ship_line_id; new.ship_price := old.ship_price; new.ship_kg := old.ship_kg; new.ship_priced_at := old.ship_priced_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists orders_ship_price_guard on public.orders;
create trigger orders_ship_price_guard before insert or update on public.orders
  for each row execute function public.orders_ship_price_guard();
