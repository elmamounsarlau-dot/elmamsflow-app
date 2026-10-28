import 'server-only';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from './supabase/admin';

/**
 * Private files in Supabase Storage (product photos, brand logos, support attachments, labels).
 * Only the server reads and writes them, after its own permission checks; people open them through the app.
 */
export const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/svg+xml': 'svg', 'application/pdf': 'pdf',
};
export const IMAGES = ['image/jpeg', 'image/png', 'image/webp'];

/** The real type, from the file's first bytes (a renamed file can't pass as an image or PDF). */
export async function sniff(file: Blob) {
  const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const hex = Array.from(b.slice(0, 12)).map((x) => x.toString(16).padStart(2, '0')).join('');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
  if (hex.slice(8, 16) === '66747970') return 'image/heic'; // ftyp box (HEIC/HEIF from iPhones)
  const head = new TextDecoder().decode(b).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

export async function saveFile(bucket: string, folder: string, file: File, opts: { types: string[]; maxMb: number; what: string }) {
  if (!file || !file.size) throw new Error(`Choose the ${opts.what} first.`);
  if (file.size > opts.maxMb * 1024 * 1024) throw new Error(`The ${opts.what} is larger than ${opts.maxMb} MB.`);
  const type = await sniff(file);
  if (!type || !opts.types.includes(type)) {
    const names = opts.types.map((t) => EXT[t]?.toUpperCase()).filter(Boolean).join(', ');
    throw new Error(`The ${opts.what} must be ${names}.`);
  }
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${EXT[type]}`;
  const { error } = await supabaseAdmin().storage.from(bucket).upload(path, Buffer.from(await file.arrayBuffer()), { contentType: type, upsert: false });
  if (error) throw new Error(`The ${opts.what} couldn’t be saved: ${error.message}`);
  return { path, type, size: file.size };
}

export async function readFile(bucket: string, path: string) {
  const { data, error } = await supabaseAdmin().storage.from(bucket).download(path);
  if (error || !data) return null;
  const ext = path.split('.').pop() ?? '';
  const type = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
  return { body: Buffer.from(await data.arrayBuffer()), type };
}

export async function removeFile(bucket: string, path: string | null | undefined) {
  if (path) await supabaseAdmin().storage.from(bucket).remove([path]).catch(() => null);
}

/** Sends a stored file back safely: never run as a page, and images can't load anything else. */
export function fileResponse(f: { body: Buffer; type: string }, name: string, opts: { download?: boolean; cache?: boolean } = {}) {
  return new NextResponse(new Uint8Array(f.body), {
    headers: {
      'content-type': f.type,
      'content-disposition': `${opts.download ? 'attachment' : 'inline'}; filename="${name.replace(/["\\\r\n]/g, '')}"`,
      'cache-control': opts.cache ? 'private, max-age=3600' : 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...(f.type === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }),
    },
  });
}
