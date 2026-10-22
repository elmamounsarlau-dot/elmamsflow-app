-- =====================================================================
-- Database checks: client isolation, permissions, inventory accounting.
-- Runs on a throw-away database (see run.sh). Never point this at production.
-- =====================================================================

create schema t;
create table t.results (id serial primary key, name text not null, ok boolean not null, detail text);
grant usage on schema t to authenticated, anon;

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
insert into public.inbounds (id, org_id, ref, status) values
  ('1c000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'IB-T1', 'announced');
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
select t.raises('writes: client A cannot adjust stock', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', 500, 'x')$q$);
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
select t.raises('anonymous: cannot run warehouse functions', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', 5, 'x')$q$);
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
select t.raises('adjust: cannot go below zero', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', -99, 'x')$q$);
select t.works('quarantine: 10 units', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000001', 10, 'damaged')$q$);
select t.ok('quarantine: excluded from available (98 - 10 - 2 = 86)', (select available from t.stock('a0000000-0000-0000-0000-000000000001')) = 86,
  (select available from t.stock('a0000000-0000-0000-0000-000000000001'))::text);
select t.ok('quarantine: on hand unchanged', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 98);
select t.raises('quarantine: cannot quarantine more than on hand', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000001', 89, 'x')$q$);
select t.raises('quarantine: reason required', $q$select public.quarantine_stock('a0000000-0000-0000-0000-000000000001', 1, '  ')$q$);
select t.raises('adjust: cannot drop on hand below quarantined units', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', -90, 'x')$q$);
select t.works('release: 4 back to sellable', $q$select public.release_stock('a0000000-0000-0000-0000-000000000001', 4, 'checked ok')$q$);
select t.works('release: write off 3', $q$select public.release_stock('a0000000-0000-0000-0000-000000000001', 3, 'broken', true)$q$);
select t.ok('release: balances after release + write-off (on hand 95, quarantine 3)',
  (select on_hand = 95 and quarantined = 3 from t.stock('a0000000-0000-0000-0000-000000000001')),
  (select on_hand || '/' || quarantined from t.stock('a0000000-0000-0000-0000-000000000001')));
select t.raises('release: cannot release more than quarantined', $q$select public.release_stock('a0000000-0000-0000-0000-000000000001', 4, 'x')$q$);
select t.raises('adjust: zero adjustment refused', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000001', 0, 'x')$q$);
select t.ok('audit: every movement records who did it',
  t.rows($q$select 1 from public.stock_moves where user_id is null$q$) = 0);
select t.ok('audit: stock view equals the sum of movements', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = t.moves_sum('a0000000-0000-0000-0000-000000000001'));

-- Shipping takes stock out exactly once
select t.works('adjust: A-2 gets 5 units', $q$select public.adjust_stock('a0000000-0000-0000-0000-000000000002', 5, 'found in count')$q$);
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
select t.works('count CSV: applied', $q$select public.apply_stock_count('[{"product_id":"a0000000-0000-0000-0000-000000000001","counted":90}]'::jsonb, 'count.csv', 'hash-1', current_date, 'WH')$q$);
select t.raises('count CSV: same file refused the second time', $q$select public.apply_stock_count('[{"product_id":"a0000000-0000-0000-0000-000000000001","counted":90}]'::jsonb, 'count.csv', 'hash-1', current_date, 'WH')$q$);
select t.ok('count CSV: on hand set to counted value', (select on_hand from t.stock('a0000000-0000-0000-0000-000000000001')) = 90);
select t.raises('count CSV: negative count refused (whole file rolled back)', $q$select public.apply_stock_count('[{"product_id":"a0000000-0000-0000-0000-000000000002","counted":5},{"product_id":"a0000000-0000-0000-0000-000000000001","counted":-1}]'::jsonb, 'bad.csv', 'hash-2', current_date, 'WH')$q$);
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
