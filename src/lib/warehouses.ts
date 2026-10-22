import 'server-only';
import { cache } from 'react';
import { supabaseServer } from './supabase/server';

export type Warehouse = { id: string; code: string; name: string; city: string | null; province: string | null; kind: 'physical' | 'holding'; active: boolean };

/** All warehouses (physical ones first, then the unallocated pool). */
export const getWarehouses = cache(async (): Promise<Warehouse[]> => {
  const sb = await supabaseServer();
  const { data } = await sb.from('warehouses').select('id, code, name, city, province, kind, active').order('kind').order('name');
  return (data ?? []) as Warehouse[];
});

/** Warehouses that can receive and ship stock. */
export const shippingWarehouses = (list: Warehouse[]) => list.filter((w) => w.kind === 'physical' && w.active);

export type WarehouseStock = { product_id: string; org_id: string; sku: string; name: string; warehouse_id: string; warehouse_code: string; warehouse_name: string; warehouse_kind: string; on_hand: number; quarantined: number; reserved: number };

export const whLabel = (w: Pick<Warehouse, 'name' | 'kind'> | undefined) => (w ? (w.kind === 'holding' ? 'Unallocated' : w.name) : '—');
