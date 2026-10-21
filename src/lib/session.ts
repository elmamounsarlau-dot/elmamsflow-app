import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase/server';
import { clientCan, staffCan, type ClientRole, type Perm, type StaffRole } from './roles';

export type Org = { id: string; name: string; code: string | null; status: string; kind: string };

export type Ctx = {
  userId: string;
  email: string;
  name: string;
  staffRole: StaffRole | null;
  clientRole: ClientRole | null;
  /** The client organisation in view (a client's own, or the one staff are "viewing as"). Null = whole back office. */
  org: Org | null;
  viewingAs: boolean;
  /** True when Elmamsflow staff see the back office (not viewing as a client). */
  backOffice: boolean;
  can: (p: Perm) => boolean;
};

export const VIEW_AS_COOKIE = 'elm_as';

export const getCtx = cache(async (): Promise<Ctx | null> => {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: profile }, { data: memberships }] = await Promise.all([
    supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle(),
    supabase.from('memberships').select('role, status, org:organizations(id, name, code, status, kind)').eq('user_id', user.id),
  ]);

  type Row = { role: string; status: string; org: Org | Org[] | null };
  const rows = ((memberships ?? []) as Row[])
    .map((m) => ({ ...m, org: Array.isArray(m.org) ? m.org[0] : m.org }))
    .filter((m): m is { role: string; status: string; org: Org } => !!m.org && m.status !== 'paused' && m.org.status === 'active');

  const staff = rows.find((m) => m.org.kind === 'owner');
  const client = rows.find((m) => m.org.kind === 'client');
  const name = profile?.full_name || user.email?.split('@')[0] || 'You';
  const base = { userId: user.id, email: user.email ?? '', name };

  if (staff) {
    const role = staff.role as StaffRole;
    const asId = (await cookies()).get(VIEW_AS_COOKIE)?.value;
    let org: Org | null = null;
    if (asId) {
      const { data } = await supabase.from('organizations').select('id, name, code, status, kind').eq('id', asId).eq('kind', 'client').maybeSingle();
      org = (data as Org) ?? null;
    }
    return { ...base, staffRole: role, clientRole: null, org, viewingAs: !!org, backOffice: !org, can: (p) => staffCan(role, p) };
  }
  if (client) {
    const role = client.role as ClientRole;
    return { ...base, staffRole: null, clientRole: role, org: client.org, viewingAs: false, backOffice: false, can: (p) => clientCan(role, p) };
  }
  return { ...base, staffRole: null, clientRole: null, org: null, viewingAs: false, backOffice: false, can: () => false };
});

/** For pages: signed in and with access, otherwise away. */
export async function requireCtx(): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  if (!ctx.staffRole && !ctx.clientRole) redirect('/no-access');
  return ctx;
}

/** Restrict a query to the organisation in view (staff in back office see everything). */
export function scoped<T extends { eq: (col: string, v: string) => T }>(q: T, ctx: Ctx): T {
  return ctx.org ? q.eq('org_id', ctx.org.id) : q;
}
