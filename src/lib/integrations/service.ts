import 'server-only';
import { supabaseAdmin } from '../supabase/admin';
import { siteUrl } from '../format';
import { importOrder, syncShipTo, loadIntegration, logEvent, markError, type ExtOrder, type ExtProduct, type Integration } from './core';
import { shopifyOpenOrders, shopifyOrder, shopifyProducts, shopifyRegisterWebhooks } from './shopify';
import { wooCall, wooOpenOrders, wooProducts, wooRegisterWebhooks, wooToExt } from './woocommerce';
import { BRIDGE_TOPICS } from './bridge';
import { afterOrderChange } from './flow';

export const webhookUrl = (i: Pick<Integration, 'id' | 'kind'>) => `${siteUrl()}/api/integrations/${i.kind}/${i.id}`;

export async function registerWebhooks(i: Integration) {
  const errs = i.kind === 'shopify' ? await shopifyRegisterWebhooks(i, webhookUrl(i), i.role === 'bridge' ? BRIDGE_TOPICS : undefined) : await wooRegisterWebhooks(i, webhookUrl(i));
  if (errs.length) await logEvent(i, 'error', `Automatic order updates could not be fully set up: ${errs.join(' | ')}`);
  return errs;
}

/** Bring in paid orders waiting to ship, created since `since`. */
export async function syncOrders(i: Integration, since: Date) {
  const counts = { imported: 0, existing: 0, updated: 0, skipped: 0, cancelled: 0, failed: 0 };
  let list: ExtOrder[];
  try {
    list = i.kind === 'shopify' ? await shopifyOpenOrders(i, since) : await wooOpenOrders(i, since);
  } catch (e) {
    await markError(i, (e as Error).message);
    throw e;
  }
  const touched: string[] = [];
  for (const o of list) {
    try {
      const r = await importOrder(i, o, touched);
      counts[r === 'exists' ? 'existing' : r]++;
    } catch (e) {
      counts.failed++;
      await logEvent(i, 'error', `${o.ref}: ${(e as Error).message}`);
    }
  }
  await afterOrderChange(touched);
  await supabaseAdmin().from('integrations').update({ last_sync_at: new Date().toISOString(), ...(counts.failed ? {} : { last_error: null, status: 'active' }) }).eq('id', i.id);
  return counts;
}

/** Create Elmamsflow products for store SKUs that don't exist yet (never overwrites). */
export async function importProducts(i: Integration) {
  const list: ExtProduct[] = i.kind === 'shopify' ? await shopifyProducts(i) : await wooProducts(i);
  const admin = supabaseAdmin();
  const { data: have } = await admin.from('products').select('id, sku, ext_ref').eq('org_id', i.org_id);
  const bySku = new Map((have ?? []).map((p) => [p.sku.trim().toUpperCase(), p]));
  const refs = new Set((have ?? []).map((p) => p.ext_ref).filter(Boolean));
  const fresh = new Map<string, ExtProduct>();
  let linked = 0;
  for (const p of list) {
    const sku = p.sku.trim().toUpperCase().replace(/[^A-Z0-9\-_.]/g, '');
    if (!sku || fresh.has(sku) || refs.has(p.ref)) continue;
    const same = bySku.get(sku);
    if (same) {
      // Already here under the same SKU: remember the store link so orders match even without SKU.
      if (!same.ext_ref) { await admin.from('products').update({ ext_ref: p.ref }).eq('id', same.id); linked++; }
      continue;
    }
    fresh.set(sku, { ...p, sku });
  }
  const rows = [...fresh.values()].map((p) => ({ org_id: i.org_id, sku: p.sku, name: p.name.slice(0, 200), barcode: p.barcode, weight_g: p.weight_g, customs_value: 0, low_stock: 10, ext_ref: p.ref }));
  for (let k = 0; k < rows.length; k += 200) {
    const { error } = await admin.from('products').insert(rows.slice(k, k + 200));
    if (error) throw new Error(/ext_ref/.test(error.message) ? 'Run the latest database update (0008) first.' : error.message);
  }
  await logEvent(i, 'products_imported', `${rows.length} new product${rows.length === 1 ? '' : 's'} from ${list.length} store products${linked ? `, ${linked} linked` : ''}`);
  return { found: list.length, added: rows.length, linked };
}

/** One store order changed (from a webhook): import it, or cancel ours if it was cancelled. */
export async function handleStoreOrder(i: Integration, ref: { shopifyGid?: string; woo?: ExtOrder }) {
  if (i.status === 'paused' || i.settings?.auto_import === false) return 'paused';
  const o = ref.shopifyGid ? await shopifyOrder(i, ref.shopifyGid) : ref.woo ?? null;
  if (!o) return 'missing';
  const touched: string[] = [];
  const r = await importOrder(i, o, touched);
  await afterOrderChange(touched);
  return r;
}

/** Re-read an order's lines from the store (older imports didn't keep the store's product id). */
export async function refreshLines(orderId: string) {
  const admin = supabaseAdmin();
  const { data: o } = await admin.from('orders').select('id, integration_id, external_id, external_lines').eq('id', orderId).maybeSingle();
  const lines = (o?.external_lines ?? []) as ExtOrder['lines'];
  if (!o?.integration_id || !o.external_id || lines.every((l) => l.ref)) return;
  const i = await loadIntegration(o.integration_id);
  if (!i) return;
  try {
    const fresh = i.kind === 'shopify' ? await shopifyOrder(i, o.external_id) : wooToExt(await wooCall(i, `/orders/${encodeURIComponent(o.external_id)}`));
    if (fresh?.lines.length) await admin.from('orders').update({ external_lines: fresh.lines }).eq('id', o.id);
  } catch { /* store unreachable: match with what we have */ }
}

/** Read the order again from the store and apply a changed address (used by "Check the store again"). */
export async function refreshFromStore(orderId: string) {
  const { data: o } = await supabaseAdmin().from('orders').select('id, integration_id, external_id').eq('id', orderId).maybeSingle();
  if (!o?.integration_id || !o.external_id) return 'not_store' as const;
  const i = await loadIntegration(o.integration_id);
  if (!i) return 'not_store' as const;
  const fresh = i.kind === 'shopify' ? await shopifyOrder(i, o.external_id) : wooToExt(await wooCall(i, `/orders/${encodeURIComponent(o.external_id)}`));
  if (!fresh) return 'missing' as const;
  if (!(await syncShipTo(i, o.id, fresh))) return 'same' as const;
  await afterOrderChange([`~${o.id}`]);
  return 'updated' as const;
}
