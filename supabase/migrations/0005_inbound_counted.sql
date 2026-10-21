-- =====================================================================
-- 0005 — Inbound step "Counted": the warehouse saves the count first,
--         then confirms to make the units available.
-- =====================================================================
alter table public.inbounds drop constraint if exists inbounds_status_check;
alter table public.inbounds add constraint inbounds_status_check
  check (status in ('announced', 'in_transit', 'receiving', 'counted', 'received'));

-- Save what was counted (not available for sale yet).
create or replace function public.count_inbound(p_inbound uuid, p_counts jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare b inbounds; it record; total integer := 0; q integer;
begin
  if not public.staff_has('inbounds.receive') then raise exception 'not allowed'; end if;
  select * into b from inbounds where id = p_inbound for update;
  if not found or b.status = 'received' then raise exception 'inbound not found or already available'; end if;
  for it in select * from inbound_items where inbound_id = p_inbound loop
    q := greatest(coalesce((p_counts ->> it.id::text)::int, 0), 0);
    update inbound_items set received = q where id = it.id;
    total := total + q;
  end loop;
  update inbounds set status = 'counted' where id = p_inbound;
  insert into activity_log (org_id, user_id, action, detail) values (b.org_id, auth.uid(), 'inbound_counted', b.ref || ' · ' || total || ' units counted');
end $$;
revoke all on function public.count_inbound from public, anon;
grant execute on function public.count_inbound to authenticated;
