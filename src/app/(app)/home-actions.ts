'use server';

import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';

/** Remember Quick view / Full view for this person (on every device they sign in from). */
export async function setHomeView(view: 'quick' | 'full') {
  const ctx = await getCtx();
  if (!ctx || (view !== 'quick' && view !== 'full')) return { ok: false };
  const sb = await supabaseServer();
  const { error } = await sb.from('profiles').update({ home_view: view }).eq('id', ctx.userId);
  return { ok: !error };
}
