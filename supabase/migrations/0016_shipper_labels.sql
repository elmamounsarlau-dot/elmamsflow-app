-- =====================================================================
-- 0016 — Shipper role and shipping labels
--
--  * New staff role "Shipper": sees the orders to ship (address, items, customs info), marks them packed or
--    in transit with carrier + tracking number, and uploads the shipping label (photo or PDF).
--    No stock, billing, clients or team. Holding, releasing and cancelling stay with roles that have orders.hold.
--  * Each order keeps its label: a private file in Storage (bucket "labels"), opened only through the app.
-- =====================================================================

insert into public.roles (org_id, key, label, about, perms, locked, system, position)
select id, 'shipper', 'Shipper', 'Ships orders: sees what to ship and where, adds the tracking number and the label photo.',
       array['orders.warehouse'], false, true, 6
from public.organizations where kind = 'owner'
on conflict (org_id, key) do nothing;

alter table public.orders add column if not exists label_path text;
alter table public.orders add column if not exists label_uploaded_at timestamptz;
alter table public.orders add column if not exists label_uploaded_by uuid references auth.users (id);

-- Private bucket for labels (Supabase only; the app reads/writes with the service role after its own checks).
do $b$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('labels', 'labels', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
    on conflict (id) do nothing;
  end if;
end $b$;

create or replace function public.set_order_status(
  p_order uuid, p_status text, p_carrier text default null, p_tracking text default null,
  p_weight integer default null, p_hold_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare o orders; ship boolean := public.staff_has('orders.warehouse'); hold boolean := public.staff_has('orders.hold');
        it record; sellable integer; w warehouses;
begin
  if not (ship or hold) then raise exception 'not allowed'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if not ship and p_status not in ('new', 'on_hold') then
    raise exception 'your role can only put orders on hold or release them';
  end if;
  -- Shipping-only roles (e.g. Shipper) move orders forward; holding and cancelling stay with roles that have orders.hold.
  if not hold and (p_status in ('on_hold', 'cancelled') or o.status = 'on_hold') then
    raise exception 'Your role can pack and ship orders, but not hold, release or cancel them.';
  end if;
  if o.status in ('shipped', 'delivered') and p_status not in ('shipped', 'delivered') then
    raise exception 'this order already left the warehouse';
  end if;
  if o.status = 'cancelled' then raise exception 'this order is cancelled'; end if;
  if o.status = 'on_hold' and p_status in ('packed', 'shipped', 'delivered') then
    raise exception 'This order is on hold (%). Release it first.', coalesce(o.hold_reason, 'no reason given');
  end if;
  if p_weight is not null and p_weight < 0 then raise exception 'Weight can''t be negative.'; end if;

  if p_status in ('packed', 'shipped', 'delivered') and not o.stock_out then
    if o.warehouse_id is null then raise exception 'Choose the warehouse that ships this order first.'; end if;
    w := public._physical_wh(o.warehouse_id);
  end if;

  if p_status in ('shipped', 'delivered') and not o.stock_out then
    for it in
      select i.product_id, sum(i.qty)::int as qty, p.sku
      from order_items i join products p on p.id = i.product_id
      where i.order_id = o.id group by i.product_id, p.sku order by i.product_id
    loop
      perform 1 from products where id = it.product_id for update;
      sellable := public._on_hand_wh(it.product_id, w.id) - public._quarantined_wh(it.product_id, w.id);
      if sellable < it.qty then
        raise exception 'Not enough stock of % in %: % on the shelf there, this order needs %. Transfer stock or ship from another warehouse.', it.sku, w.name, greatest(sellable, 0), it.qty;
      end if;
    end loop;
  end if;

  update orders set
    status = p_status,
    carrier = coalesce(p_carrier, carrier),
    tracking = coalesce(nullif(regexp_replace(coalesce(p_tracking, ''), '[^A-Za-z0-9]', '', 'g'), ''), tracking),
    weight_g = coalesce(p_weight, weight_g),
    hold_reason = case when p_status = 'on_hold' then coalesce(p_hold_reason, hold_reason) else null end,
    shipped_at = case when p_status in ('shipped', 'delivered') then coalesce(shipped_at, now()) else shipped_at end,
    delivered_at = case when p_status = 'delivered' then coalesce(delivered_at, now()) when p_status = 'shipped' then null else delivered_at end
  where id = p_order;

  if p_status in ('shipped', 'delivered') and not o.stock_out then
    insert into stock_moves (product_id, org_id, warehouse_id, qty, type, ref, user_id)
    select i.product_id, o.org_id, w.id, -i.qty, 'order', o.number, auth.uid() from order_items i where i.order_id = o.id;
    update orders set stock_out = true where id = p_order;
  end if;

  insert into activity_log (org_id, user_id, action, detail)
  values (o.org_id, auth.uid(), 'order_updated', '#' || o.number || ' → ' || p_status || coalesce(' · ' || w.code, ''));
end $$;
