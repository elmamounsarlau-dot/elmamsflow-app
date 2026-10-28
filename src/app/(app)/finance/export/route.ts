import { NextResponse, type NextRequest } from 'next/server';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { allRows } from '@/lib/data';
import { csvCell as cell } from '@/lib/format';
import { invoiceTz, monthBounds } from '@/lib/billing';
import { financeSettings, toReport } from '@/lib/fx';
import { CAT_LABEL, currentYm, monthFinance, ymOk, type ExpenseCat } from '@/lib/finance';
import { dayKey } from '@/lib/orders-overview';

/** One month for the accountant: every invoice, every expense, every order cost, and the totals — one CSV. */
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  if (!ctx) return NextResponse.redirect(new URL('/login', req.url));
  if (!ctx.staffRole || !ctx.backOffice || !ctx.can('billing.manage')) return new NextResponse('Not allowed', { status: 403 });
  const cur = await currentYm();
  const m = ymOk(req.nextUrl.searchParams.get('m'));
  const ym = m && m <= cur ? m : cur;
  const admin = supabaseAdmin();
  const [f, fin, tz] = await Promise.all([monthFinance(ym), financeSettings(), invoiceTz()]);
  const { start, end } = monthBounds(ym, tz);
  const c = fin.report_currency;
  const [{ data: orgs }, costs] = await Promise.all([
    admin.from('organizations').select('id, name').eq('kind', 'client'),
    allRows<{ org_id: string; label_cost: number | null; duties_paid: number | null; currency: string; orders: { number: string; shipped_at: string; carrier: string | null; tracking: string | null } }>(() =>
      admin.from('order_costs').select('org_id, label_cost, duties_paid, currency, orders!inner(number, shipped_at, carrier, tracking, status)')
        .in('orders.status', ['shipped', 'delivered']).gte('orders.shipped_at', start.toISOString()).lt('orders.shipped_at', end.toISOString()).order('order_id')),
  ]);
  const names = Object.fromEntries((orgs ?? []).map((o) => [o.id, o.name])) as Record<string, string>;
  // Numbers stay numbers (a text starting with “-” would be escaped as a formula).
  const n2 = (v: number | null) => (v === null ? '' : Math.round(v * 100) / 100);

  const head = ['type', 'date', 'reference', 'paid_to_or_client', 'client', 'category', 'amount', 'currency', `amount_${c}`, 'status_or_source', 'receipt', 'note'];
  const rows: (string | number | null)[][] = [];
  for (const r of f.rev.rows) {
    rows.push(['revenue', `${ym}-01`, r.number ?? 'not invoiced yet', r.name, r.name, r.source === 'invoice' ? 'Invoice' : 'Billable so far', n2(r.total), r.currency, n2(r.report), r.status ?? 'so far', '', r.error ?? '']);
  }
  for (const e of f.exp.rows) {
    rows.push(['expense', e.spent_on, '', e.payee, e.org_id ? names[e.org_id] ?? '' : 'shared', CAT_LABEL[e.category as ExpenseCat], n2(e.amount), e.currency, n2(e.report), e.source, e.receipt_path ? 'yes' : 'no', e.note ?? '']);
  }
  for (const o of costs) {
    const d = dayKey(o.orders.shipped_at);
    if (Number(o.label_cost) > 0) rows.push(['expense', d, `#${o.orders.number}`, o.orders.carrier ?? 'Shipping label', names[o.org_id] ?? '', CAT_LABEL.carrier, n2(Number(o.label_cost)), o.currency, n2(toReport(Number(o.label_cost), o.currency, fin)), 'order', 'no', o.orders.tracking ?? '']);
    if (Number(o.duties_paid) > 0) rows.push(['expense', d, `#${o.orders.number}`, 'Customs (DDP duties)', names[o.org_id] ?? '', CAT_LABEL.duties, n2(Number(o.duties_paid)), o.currency, n2(toReport(Number(o.duties_paid), o.currency, fin)), 'order', 'no', '']);
  }
  rows.push([]);
  rows.push(['total', '', '', 'Revenue', '', '', '', '', n2(f.rev.total), '', '', '']);
  rows.push(['total', '', '', 'Expenses', '', '', '', '', n2(f.exp.total), '', '', '']);
  rows.push(['total', '', '', 'Profit', '', '', '', '', n2(f.profit), '', '', '']);
  if (f.noRate.length) rows.push(['note', '', '', `Left out of the totals (no exchange rate): ${f.noRate.join(', ')}`, '', '', '', '', '', '', '', '']);
  const csv = '﻿' + [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
  return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="elmamsflow-finance-${ym}.csv"`, 'Cache-Control': 'private, no-store' } });
}
