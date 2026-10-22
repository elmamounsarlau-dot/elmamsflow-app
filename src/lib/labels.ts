import 'server-only';
import { supabaseAdmin } from './supabase/admin';

/** Shipping labels: private files in Supabase Storage (bucket "labels"), read and written only by the server. */
const BUCKET = 'labels';
export const LABEL_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
export const LABEL_MAX = 8 * 1024 * 1024;

/** Checks the file by its first bytes too (a renamed file can't pass as an image or PDF). */
async function sniff(file: File) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
  if (hex.slice(8, 16) === '66747970') return 'image/heic'; // ftyp box (HEIC/HEIF from iPhones)
  return null;
}

export async function saveLabel(order: { id: string; org_id: string; label_path?: string | null }, file: File, userId: string) {
  if (!file || !file.size) throw new Error('Choose the label photo or PDF.');
  if (file.size > LABEL_MAX) throw new Error('The label file is larger than 8 MB. Take the photo again at a lower size.');
  const type = await sniff(file);
  if (!type) throw new Error('The label must be a photo (JPG, PNG, WEBP, HEIC) or a PDF.');
  const path = `${order.org_id}/${order.id}/${Date.now()}.${LABEL_TYPES[type]}`;
  const admin = supabaseAdmin();
  const { error } = await admin.storage.from(BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), { contentType: type, upsert: false });
  if (error) throw new Error(`The label couldn’t be saved: ${error.message}`);
  const { error: e2 } = await admin.from('orders').update({ label_path: path, label_uploaded_at: new Date().toISOString(), label_uploaded_by: userId }).eq('id', order.id);
  if (e2) throw new Error(e2.message);
  if (order.label_path) await admin.storage.from(BUCKET).remove([order.label_path]).catch(() => null); // replaced
  return path;
}

export async function readLabel(path: string) {
  const { data, error } = await supabaseAdmin().storage.from(BUCKET).download(path);
  if (error || !data) return null;
  const ext = path.split('.').pop() ?? '';
  const type = Object.entries(LABEL_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
  return { body: Buffer.from(await data.arrayBuffer()), type };
}
