import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { available, getProducts, orgNames } from '@/lib/data';
import { HEALTH, runway, salesByProduct } from '@/lib/insights';

import { csvCell as cell } from '@/lib/format';

/** The inventory as a CSV file (same search and client filter as the page). */
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx || (!ctx.staffRole && !ctx.clientRole)) return NextResponse.redirect(new URL('/login', req.url));
  const sp = req.nextUrl.searchParams;
  const [products, names, sales] = await Promise.all([getProducts(ctx), ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>), salesByProduct(ctx, 30)]);
  const q = (sp.get('q') ?? '').toLowerCase();
  const c = ctx.backOffice ? sp.get('c') ?? '' : '';
  const head = [...(ctx.backOffice ? ['client'] : []), 'sku', 'name', 'barcode', 'in_warehouse', 'reserved', 'sellable', 'quarantine', 'incoming', 'sold_30d', 'days_left', 'status', 'weight_g', 'hs_code', 'customs_value', 'low_stock'];
  const lines = products
    .filter((p) => (!c || p.org_id === c) && (!q || `${p.sku} ${p.name} ${p.barcode ?? ''}`.toLowerCase().includes(q)))
    .map((p) => {
      const r = runway(p, sales.get(p.id) ?? 0);
      return [...(ctx.backOffice ? [names[p.org_id]] : []), p.sku, p.name, p.barcode, p.on_hand, p.reserved, available(p), p.quarantined, p.incoming, r.sold30, r.days === null ? '' : Math.floor(r.days), HEALTH[r.health][0], p.weight_g, p.hs_code, p.customs_value, p.low_stock].map(cell).join(',');
    });
  const csv = '﻿' + [head.join(','), ...lines].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inventory-${date}.csv"` } });
}
