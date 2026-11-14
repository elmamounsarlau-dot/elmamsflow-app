'use server';

import { redirect } from 'next/navigation';
import { getCtx, type Ctx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';
import { seal, randomSecret } from '@/lib/integrations/crypto';
import { KIND_LABEL, loadIntegration, logEvent, rematchOrder, type Integration, type Kind } from '@/lib/integrations/core';
import { normalizeShop, shopifyConnect, type ShopifySecrets } from '@/lib/integrations/shopify';
import { normalizeWooUrl, wooCall, wooConnect, type WooSecrets } from '@/lib/integrations/woocommerce';
import { importProducts, refreshFromStore, refreshLines, registerWebhooks, syncOrders, webhookUrl } from '@/lib/integrations/service';
import { syncClientStore } from '@/lib/integrations/store-sync';
import { afterOrderChange, sweepOrders } from '@/lib/integrations/flow';
import { BRIDGE_SCOPES, loadBridge, syncClientProducts } from '@/lib/integrations/bridge';

/** Who may manage a client's stores: the client's own admins, or Elmamsflow owner/managers. */
function allowed(ctx: Ctx | null, orgId: string) {
  if (!ctx?.can('integrations.manage')) return false;
  if (ctx.staffRole) return true;
  return ctx.org?.id === orgId;
}

async function guard(id: string) {
  const ctx = await getCtx();
  const i = await loadIntegration(id);
  if (!i || !allowed(ctx, i.org_id)) redirect(withMsg('/integrations', 'You don’t have access to that store.', 'err'));
  return { ctx: ctx!, i };
}

const days = (v: string) => Math.min(60, Math.max(0, parseInt(v, 10) || 0));

export async function connectStore(fd: FormData) {
  const ctx = await getCtx();
  const kind = str(fd, 'kind') as Kind;
  const back = `/integrations/new?kind=${kind}`;
  const orgId = ctx?.org?.id ?? str(fd, 'org_id');
  if (!['shopify', 'woocommerce'].includes(kind) || !orgId || !allowed(ctx, orgId)) redirect(withMsg(back, 'Choose the client and fill in every field.', 'err'));

  let storeUrl: string | null;
  let secrets: ShopifySecrets | WooSecrets;
  let name: string;
  try {
    if (kind === 'shopify') {
      storeUrl = normalizeShop(str(fd, 'store'));
      if (!storeUrl) throw new Error('Use your store’s .myshopify.com address, e.g. mybrand.myshopify.com');
      secrets = str(fd, 'mode') === 'token'
        ? { mode: 'token', token: str(fd, 'token'), api_secret: str(fd, 'api_secret') }
        : { mode: 'client', client_id: str(fd, 'client_id'), client_secret: str(fd, 'client_secret') };
      if (secrets.mode === 'client' && (!secrets.client_id || !secrets.client_secret)) throw new Error('Paste the Client ID and the Client secret.');
      if (secrets.mode === 'token' && (!secrets.token || !secrets.api_secret)) throw new Error('Paste the Admin API access token and the API secret key.');
      name = (await shopifyConnect(storeUrl, secrets)).name;
    } else {
      storeUrl = normalizeWooUrl(str(fd, 'store'));
      if (!storeUrl) throw new Error('Use your store’s full https:// address.');
      const ck = str(fd, 'ck');
      const cs = str(fd, 'cs');
      if (!/^ck_/.test(ck) || !/^cs_/.test(cs)) throw new Error('The keys start with ck_ and cs_. Paste both.');
      secrets = { ck, cs, webhook_secret: randomSecret() };
      name = (await wooConnect(storeUrl, secrets)).name;
    }
  } catch (e) {
    redirect(withMsg(back, (e as Error).message, 'err'));
  }

  const admin = supabaseAdmin();
  const { data: row, error } = await admin.from('integrations').upsert({
    org_id: orgId, kind, store_url: storeUrl!, name: name!, status: 'active', secret_enc: seal(secrets!), token_enc: null, token_expires_at: null,
    settings: { auto_import: true, push_tracking: true }, last_error: null, created_by: ctx!.userId,
  }, { onConflict: 'org_id,kind,store_url' }).select('*').single();
  if (error || !row) redirect(withMsg(back, error?.message ?? 'Could not save the connection.', 'err'));
  const i = row as Integration;
  await logEvent(i, 'connected', `${KIND_LABEL[kind]} store connected: ${name!}`);
  await logActivity(admin, ctx!.userId, orgId, 'store_connected', `${KIND_LABEL[kind]} · ${name!}`);

  const hookErrors = await registerWebhooks(i).catch((e) => [(e as Error).message]);
  const back2 = days(str(fd, 'days'));
  let msg = `${name!} is connected. New paid orders now arrive automatically.`;
  if (back2 > 0) {
    try {
      const c = await syncOrders(i, new Date(Date.now() - back2 * 864e5));
      msg += ` ${c.imported} open order${c.imported === 1 ? '' : 's'} from the last ${back2} days imported.`;
    } catch (e) {
      msg += ` Importing past orders failed: ${(e as Error).message}`;
    }
  }
  if (hookErrors.length) msg += ' Automatic updates need attention — see the store page.';
  redirect(withMsg(`/integrations/${i.id}`, msg, hookErrors.length ? 'warn' : 'ok'));
}

export async function syncNow(fd: FormData) {
  const { i } = await guard(str(fd, 'id'));
  const d = Math.max(1, days(str(fd, 'days')) || 7);
  try {
    const c = await syncOrders(i, new Date(Date.now() - d * 864e5));
    redirect(withMsg(`/integrations/${i.id}`, `Checked the last ${d} days: ${c.imported} new order${c.imported === 1 ? '' : 's'} imported, ${c.existing} already here${c.failed ? `, ${c.failed} failed` : ''}.`, c.failed ? 'warn' : 'ok'));
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw e;
    redirect(withMsg(`/integrations/${i.id}`, (e as Error).message, 'err'));
  }
}

export async function importStoreProducts(fd: FormData) {
  const { ctx, i } = await guard(str(fd, 'id'));
  const back = str(fd, 'back').startsWith('/inventory') ? str(fd, 'back') : `/integrations/${i.id}`;
  if (!ctx.can('products.edit')) redirect(withMsg(back, 'Your role can’t add products.', 'err'));
  let msg: string;
  try {
    const r = await importProducts(i);
    msg = r.added
      ? `${r.added} product${r.added === 1 ? '' : 's'} imported from ${i.name ?? KIND_LABEL[i.kind]}. Add the HS code and customs value so orders don’t get held.`
      : r.found ? `All ${r.found} products from ${i.name ?? KIND_LABEL[i.kind]} are already in Elmamsflow${r.linked ? ` (${r.linked} linked to the store)` : ''}.` : `No products were found in ${i.name ?? KIND_LABEL[i.kind]}.`;
  } catch (e) {
    redirect(withMsg(back, (e as Error).message, 'err'));
  }
  redirect(withMsg(back, msg!, 'ok'));
}

export async function saveStoreSettings(fd: FormData) {
  const { i } = await guard(str(fd, 'id'));
  const settings = { auto_import: fd.get('auto_import') === 'on', push_tracking: fd.get('push_tracking') === 'on' };
  const status = fd.get('paused') === 'on' ? 'paused' : i.status === 'paused' ? 'active' : i.status;
  await supabaseAdmin().from('integrations').update({ settings, status }).eq('id', i.id);
  redirect(withMsg(`/integrations/${i.id}`, 'Settings saved.'));
}

export async function repairWebhooks(fd: FormData) {
  const { i } = await guard(str(fd, 'id'));
  const errs = await registerWebhooks(i).catch((e) => [(e as Error).message]);
  if (!errs.length) await supabaseAdmin().from('integrations').update({ last_error: null, status: i.status === 'error' ? 'active' : i.status }).eq('id', i.id);
  redirect(withMsg(`/integrations/${i.id}`, errs.length ? `Still not working: ${errs[0]}` : 'Automatic order updates are set up.', errs.length ? 'err' : 'ok'));
}

export async function disconnectStore(fd: FormData) {
  const { ctx, i } = await guard(str(fd, 'id'));
  if (i.kind === 'woocommerce') {
    // Remove the webhooks we created in the store (best effort).
    try {
      const hooks = await wooCall<{ id: number; delivery_url: string }[]>(i, '/webhooks', { query: { per_page: '100' } });
      for (const h of hooks.filter((h) => h.delivery_url === webhookUrl(i))) await wooCall(i, `/webhooks/${h.id}`, { method: 'DELETE', query: { force: 'true' } });
    } catch { /* store unreachable: nothing more to do */ }
  }
  // Keep the row (without credentials): reconnecting the same store reuses it, so its orders are never imported twice.
  await supabaseAdmin().from('integrations').update({ status: 'disconnected', secret_enc: '', token_enc: null, token_expires_at: null, last_error: null }).eq('id', i.id);
  await logActivity(supabaseAdmin(), ctx.userId, i.org_id, 'store_disconnected', `${KIND_LABEL[i.kind]} · ${i.name ?? i.store_url}`);
  redirect(withMsg('/integrations', `${i.name ?? i.store_url} is disconnected. Orders already imported stay in Elmamsflow.${i.kind === 'shopify' ? ' You can also uninstall the app in Shopify.' : ''}`));
}

// ---------- From an order page ----------

export async function rematchProducts(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'order');
  const { data: o } = await supabaseAdmin().from('orders').select('org_id').eq('id', id).maybeSingle();
  if (!o || !ctx || !(ctx.staffRole || ctx.org?.id === o.org_id) || !(ctx.can('orders.create') || ctx.can('orders.hold'))) redirect(withMsg(`/orders/${id}`, 'You don’t have access to that.', 'err'));
  await refreshLines(id);
  // Pick up a corrected address from the store first (this also re-checks the hold).
  const fresh = await refreshFromStore(id).catch(() => 'error' as const);
  const { data: after } = await supabaseAdmin().from('orders').select('status, hold_kind').eq('id', id).maybeSingle();
  if (fresh === 'updated' && after?.status === 'new') redirect(withMsg(`/orders/${id}`, 'New address received from the store. The order is ready for the warehouse.'));
  if (after?.hold_kind === 'address') redirect(withMsg(`/orders/${id}`, fresh === 'error' ? 'The store couldn’t be reached. Try again in a minute.' : 'The address in the store is still incomplete. Fix it in the store; this order updates by itself.', 'warn'));
  const r = await rematchOrder(id);
  await afterOrderChange([id]);
  redirect(withMsg(`/orders/${id}`, r.message, r.ok ? 'ok' : 'warn'));
}

