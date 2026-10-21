/** Who can do what. Roles live in the database per organisation and can be adjusted; these are the defaults. */

export type StaffRole = string;
export type ClientRole = string;

export type Perm =
  | 'clients.view'
  | 'clients.manage'
  | 'team.manage'
  | 'orders.create'
  | 'orders.warehouse'
  | 'orders.hold'
  | 'products.edit'
  | 'stock.adjust'
  | 'inbounds.create'
  | 'inbounds.receive'
  | 'support.reply'
  | 'activity.view'
  | 'invoices.view'
  | 'billing.manage';

/** Every permission, in the order shown. `staffOnly` ones can only be given to Elmamsflow team roles. */
export const PERMS: { key: Perm; label: string; staffOnly?: boolean }[] = [
  { key: 'clients.view', label: 'See clients', staffOnly: true },
  { key: 'clients.manage', label: 'Add clients and manage their access', staffOnly: true },
  { key: 'team.manage', label: 'Invite people and manage the team' },
  { key: 'orders.create', label: 'Create and cancel orders' },
  { key: 'orders.warehouse', label: 'Pack and ship orders', staffOnly: true },
  { key: 'orders.hold', label: 'Put orders on hold or release them', staffOnly: true },
  { key: 'products.edit', label: 'Add and edit products' },
  { key: 'inbounds.create', label: 'Announce stock inbounds' },
  { key: 'inbounds.receive', label: 'Receive inbounds at the warehouse', staffOnly: true },
  { key: 'stock.adjust', label: 'Correct stock, quarantine, import counts', staffOnly: true },
  { key: 'support.reply', label: 'Support tickets' },
  { key: 'activity.view', label: 'Activity log' },
  { key: 'invoices.view', label: 'See invoices and pay them' },
  { key: 'billing.manage', label: 'Price lists, create invoices, record payments', staffOnly: true },
];

export const permsFor = (staff: boolean) => PERMS.filter((p) => staff || !p.staffOnly);

export type RoleDef = { key: string; label: string; about: string | null; perms: string[]; locked: boolean; system: boolean; position: number };

const ALL = PERMS.map((p) => p.key);
export const DEFAULT_STAFF_ROLES: RoleDef[] = [
  { key: 'owner', label: 'Owner', about: 'Everything, including the team and every client.', perms: ALL, locked: true, system: true, position: 1 },
  { key: 'manager', label: 'Manager', about: 'Runs clients, orders, stock and the team (except owners).', perms: ALL, locked: false, system: true, position: 2 },
  { key: 'warehouse', label: 'Warehouse', about: 'Receives stock, packs and ships orders, adjusts counts.', perms: ['orders.warehouse', 'orders.hold', 'stock.adjust', 'inbounds.receive', 'products.edit'], locked: false, system: true, position: 3 },
  { key: 'support', label: 'Customer service', about: 'Answers tickets, puts orders on hold or releases them.', perms: ['clients.view', 'orders.hold', 'support.reply', 'orders.create', 'products.edit', 'inbounds.create'], locked: false, system: true, position: 4 },
  { key: 'finance', label: 'Finance', about: 'Sees clients and orders; billing when it arrives.', perms: ['clients.view', 'activity.view', 'invoices.view', 'billing.manage'], locked: false, system: true, position: 5 },
];
export const DEFAULT_CLIENT_ROLES: RoleDef[] = [
  { key: 'admin', label: 'Admin', about: 'Everything in the workspace, including the team.', perms: permsFor(false).map((p) => p.key), locked: true, system: true, position: 1 },
  { key: 'operations', label: 'Operations', about: 'Orders, products, inbounds and support.', perms: ['orders.create', 'products.edit', 'inbounds.create', 'support.reply'], locked: false, system: true, position: 2 },
  { key: 'support', label: 'Customer support', about: 'Orders, tracking and support tickets. Read only for stock.', perms: ['support.reply'], locked: false, system: true, position: 3 },
  { key: 'finance', label: 'Finance', about: 'Invoices and reports. Read only for orders.', perms: ['invoices.view', 'activity.view'], locked: false, system: true, position: 4 },
];

/** Can this role do this? Locked roles (Owner, client Admin) can do everything their side allows. */
export function roleCan(def: Pick<RoleDef, 'perms' | 'locked'> | undefined, p: Perm, staff: boolean) {
  if (!def) return false;
  if (!staff && PERMS.find((x) => x.key === p)?.staffOnly) return false;
  return def.locked || def.perms.includes(p);
}

/** Sort roles as shown everywhere; fall back to the defaults when the roles table isn't there yet. */
export function orderRoles(rows: RoleDef[] | null | undefined, staff: boolean): RoleDef[] {
  const list = rows && rows.length ? rows : staff ? DEFAULT_STAFF_ROLES : DEFAULT_CLIENT_ROLES;
  return [...list].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
}

export function roleLabel(role: string, defs?: RoleDef[]) {
  return (
    defs?.find((d) => d.key === role)?.label ??
    [...DEFAULT_STAFF_ROLES, ...DEFAULT_CLIENT_ROLES].find((d) => d.key === role)?.label ??
    role.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}
