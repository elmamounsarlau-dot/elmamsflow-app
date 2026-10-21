import 'server-only';
import { redirect } from 'next/navigation';
import { requireCtx } from './session';
import type { Perm } from './roles';

export async function requirePerm(p: Perm) {
  const ctx = await requireCtx();
  if (!ctx.can(p)) redirect('/?err=' + encodeURIComponent('You don’t have access to that.'));
  return ctx;
}