export async function resendTracking(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'order');
  if (!ctx?.staffRole || !ctx.can('orders.warehouse')) redirect(withMsg(`/orders/${id}`, 'You don’t have access to that.', 'err'));
  await supabaseAdmin().from('orders').update({ pushed_at: null, store_state: null }).eq('id', id);
  const r = await syncClientStore(id);
  redirect(withMsg(`/orders/${id}`, r === 'ok' ? 'The client’s store is updated.' : `Not sent: ${r ?? 'nothing to send'}`, r === 'ok' ? 'ok' : 'err'));
}

// ---------- The bridge store (our own Shopify store, connected to the fulfilment partner) ----------

export async function connectBridge(fd: FormData) {
  const ctx = await getCtx();
  const back = '/integrations#bridge';
  if (!ctx?.staffRole || !['owner', 'manager'].includes(ctx.staffRole) || ctx.viewingAs) redirect(withMsg(back, 'Only the owner or a manager can connect the bridge store.', 'err'));
  const storeUrl = normalizeShop(str(fd, 'store'));
  const clientId = str(fd, 'client_id');
  const clientSecret = str(fd, 'client_secret');
  const token = str(fd, 'token');
  const apiSecret = str(fd, 'api_secret');
  if (!storeUrl) redirect(withMsg(back, 'Use the bridge store’s .myshopify.com address, e.g. elmamsflow-bridge.myshopify.com', 'err'));
  // A Dev Dashboard app (Client ID + secret) — the way Shopify offers now — or an older custom app's token.
  const secrets: ShopifySecrets | null = clientId && clientSecret ? { mode: 'client', client_id: clientId, client_secret: clientSecret }
    : token && apiSecret ? { mode: 'token', token, api_secret: apiSecret } : null;
  if (!secrets) redirect(withMsg(back, 'Paste the Client ID and the Client secret of the app.', 'err'));
  let name = '';
  try {
    name = (await shopifyConnect(storeUrl!, secrets!)).name;
  } catch (e) {
    redirect(withMsg(back, (e as Error).message, 'err'));
  }
  const admin = supabaseAdmin();
  const { data: ownerOrg } = await admin.from('organizations').select('id').eq('kind', 'owner').limit(1).maybeSingle();
  if (!ownerOrg) redirect(withMsg(back, 'Your company workspace wasn’t found.', 'err'));
  // Only one bridge at a time: an older one is switched off.
  await admin.from('integrations').update({ status: 'paused' }).eq('role', 'bridge').neq('store_url', storeUrl!);
  const { data: row, error } = await admin.from('integrations').upsert({
    org_id: ownerOrg!.id, kind: 'shopify', role: 'bridge', store_url: storeUrl!, name, status: 'active', secret_enc: seal(secrets!), token_enc: null, token_expires_at: null,
    settings: { auto_import: false, push_tracking: false }, last_error: null, created_by: ctx!.userId,
  }, { onConflict: 'org_id,kind,store_url' }).select('*').single();
  if (error || !row) redirect(withMsg(back, error?.message ?? 'Could not save the connection.', 'err'));
  const i = row as Integration;
  await logEvent(i, 'connected', `Bridge store connected: ${name}`);
  await logActivity(admin, ctx!.userId, null, 'store_connected', `Bridge store · ${name}`);
  const hookErrors = await registerWebhooks(i).catch((e) => [(e as Error).message]);
  if (hookErrors.length) await admin.from('integrations').update({ last_error: hookErrors[0].slice(0, 500) }).eq('id', i.id);
  redirect(withMsg(back, hookErrors.length ? `${name} is connected, but updates from the warehouse aren’t set up yet: ${hookErrors[0]}` : `${name} is connected as the bridge store. Give each client a client code, then send its products.`, hookErrors.length ? 'warn' : 'ok'));
}

