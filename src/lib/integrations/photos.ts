import 'server-only';
import { supabaseAdmin } from '../supabase/admin';
import { EXT, IMAGES, sniff } from '../files';
import type { ExtProduct, Integration } from './core';
import { shopifyProducts } from './shopify';
import { wooProducts } from './woocommerce';

/**
 * Product photos come from the client's own store: a product without a photo in Elmamsflow takes the store's.
 * Never replaces a photo someone uploaded.
 */

const MAX = 5 * 1024 * 1024;

/** Only public https images (no addresses or local names). */
function safeUrl(u: string | null | undefined) {
  if (!u) return null;
  try {
    const url = new URL(u.startsWith('//') ? `https:${u}` : u);
    if (url.protocol !== 'https:') return null;
    const h = url.hostname;
    if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || /(^|\.)(localhost|local|internal)$/i.test(h)) return null;
    return url.toString();
  } catch { return null; }
}

async function download(u: string) {
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX) throw new Error('photo larger than 5 MB');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX) throw new Error('photo larger than 5 MB');
  const type = await sniff(new Blob([new Uint8Array(buf)]));
  if (!type || !IMAGES.includes(type)) throw new Error('not a JPG, PNG or WEBP photo');
  return { buf, type };
}

/** Give products without a photo the photo from the store list. Returns how many got one. */
export async function fillPhotos(orgId: string, list: ExtProduct[]) {
  const admin = supabaseAdmin();
  const { data } = await admin.from('products').select('id, sku, ext_ref').eq('org_id', orgId).is('photo_path', null);
  if (!data?.length) return 0;
  const byRef = new Map(list.filter((p) => p.ref).map((p) => [p.ref, p]));
  const bySku = new Map(list.map((p) => [p.sku.trim().toUpperCase(), p]));
  let n = 0;
  for (const p of data) {
    const src = (p.ext_ref && byRef.get(p.ext_ref)) || bySku.get(p.sku.trim().toUpperCase());
    const u = safeUrl(src?.image);
    if (!u) continue;
    try {
      const { buf, type } = await download(u);
      const path = `${orgId}/${p.id}/${Date.now()}-store.${EXT[type]}`;
      const { error } = await admin.storage.from('products').upload(path, buf, { contentType: type, upsert: false });
      if (error) continue;
      await admin.from('products').update({ photo_path: path }).eq('id', p.id).is('photo_path', null);
      n++;
    } catch { /* that store photo can't be fetched: the product stays without one */ }
  }
  return n;
}

/** Fill missing photos from every store this client has connected. */
export async function fillPhotosFromStores(orgId: string) {
  const { data } = await supabaseAdmin().from('integrations').select('*').eq('org_id', orgId).eq('role', 'store').eq('status', 'active');
  let n = 0;
  for (const i of (data ?? []) as Integration[]) {
    try { n += await fillPhotos(orgId, i.kind === 'shopify' ? await shopifyProducts(i) : await wooProducts(i)); } catch { /* store unreachable */ }
  }
  return n;
}

/** A short-lived link the bridge store can download the photo from. */
export async function photoLink(path: string | null | undefined) {
  if (!path) return null;
  const { data } = await supabaseAdmin().storage.from('products').createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}
