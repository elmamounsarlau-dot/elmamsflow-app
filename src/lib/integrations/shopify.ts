import 'server-only';
import { open } from './crypto';
import { saveToken, tracking17, type ExtOrder, type ExtProduct, type Integration } from './core';

export const SHOPIFY_API = '2026-07';
export const SHOPIFY_SCOPES = ['read_orders', 'read_products', 'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders'];

/** Two ways in: a Dev Dashboard app (Client ID + secret, token renewed every 24 h) or an older custom app's Admin API token. */
export type ShopifySecrets = { mode: 'client'; client_id: string; client_secret: string } | { mode: 'token'; token: string; api_secret: string };

export function normalizeShop(input: string) {
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (s && !s.includes('.')) s = `${s}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

export const webhookSecretOf = (s: ShopifySecrets) => (s.mode === 'client' ? s.client_secret : s.api_secret);

async function requestToken(shop: string, s: Extract<ShopifySecrets, { mode: 'client' }>) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.client_id, client_secret: s.client_secret }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !json.access_token) {
    const why = json.error_description || json.error || text.slice(0, 160) || `HTTP ${res.status}`;
    if (/shop_not_permitted/i.test(why)) throw new Error('Shopify refused: the app must be created by the store owner in the same Shopify organization as the store (Dev Dashboard).');
    if (/app_not_installed/i.test(why)) throw new Error('The app is created but not installed on the store yet. Install it, then try again.');
    throw new Error(`Shopify refused the Client ID / secret: ${why}`);
  }
  return { token: json.access_token, expires: json.expires_in ?? 86399 };
}

/** A valid Admin API token, renewed when it's about to expire. */
export async function shopifyToken(i: Integration) {
  const s = open<ShopifySecrets>(i.secret_enc);
  if (s.mode === 'token') return s.token;
  if (i.token_enc && i.token_expires_at && Date.parse(i.token_expires_at) - Date.now() > 120_000) return open<string>(i.token_enc);
  const t = await requestToken(i.store_url, s);
  await saveToken(i, t.token, t.expires);
  return t.token;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function gql<T = any>(shop: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) throw new Error('Shopify rejected the access. Check that the app is installed and has the right permissions (scopes).');
  const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] | string };
  if (json.errors) {
    const msg = typeof json.errors === 'string' ? json.errors : json.errors.map((e) => e.message).join('; ');
    if (/access denied|ACCESS_DENIED|protected customer data/i.test(msg)) throw new Error(`Shopify: missing permission — ${msg}`);
    throw new Error(`Shopify: ${msg}`);
  }
  return json.data as T;
}

/** Check the credentials and return the store's name. */
export async function shopifyConnect(shop: string, s: ShopifySecrets) {
  const token = s.mode === 'token' ? s.token : (await requestToken(shop, s)).token;
  const d = await gql<{ shop: { name: string } }>(shop, token, '{ shop { name } }');
  return { name: d.shop.name, token };
}

const TOPICS = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED'];

export async function shopifyRegisterWebhooks(i: Integration, url: string) {
  const token = await shopifyToken(i);
  const errors: string[] = [];
  for (const topic of TOPICS) {
    // Newer API versions take `uri`; fall back to `callbackUrl` for older behaviour.
    for (const field of ['uri', 'callbackUrl']) {
      try {
        const d = await gql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(
          i.store_url, token,
          `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } } }`,
          { topic, sub: { [field]: url, format: 'JSON' } },
        );
        const ue = d.webhookSubscriptionCreate.userErrors.map((e) => e.message).filter((m) => !/taken|already/i.test(m));
        if (ue.length) errors.push(`${topic}: ${ue.join(', ')}`);
        break;
      } catch (e) {
        if (field === 'callbackUrl' || !/uri/i.test(String(e))) { errors.push(`${topic}: ${(e as Error).message}`); break; }
      }
    }
  }
  return errors;
}

const ORDER_FIELDS = `id name email phone createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
  shippingAddress { firstName lastName name company address1 address2 city zip countryCodeV2 phone }
  lineItems(first: 100) { nodes { sku name quantity currentQuantity requiresShipping variant { id } } }`;

type ShopOrder = {
  id: string; name: string; email: string | null; phone: string | null; cancelledAt: string | null;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string | null;
  shippingAddress: { firstName: string | null; lastName: string | null; name: string | null; company: string | null; address1: string | null; address2: string | null; city: string | null; zip: string | null; countryCodeV2: string | null; phone: string | null } | null;
  lineItems: { nodes: { sku: string | null; name: string; quantity: number; currentQuantity: number | null; requiresShipping: boolean; variant?: { id: string } | null }[] };
};

export function shopifyToExt(o: ShopOrder): ExtOrder {
  const a = o.shippingAddress;
  const paid = ['PAID', 'PARTIALLY_REFUNDED'].includes(o.displayFinancialStatus ?? '');
  const open = ['UNFULFILLED', 'PARTIALLY_FULFILLED', 'SCHEDULED', 'ON_HOLD'].includes(o.displayFulfillmentStatus ?? '') || !o.displayFulfillmentStatus;
  return {
    external_id: o.id,
    ref: o.name,
    customer: a?.name || [a?.firstName, a?.lastName].filter(Boolean).join(' ') || 'Customer',
    email: o.email,
    phone: a?.phone || o.phone,
    address: [a?.company, a?.address1, a?.address2].filter(Boolean).join(', '),
    city: a?.city ?? null,
    zip: a?.zip ?? null,
    country: a?.countryCodeV2 ?? '',
    lines: o.lineItems.nodes.filter((l) => l.requiresShipping !== false).map((l) => ({ sku: l.sku ?? '', name: l.name, qty: l.currentQuantity ?? l.quantity, ref: l.variant?.id })),
    shippable: paid && open && !!a,
    cancelled: !!o.cancelledAt,
  };
}

/** Paid, not yet fulfilled orders created since `since`. */
export async function shopifyOpenOrders(i: Integration, since: Date) {
  const token = await shopifyToken(i);
  const out: ExtOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const d: { orders: { nodes: ShopOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(i.store_url, token,
      `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { q: `created_at:>='${since.toISOString()}' financial_status:paid fulfillment_status:unfulfilled`, after });
    out.push(...d.orders.nodes.map(shopifyToExt));
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

