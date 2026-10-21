import 'server-only';
import { redirect } from 'next/navigation';
import { requireCtx } from './session';
import { PERMS, type Perm } from './roles';

/** Back-office pages (clients list, a client's file…) are never shown inside a client's workspace. */
const BACK_OFFICE_ONLY = new Set(PERMS.filter((p) => p.staffOnly).map((p) => p.key as string));

export async function requirePerm(p: Perm, path?: string) {
  const ctx = await requireCtx();
  if (BACK_OFFICE_ONLY.has(p) && !ctx.backOffice) {
    // Staff viewing as a client: leave the client view first, then open the page.
    if (ctx.viewingAs) redirect(`/back-office?to=${encodeURIComponent(path ?? '/')}`);
    redirect('/?err=' + encodeURIComponent('You don’t have access to that.'));
  }
  if (!ctx.can(p)) redirect('/?err=' + encodeURIComponent('You don’t have access to that.'));
  return ctx;
}
