import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fileResponse, readFile } from '@/lib/files';

/** A client's brand logo, for that client's people and the Elmamsflow team. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getCtx())) return new NextResponse('Not signed in', { status: 401 });
  const { data: o } = await (await supabaseServer()).from('organizations').select('code, logo_path').eq('id', id).maybeSingle();
  if (!o?.logo_path) return new NextResponse('No logo', { status: 404 });
  const f = await readFile('brand', o.logo_path);
  if (!f) return new NextResponse('Logo not found', { status: 404 });
  return fileResponse(f, `logo-${o.code ?? 'brand'}.${o.logo_path.split('.').pop()}`, { cache: true });
}