export async function shopifyOrder(i: Integration, gid: string) {
  const token = await shopifyToken(i);
  const d = await gql<{ order: ShopOrder | null }>(i.store_url, token, `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: gid });
  return d.order ? shopifyToExt(d.order) : null;
}

/** Mark the order fulfilled in Shopify with the tracking number; Shopify emails the customer. */
export async function shopifyFulfil(i: Integration, gid: string, carrier: string | null, tracking: string) {
  const token = await shopifyToken(i);
  const d = await gql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string }[] } } | null }>(i.store_url, token,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`, { id: gid });
  const fos = (d.order?.fulfillmentOrders.nodes ?? []).filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status));
  if (!fos.length) return 'already';
  const r = await gql<{ fulfillmentCreate: { userErrors: { message: string }[] } }>(i.store_url, token,
    `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } } }`,
    { f: { notifyCustomer: true, lineItemsByFulfillmentOrder: fos.map((f) => ({ fulfillmentOrderId: f.id })), trackingInfo: { company: carrier || 'Other', number: tracking, url: tracking17(tracking) } } });
  if (r.fulfillmentCreate.userErrors.length) throw new Error(r.fulfillmentCreate.userErrors.map((e) => e.message).join('; '));
  return 'done';
}

const GRAMS: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, POUNDS: 453.592, OUNCES: 28.3495 };

export async function shopifyProducts(i: Integration) {
  const token = await shopifyToken(i);
  const out: ExtProduct[] = [];
  let after: string | null = null;
  for (let page = 0; page < 8; page++) {
    const d: { productVariants: { nodes: { id: string; sku: string | null; barcode: string | null; title: string; product: { title: string }; inventoryItem: { measurement: { weight: { unit: string; value: number } | null } | null } | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await gql(i.store_url, token,
      `query($after: String) { productVariants(first: 250, after: $after) { nodes { id sku barcode title product { title } inventoryItem { measurement { weight { unit value } } } } pageInfo { hasNextPage endCursor } } }`, { after });
    for (const v of d.productVariants.nodes) {
      const w = v.inventoryItem?.measurement?.weight;
      // No SKU in the store: give it one based on Shopify's variant number; orders still match through the variant id.
      out.push({ ref: v.id, sku: v.sku || `SH-${v.id.split('/').pop()}`, name: v.title && v.title !== 'Default Title' ? `${v.product.title} · ${v.title}` : v.product.title, barcode: v.barcode, weight_g: w ? Math.round(w.value * (GRAMS[w.unit] ?? 1)) : 0 });
    }
    if (!d.productVariants.pageInfo.hasNextPage) break;
    after = d.productVariants.pageInfo.endCursor;
  }
  return out;
}
