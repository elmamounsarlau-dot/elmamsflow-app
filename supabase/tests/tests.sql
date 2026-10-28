-- =====================================================================
-- Database checks: client isolation, permissions, inventory accounting.
-- Runs on a throw-away database (see run.sh). Never point this at production.
-- =====================================================================

create schema t;
create table t.results (id serial primary key, name text not null, ok boolean not null, detail text);
grant usage on schema t to authenticated, anon, service_role;

create function t.ok(p_name text, p_ok boolean, p_detail text default null) returns void
language sql security definer as $$ insert into t.results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail) $$;

-- The statement must fail (runs as the current role).
create function t.raises(p_name text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  perform t.ok(p_name, false, 'no error was raised');
exception when others then
  perform t.ok(p_name, true, sqlerrm);
end $$;

-- The statement must fail or change nothing.
create function t.denied(p_name text, p_sql text) returns void language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform t.ok(p_name, n = 0, 'rows changed: ' || n);
exception when others then
  perform t.ok(p_name, true, sqlerrm);
end $$;

-- The statement must succeed.
create function t.works(p_name text, p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  perform t.ok(p_name, true, null);
exception when others then
  perform t.ok(p_name, false, sqlerrm);
end $$;

create function t.rows(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;

create function t.gz() returns uuid language sql stable security definer as $$ select id from public.warehouses where code = 'GZ' $$;
create function t.nb() returns uuid language sql stable security definer as $$ select id from public.warehouses where code = 'NB' $$;
create function t.owner_org() returns uuid language sql security definer as $$ select id from public.organizations where kind = 'owner' limit 1 $$;
create function t.login(p_user uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', p_user::text, false) $$;

-- Balances read with full rights (independent of who is logged in).
create function t.stock(p_product uuid) returns table (on_hand int, quarantined int, reserved int, available int)
language sql security definer as $$
  select on_hand, quarantined, reserved, on_hand - quarantined - reserved from public.product_stock where id = p_product
$$;
create function t.moves_sum(p_product uuid) returns bigint language sql security definer as $$
  select coalesce(sum(qty), 0) from public.stock_moves where product_id = p_product and type in ('inbound', 'order', 'adjust', 'count')
$$;
grant execute on all functions in schema t to authenticated, anon;
grant insert, select on t.results to authenticated, anon;
grant usage on sequence t.results_id_seq to authenticated, anon;

-- ---------- Test data (synthetic) ----------
insert into auth.users (id, email, last_sign_in_at, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local', now(), now()),
  ('00000000-0000-0000-0000-0000000000a2', 'manager@test.local', now(), now()),
  ('00000000-0000-0000-0000-0000000000a3', 'warehouse@test.local', now(), now()),
  ('00000000-0000-0000-0000-0000000000b1', 'a-admin@test.local', now(), now()),
  ('00000000-0000-0000-0000-0000000000b2', 'a-finance@test.local', now(), now()),
  ('00000000-0000-0000-0000-0000000000b3', 'a-support@test.local', now(), now()),
  ('00000000-0000-0000-0000-0000000000c1', 'b-admin@test.local', now(), now());

insert into public.organizations (id, kind, name) values
  ('11111111-1111-1111-1111-111111111111', 'client', 'Client A'),
  ('22222222-2222-2222-2222-222222222222', 'client', 'Client B');

update public.organizations set default_warehouse_id = t.gz() where id = '11111111-1111-1111-1111-111111111111';
update public.organizations set default_warehouse_id = t.nb() where id = '22222222-2222-2222-2222-222222222222';
insert into public.memberships (org_id, user_id, role, status)
select o.id, u.id::uuid, u.role, 'active' from (values
  ('00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000a2', 'manager'),
  ('00000000-0000-0000-0000-0000000000a3', 'warehouse')) u(id, role)
cross join (select id from public.organizations where kind = 'owner') o;
insert into public.memberships (org_id, user_id, role, status) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000b1', 'admin', 'active'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000b2', 'finance', 'active'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000b3', 'support', 'active'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-0000000000c1', 'admin', 'active');

insert into public.products (id, org_id, sku, name, weight_g, hs_code, customs_value) values
  ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A-1', 'Product A1', 250, '630790', 5),
  ('a0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'A-2', 'Product A2', 100, '630790', 3),
  ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'B-1', 'Product B1', 300, '630790', 7);

insert into public.orders (id, org_id, customer, address, country, status) values
  ('0a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Alice', '1 Street', 'FR', 'new'),
  ('0b000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Bob', '2 Street', 'DE', 'new');
insert into public.order_items (order_id, product_id, qty) values
  ('0a000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 2),
  ('0b000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 1);
insert into public.tickets (id, org_id, subject) values
  ('7b000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'B private ticket'),
  ('7a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A ticket');
insert into public.invoices (id, org_id, period_start, period_end, currency, status, total) values
  ('1a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '2026-09-01', '2026-09-30', 'USD', 'draft', 10),
  ('1a000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '2026-08-01', '2026-08-31', 'USD', 'open', 20),
  ('1b000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', '2026-09-01', '2026-09-30', 'USD', 'open', 30);
insert into public.inbounds (id, org_id, ref, status, warehouse_id) values
  ('1c000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'IB-T1', 'announced', t.gz());
insert into public.inbound_items (id, inbound_id, product_id, expected) values
  ('1d000000-0000-0000-0000-000000000001', '1c000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 100);

-- =====================================================================
-- 1. Client isolation (client A admin)
-- =====================================================================
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000b1');

select t.ok('isolation: client A sees only its own products', t.rows('select 1 from public.products') = 2, t.rows('select 1 from public.products')::text);
select t.ok('isolation: client A cannot see client B products', t.rows($q$select 1 from public.products where org_id = '22222222-2222-2222-2222-222222222222'$q$) = 0);
select t.ok('isolation: client A cannot see client B orders', t.rows($q$select 1 from public.orders where org_id = '22222222-2222-2222-2222-222222222222'$q$) = 0);
select t.ok('isolation: client A cannot see client B order lines', t.rows($q$select 1 from public.order_items where order_id = '0b000000-0000-0000-0000-000000000001'$q$) = 0);
select t.ok('isolation: client A cannot see client B tickets', t.rows($q$select 1 from public.tickets where org_id = '22222222-2222-2222-2222-222222222222'$q$) = 0);
select t.ok('isolation: client A cannot see client B invoices', t.rows($q$select 1 from public.invoices where org_id = '22222222-2222-2222-2222-222222222222'$q$) = 0);
select t.ok('isolation: client A cannot see client B stock view rows', t.rows($q$select 1 from public.product_stock where org_id = '22222222-2222-2222-2222-222222222222'$q$) = 0);
select t.ok('isolation: client A cannot see other organisations', t.rows('select 1 from public.organizations') = 1, t.rows('select 1 from public.organizations')::text);
select t.ok('isolation: client A cannot see store connections (secrets)', t.rows('select 1 from public.integrations') = 0);
select t.ok('isolation: client A cannot read access links', t.rows('select 1 from public.access_links') = 0);
select t.ok('isolation: client A sees only its own memberships', t.rows($q$select 1 from public.memberships where org_id <> '11111111-1111-1111-1111-111111111111'$q$) = 0);
select t.ok('isolation: client A cannot see client B roles', t.rows($q$select 1 from public.roles where org_id = '22222222-2222-2222-2222-222222222222'$q$) = 0);
select t.ok('invoices: clients never see drafts', t.rows($q$select 1 from public.invoices where status = 'draft'$q$) = 0);
select t.ok('invoices: client A sees its issued invoice', t.rows($q$select 1 from public.invoices where id = '1a000000-0000-0000-0000-000000000002'$q$) = 1);

-- Writes a client must never be able to make
select t.raises('writes: client A cannot create a product for client B',
  $q$insert into public.products (org_id, sku, name) values ('22222222-2222-2222-2222-222222222222', 'X', 'x')$q$);
select t.denied('writes: client A cannot edit client B products',
  $q$update public.products set name = 'hacked' where org_id = '22222222-2222-2222-2222-222222222222'$q$);
select t.denied('writes: client A cannot move its product to client B',
  $q$update public.products set org_id = '22222222-2222-2222-2222-222222222222' where id = 'a0000000-0000-0000-0000-000000000001'$q$);
select t.raises('writes: client A cannot write stock movements directly',
  $q$insert into public.stock_moves (product_id, org_id, qty, type) values ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1000, 'adjust')$q$);
select t.denied('writes: client A cannot change order status directly',
  $q$update public.orders set status = 'shipped' where id = '0a000000-0000-0000-0000-000000000001'$q$);
select t.denied('writes: client A cannot delete orders',
  $q$delete from public.orders where id = '0a000000-0000-0000-0000-000000000001'$q$);
select t.denied('writes: client A cannot delete products',
  $q$delete from public.products where id = 'a0000000-0000-0000-0000-000000000001'$q$);
select t.raises('writes: client A cannot adjust stock', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', 500, 'x', t.gz())$q$);
select t.raises('writes: client A cannot receive an inbound', $q$select public.receive_inbound('1c000000-0000-0000-0000-000000000001', '{}'::jsonb)$q$);
select t.raises('writes: client A cannot ship an order', $q$select public.set_order_status('0a000000-0000-0000-0000-000000000001', 'shipped')$q$);
select t.raises('writes: client A cannot cancel client B order', $q$select public.cancel_order('0b000000-0000-0000-0000-000000000001')$q$);
select t.raises('writes: client A cannot give itself a staff membership',
  format($q$insert into public.memberships (org_id, user_id, role, status) values (%L, '00000000-0000-0000-0000-0000000000b1', 'owner', 'active')$q$, t.owner_org()));
select t.denied('writes: client A cannot change its own role',
  $q$update public.memberships set role = 'owner' where user_id = '00000000-0000-0000-0000-0000000000b1'$q$);
select t.denied('writes: client A cannot edit roles to gain permissions',
  $q$update public.roles set perms = array['stock.adjust'] where org_id = '11111111-1111-1111-1111-111111111111'$q$);
select t.raises('writes: client A cannot add permissions to roles',
  $q$insert into public.roles (org_id, key, label, perms) values ('11111111-1111-1111-1111-111111111111', 'x', 'x', array['stock.adjust'])$q$);
select t.denied('writes: client A cannot edit its organisation (e.g. un-pause)',
  $q$update public.organizations set status = 'active', name = 'x' where id = '11111111-1111-1111-1111-111111111111'$q$);
select t.denied('writes: client A cannot edit someone else''s profile',
  $q$update public.profiles set full_name = 'x' where id = '00000000-0000-0000-0000-0000000000a1'$q$);
select t.denied('writes: client A cannot mark its invoice paid',
  $q$update public.invoices set status = 'paid' where id = '1a000000-0000-0000-0000-000000000002'$q$);
select t.raises('writes: client A cannot add lines to an invoice',
  $q$insert into public.invoice_lines (invoice_id, category, description, amount) values ('1a000000-0000-0000-0000-000000000002', 'other', 'credit', -999)$q$);
select t.denied('writes: client A cannot change billing details (bank accounts)',
  $q$update public.billing_settings set bank_usd = 'attacker IBAN'$q$);
select t.raises('writes: client A cannot read or write store credentials',
  $q$insert into public.integrations (org_id, kind, store_url, secret_enc) values ('11111111-1111-1111-1111-111111111111', 'shopify', 'x.myshopify.com', 'x')$q$);
select t.raises('writes: client A cannot put a client B product on its own order',
  $q$insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 5)$q$);
select t.raises('writes: client A cannot put a client B product on its own inbound',
  $q$insert into public.inbound_items (inbound_id, product_id, expected) values ('1c000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 500)$q$);
select t.raises('writes: client A cannot post a message as the Elmamsflow team',
  $q$insert into public.ticket_messages (ticket_id, user_id, from_team, body) values ('7a000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', true, 'Your refund is approved')$q$);
select t.works('writes: client A can reply in its own ticket as itself',
  $q$insert into public.ticket_messages (ticket_id, user_id, from_team, body) values ('7a000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', false, 'Thanks')$q$);
select t.raises('writes: client A cannot reply in client B tickets',
  $q$insert into public.ticket_messages (ticket_id, user_id, from_team, body) values ('7b000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', false, 'hi')$q$);
select t.raises('writes: client A cannot write activity for client B',
  $q$insert into public.activity_log (org_id, user_id, action) values ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-0000000000b1', 'x')$q$);
select t.raises('writes: client A cannot write activity in someone else''s name',
  $q$insert into public.activity_log (org_id, user_id, action) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-0000000000a1', 'x')$q$);
select t.raises('validation: product weight cannot be negative',
  $q$insert into public.products (org_id, sku, name, weight_g) values ('11111111-1111-1111-1111-111111111111', 'NEG', 'neg', -5)$q$);
select t.raises('validation: customs value cannot be negative',
  $q$insert into public.products (org_id, sku, name, customs_value) values ('11111111-1111-1111-1111-111111111111', 'NEG2', 'neg', -1)$q$);
select t.raises('validation: SKUs are unique per client regardless of letter case',
  $q$insert into public.products (org_id, sku, name) values ('11111111-1111-1111-1111-111111111111', 'a-1', 'dup')$q$);
select t.raises('validation: order line quantity must be positive',
  $q$insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 0)$q$);
select t.raises('validation: inbound expected quantity cannot be negative',
  $q$insert into public.inbounds (id, org_id, ref) values ('1c000000-0000-0000-0000-0000000000ff', '11111111-1111-1111-1111-111111111111', 'IB-NEG');
     insert into public.inbound_items (inbound_id, product_id, expected) values ('1c000000-0000-0000-0000-0000000000ff', 'a0000000-0000-0000-0000-000000000001', -50)$q$);

-- Same-org product on own order is allowed
select t.works('writes: client A can add its own product to its new order',
  $q$insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 1)$q$);
select t.ok('isolation: client B product unaffected by client A attempts', (select reserved from t.stock('b0000000-0000-0000-0000-000000000001')) = 1);

-- Client finance role (invoices.view only)
select t.login('00000000-0000-0000-0000-0000000000b2');
select t.raises('roles: finance cannot create orders',
  $q$insert into public.orders (org_id, customer, address, country) values ('11111111-1111-1111-1111-111111111111', 'x', 'x', 'FR')$q$);
select t.raises('roles: finance cannot create products',
  $q$insert into public.products (org_id, sku, name) values ('11111111-1111-1111-1111-111111111111', 'FIN', 'x')$q$);
select t.ok('roles: finance sees issued invoices', t.rows('select 1 from public.invoices') = 1);
-- Client support role (support.reply only)
select t.login('00000000-0000-0000-0000-0000000000b3');
select t.ok('roles: client support cannot see invoices', t.rows('select 1 from public.invoices') = 0);
select t.raises('roles: client support cannot cancel orders', $q$select public.cancel_order('0a000000-0000-0000-0000-000000000001')$q$);

-- Not signed in
select t.login('00000000-0000-0000-0000-000000000000');
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select t.ok('anonymous: sees no products', t.rows('select 1 from public.products') = 0);
select t.ok('anonymous: sees no orders', t.rows('select 1 from public.orders') = 0);
select t.ok('anonymous: sees no organisations', t.rows('select 1 from public.organizations') = 0);
select t.ok('anonymous: sees no profiles', t.rows('select 1 from public.profiles') = 0);
select t.raises('anonymous: cannot run warehouse functions', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', 5, 'x', t.gz())$q$);
reset role;

-- =====================================================================
-- 2. Inventory accounting (warehouse)
-- =====================================================================
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');

select t.works('inbound: count saved', $q$select public.count_inbound('1c000000-0000-0000-0000-000000000001', '{"1d000000-0000-0000-0000-000000000001": 98}'::jsonb)$q$);
select t.ok('inbound: counted units are not stock yet', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 0);
select t.works('inbound: receive', $q$select public.receive_inbound('1c000000-0000-0000-0000-000000000001', '{"1d000000-0000-0000-0000-000000000001": 98}'::jsonb)$q$);
select t.raises('inbound: receiving twice is refused', $q$select public.receive_inbound('1c000000-0000-0000-0000-000000000001', '{"1d000000-0000-0000-0000-000000000001": 98}'::jsonb)$q$);
select t.raises('inbound: counting after receipt is refused', $q$select public.count_inbound('1c000000-0000-0000-0000-000000000001', '{"1d000000-0000-0000-0000-000000000001": 500}'::jsonb)$q$);
select t.ok('inbound: on hand = 98 after receipt (posted once)', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 98,
  (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001'))::text);
select t.ok('inbound: received inbound cannot be moved back to an earlier step',
  t.rows($q$select 1 from public.inbounds where id = '1c000000-0000-0000-0000-000000000001' and status = 'received'$q$) = 1);
select t.denied('inbound: a received inbound cannot be reopened directly',
  $q$update public.inbounds set status = 'announced' where id = '1c000000-0000-0000-0000-000000000001'$q$);
select t.denied('inbound: a received line cannot be edited afterwards',
  $q$update public.inbound_items set received = 5000 where inbound_id = '1c000000-0000-0000-0000-000000000001'$q$);

select t.ok('reserved: open order (2 + 1 lines) reserves units', (select reserved from t.stock('a0000000-0000-0000-0000-000000000001')) = 2);
select t.raises('adjust: cannot go below zero', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', -99, 'x', t.gz())$q$);
select t.works('quarantine: 10 units', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000001', 10, 'damaged', t.gz())$q$);
select t.ok('quarantine: excluded from available (98 - 10 - 2 = 86)', (select available from t.stock('a0000000-0000-0000-0000-000000000001')) = 86,
  (select available from t.stock('a0000000-0000-0000-0000-000000000001'))::text);
select t.ok('quarantine: on hand unchanged', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 98);
select t.raises('quarantine: cannot quarantine more than on hand', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000001', 89, 'x', t.gz())$q$);
select t.raises('quarantine: reason required', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000001', 1, '  ', t.gz())$q$);
select t.raises('adjust: cannot drop on hand below quarantined units', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', -90, 'x', t.gz())$q$);
select t.works('release: 4 back to sellable', $q$select public.release_stock('a0000000-0000-0000-0000-000000000001', 4, 'checked ok', false, t.gz())$q$);
select t.works('release: write off 3', $q$select public.release_stock('a0000000-0000-0000-0000-000000000001', 3, 'broken', true, t.gz())$q$);
select t.ok('release: balances after release + write-off (on hand 95, quarantine 3)',
  (select on_hand = 95 and quarantined = 3 from t.stock('a0000000-0000-0000-0000-000000000001')),
  (select on_hand || '/' || quarantined from t.stock('a0000000-0000-0000-0000-000000000001')));
select t.raises('release: cannot release more than quarantined', $q$select public.release_stock('a0000000-0000-0000-0000-000000000001', 4, 'x', false, t.gz())$q$);
select t.raises('adjust: zero adjustment refused', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', 0, 'x', t.gz())$q$);
select t.ok('audit: every movement records who did it',
  t.rows($q$select 1 from public.stock_moves where user_id is null$q$) = 0);
select t.ok('audit: stock view equals the sum of movements', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = t.moves_sum('a0000000-0000-0000-0000-000000000001'));

-- Shipping takes stock out exactly once
select t.works('adjust: A-2 gets 5 units', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000002', 5, 'found in count', t.gz())$q$);
select t.works('ship: order shipped', $q$select public.set_order_status('0a000000-0000-0000-0000-000000000001', 'shipped', 'YunExpress', 'YT123', 300)$q$);
select t.ok('ship: on hand 95 - 2 = 93', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 93,
  (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001'))::text);
select t.works('ship: marked delivered', $q$select public.set_order_status('0a000000-0000-0000-0000-000000000001', 'delivered')$q$);
select t.works('ship: shipped again (status correction)', $q$select public.set_order_status('0a000000-0000-0000-0000-000000000001', 'shipped')$q$);
select t.ok('ship: no double deduction after status changes', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 93);
select t.raises('ship: a shipped order cannot go back to new', $q$select public.set_order_status('0a000000-0000-0000-0000-000000000001', 'new')$q$);
select t.raises('ship: a shipped order cannot be cancelled', $q$select public.cancel_order('0a000000-0000-0000-0000-000000000001')$q$);
select t.ok('ship: reservation released after shipping', (select reserved from t.stock('a0000000-0000-0000-0000-000000000001')) = 0);

-- Shipping more than is on hand must not create negative stock
reset role;
insert into public.orders (id, org_id, customer, address, country, status) values
  ('0a000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Big', '3 Street', 'FR', 'new');
insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 50);
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.raises('ship: refused when the order needs more units than are on hand (A-2 has 4, needs 50)',
  $q$select public.set_order_status('0a000000-0000-0000-0000-000000000002', 'shipped', 'X', 'T1')$q$);
select t.ok('ship: no negative stock created', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002')) >= 0,
  (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002'))::text);

-- Stock count import: same file twice
select t.works('count CSV: applied', $q$select public.apply_stock_count('[{"product_id":"a0000000-0000-0000-0000-000000000001","counted":90}]'::jsonb, 'count.csv', 'hash-1', current_date, 'WH', t.gz())$q$);
select t.raises('count CSV: same file refused the second time', $q$select public.apply_stock_count('[{"product_id":"a0000000-0000-0000-0000-000000000001","counted":90}]'::jsonb, 'count.csv', 'hash-1', current_date, 'WH', t.gz())$q$);
select t.ok('count CSV: on hand set to counted value', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 90);
select t.raises('count CSV: negative count refused (whole file rolled back)', $q$select public.apply_stock_count('[{"product_id":"a0000000-0000-0000-0000-000000000002","counted":5},{"product_id":"a0000000-0000-0000-0000-000000000001","counted":-1}]'::jsonb, 'bad.csv', 'hash-2', current_date, 'WH', t.gz())$q$);
select t.ok('count CSV: rollback left A-2 untouched (4)', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002')) = 4, (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002'))::text);
select t.ok('count CSV: rollback left no import record', t.rows($q$select 1 from public.imports where file_hash = 'hash-2'$q$) = 0);

-- =====================================================================
-- 3. Holds (migration 0009)
-- =====================================================================
reset role;
insert into public.orders (id, org_id, customer, address, country, status, hold_reason) values
  ('0a000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'H1', '4 Street', 'FR', 'new', null),
  ('0a000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'H2', '5 Street', 'FR', 'on_hold', 'A product is missing its HS code or customs value');
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.ok('holds: automatic kind is set from the reason', t.rows($q$select 1 from public.orders where id = '0a000000-0000-0000-0000-000000000004' and hold_kind = 'customs' and held_at is not null$q$) = 1);
select t.ok('holds: client holds its own new order', (select public.hold_orders(array['0a000000-0000-0000-0000-000000000003'::uuid], true)) = 1);
select t.ok('holds: client releases its own manual hold', (select public.hold_orders(array['0a000000-0000-0000-0000-000000000003'::uuid], false)) = 1);
select t.ok('holds: client cannot release a customs hold', (select public.hold_orders(array['0a000000-0000-0000-0000-000000000004'::uuid], false)) = 0);
select t.ok('holds: client cannot hold client B orders', (select public.hold_orders(array['0b000000-0000-0000-0000-000000000001'::uuid], true)) = 0);
select t.ok('holds: client B order untouched', (select status from public.orders where id = '0b000000-0000-0000-0000-000000000001') is null);
reset role;
select t.ok('holds: client B order still new', (select status from public.orders where id = '0b000000-0000-0000-0000-000000000001') = 'new');

-- =====================================================================
-- 4. Store orders are never imported twice for the same store
-- =====================================================================
insert into public.integrations (id, org_id, kind, store_url, secret_enc) values
  ('1e000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'shopify', 'a.myshopify.com', 'x');
insert into public.orders (org_id, customer, address, country, source, integration_id, external_id) values
  ('11111111-1111-1111-1111-111111111111', 'S1', 'x', 'FR', 'shopify', '1e000000-0000-0000-0000-000000000001', 'gid://shopify/Order/1');
select t.raises('store orders: same store order cannot be inserted twice',
  $q$insert into public.orders (org_id, customer, address, country, source, integration_id, external_id) values ('11111111-1111-1111-1111-111111111111', 'S1', 'x', 'FR', 'shopify', '1e000000-0000-0000-0000-000000000001', 'gid://shopify/Order/1')$q$);

-- =====================================================================
-- 5. An order without products can't be shipped (migration 0011)
-- =====================================================================
reset role;
insert into public.orders (id, org_id, customer, address, country) values
  ('0a000000-0000-0000-0000-0000000000e1', '11111111-1111-1111-1111-111111111111', 'Empty', 'x', 'FR');
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.raises('ship: an order with no products is refused', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000e1', 'shipped', 'X', 'E1')$q$);
reset role;

-- =====================================================================
-- 6. Auditable reconciliation (migration 0012) — owner only, evidence required
-- =====================================================================
reset role;
insert into public.orders (id, org_id, customer, address, country) values
  ('0a000000-0000-0000-0000-0000000000f1', '11111111-1111-1111-1111-111111111111', 'Test ship', 'x', 'FR');
insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-000000000002', 2);
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.works('reconcile: warehouse ships a test order', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000f1', 'shipped', 'TEST', 'T0')$q$);
select t.raises('reconcile: warehouse cannot reverse a shipment', $q$select public.reverse_shipment('0a000000-0000-0000-0000-0000000000f1', 'test', 'evidence')$q$);
select t.login('00000000-0000-0000-0000-0000000000a2');
select t.raises('reconcile: a manager cannot reverse a shipment', $q$select public.reverse_shipment('0a000000-0000-0000-0000-0000000000f1', 'test', 'evidence')$q$);
select t.raises('reconcile: a manager cannot reconcile stock', $q$select public.reconcile_stock('a0000000-0000-0000-0000-000000000002', 3, 'x', 'y', null, t.gz())$q$);
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.raises('reconcile: a client admin cannot reconcile stock', $q$select public.reconcile_stock('a0000000-0000-0000-0000-000000000002', 3, 'x', 'y', null, t.gz())$q$);
select t.login('00000000-0000-0000-0000-0000000000a1');
select t.raises('reconcile: evidence is required', $q$select public.reverse_shipment('0a000000-0000-0000-0000-0000000000f1', 'test shipment', '  ')$q$);
select t.ok('reconcile: before reversal A-2 = 2', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002')) = 2, (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002'))::text);
select t.works('reconcile: owner reverses the test shipment', $q$select public.reverse_shipment('0a000000-0000-0000-0000-0000000000f1', 'Test shipment, no parcel left', 'Confirmed by warehouse on 22 Oct')$q$);
select t.ok('reconcile: units are back (4) and the order is cancelled',
  (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002')) = 4
  and (select status from public.orders where id = '0a000000-0000-0000-0000-0000000000f1') = 'cancelled');
select t.ok('reconcile: original shipment movement kept, reversal recorded with approver and evidence',
  t.rows($q$select 1 from public.stock_moves where ref = (select number from public.orders where id = '0a000000-0000-0000-0000-0000000000f1') and type = 'order'$q$) = 1
  and t.rows($q$select 1 from public.stock_moves where source = 'reconciliation' and approved_by = '00000000-0000-0000-0000-0000000000a1' and evidence is not null$q$) = 1);
select t.raises('reconcile: a reversed order cannot be reversed again', $q$select public.reverse_shipment('0a000000-0000-0000-0000-0000000000f1', 'again', 'again')$q$);
select t.raises('reconcile: cannot reconcile below zero', $q$select public.reconcile_stock('a0000000-0000-0000-0000-000000000002', -50, 'x', 'y', null, t.gz())$q$);
select t.works('reconcile: owner records a receipt with evidence', $q$select public.reconcile_stock('a0000000-0000-0000-0000-000000000002', 3, 'Units received without inbound', 'Warehouse photo WeChat 22 Oct', 'EM-TEST', t.gz())$q$);
select t.ok('reconcile: balance 7 = sum of movements', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000002')) = 7 and t.moves_sum('a0000000-0000-0000-0000-000000000002') = 7);
reset role;

-- =====================================================================
-- 7. Warehouses (migration 0014): balances per warehouse, shipping, transfers, legacy stock
-- =====================================================================
reset role;
insert into public.products (id, org_id, sku, name, hs_code, customs_value) values
  ('a0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'A-3', 'Product A3', '630790', 2),
  ('a0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'A-4', 'Legacy pooled', '630790', 2);
insert into public.inbounds (id, org_id, ref, warehouse_id) values ('1c000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'IB-NB', t.nb());
insert into public.inbound_items (id, inbound_id, product_id, expected) values ('1d000000-0000-0000-0000-0000000000a3', '1c000000-0000-0000-0000-0000000000a3', 'a0000000-0000-0000-0000-000000000003', 50);
insert into public.orders (id, org_id, customer, address, country) values ('0a000000-0000-0000-0000-0000000000a3', '11111111-1111-1111-1111-111111111111', 'WH order', 'x', 'FR');
insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000a3', 'a0000000-0000-0000-0000-000000000003', 10);
create function t.wh(p_product uuid, p_code text) returns int language sql security definer as $$
  select coalesce((select on_hand from public.warehouse_stock where product_id = p_product and warehouse_code = p_code), 0) $$;
grant execute on function t.wh to authenticated;
select t.ok('warehouses: Guangzhou, Ningbo and the unallocated pool exist', (select count(*) from public.warehouses) = 3);
select t.ok('warehouses: new orders take the client default warehouse (Guangzhou)', (select warehouse_id from public.orders where id = '0a000000-0000-0000-0000-0000000000a3') = t.gz());
select t.ok('warehouses: every stock movement has a warehouse', (select count(*) from public.stock_moves where warehouse_id is null) = 0);

set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.works('warehouses: receive 50 units at Ningbo', $q$select public.receive_inbound('1c000000-0000-0000-0000-0000000000a3', '{"1d000000-0000-0000-0000-0000000000a3": 50}'::jsonb)$q$);
select t.ok('warehouses: Ningbo 50, Guangzhou 0', t.wh('a0000000-0000-0000-0000-000000000003', 'NB') = 50 and t.wh('a0000000-0000-0000-0000-000000000003', 'GZ') = 0);
select t.raises('warehouses: an order at Guangzhou cannot ship stock that is only in Ningbo',
  $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a3', 'shipped', 'X', 'W1')$q$);
select t.raises('warehouses: cannot receive into the unallocated pool',
  $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000003', 5, 'x', (select id from public.warehouses where code = 'UNALLOC'))$q$);
select t.ok('warehouses: assign the order to Ningbo', (select public.assign_order_warehouse(array['0a000000-0000-0000-0000-0000000000a3'::uuid], t.nb())) = 1);
select t.works('warehouses: ship from Ningbo', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a3', 'shipped', 'X', 'W1')$q$);
select t.ok('warehouses: Ningbo 40 after shipping 10', t.wh('a0000000-0000-0000-0000-000000000003', 'NB') = 40);
select t.ok('warehouses: a shipped order can no longer change warehouse', (select public.assign_order_warehouse(array['0a000000-0000-0000-0000-0000000000a3'::uuid], t.gz())) = 0);

-- Transfers
select t.works('transfer: create Ningbo → Guangzhou 15 units',
  $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', t.nb(), t.gz(), '[{"product_id":"a0000000-0000-0000-0000-000000000003","qty":15}]'::jsonb, 'Rebalance for EU orders')$q$);
select t.ok('transfer: nothing moves until it is dispatched', t.wh('a0000000-0000-0000-0000-000000000003', 'NB') = 40);
select t.works('transfer: dispatch', $q$select public.dispatch_transfer((select id from public.transfers where reason = 'Rebalance for EU orders'), 'SF Express', 'SF123')$q$);
select t.ok('transfer: out of Ningbo, not yet in Guangzhou, shown as in transfer',
  t.wh('a0000000-0000-0000-0000-000000000003', 'NB') = 25 and t.wh('a0000000-0000-0000-0000-000000000003', 'GZ') = 0
  and (select in_transfer from public.product_stock where id = 'a0000000-0000-0000-0000-000000000003') = 15);
select t.raises('transfer: cannot be dispatched twice', $q$select public.dispatch_transfer((select id from public.transfers where reason = 'Rebalance for EU orders'), null, null)$q$);
select t.raises('transfer: cannot receive more than sent',
  $q$select public.receive_transfer((select id from public.transfers where reason = 'Rebalance for EU orders'), jsonb_build_object((select id::text from public.transfer_items where qty = 15), 16))$q$);
select t.works('transfer: receive 14 of 15 (1 lost on the way)',
  $q$select public.receive_transfer((select id from public.transfers where reason = 'Rebalance for EU orders'), jsonb_build_object((select id::text from public.transfer_items where qty = 15), 14))$q$);
select t.ok('transfer: Guangzhou 14, Ningbo 25, nothing in transit',
  t.wh('a0000000-0000-0000-0000-000000000003', 'GZ') = 14 and t.wh('a0000000-0000-0000-0000-000000000003', 'NB') = 25
  and (select in_transfer from public.product_stock where id = 'a0000000-0000-0000-0000-000000000003') = 0);
select t.ok('transfer: the missing unit is recorded', t.rows($q$select 1 from public.activity_log where action = 'transfer_received' and detail like '%1 units missing%'$q$) = 1);
select t.raises('transfer: cannot be received twice', $q$select public.receive_transfer((select id from public.transfers where reason = 'Rebalance for EU orders'), null)$q$);

-- Reserved stock and quarantine can't be sent away
reset role;
insert into public.orders (id, org_id, customer, address, country, warehouse_id) values ('0a000000-0000-0000-0000-0000000000a4', '11111111-1111-1111-1111-111111111111', 'NB reserve', 'x', 'FR', t.nb());
insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000a4', 'a0000000-0000-0000-0000-000000000003', 20);
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.works('transfer: request 10 more from Ningbo', $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', t.nb(), t.gz(), '[{"product_id":"a0000000-0000-0000-0000-000000000003","qty":10}]'::jsonb, 'Second move')$q$);
select t.raises('transfer: units reserved for orders at Ningbo cannot be sent (25 on hand − 20 reserved = 5 free)',
  $q$select public.dispatch_transfer((select id from public.transfers where reason = 'Second move'), null, null)$q$);
select t.works('transfer: a transfer that has not left can be cancelled', $q$select public.cancel_transfer((select id from public.transfers where reason = 'Second move'), 'not needed')$q$);
select t.works('quarantine: 3 units at Guangzhou', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000003', 3, 'dented', t.gz())$q$);
select t.raises('quarantine: cannot quarantine in Ningbo what is only in Guangzhou', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000003', 26, 'x', t.nb())$q$);

-- Holds block packing and shipping
reset role;
insert into public.orders (id, org_id, customer, address, country, status, hold_reason, warehouse_id) values ('0a000000-0000-0000-0000-0000000000a5', '11111111-1111-1111-1111-111111111111', 'Held', 'x', 'FR', 'on_hold', 'Customer asked to wait', t.nb());
insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000a5', 'a0000000-0000-0000-0000-000000000003', 1);
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.raises('holds: an order on hold cannot be shipped without releasing it', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a5', 'shipped', 'X', 'H1')$q$);

-- Client and permission rules
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.raises('transfer: a client cannot create transfers', $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', t.nb(), t.gz(), '[{"product_id":"a0000000-0000-0000-0000-000000000003","qty":1}]'::jsonb, 'x')$q$);
select t.raises('warehouses: a client cannot assign warehouses', $q$select public.assign_order_warehouse(array['0a000000-0000-0000-0000-0000000000a4'::uuid], t.gz())$q$);
select t.ok('transfer: client A sees its own transfers', t.rows('select 1 from public.transfers') >= 2);
select t.login('00000000-0000-0000-0000-0000000000c1');
select t.ok('transfer: client B cannot see client A transfers', t.rows('select 1 from public.transfers') = 0);
select t.ok('warehouses: client B cannot see client A per-warehouse stock', t.rows($q$select 1 from public.warehouse_stock where org_id = '11111111-1111-1111-1111-111111111111'$q$) = 0);
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.raises('transfer: a client B product cannot travel on a client A transfer',
  $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', t.nb(), t.gz(), '[{"product_id":"b0000000-0000-0000-0000-000000000001","qty":1}]'::jsonb, 'x')$q$);

-- Stock recorded before warehouses: kept in the unallocated pool until the owner allocates it with evidence
reset role;
-- Simulates a receipt recorded before 0014 (the migration labels those rows as unallocated; triggers don't run on them).
set session_replication_role = replica;
insert into public.stock_moves (product_id, org_id, warehouse_id, qty, type, ref, user_id)
values ('a0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', (select id from public.warehouses where code = 'UNALLOC'), 30, 'inbound', 'PRE-WH', null);
set session_replication_role = origin;
insert into public.orders (id, org_id, customer, address, country, warehouse_id) values ('0a000000-0000-0000-0000-0000000000a6', '11111111-1111-1111-1111-111111111111', 'Legacy', 'x', 'FR', t.gz());
insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000a6', 'a0000000-0000-0000-0000-000000000004', 5);
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.raises('legacy: unallocated stock cannot ship', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a6', 'shipped', 'X', 'L1')$q$);
select t.raises('legacy: the warehouse team cannot allocate the pool',
  $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', (select id from public.warehouses where code = 'UNALLOC'), t.gz(), '[{"product_id":"a0000000-0000-0000-0000-000000000004","qty":30}]'::jsonb, 'x', 'allocation', 'y')$q$);
select t.login('00000000-0000-0000-0000-0000000000a1');
select t.raises('legacy: an allocation needs evidence',
  $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', (select id from public.warehouses where code = 'UNALLOC'), t.gz(), '[{"product_id":"a0000000-0000-0000-0000-000000000004","qty":30}]'::jsonb, 'Physical count', 'allocation', ' ')$q$);
select t.raises('legacy: cannot allocate more than is in the pool',
  $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', (select id from public.warehouses where code = 'UNALLOC'), t.gz(), '[{"product_id":"a0000000-0000-0000-0000-000000000004","qty":31}]'::jsonb, 'Physical count', 'allocation', 'GZ count sheet 22 Oct')$q$);
select t.works('legacy: owner allocates 30 units to Guangzhou with evidence',
  $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', (select id from public.warehouses where code = 'UNALLOC'), t.gz(), '[{"product_id":"a0000000-0000-0000-0000-000000000004","qty":30}]'::jsonb, 'Physical count', 'allocation', 'GZ count sheet 22 Oct')$q$);
select t.ok('legacy: pool 0, Guangzhou 30, total unchanged (30)',
  t.wh('a0000000-0000-0000-0000-000000000004', 'UNALLOC') = 0 and t.wh('a0000000-0000-0000-0000-000000000004', 'GZ') = 30
  and (select on_hand from public.product_stock where id = 'a0000000-0000-0000-0000-000000000004') = 30);
select t.ok('legacy: allocation recorded with approver and evidence', t.rows($q$select 1 from public.stock_moves where type = 'transfer_in' and source = 'reconciliation' and approved_by = '00000000-0000-0000-0000-0000000000a1' and evidence = 'GZ count sheet 22 Oct'$q$) = 1);
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.works('legacy: once allocated, the order ships from Guangzhou', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a6', 'shipped', 'X', 'L1')$q$);
reset role;
select t.ok('invariant: per-warehouse balances add up to each product total',
  not exists (select 1 from public.product_stock p
              where p.on_hand <> coalesce((select sum(on_hand) from public.warehouse_stock w where w.product_id = p.id), 0)));
select t.ok('invariant: no warehouse balance is negative', not exists (select 1 from public.warehouse_stock where on_hand < 0 or quarantined < 0 or quarantined > on_hand));

-- =====================================================================
-- 8. Live carrier tracking (17TRACK, 0015)
-- =====================================================================
-- Order a6 shipped above with tracking L1 (client A).
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a1');
select t.raises('tracking: staff (even the owner) cannot write carrier data directly',
  $q$select public.apply_tracking('0a000000-0000-0000-0000-0000000000a6', 'L1', 'Delivered', null, 'x', null, now(), null, null, '[]')$q$);
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.raises('tracking: a client cannot mark its own order delivered',
  $q$select public.apply_tracking('0a000000-0000-0000-0000-0000000000a6', 'L1', 'Delivered', null, 'x', null, now(), null, null, '[]')$q$);
select t.denied('tracking: a client cannot set carrier fields on its order',
  $q$update public.orders set tracking_status = 'Delivered' where id = '0a000000-0000-0000-0000-0000000000a6'$q$);
reset role;
set role service_role;
select t.ok('tracking: an in-transit update is stored with its events',
  public.apply_tracking('0a000000-0000-0000-0000-0000000000a6', 'L1', 'InTransit', 'InTransit_Other', 'Departed Guangzhou hub', 'Guangzhou, CN',
    '2099-01-02T03:00:00Z', '2099-01-09', 190008,
    '[{"at":"2099-01-02T03:00:00Z","description":"Departed Guangzhou hub","location":"Guangzhou, CN"},{"at":"2099-01-01T10:00:00Z","description":"Accepted by carrier"}]') = 'updated');
select t.ok('tracking: same push twice stores each event once',
  public.apply_tracking('0a000000-0000-0000-0000-0000000000a6', 'L1', 'InTransit', 'InTransit_Other', 'Departed Guangzhou hub', 'Guangzhou, CN',
    '2099-01-02T03:00:00Z', null, null,
    '[{"at":"2099-01-02T03:00:00Z","description":"Departed Guangzhou hub","location":"Guangzhou, CN"},{"at":"2099-01-01T10:00:00Z","description":"Accepted by carrier"}]') = 'updated'
  and (select count(*) from public.tracking_events where order_id = '0a000000-0000-0000-0000-0000000000a6') = 2);
select t.ok('tracking: an older push arriving late does not overwrite newer status',
  public.apply_tracking('0a000000-0000-0000-0000-0000000000a6', 'L1', 'InfoReceived', null, 'Label created', null, '2099-01-01T00:00:00Z', null, null, '[]') = 'stale'
  and (select tracking_status from public.orders where id = '0a000000-0000-0000-0000-0000000000a6') = 'InTransit');
select t.ok('tracking: an update for an old tracking number is ignored',
  public.apply_tracking('0a000000-0000-0000-0000-0000000000a6', 'OTHER-NUMBER', 'Delivered', null, 'x', null, '2099-02-01', null, null, '[]') = 'ignored');
select t.ok('tracking: carrier Delivered marks the order delivered automatically, logged',
  public.apply_tracking('0a000000-0000-0000-0000-0000000000a6', 'L1', 'Delivered', 'Delivered_Other', 'Delivered to recipient', 'Paris, FR', '2099-01-05T09:00:00Z', null, null,
    '[{"at":"2099-01-05T09:00:00Z","description":"Delivered to recipient","location":"Paris, FR"}]') = 'delivered');
select t.ok('tracking: the order is now Delivered with a delivery date', (select status = 'delivered' and delivered_at is not null from public.orders where id = '0a000000-0000-0000-0000-0000000000a6'),
  (select status || ' ' || coalesce(delivered_at::text, 'null') from public.orders where id = '0a000000-0000-0000-0000-0000000000a6'));
select t.ok('tracking: automatic delivery is in the activity log', exists (select 1 from public.activity_log where action = 'order_delivered_auto'));
reset role;
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.ok('tracking: the client sees its own carrier history', t.rows($q$select 1 from public.tracking_events where order_id = '0a000000-0000-0000-0000-0000000000a6'$q$) = 3);
select t.login('00000000-0000-0000-0000-0000000000c1');
select t.ok('tracking: another client cannot see that history', t.rows($q$select 1 from public.tracking_events where order_id = '0a000000-0000-0000-0000-0000000000a6'$q$) = 0);
reset role;
-- A corrected tracking number starts live tracking from scratch.
update public.orders set tracking_status = 'InTransit', tracking_registered_at = now(), status = 'shipped' where id = '0a000000-0000-0000-0000-0000000000a6';
update public.orders set tracking = 'L2' where id = '0a000000-0000-0000-0000-0000000000a6';
select t.ok('tracking: changing the number clears the old live status', (select tracking_status is null and tracking_registered_at is null from public.orders where id = '0a000000-0000-0000-0000-0000000000a6'));
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000b1');
insert into public.orders (id, org_id, customer, address, country, tracking_status, tracking_last_event) values ('0a000000-0000-0000-0000-0000000000a7', '11111111-1111-1111-1111-111111111111', 'Fake', 'x', 'FR', 'Delivered', 'fake');
reset role;
select t.ok('tracking: a new order cannot arrive with carrier data filled in', (select tracking_status is null and tracking_last_event is null from public.orders where id = '0a000000-0000-0000-0000-0000000000a7'));

-- =====================================================================
-- 9. Shipper role (0016): ships orders, nothing else
-- =====================================================================
insert into auth.users (id, email, last_sign_in_at, email_confirmed_at) values ('00000000-0000-0000-0000-0000000000a4', 'shipper@test.local', now(), now());
insert into public.memberships (org_id, user_id, role, status) values (t.owner_org(), '00000000-0000-0000-0000-0000000000a4', 'shipper', 'active');
insert into public.orders (id, org_id, customer, address, country, warehouse_id) values
  ('0a000000-0000-0000-0000-0000000000a8', '11111111-1111-1111-1111-111111111111', 'Ship me', 'x', 'FR', t.gz()),
  ('0a000000-0000-0000-0000-0000000000a9', '11111111-1111-1111-1111-111111111111', 'Ship me too', 'x', 'FR', t.gz());
insert into public.order_items (order_id, product_id, qty) values
  ('0a000000-0000-0000-0000-0000000000a8', 'a0000000-0000-0000-0000-000000000004', 1),
  ('0a000000-0000-0000-0000-0000000000a9', 'a0000000-0000-0000-0000-000000000004', 1);
select t.ok('shipper: role exists for the team with only "pack and ship"', (select perms = array['orders.warehouse'] and not locked from public.roles where key = 'shipper' and org_id = t.owner_org()));
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a4');
select t.works('shipper: marks an order packed', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a8', 'packed')$q$);
select t.works('shipper: ships it with carrier and tracking', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a8', 'shipped', 'YunExpress', 'YT0000000001')$q$);
select t.ok('shipper: shipping takes the units out of stock at that warehouse', (select stock_out from public.orders where id = '0a000000-0000-0000-0000-0000000000a8'));
select t.raises('shipper: cannot put an order on hold', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a9', 'on_hold', null, null, null, 'x')$q$);
select t.raises('shipper: cannot cancel an order', $q$select public.set_order_status('0a000000-0000-0000-0000-0000000000a9', 'cancelled')$q$);
select t.ok('shipper: cannot hold orders in bulk', public.hold_orders(array['0a000000-0000-0000-0000-0000000000a9'::uuid], true, 'x') = 0);
select t.raises('shipper: cannot correct stock', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000004', 5, 'x', t.gz())$q$);
select t.raises('shipper: cannot move stock between warehouses',
  $q$select public.create_transfer('11111111-1111-1111-1111-111111111111', t.gz(), t.nb(), '[{"product_id":"a0000000-0000-0000-0000-000000000004","qty":1}]'::jsonb, 'x')$q$);
select t.denied('shipper: cannot change prices', $q$update public.rate_cards set currency = 'USD'$q$);
select t.denied('shipper: cannot add team members', $q$insert into public.memberships (org_id, user_id, role, status) values (t.owner_org(), '00000000-0000-0000-0000-0000000000a4', 'owner', 'active')$q$);
reset role;

-- =====================================================================
-- 10. Client experience (0017): quarantine decisions, bundles, attachments, DDP
-- =====================================================================
insert into public.products (id, org_id, sku, name, weight_g, hs_code, customs_value) values
  ('a0000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'A-Q', 'Quarantine test', 100, '630790', 2),
  ('a0000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'A-CUP', 'Cup', 100, '691200', 2),
  ('a0000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'A-LID', 'Lid', 20, '392350', 1);
insert into public.products (id, org_id, sku, name, kind) values
  ('a0000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'A-KIT', 'Cup + 2 lids', 'bundle'),
  ('a0000000-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111', 'A-EMPTY', 'Empty kit', 'bundle');
insert into public.stock_moves (product_id, org_id, warehouse_id, qty, type) values
  ('a0000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', t.gz(), 20, 'inbound'),
  ('a0000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', t.gz(), 6, 'quarantine');

select t.ok('ddp: new orders ship DDP by default', (select column_default like '%ddp%' from information_schema.columns where table_name = 'orders' and column_name = 'service'));

set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.works('quarantine decision: the brand asks to restock 2 units', $q$select public.request_quarantine_decision('a0000000-0000-0000-0000-000000000009', t.gz(), 2, 'restock', 'checked photos, fine')$q$);
select t.works('quarantine decision: and to dispose of 3', $q$select public.request_quarantine_decision('a0000000-0000-0000-0000-000000000009', t.gz(), 3, 'dispose', null)$q$);
select t.raises('quarantine decision: cannot decide on more units than are still waiting (6 − 5 = 1)', $q$select public.request_quarantine_decision('a0000000-0000-0000-0000-000000000009', t.gz(), 2, 'return', null)$q$);
select t.raises('quarantine decision: unknown decision refused', $q$select public.request_quarantine_decision('a0000000-0000-0000-0000-000000000009', t.gz(), 1, 'sell', null)$q$);
select t.raises('quarantine decision: the brand cannot carry it out itself', $q$select public.decide_quarantine((select id from public.quarantine_requests where decision = 'restock'), true, null)$q$);
select t.ok('quarantine decision: the brand sees its own requests', (select count(*) = 2 from public.quarantine_requests));
select t.login('00000000-0000-0000-0000-0000000000c1');
select t.raises('quarantine decision: another client cannot decide on these units', $q$select public.request_quarantine_decision('a0000000-0000-0000-0000-000000000009', t.gz(), 1, 'return', null)$q$);
select t.ok('quarantine decision: another client sees none of them', (select count(*) = 0 from public.quarantine_requests));
select t.login('00000000-0000-0000-0000-0000000000b3');
select t.raises('quarantine decision: a read-only client role cannot ask', $q$select public.request_quarantine_decision('a0000000-0000-0000-0000-000000000009', t.gz(), 1, 'return', null)$q$);
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.works('quarantine decision: the warehouse restocks', $q$select public.decide_quarantine((select id from public.quarantine_requests where decision = 'restock'), true, null)$q$);
select t.works('quarantine decision: the warehouse disposes', $q$select public.decide_quarantine((select id from public.quarantine_requests where decision = 'dispose'), true, 'binned')$q$);
select t.raises('quarantine decision: a handled request cannot be applied twice', $q$select public.decide_quarantine((select id from public.quarantine_requests where decision = 'dispose'), true, null)$q$);
reset role;
select t.ok('quarantine decision: 2 back to sellable, 3 written off, 1 still in quarantine',
  (select on_hand = 17 and quarantined = 1 from t.stock('a0000000-0000-0000-0000-000000000009')), (select on_hand || ' on hand, ' || quarantined || ' quarantined' from t.stock('a0000000-0000-0000-0000-000000000009')));

-- Bundles
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.works('bundle: the brand sets up a kit', $q$insert into public.bundle_items (bundle_id, component_id, qty) values ('a0000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000a', 1), ('a0000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000b', 2)$q$);
select t.raises('bundle: no bundle inside a bundle', $q$insert into public.bundle_items (bundle_id, component_id, qty) values ('a0000000-0000-0000-0000-00000000000d', 'a0000000-0000-0000-0000-00000000000c', 1)$q$);
select t.raises('bundle: no product of another client', $q$insert into public.bundle_items (bundle_id, component_id, qty) values ('a0000000-0000-0000-0000-00000000000d', 'b0000000-0000-0000-0000-000000000001', 1)$q$);
select t.ok('bundle: the brand sees its kit contents', (select count(*) = 2 from public.bundle_items where bundle_id = 'a0000000-0000-0000-0000-00000000000c'));
insert into public.orders (id, org_id, customer, address, country) values ('0a000000-0000-0000-0000-0000000000b0', '11111111-1111-1111-1111-111111111111', 'Kit buyer', '3 Street', 'FR');
select t.works('bundle: ordering 3 kits', $q$insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000b0', 'a0000000-0000-0000-0000-00000000000c', 3)$q$);
select t.ok('bundle: the order ships the components (3 cups, 6 lids), not the kit',
  (select string_agg(p.sku || '×' || i.qty, ',' order by p.sku) = 'A-CUP×3,A-LID×6' from public.order_items i join public.products p on p.id = i.product_id where i.order_id = '0a000000-0000-0000-0000-0000000000b0'));
select t.raises('bundle: a kit with nothing in it cannot be ordered', $q$insert into public.order_items (order_id, product_id, qty) values ('0a000000-0000-0000-0000-0000000000b0', 'a0000000-0000-0000-0000-00000000000d', 1)$q$);
select t.login('00000000-0000-0000-0000-0000000000c1');
select t.ok('bundle: another client cannot see the kit contents', (select count(*) = 0 from public.bundle_items));
insert into public.orders (id, org_id, customer, address, country) values ('0b000000-0000-0000-0000-0000000000b0', '22222222-2222-2222-2222-222222222222', 'Sneaky', '4 Street', 'DE');
select t.raises('bundle: another client cannot order this kit into their order', $q$insert into public.order_items (order_id, product_id, qty) values ('0b000000-0000-0000-0000-0000000000b0', 'a0000000-0000-0000-0000-00000000000c', 1)$q$);
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.raises('bundle: a kit has no stock of its own', $q$select public.adjust_stock('a0000000-0000-0000-0000-00000000000c', 5, 'x', t.gz())$q$);
reset role;
select t.raises('bundle: a kit cannot be announced on an inbound', $q$insert into public.inbound_items (inbound_id, product_id, expected) values ('1c000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000c', 5)$q$);

-- Ticket attachments and categories
insert into public.ticket_files (ticket_id, path, name, type, size) values
  ('7a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111/x/a.jpg', 'damaged.jpg', 'image/jpeg', 100),
  ('7b000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222/x/b.jpg', 'private.jpg', 'image/jpeg', 100);
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.ok('tickets: a client sees the attachments of its own tickets only', (select string_agg(name, ',') = 'damaged.jpg' from public.ticket_files));
select t.denied('tickets: a client cannot add attachment rows directly', $q$insert into public.ticket_files (ticket_id, path, name, type, size) values ('7a000000-0000-0000-0000-000000000001', 'x', 'x', 'x', 1)$q$);
select t.raises('tickets: an unknown category is refused', $q$update public.tickets set category = 'nonsense' where id = '7a000000-0000-0000-0000-000000000001'$q$);
select t.works('tickets: a category can be set', $q$update public.tickets set category = 'damaged' where id = '7a000000-0000-0000-0000-000000000001'$q$);
select t.denied('company profile: a client cannot write its organisation row directly', $q$update public.organizations set vat_number = 'X' where id = '11111111-1111-1111-1111-111111111111'$q$);
reset role;

-- =====================================================================
-- 11. Finance (0018): only owner / manager / finance see money and costs
-- =====================================================================
insert into public.order_costs (order_id, org_id, label_cost, duties_paid, currency) values
  ('0a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 42.5, 12, 'CNY');
insert into public.expenses (spent_on, category, payee, amount, currency) values ('2026-10-01', 'rent', 'Ningbo warehouse', 1480, 'USD');
set role authenticated;
select t.login('00000000-0000-0000-0000-0000000000a1');
select t.ok('finance: the owner sees expenses', (select count(*) = 1 from public.expenses));
select t.works('finance: the owner adds an expense', $q$insert into public.expenses (spent_on, category, payee, amount, currency) values ('2026-10-02', 'software', 'App', 90, 'USD')$q$);
select t.works('finance: the owner sets the reporting currency', $q$update public.finance_settings set report_currency = 'USD', fx = '{"EUR": 1.08}' where id = 1$q$);
select t.raises('finance: an expense needs a known category', $q$insert into public.expenses (spent_on, category, payee, amount, currency) values ('2026-10-02', 'party', 'x', 1, 'USD')$q$);
select t.raises('finance: an expense amount is positive', $q$insert into public.expenses (spent_on, category, payee, amount, currency) values ('2026-10-02', 'other', 'x', -5, 'USD')$q$);
select t.ok('finance: the owner sees shipping costs', (select count(*) = 1 from public.order_costs));
select t.login('00000000-0000-0000-0000-0000000000a3');
select t.ok('finance: the warehouse sees the shipping costs it types', (select count(*) = 1 from public.order_costs));
select t.ok('finance: the warehouse does not see expenses', (select count(*) = 0 from public.expenses));
select t.denied('finance: the warehouse cannot add an expense', $q$insert into public.expenses (spent_on, category, payee, amount, currency) values ('2026-10-02', 'other', 'x', 1, 'USD')$q$);
select t.ok('finance: the warehouse cannot read finance settings', (select count(*) = 0 from public.finance_settings));
select t.login('00000000-0000-0000-0000-0000000000b1');
select t.ok('finance: a client never sees what shipping cost us', (select count(*) = 0 from public.order_costs));
select t.ok('finance: a client never sees expenses', (select count(*) = 0 from public.expenses));
select t.ok('finance: a client never sees finance settings', (select count(*) = 0 from public.finance_settings));
select t.denied('finance: a client cannot add an expense', $q$insert into public.expenses (spent_on, category, payee, amount, currency) values ('2026-10-02', 'other', 'x', 1, 'USD')$q$);
select t.denied('finance: a client cannot write shipping costs', $q$insert into public.order_costs (order_id, org_id, label_cost, currency) values ('0a000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1, 'USD')$q$);
select t.login('00000000-0000-0000-0000-0000000000a4');
select t.ok('finance: the shipper does not see expenses', (select count(*) = 0 from public.expenses));
reset role;
