-- =====================================================================
-- 0011 — An order with no products can't be shipped
-- (it would take nothing out of stock but still be billed as a parcel).
-- =====================================================================
create or replace function public.orders_need_lines_to_ship() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('shipped', 'delivered') and old.status not in ('shipped', 'delivered')
     and not exists (select 1 from order_items where order_id = new.id) then
    raise exception 'This order has no products matched yet, so it can''t be shipped. Match or add its products first.';
  end if;
  return new;
end $$;
drop trigger if exists orders_need_lines_to_ship on public.orders;
create trigger orders_need_lines_to_ship before update of status on public.orders
  for each row execute function public.orders_need_lines_to_ship();
