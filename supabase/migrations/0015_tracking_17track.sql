-- =====================================================================
-- 0015 — Live carrier tracking (17TRACK)
--
--  * When an order ships with a tracking number, the app registers it with 17TRACK.
--  * 17TRACK pushes every carrier update (webhook) and a daily sync catches anything missed.
--  * Each order keeps its live status, latest event and full event history.
--  * "Delivered" from the carrier marks the order Delivered automatically (date = carrier's delivery time).
--  Only the server (service role) writes tracking data; clients and staff read it.
-- =====================================================================

alter table public.orders add column if not exists tracking_status text;          -- 17TRACK main status, e.g. InTransit
alter table public.orders add column if not exists tracking_sub_status text;      -- e.g. InTransit_Arrival
alter table public.orders add column if not exists tracking_last_event text;
alter table public.orders add column if not exists tracking_last_location text;
alter table public.orders add column if not exists tracking_last_event_at timestamptz;
alter table public.orders add column if not exists tracking_eta date;
alter table public.orders add column if not exists tracking_carrier_code integer;   -- 17TRACK carrier id (auto-detected)
alter table public.orders add column if not exists tracking_registered_at timestamptz;
alter table public.orders add column if not exists tracking_checked_at timestamptz;
alter table public.orders add column if not exists tracking_error text;

alter table public.orders drop constraint if exists orders_tracking_status_check;
alter table public.orders add constraint orders_tracking_status_check check (tracking_status is null or tracking_status in
  ('NotFound', 'InfoReceived', 'InTransit', 'Expired', 'AvailableForPickup', 'OutForDelivery', 'DeliveryFailure', 'Delivered', 'Exception', 'Stopped'));

create index if not exists orders_tracking_open on public.orders (tracking_checked_at)
  where status = 'shipped' and tracking is not null;

-- Full carrier history, one row per event; the same event arriving twice is stored once.
create table if not exists public.tracking_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  tracking text not null,
  at timestamptz,
  description text not null,
  location text,
  sub_status text,
  created_at timestamptz not null default now()
);
create unique index if not exists tracking_events_once on public.tracking_events (order_id, tracking, coalesce(at, 'epoch'::timestamptz), md5(description));
create index if not exists tracking_events_order on public.tracking_events (order_id, at desc);
alter table public.tracking_events enable row level security;
drop policy if exists tracking_events_read on public.tracking_events;
create policy tracking_events_read on public.tracking_events for select using (
  exists (select 1 from public.orders o where o.id = order_id and public.can_see(o.org_id)));

-- A new or corrected tracking number starts its live tracking from scratch, and a new order can't
-- arrive with carrier data already filled in (only the server's tracking sync writes it).
create or replace function public.orders_tracking_reset() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.tracking is distinct from old.tracking then
    new.tracking_status := null; new.tracking_sub_status := null; new.tracking_last_event := null;
    new.tracking_last_location := null; new.tracking_last_event_at := null; new.tracking_eta := null;
    new.tracking_carrier_code := null; new.tracking_registered_at := null; new.tracking_checked_at := null; new.tracking_error := null;
  end if;
  return new;
end $$;
drop trigger if exists orders_tracking_reset on public.orders;
create trigger orders_tracking_reset before insert or update of tracking on public.orders
  for each row execute function public.orders_tracking_reset();

-- Applies one carrier update. Called by the server only (webhook, sync).
-- p_events: [{ "at": iso, "description": text, "location": text, "sub_status": text }, ...]
-- Returns 'delivered' when this update moved the order to Delivered, else 'updated' / 'stale' / 'ignored'.
create or replace function public.apply_tracking(
  p_order uuid, p_tracking text, p_status text, p_sub_status text, p_last_event text, p_last_location text,
  p_last_event_at timestamptz, p_eta date, p_carrier integer, p_events jsonb
) returns text language plpgsql security definer set search_path = public as $$
declare o orders; e jsonb; delivered_at_ timestamptz;
begin
  select * into o from orders where id = p_order for update;
  if not found or o.tracking is null or o.tracking <> p_tracking then return 'ignored'; end if;  -- number changed since
  if o.status not in ('shipped', 'delivered') then return 'ignored'; end if;
  -- Older than what we already have (out-of-order push): keep the newer state.
  if o.tracking_last_event_at is not null and p_last_event_at is not null and p_last_event_at < o.tracking_last_event_at then
    return 'stale';
  end if;

  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    if coalesce(trim(e ->> 'description'), '') = '' then continue; end if;
    insert into tracking_events (order_id, tracking, at, description, location, sub_status)
    values (o.id, p_tracking, nullif(e ->> 'at', '')::timestamptz, left(trim(e ->> 'description'), 500),
            nullif(left(trim(coalesce(e ->> 'location', '')), 200), ''), nullif(e ->> 'sub_status', ''))
    on conflict do nothing;
  end loop;

  update orders set
    tracking_status = coalesce(p_status, tracking_status),
    tracking_sub_status = coalesce(p_sub_status, tracking_sub_status),
    tracking_last_event = coalesce(left(p_last_event, 500), tracking_last_event),
    tracking_last_location = coalesce(left(p_last_location, 200), tracking_last_location),
    tracking_last_event_at = coalesce(p_last_event_at, tracking_last_event_at),
    tracking_eta = coalesce(p_eta, tracking_eta),
    tracking_carrier_code = coalesce(p_carrier, tracking_carrier_code),
    tracking_checked_at = now(),
    tracking_error = null
  where id = o.id;

  if p_status = 'Delivered' and o.status = 'shipped' then
    delivered_at_ := least(coalesce(p_last_event_at, now()), now());
    if delivered_at_ < coalesce(o.shipped_at, delivered_at_) then delivered_at_ := now(); end if;
    update orders set status = 'delivered', delivered_at = delivered_at_ where id = o.id;
    insert into activity_log (org_id, user_id, action, detail)
    values (o.org_id, null, 'order_delivered_auto', '#' || o.number || ' · carrier confirmed delivery (17TRACK)');
    return 'delivered';
  end if;
  return 'updated';
end $$;

revoke all on function public.apply_tracking from public, anon, authenticated;
grant execute on function public.apply_tracking to service_role;
