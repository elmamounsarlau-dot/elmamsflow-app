import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fileResponse, readFile } from '@/lib/files';

/** A product's photo, for people who can see the product (Row Level Security decides). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getCtx())) return new NextResponse('Not signed in', { status: 401 });
  const { data: p } = await (await supabaseServer()).from('products').select('sku, photo_path').eq('id', id).maybeSingle();
  if (!p?.photo_path) return new NextResponse('No photo', { status: 404 });
  const f = await readFile('products', p.photo_path);
  if (!f) return new NextResponse('Photo not found', { status: 404 });
  return fileResponse(f, `${p.sku}.${p.photo_path.split('.').pop()}`, { cache: true });
}
