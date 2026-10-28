import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { fileResponse, readFile } from '@/lib/files';

/** The receipt kept with an expense: owner, managers and finance only. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  if (!ctx) return new NextResponse('Not signed in', { status: 401 });
  if (!ctx.staffRole || !ctx.backOffice || !ctx.can('billing.manage')) return new NextResponse('Not allowed', { status: 403 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return new NextResponse('Not found', { status: 404 });
  const { data: e } = await supabaseAdmin().from('expenses').select('payee, spent_on, receipt_path').eq('id', id).maybeSingle();
  if (!e?.receipt_path) return new NextResponse('Not found', { status: 404 });
  const f = await readFile('finance', e.receipt_path);
  if (!f) return new NextResponse('File not found', { status: 404 });
  const ext = e.receipt_path.split('.').pop();
  return fileResponse(f, `receipt-${e.spent_on}-${e.payee}.${ext}`.replace(/[^\w.-]+/g, '-'), { download: req.nextUrl.searchParams.has('download') });
}