export async function bridgeSyncNow() {
  const ctx = await getCtx();
  if (!ctx?.staffRole || !ctx.can('integrations.manage')) redirect(withMsg('/integrations#bridge', 'You don’t have access to that.', 'err'));
  try {
    const r = await sweepOrders();
    redirect(withMsg('/integrations#bridge', `Done: ${r.bridgeChecked} order${r.bridgeChecked === 1 ? '' : 's'} checked at the warehouse, ${r.synced} brought up to date.`));
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw e;
    redirect(withMsg('/integrations#bridge', (e as Error).message, 'err'));
  }
}

export async function sendClientProducts(fd: FormData) {
  const ctx = await getCtx();
  const org = str(fd, 'org_id');
  const back = str(fd, 'back').startsWith('/') ? str(fd, 'back') : `/clients/${org}`;
  if (!ctx?.staffRole || !ctx.can('integrations.manage')) redirect(withMsg(back, 'You don’t have access to that.', 'err'));
  const r = await syncClientProducts(org).catch((e) => ({ error: (e as Error).message }));
  if ('error' in r) redirect(withMsg(back, r.error as string, 'err'));
  redirect(withMsg(back, r.errors.length ? `${r.done} product${r.done === 1 ? '' : 's'} in the bridge store; ${r.errors.length} failed: ${r.errors[0]}` : `${r.done} product${r.done === 1 ? '' : 's'} in the bridge store. The partner must hold the stock under exactly these SKUs.`, r.errors.length ? 'warn' : 'ok'));
}

