import 'server-only';
import { supabaseAdmin } from './supabase/admin';
import { orderRoles, type RoleDef } from './roles';

/** The roles of one organisation (defaults if the roles migration isn't run yet). */
export async function getOrgRoles(orgId: string, staff: boolean): Promise<{ roles: RoleDef[]; editable: boolean }> {
  const { data, error } = await supabaseAdmin().from('roles').select('key, label, about, perms, locked, system, position').eq('org_id', orgId);
  return { roles: orderRoles(error ? null : (data as RoleDef[]), staff), editable: !error };
}
