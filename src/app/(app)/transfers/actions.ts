'use server';

import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { itemsFromForm } from '@/lib/data';
import { str, withMsg } from '@/lib/format';

const uuid = (v: string) => (/^[0-9a-f-]{36}$/.test(v) ? v : null);

/** Request a transfer between warehouses — or, for the owner, allocate unallocated stock (done at once, with evidence). */
export async function createTransfer(fd: FormData) {
  const ctx = await getCtx();
  const back = str(fd, 'back').startsWith('/') ? str(fd, 'back') : '/transfers/new';
  if (!ctx?.staffRole || !ctx.can('stock.adjust')) redirect(withMsg(back, 'You don’t have access to that.', 'err'));
  const items = itemsFromForm(fd);
  const org = ctx.org?.id ?? uuid(str(fd, 'org_id'));
  const kind = str(fd, 'kind') === 'allocation' ? 'allocation' : 'transfer';
  if (!org || !items.length) redirect(withMsg(back, 'Choose the client and at least one product with a quantity.', 'err'));
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('create_transfer', {
    p_org: org, p_from: uuid(str(fd, 'from')), p_to: uuid(str(fd, 'to')), p_items: items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
    p_reason: str(fd, 'reason').slice(0, 300), p_kind: kind, p_evidence: str(fd, 'evidence').slice(0, 500) || null,
  });
  if (error) redirect(withMsg(back, error.message, 'err'));
  redirect(withMsg(`/transfers/${data}`, kind === 'allocation' ? 'Allocated. The units are now in that warehouse; the evidence is stored with the movement.' : 'Transfer requested. Mark it sent when it leaves the warehouse.'));
}

export async function dispatchTransfer(fd: FormData) {
  const id = str(fd, 'id');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('dispatch_transfer', { p_transfer: id, p_carrier: str(fd, 'carrier').slice(0, 80) || null, p_tracking: str(fd, 'tracking').slice(0, 80) || null });
  redirect(withMsg(`/transfers/${id}`, error ? error.message : 'Marked as sent. The units left the sending warehouse.', error ? 'err' : 'ok'));
}

export async function receiveTransfer(fd: FormData) {
  const id = str(fd, 'id');
  const counts: Record<string, number> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith('rcv_')) counts[k.slice(4)] = Math.max(0, parseInt(String(v), 10) || 0);
  const sb = await supabaseServer();
  const { error } = await sb.rpc('receive_transfer', { p_transfer: id, p_counts: counts });
  redirect(withMsg(`/transfers/${id}`, error ? error.message : 'Received. The counted units are available in the receiving warehouse.', error ? 'err' : 'ok'));
}

export async function cancelTransfer(fd: FormData) {
  const id = str(fd, 'id');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('cancel_transfer', { p_transfer: id, p_reason: str(fd, 'reason').slice(0, 200) });
  redirect(withMsg(`/transfers/${id}`, error ? error.message : 'Transfer cancelled. Nothing moved.', error ? 'err' : 'ok'));
}
