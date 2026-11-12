import 'server-only';
import { holdIfNoBalance, chargeShipped } from '../wallet';
import { supabaseAdmin } from '../supabase/admin';
import { bridgeAddress, pollBridge, syncBridge } from './bridge';
import { syncClientStore } from './store-sync';

/**
 * Run after any order changes, whoever changed it (client, team, the client's store, the partner):
 *  1. a prepaid client's new order waits if the balance can't cover it,
 *  2. the bridge store copy follows (created, held, released, cancelled, new address),
 *  3. a shipped order is paid from the prepaid balance,
 *  4. the client's own store is told.
 * Ids starting with "~" also had their address changed. Never throws: problems are kept on the order.
 */
export async function afterOrderChange(ids: string[]) {
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.replace(/^~/, '');
    if (seen.has(raw)) continue;
    seen.add(raw);
    try { await holdIfNoBalance(id); } catch { /* checked again next time */ }
    if (raw.startsWith('~')) await bridgeAddress(id).catch(() => null);
    await syncBridge(id).catch(() => null);
    await chargeShipped(id).catch(() => null);
    await syncClientStore(id).catch(() => null);
  }
}

/**
 * Backup pass (daily cron, "Sync now", and at most every few minutes while the team uses the app): catches anything
 * a missed webhook or an automatic release left behind — new orders not yet at the warehouse, statuses the
 * client's store doesn't know, shipped prepaid orders not yet paid, and fresh news from the bridge store.
 */
export async function sweepOrders() {
  const admin = supabaseAdmin();
  const since = new Date(Date.now() - 21 * 864e5).toISOString();
  const ids = new Set<string>();
  const { data: coded } = await admin.from('organizations').select('id').not('client_code', 'is', null);
  const codedIds = (coded ?? []).map((c) => c.id);
  if (codedIds.length) {
    const { data } = await admin.from('orders').select('id').in('org_id', codedIds).eq('status', 'new').is('bridge_id', null).gte('created_at', since).limit(200);
    for (const r of data ?? []) ids.add(r.id);
  }
  const { data: store } = await admin.from('orders').select('id, status, tracking, shipment_status, store_state').not('integration_id', 'is', null).gte('created_at', since).neq('status', 'new').limit(1000);
  for (const r of store ?? []) if (r.store_state !== `${r.status}|${r.tracking ?? ''}|${r.shipment_status ?? ''}`) ids.add(r.id);
  const { data: prepaid } = await admin.from('organizations').select('id').eq('billing_mode', 'prepaid');
  if (prepaid?.length) {
    const { data: shipped } = await admin.from('orders').select('id, wallet_entries(id)').in('org_id', prepaid.map((p) => p.id)).in('status', ['shipped', 'delivered']).gte('shipped_at', since).limit(1000);
    for (const r of shipped ?? []) if (!(r.wallet_entries as unknown[] | null)?.length) ids.add(r.id);
  }
  const polled = await pollBridge().catch(() => ({ checked: 0, changed: [] as string[] }));
  for (const id of polled.changed) ids.add(id);
  await afterOrderChange([...ids]);
  return { synced: ids.size, bridgeChecked: polled.checked };
}

let lastSweep = 0;
/** The light version, at most every 3 minutes per server instance. */
export async function sweepSoon() {
  if (Date.now() - lastSweep < 180_000) return;
  lastSweep = Date.now();
  await sweepOrders().catch(() => null);
}