export async function disconnectBridge() {
  const ctx = await getCtx();
  if (!ctx?.staffRole || ctx.staffRole !== 'owner') redirect(withMsg('/integrations#bridge', 'Only the owner can do that.', 'err'));
  const b = await loadBridge();
  if (b) await supabaseAdmin().from('integrations').update({ status: 'paused' }).eq('id', b.id);
  redirect(withMsg('/integrations#bridge', 'The bridge store is switched off. New orders stay here until you connect it again.'));
}

export const bridgeScopes = async () => BRIDGE_SCOPES;

// ---------- One-link Shopify connection (custom-distribution app made by Elmamsflow) ----------

const INSTALL_BACK = '/integrations/new?kind=shopify#link';

export async function prepareShopifyInstall(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.staffRole || !ctx.can('integrations.manage')) redirect(withMsg(INSTALL_BACK, 'You don’t have access to that.', 'err'));
  const orgId = str(fd, 'org_id');
  const shop = normalizeShop(str(fd, 'store'));
  const clientId = str(fd, 'client_id');
  const secret = str(fd, 'client_secret');
  const link = str(fd, 'install_link');
  if (!orgId) redirect(withMsg(INSTALL_BACK, 'Choose the client.', 'err'));
  if (!shop) redirect(withMsg(INSTALL_BACK, 'Use the client’s .myshopify.com address, e.g. brand.myshopify.com', 'err'));
  if (!clientId || !secret) redirect(withMsg(INSTALL_BACK, 'Paste the app’s Client ID and Client secret.', 'err'));
  if (link && !/^https:\/\/([a-z0-9-]+\.)*(shopify\.com|myshopify\.com)\//i.test(link)) redirect(withMsg(INSTALL_BACK, 'The install link must be the one Shopify gave you (https://…shopify.com/…).', 'err'));
  const admin = supabaseAdmin();
  const { data: org } = await admin.from('organizations').select('id, name').eq('id', orgId).eq('kind', 'client').maybeSingle();
  if (!org) redirect(withMsg(INSTALL_BACK, 'Choose the client.', 'err'));
  await admin.from('shopify_installs').update({ status: 'cancelled' }).eq('shop', shop!).eq('status', 'waiting');
  const { error } = await admin.from('shopify_installs').insert({
    org_id: orgId, shop: shop!, client_id: clientId, secret_enc: seal(secret), install_link: link || null, created_by: ctx!.userId,
  });
  if (error) redirect(withMsg(INSTALL_BACK, /shopify_installs/.test(error.message) ? 'Run the latest database update (0021) first.' : error.message, 'err'));
  await logActivity(admin, ctx!.userId, orgId, 'store_link_ready', `Shopify install link · ${shop}`);
  redirect(withMsg(INSTALL_BACK, `Ready. Send ${org!.name} the install link — when they click Install, the store connects by itself.`));
}

export async function cancelShopifyInstall(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx?.staffRole || !ctx.can('integrations.manage')) redirect(withMsg(INSTALL_BACK, 'You don’t have access to that.', 'err'));
  await supabaseAdmin().from('shopify_installs').update({ status: 'cancelled' }).eq('id', str(fd, 'id')).eq('status', 'waiting');
  redirect(withMsg(INSTALL_BACK, 'Install link cancelled.'));
}

