import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase/server';
import { orderRoles, roleCan, roleLabel, type ClientRole, type Perm, type RoleDef, type StaffRole } from './roles';

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
  /** The name of the person's role, e.g. "Warehouse" or a custom role. */
  roleName: string;
};

export const VIEW_AS_COOKIE = 'elm_as';

export const getCtx = cache(async (): Promise<Ctx | null> => {
  const supabase = await supabaseServer();
  const { data: claimData } = await supabase.auth.getClaims();
  const claims = claimData?.claims;
  if (!claims?.sub) return null;
  const user = { id: claims.sub as string, email: (claims.email as string | undefined) ?? '' };

  const [{ data: profile }, withRoles] = await Promise.all([
    supabase.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle(),
    supabase.from('memberships').select('role, status, org:organizations(id, name, code, status, kind, roles(key, label, about, perms, locked, system, position))').eq('user_id', user.id),
  ]);
  // Before the roles migration is run, read memberships without roles (defaults apply).
  const memberships = withRoles.error
    ? (await supabase.from('memberships').select('role, status, org:organizations(id, name, code, status, kind)').eq('user_id', user.id)).data
    : withRoles.data;

  type Row = { role: string; status: string; org: (Org & { roles?: RoleDef[] }) | (Org & { roles?: RoleDef[] })[] | null };
  const rows = ((memberships ?? []) as Row[])
    .map((m) => ({ ...m, org: Array.isArray(m.org) ? m.org[0] : m.org }))
    .filter((m): m is { role: string; status: string; org: Org & { roles?: RoleDef[] } } => !!m.org && m.status !== 'paused' && m.org.status === 'active');

  const staff = rows.find((m) => m.org.kind === 'owner');
  const client = rows.find((m) => m.org.kind === 'client');
  const name = profile?.full_name || user.email.split('@')[0] || 'You';
  const base = { userId: user.id, email: user.email, name };

  const defOf = (m: { role: string; org: { roles?: RoleDef[] } }, isStaff: boolean) => {
    const defs = orderRoles(m.org.roles, isStaff);
    return { def: defs.find((d) => d.key === m.role), label: roleLabel(m.role, defs) };
  };

  if (staff) {
    const role = staff.role as StaffRole;
    const { def, label } = defOf(staff, true);
    const asId = (await cookies()).get(VIEW_AS_COOKIE)?.value;
    let org: Org | null = null;
    if (asId) {
      const { data } = await supabase.from('organizations').select('id, name, code, status, kind').eq('id', asId).eq('kind', 'client').maybeSingle();
      org = (data as Org) ?? null;
    }
    return { ...base, staffRole: role, clientRole: null, org, viewingAs: !!org, backOffice: !org, can: (p) => roleCan(def, p, true), roleName: label };
  }
  if (client) {
    const role = client.role as ClientRole;
    const { def, label } = defOf(client, false);
    const { roles: _r, ...org } = client.org; void _r;
    return { ...base, staffRole: null, clientRole: role, org, viewingAs: false, backOffice: false, can: (p) => roleCan(def, p, false), roleName: label };
  }
  return { ...base, staffRole: null, clientRole: null, org: null, viewingAs: false, backOffice: false, can: () => false, roleName: '' };
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

/** Team member whose job is only shipping (e.g. the Shipper role): sees the shipping queue, orders and tracking. */
export const shippingOnly = (ctx: Ctx) =>
  !!ctx.staffRole && !ctx.viewingAs && ctx.can('orders.warehouse') &&
  !ctx.can('orders.hold') && !ctx.can('stock.adjust') && !ctx.can('clients.view') && !ctx.can('products.edit') && !ctx.can('inbounds.receive');
/** Sees inventory, inbounds, transfers and warehouses. */
export const seesStock = (ctx: Ctx) => !ctx.backOffice || !shippingOnly(ctx);
