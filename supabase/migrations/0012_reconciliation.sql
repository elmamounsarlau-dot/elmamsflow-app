-- =====================================================================
-- 0012 — Auditable stock reconciliation (owner only)
--   * reconcile_stock: a correction backed by evidence (who approved it, why, what proves it).
--   * reverse_shipment: undo a shipment that never physically happened (e.g. a test), putting the
--     units back and cancelling the order — the original movement stays in the history.
-- Nothing here changes existing data. Both functions refuse to run without a reason and evidence.
-- =====================================================================

alter table public.stock_moves drop constraint if exists stock_moves_source_check;
alter table public.stock_moves add constraint stock_moves_source_check
  check (source in ('manual', 'csv', 'warehouse', 'reconciliation'));
alter table public.stock_moves add column if not exists evidence text;      -- what proves the correction
alter table public.stock_moves add column if not exists approved_by uuid references auth.users (id);

create or replace function public.reconcile_stock(p_product uuid, p_qty integer, p_reason text, p_evidence text, p_ref text default null)
returns void language plpgsql security definer set search_path = public as $$
declare p products; onh integer; qua integer;
begin
  if coalesce(public.staff_role(), '') <> 'owner' then raise exception 'Only the owner can approve a reconciliation.'; end if;
  if p_qty = 0 then raise exception 'Nothing to reconcile.'; end if;
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_evidence), '') = '' then
    raise exception 'A reconciliation needs a reason and the evidence it is based on.';
  end if;
  select * into p from products where id = p_product for update;
  if not found then raise exception 'product not found'; end if;
  onh := public._on_hand(p.id); qua := public._quarantined(p.id);
  if onh + p_qty < 0 then raise exception 'This would leave % units on hand.', onh + p_qty; end if;
  if onh + p_qty < qua then raise exception 'This would leave fewer units than the % in quarantine.', qua; end if;
  insert into stock_moves (product_id, org_id, qty, type, ref, note, user_id, source, evidence, approved_by)
  values (p.id, p.org_id, p_qty, 'adjust', nullif(trim(p_ref), ''), 'Reconciliation · ' || trim(p_reason), auth.uid(), 'reconciliation', trim(p_evidence), auth.uid());
  insert into activity_log (org_id, user_id, action, detail)
  values (p.org_id, auth.uid(), 'stock_reconciled', p.sku || ' ' || case when p_qty > 0 then '+' else '' end || p_qty || ' · ' || trim(p_reason));
end $$;

create or replace function public.reverse_shipment(p_order uuid, p_reason text, p_evidence text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; it record;
begin
  if coalesce(public.staff_role(), '') <> 'owner' then raise exception 'Only the owner can reverse a shipment.'; end if;
  if coalesce(trim(p_reason), '') = '' or coalesce(trim(p_evidence), '') = '' then
    raise exception 'Reversing a shipment needs a reason and the evidence it is based on.';
  end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order not found'; end if;
  if o.status not in ('shipped', 'delivered') or not o.stock_out then raise exception 'Only a shipped order can be reversed.'; end if;
  for it in select i.product_id, sum(i.qty)::int as qty from order_items i where i.order_id = o.id group by i.product_id order by i.product_id loop
    perform 1 from products where id = it.product_id for update;
    insert into stock_moves (product_id, org_id, qty, type, ref, note, user_id, source, evidence, approved_by)
    values (it.product_id, o.org_id, it.qty, 'adjust', o.number, 'Shipment reversed · ' || trim(p_reason), auth.uid(), 'reconciliation', trim(p_evidence), auth.uid());
  end loop;
  update orders set status = 'cancelled', stock_out = false,
    hold_reason = 'Shipment reversed: ' || trim(p_reason)
  where id = o.id;
  insert into activity_log (org_id, user_id, action, detail)
  values (o.org_id, auth.uid(), 'shipment_reversed', '#' || o.number || ' · ' || trim(p_reason));
end $$;

revoke all on function public.reconcile_stock, public.reverse_shipment from public, anon;
grant execute on function public.reconcile_stock, public.reverse_shipment to authenticated;
