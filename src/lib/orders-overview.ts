import 'server-only';
import { supabaseServer } from './supabase/server';
import { allRows, getClients } from './data';

/** Days are counted in China time, like the warehouse's own day. */
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayKey = (v: string | Date) => DAY.format(typeof v === 'string' ? new Date(v) : v);

type O = {
  id: string; org_id: string; status: string; created_at: string; shipped_at: string | null; delivered_at: string | null;
  hold_kind: string | null; warehouse_id: string | null;
};

export type BrandRow = {
  id: string; name: string; code: string | null;
  today: number; week: number; prevWeek: number; shippedWeek: number;
  toShip: number; packed: number; onHold: number; inTransit: number; noWarehouse: number;
  holds: Record<string, number>; spark: number[]; lastOrderAt: string | null;
};

export async function ordersOverview(days = 14) {
  const sb = await supabaseServer();
  const since = new Date(Date.now() - 35 * 864e5).toISOString();
  const [rows, clients] = await Promise.all([
    allRows<O>(() => sb.from('orders').select('id, org_id, status, created_at, shipped_at, delivered_at, hold_kind, warehouse_id')
      .or(`created_at.gte.${since},shipped_at.gte.${since},delivered_at.gte.${since},status.in.(new,on_hold,packed,shipped)`)
      .order('created_at', { ascending: false }).order('id')),
    getClients(),
  ]);

  const now = new Date();
  const keys = Array.from({ length: days }, (_, i) => dayKey(new Date(now.getTime() - (days - 1 - i) * 864e5)));
  const today = keys[keys.length - 1];
  const yesterday = keys[keys.length - 2];
  const weekKeys = new Set(keys.slice(-7));
  const prevWeekKeys = new Set(Array.from({ length: 7 }, (_, i) => dayKey(new Date(now.getTime() - (13 - i) * 864e5))));

  const received = new Map(keys.map((k) => [k, 0]));
  const shipped = new Map(keys.map((k) => [k, 0]));
  const t = { received: 0, shipped: 0, delivered: 0, receivedY: 0, shippedY: 0 };
  const pipe = { new: 0, on_hold: 0, packed: 0, shipped: 0 };
  let noWarehouse = 0;
  const brands = new Map<string, BrandRow>(clients.map((c) => [c.id, {
    id: c.id, name: c.name, code: c.code, today: 0, week: 0, prevWeek: 0, shippedWeek: 0, toShip: 0, packed: 0, onHold: 0, inTransit: 0,
    noWarehouse: 0, holds: {}, spark: keys.map(() => 0), lastOrderAt: null,
  }]));

  for (const o of rows) {
    const b = brands.get(o.org_id);
    const c = dayKey(o.created_at);
    // Every order that came in counts as received (also one cancelled later), like the Orders list for that day.
    if (received.has(c)) received.set(c, received.get(c)! + 1);
    if (c === today) t.received++;
    if (c === yesterday) t.receivedY++;
    const s = o.shipped_at ? dayKey(o.shipped_at) : null;
    if (s && ['shipped', 'delivered'].includes(o.status)) {
      if (shipped.has(s)) shipped.set(s, shipped.get(s)! + 1);
      if (s === today) t.shipped++;
      if (s === yesterday) t.shippedY++;
      if (b && weekKeys.has(s)) b.shippedWeek++;
    }
    if (o.delivered_at && o.status === 'delivered' && dayKey(o.delivered_at) === today) t.delivered++;
    if (o.status in pipe) pipe[o.status as keyof typeof pipe]++;
    const open = ['new', 'on_hold', 'packed'].includes(o.status);
    if (open && !o.warehouse_id) noWarehouse++;
    if (!b) continue;
    if (!b.lastOrderAt || o.created_at > b.lastOrderAt) b.lastOrderAt = o.created_at;
    {
      const i = keys.indexOf(c);
      if (i >= 0) b.spark[i]++;
      if (c === today) b.today++;
      if (weekKeys.has(c)) b.week++;
      if (prevWeekKeys.has(c)) b.prevWeek++;
    }
    if (o.status === 'new') b.toShip++;
    if (o.status === 'packed') b.packed++;
    if (o.status === 'shipped') b.inTransit++;
    if (o.status === 'on_hold') { b.onHold++; const k = o.hold_kind ?? 'manual'; b.holds[k] = (b.holds[k] ?? 0) + 1; }
    if (open && !o.warehouse_id) b.noWarehouse++;
  }

  const label = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const series = keys.map((k) => ({ key: k, label: label(k), received: received.get(k)!, shipped: shipped.get(k)! }));
  const list = [...brands.values()].sort((a, b) =>
    (b.toShip + b.onHold + b.packed > 0 ? 1 : 0) - (a.toShip + a.onHold + a.packed > 0 ? 1 : 0) || b.week - a.week || b.toShip - a.toShip || a.name.localeCompare(b.name));
  return { today: t, pipe, noWarehouse, series, brands: list, clients: clients.map((c) => ({ id: c.id, name: c.name, code: c.code })) };
}

/** What needs doing for one client right now (shown above their order list). */
export async function clientTodo(orgId: string) {
  const sb = await supabaseServer();
  const { data } = await sb.from('orders').select('status, hold_kind, warehouse_id').eq('org_id', orgId).in('status', ['new', 'on_hold', 'packed']).limit(5000);
  const r = data ?? [];
  const holds: Record<string, number> = {};
  for (const o of r) if (o.status === 'on_hold') holds[o.hold_kind ?? 'manual'] = (holds[o.hold_kind ?? 'manual'] ?? 0) + 1;
  return {
    toShip: r.filter((o) => o.status === 'new').length,
    packed: r.filter((o) => o.status === 'packed').length,
    noWarehouse: r.filter((o) => !o.warehouse_id).length,
    holds,
  };
}
