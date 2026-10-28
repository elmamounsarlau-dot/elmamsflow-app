import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fileResponse, readFile } from '@/lib/files';

/** A file attached to a support ticket, for people who can see the ticket. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getCtx())) return new NextResponse('Not signed in', { status: 401 });
  const { data: t } = await (await supabaseServer()).from('ticket_files').select('name, path').eq('id', id).maybeSingle();
  if (!t) return new NextResponse('Not found', { status: 404 });
  const f = await readFile('tickets', t.path);
  if (!f) return new NextResponse('File not found', { status: 404 });
  return fileResponse(f, t.name, { download: req.nextUrl.searchParams.has('download'), cache: true });
}
