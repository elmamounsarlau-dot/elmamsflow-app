import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { readLabel } from '@/lib/labels';

/** The order's shipping label, for people who can see the order (the team, and the client it belongs to). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  if (!ctx) return new NextResponse('Not signed in', { status: 401 });
  let q = (await supabaseServer()).from('orders').select('id, number, label_path').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: o } = await q.maybeSingle(); // Row Level Security decides who sees the order
  if (!o?.label_path) return new NextResponse('No label', { status: 404 });
  const f = await readLabel(o.label_path);
  if (!f) return new NextResponse('Label not found', { status: 404 });
  return new NextResponse(new Uint8Array(f.body), {
    headers: {
      'content-type': f.type,
      'content-disposition': `inline; filename="label-${o.number}.${o.label_path.split('.').pop()}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...(f.type === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }),
    },
  });
}
