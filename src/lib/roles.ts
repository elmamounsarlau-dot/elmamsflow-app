/** Who can do what. One place to read and change it. */

export type StaffRole = 'owner' | 'manager' | 'warehouse' | 'support' | 'finance';
export type ClientRole = 'admin' | 'operations' | 'support' | 'finance';

export const STAFF_ROLES: Record<StaffRole, { label: string; about: string }> = {
  owner: { label: 'Owner', about: 'Everything, including the team and every client.' },
  manager: { label: 'Manager', about: 'Runs clients, orders, stock and the team (except owners).' },
  warehouse: { label: 'Warehouse', about: 'Receives stock, packs and ships orders, adjusts counts.' },
  support: { label: 'Customer service', about: 'Answers tickets, puts orders on hold or releases them.' },
  finance: { label: 'Finance', about: 'Sees clients and orders; billing when it arrives.' },
};

export const CLIENT_ROLES: Record<ClientRole, { label: string; about: string }> = {
  admin: { label: 'Admin', about: 'Everything in the workspace, including the team.' },
  operations: { label: 'Operations', about: 'Orders, products, inbounds and support.' },
  support: { label: 'Customer support', about: 'Orders, tracking and support tickets. Read only for stock.' },
  finance: { label: 'Finance', about: 'Invoices and reports. Read only for orders.' },
};

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
  | 'invoices.view';

const STAFF_PERMS: Record<StaffRole, Perm[]> = {
  owner: ['clients.view', 'clients.manage', 'team.manage', 'orders.create', 'orders.warehouse', 'orders.hold', 'products.edit', 'stock.adjust', 'inbounds.create', 'inbounds.receive', 'support.reply', 'activity.view', 'invoices.view'],
  manager: ['clients.view', 'clients.manage', 'team.manage', 'orders.create', 'orders.warehouse', 'orders.hold', 'products.edit', 'stock.adjust', 'inbounds.create', 'inbounds.receive', 'support.reply', 'activity.view', 'invoices.view'],
  warehouse: ['orders.warehouse', 'orders.hold', 'stock.adjust', 'inbounds.receive', 'products.edit'],
  support: ['clients.view', 'orders.hold', 'support.reply', 'orders.create', 'products.edit', 'inbounds.create'],
  finance: ['clients.view', 'activity.view', 'invoices.view'],
};

const CLIENT_PERMS: Record<ClientRole, Perm[]> = {
  admin: ['team.manage', 'orders.create', 'products.edit', 'inbounds.create', 'support.reply', 'activity.view', 'invoices.view'],
  operations: ['orders.create', 'products.edit', 'inbounds.create', 'support.reply'],
  support: ['support.reply'],
  finance: ['invoices.view', 'activity.view'],
};

export function staffCan(role: StaffRole | null, p: Perm) {
  return !!role && STAFF_PERMS[role].includes(p);
}

export function clientCan(role: ClientRole | null, p: Perm) {
  return !!role && CLIENT_PERMS[role].includes(p);
}

export function roleLabel(role: string) {
  return (STAFF_ROLES as Record<string, { label: string }>)[role]?.label ?? (CLIENT_ROLES as Record<string, { label: string }>)[role]?.label ?? role;
}
