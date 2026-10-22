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
import { importProducts, pushTracking, registerWebhooks, syncOrders, webhookUrl } from '@/lib/integrations/service';

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
  if (!ctx.can('products.edit')) redirect(withMsg(`/integrations/${i.id}`, 'Your role can’t add products.', 'err'));
  let msg: string;
  try {
    const r = await importProducts(i);
    msg = r.added ? `${r.added} product${r.added === 1 ? '' : 's'} added from the store. Add the HS code and customs value so orders don’t get held.` : `All ${r.found} store SKUs are already in Elmamsflow.`;
  } catch (e) {
    redirect(withMsg(`/integrations/${i.id}`, (e as Error).message, 'err'));
  }
  redirect(withMsg(`/integrations/${i.id}`, msg!));
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
  await supabaseAdmin().from('integrations').delete().eq('id', i.id);
  await logActivity(supabaseAdmin(), ctx.userId, i.org_id, 'store_disconnected', `${KIND_LABEL[i.kind]} · ${i.name ?? i.store_url}`);
  redirect(withMsg('/integrations', `${i.name ?? i.store_url} is disconnected. Orders already imported stay in Elmamsflow.${i.kind === 'shopify' ? ' You can also uninstall the app in Shopify.' : ''}`));
}

// ---------- From an order page ----------

export async function rematchProducts(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'order');
  const { data: o } = await supabaseAdmin().from('orders').select('org_id').eq('id', id).maybeSingle();
  if (!o || !ctx || !(ctx.staffRole || ctx.org?.id === o.org_id) || !(ctx.can('orders.create') || ctx.can('orders.hold'))) redirect(withMsg(`/orders/${id}`, 'You don’t have access to that.', 'err'));
  const r = await rematchOrder(id);
  redirect(withMsg(`/orders/${id}`, r.message, r.ok ? 'ok' : 'warn'));
}

export async function resendTracking(fd: FormData) {
  const ctx = await getCtx();
  const id = str(fd, 'order');
  if (!ctx?.staffRole || !ctx.can('orders.warehouse')) redirect(withMsg(`/orders/${id}`, 'You don’t have access to that.', 'err'));
  await supabaseAdmin().from('orders').update({ pushed_at: null }).eq('id', id);
  const r = await pushTracking(id);
  redirect(withMsg(`/orders/${id}`, r === 'ok' ? 'Tracking sent to the store.' : `Not sent: ${r ?? 'nothing to send'}`, r === 'ok' ? 'ok' : 'err'));
}
