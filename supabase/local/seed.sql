-- Synthetic data for local UI / end-to-end testing. Never run against production.
insert into auth.users (id, email, last_sign_in_at, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@local.test', now(), now(), '{"full_name":"Yasser (test owner)"}'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@local.test', now(), now(), '{"full_name":"Mina Manager"}'),
  ('00000000-0000-0000-0000-0000000000a3', 'warehouse@local.test', now(), now(), '{"full_name":"Wei Warehouse"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'admin@atlas.local.test', now(), now(), '{"full_name":"Amal Atlas"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'ops@atlas.local.test', now(), now(), '{"full_name":"Omar Ops"}'),
  ('00000000-0000-0000-0000-0000000000b3', 'new@atlas.local.test', null, null, '{"full_name":"Nadia New"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'admin@nova.local.test', now(), now(), '{"full_name":"Nora Nova"}');

insert into public.organizations (id, kind, name, country, phone, default_warehouse_id) values
  ('11111111-1111-1111-1111-111111111111', 'client', 'Atlas Home Goods', 'FR', '+33 1 23 45 67 89', (select id from public.warehouses where code = 'NB')),
  ('22222222-2222-2222-2222-222222222222', 'client', 'Nova Skincare Ltd', 'GB', '+44 20 7946 0000', (select id from public.warehouses where code = 'GZ'));

insert into public.memberships (org_id, user_id, role, status)
select o.id, u.id::uuid, u.role, 'active' from (values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'), ('00000000-0000-0000-0000-0000000000a2', 'manager'),
  ('00000000-0000-0000-0000-0000000000a3', 'warehouse')) u(id, role)
cross join (select id from public.organizations where kind = 'owner') o;
insert into public.memberships (org_id, user_id, role, status) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000b1', 'admin', 'active'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000b2', 'operations', 'active'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000b3', 'operations', 'invited'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-0000000000c1', 'admin', 'active');
insert into public.access_links (user_id, org_id, email, link, emailed) values
  ('00000000-0000-0000-0000-0000000000b3', '11111111-1111-1111-1111-111111111111', 'new@atlas.local.test', 'http://localhost:3000/auth/confirm?token_hash=local-test&type=invite&next=/set-password', false);

-- Products: a realistic mix (long names, missing customs info, quarantine, zero stock)
insert into public.products (id, org_id, sku, name, barcode, weight_g, hs_code, customs_value, low_stock)
select ('a0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '11111111-1111-1111-1111-111111111111',
  'ATL-' || lpad(i::text, 3, '0'),
  (array['Linen bed sheet set · Queen · Natural oat','Cotton bath towel · 70×140 · Charcoal','Ceramic table lamp with pleated linen shade, extra-long name to test wrapping','Wool throw blanket · Mustard','Scented candle · Fig & cedar · 220 g','Bamboo cutting board','Glass storage jar set (3)','Velvet cushion cover · 45×45 · Emerald','Stoneware dinner plate (4)','Rattan laundry basket'])[i],
  '37600' || lpad(i::text, 8, '0'), 150 + i * 90, case when i in (4, 9) then null else '630790' end, case when i = 9 then 0 else 4 + i * 2.5 end, 20
from generate_series(1, 10) i;
insert into public.products (id, org_id, sku, name, weight_g, hs_code, customs_value, low_stock)
select ('b0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, '22222222-2222-2222-2222-222222222222',
  'NOVA-' || lpad(i::text, 3, '0'), (array['Hydrating serum 30 ml','Night cream 50 ml','Vitamin C toner 100 ml','Clay mask 75 ml'])[i], 90 + i * 20, '330499', 6 + i, 50
from generate_series(1, 4) i;

-- Received inbounds with their stock
insert into public.inbounds (id, org_id, ref, status, cartons, eta, supplier, received_at, created_at) values
  ('1c000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'IB-0001', 'received', 24, current_date - 40, 'Ningbo Textile Co.', now() - interval '38 days', now() - interval '50 days'),
  ('1c000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'IB-0002', 'received', 10, current_date - 20, 'Guangzhou Beauty Lab', now() - interval '19 days', now() - interval '30 days'),
  ('1c000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'IB-0003', 'in_transit', 12, current_date + 6, 'Ningbo Textile Co.', null, now() - interval '5 days'),
  ('1c000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'IB-0004', 'announced', 4, current_date - 3, 'Yiwu Home Deco', null, now() - interval '12 days'),
  ('1c000000-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'IB-0005', 'counted', 6, current_date - 1, 'Guangzhou Beauty Lab', null, now() - interval '9 days');
update public.inbounds b set warehouse_id = o.default_warehouse_id from public.organizations o where o.id = b.org_id;
insert into public.inbound_items (inbound_id, product_id, expected, received)
select '1c000000-0000-0000-0000-000000000001', id, 300, case when sku = 'ATL-010' then 0 else 300 end from public.products where org_id = '11111111-1111-1111-1111-111111111111';
insert into public.inbound_items (inbound_id, product_id, expected, received)
select '1c000000-0000-0000-0000-000000000002', id, 500, 500 from public.products where org_id = '22222222-2222-2222-2222-222222222222';
insert into public.inbound_items (inbound_id, product_id, expected) select '1c000000-0000-0000-0000-000000000003', id, 150 from public.products where sku in ('ATL-001', 'ATL-002', 'ATL-005');
insert into public.inbound_items (inbound_id, product_id, expected) select '1c000000-0000-0000-0000-000000000004', id, 80 from public.products where sku in ('ATL-007');
insert into public.inbound_items (inbound_id, product_id, expected, received) select '1c000000-0000-0000-0000-000000000005', id, 200, 196 from public.products where sku in ('NOVA-001', 'NOVA-003');
insert into public.stock_moves (product_id, org_id, qty, type, ref, user_id, source, created_at, warehouse_id)
select i.product_id, b.org_id, i.received, 'inbound', b.ref, '00000000-0000-0000-0000-0000000000a3', 'warehouse', b.received_at, b.warehouse_id
from public.inbound_items i join public.inbounds b on b.id = i.inbound_id where b.status = 'received' and i.received > 0;
insert into public.stock_moves (product_id, org_id, qty, type, note, user_id, created_at, warehouse_id)
select id, org_id, 12, 'quarantine', 'Crushed cartons on arrival', '00000000-0000-0000-0000-0000000000a3', now() - interval '20 days', (select id from public.warehouses where code = 'NB') from public.products where sku = 'ATL-003';
-- Stock recorded before warehouses existed (what 0014 does to old movements): 40 units, place unknown.
set session_replication_role = replica;
insert into public.stock_moves (product_id, org_id, qty, type, ref, user_id, source, created_at, warehouse_id)
select id, org_id, 40, 'inbound', 'LEGACY', '00000000-0000-0000-0000-0000000000a3', 'warehouse', now() - interval '60 days', public.holding_warehouse() from public.products where sku = 'ATL-004';
set session_replication_role = origin;

-- Orders: 45 across every status and hold reason, from Shopify and manual
insert into public.orders (id, org_id, customer, email, phone, address, city, zip, country, service, status, hold_reason, carrier, tracking, weight_g, source, store_ref, created_at, shipped_at, delivered_at)
select ('0a000000-0000-0000-0000-0000000' || lpad(i::text, 5, '0'))::uuid,
  case when i % 4 = 0 then '22222222-2222-2222-2222-222222222222' else '11111111-1111-1111-1111-111111111111' end::uuid,
  (array['Camille Durand','Jonas Becker','Sofia Rossi','Liam O''Connor','Emma Johansson','Lucía Fernández','Noah Müller','Chloé Martin','Oliver Smith','Zoë van Dijk'])[1 + i % 10],
  'customer' || i || '@example.com', '+33 6 00 00 00 ' || lpad(i::text, 2, '0'),
  (10 + i) || ' Rue de la République', (array['Paris','Berlin','Milano','Dublin','Stockholm','Madrid','München','Lyon','London','Amsterdam'])[1 + i % 10],
  '7500' || (i % 10), (array['FR','DE','IT','IE','SE','ES','DE','FR','GB','NL'])[1 + i % 10],
  case when i % 5 = 0 then 'ddp' else 'express' end,
  case when i <= 8 then 'new' when i <= 14 then 'on_hold' when i <= 18 then 'packed' when i <= 32 then 'shipped' when i <= 42 then 'delivered' else 'cancelled' end,
  case i when 9 then 'Not in Elmamsflow yet: SH-999. Import or add these products, then press “Match products again”'
         when 10 then 'A product is missing its HS code or customs value' when 11 then 'The shipping address is incomplete in the store'
         when 12 then 'Customer asked to wait until Friday' when 13 then 'Waiting for stock' when 14 then 'A product is missing its HS code or customs value' end,
  case when i > 18 and i <= 42 then (array['YunExpress','4PX','Yanwen','DHL eCommerce'])[1 + i % 4] end,
  case when i > 18 and i <= 42 then 'YT' || lpad((2400000 + i * 7919)::text, 10, '0') end,
  case when i > 14 then 300 + (i * 137) % 2200 else 0 end,
  case when i % 3 = 0 then 'shopify' else 'manual' end, case when i % 3 = 0 then '#' || (1000 + i) end,
  now() - (46 - i) * interval '20 hours',
  case when i > 18 and i <= 42 then now() - (46 - i) * interval '20 hours' + interval '1 day' end,
  case when i > 32 and i <= 42 then now() - (46 - i) * interval '20 hours' + interval '7 days' end
from generate_series(1, 45) i;
insert into public.order_items (order_id, product_id, qty)
select o.id, p.id, 1 + (substr(o.id::text, 33, 4)::int % 3)
from public.orders o
join lateral (select id from public.products where org_id = o.org_id and sku <> 'ATL-010' order by md5(o.id::text || id::text) limit 1 + (substr(o.id::text, 33, 4)::int % 2)) p on true
where o.number not in (select number from public.orders where hold_reason like 'Not in Elmamsflow%');
update public.orders set stock_out = true where status in ('shipped', 'delivered');
insert into public.stock_moves (product_id, org_id, qty, type, ref, user_id, created_at, warehouse_id)
select i.product_id, o.org_id, -i.qty, 'order', o.number, '00000000-0000-0000-0000-0000000000a3', o.shipped_at, o.warehouse_id
from public.order_items i join public.orders o on o.id = i.order_id where o.stock_out;
-- Two open orders not yet given a warehouse, and one transfer on the way Ningbo → Guangzhou (through the real functions).
update public.orders set warehouse_id = null where number in (select number from public.orders where status = 'new' order by number limit 2);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select public.dispatch_transfer(public.create_transfer('11111111-1111-1111-1111-111111111111', (select id from public.warehouses where code = 'NB'), (select id from public.warehouses where code = 'GZ'),
  jsonb_build_array(jsonb_build_object('product_id', 'a0000000-0000-0000-0000-000000000001', 'qty', 30)), 'Stock for EU express orders packed in Guangzhou'), 'SF Express', 'SF1400000000001');
select set_config('request.jwt.claim.sub', '', false);

-- Live carrier tracking (as 17TRACK would have pushed it) on the parcels in transit and delivered.
update public.orders o set
  tracking_registered_at = o.shipped_at + interval '5 minutes',
  tracking_checked_at = now() - interval '2 hours',
  tracking_status = case when o.status = 'delivered' then 'Delivered' else (array['InTransit','InTransit','OutForDelivery','Exception','InfoReceived','AvailableForPickup','DeliveryFailure'])[1 + right(o.number, 2)::int % 7] end,
  tracking_last_event = case when o.status = 'delivered' then 'Delivered, in mailbox' else (array['Arrived at destination hub','Departed from origin facility','Out for delivery','Customs inspection: held for documents','Shipment information received','Available for pickup at service point','Delivery attempted: recipient not available'])[1 + right(o.number, 2)::int % 7] end,
  tracking_last_location = o.city || ', ' || o.country,
  tracking_last_event_at = coalesce(o.delivered_at, now() - interval '6 hours'),
  tracking_eta = case when o.status = 'shipped' then (now() + interval '3 days')::date end
where o.status in ('shipped', 'delivered') and o.tracking is not null;
insert into public.tracking_events (order_id, tracking, at, description, location)
select o.id, o.tracking, o.shipped_at + interval '8 hours', 'Departed from origin facility', 'Ningbo, CN' from public.orders o where o.tracking_status is not null
union all
select o.id, o.tracking, o.shipped_at + interval '2 days', 'Arrived at destination country', o.country from public.orders o where o.tracking_status is not null
union all
select o.id, o.tracking, o.tracking_last_event_at, o.tracking_last_event, o.tracking_last_location from public.orders o where o.tracking_status is not null;

-- Support, billing, a connected store
insert into public.tickets (id, org_id, subject, order_ref, status, created_by, updated_at) values
  ('7a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Parcel to Dublin shows no movement for 5 days', 'EM-20020', 'open', '00000000-0000-0000-0000-0000000000b1', now() - interval '3 hours'),
  ('7a000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Can you relabel 40 lamps before shipping?', null, 'answered', '00000000-0000-0000-0000-0000000000b2', now() - interval '1 day'),
  ('7b000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Invoice question', null, 'closed', '00000000-0000-0000-0000-0000000000c1', now() - interval '6 days');
insert into public.ticket_messages (ticket_id, user_id, from_team, body) values
  ('7a000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', false, 'Hi, tracking hasn''t updated since Monday. Can you check with the carrier?'),
  ('7a000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000b2', false, 'We need new labels on the lamps (ATL-003).'),
  ('7a000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a2', true, 'Yes — send the label file and we''ll do it this week.'),
  ('7b000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', false, 'Thanks, all clear.');
insert into public.rate_cards (org_id, currency, pick_pack_order, pick_pack_extra_unit, packaging_order, shipping_base, shipping_per_kg, ddp_order, receiving_carton, receiving_unit, storage_unit_month, monthly_minimum) values
  ('11111111-1111-1111-1111-111111111111', 'EUR', 1.2, 0.3, 0.35, 2.1, 6.5, 1.5, 3, 0.05, 0.12, 150),
  ('22222222-2222-2222-2222-222222222222', 'GBP', 1.1, 0.25, 0.3, 1.9, 6.2, 1.4, 3, 0.05, 0.1, 100);
insert into public.invoices (id, org_id, period_start, period_end, currency, status, total, issued_at, due_date, paid_at, paid_method) values
  ('1a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '2026-08-01', '2026-08-31', 'EUR', 'paid', 812.40, '2026-09-01', '2026-09-15', '2026-09-10', 'bank'),
  ('1a000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '2026-09-01', '2026-09-30', 'EUR', 'open', 954.10, '2026-10-01', '2026-10-15', null, null),
  ('1b000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', '2026-09-01', '2026-09-30', 'GBP', 'draft', 402.00, null, null, null, null);
insert into public.invoice_lines (invoice_id, category, description, qty, unit_price, amount, position)
select id, 'fulfillment', 'Pick & pack · 120 orders', 120, 1.2, 144, 0 from public.invoices
union all select id, 'shipping', 'Shipping weight · 96 kg billed', 96, 6.5, 624, 1 from public.invoices
union all select id, 'storage', 'Storage · avg 2,100 units over 30 days', 2100, 0.12, 252, 2 from public.invoices;
insert into public.integrations (id, org_id, kind, store_url, name, status, secret_enc, orders_imported, last_sync_at) values
  ('1e000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'shopify', 'atlas-home.myshopify.com', 'Atlas Home', 'active', 'local-test-not-a-secret', 15, now() - interval '2 hours');
update public.orders set integration_id = '1e000000-0000-0000-0000-000000000001', external_id = 'gid://shopify/Order/' || (900000 + right(number, 3)::int)
where source = 'shopify' and org_id = '11111111-1111-1111-1111-111111111111';
update public.orders set source = 'manual', store_ref = null where source = 'shopify' and integration_id is null;
insert into public.billing_settings (id, company, address, email, bank_eur) values (1, 'EL MAMOUN SHIPPING & TRADING SARL-AU', 'Guangzhou, China', 'billing@local.test', 'TEST IBAN — not real')
on conflict (id) do update set address = excluded.address, email = excluded.email, bank_eur = excluded.bank_eur;
insert into public.activity_log (org_id, user_id, action, detail, created_at)
select '11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a3', 'order_updated', '#' || number || ' → ' || status, created_at + interval '1 day'
from public.orders where status in ('shipped', 'delivered') limit 20;
