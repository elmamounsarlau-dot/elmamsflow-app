import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate } from '@/lib/format';
import { Back, Empty } from '@/components/ui';

const TYPES: Record<string, string> = { inbound: 'Received', order: 'Shipped', adjust: 'Correction', count: 'Warehouse count', quarantine: 'To quarantine', release: 'Out of quarantine' };
const SOURCE: Record<string, string> = { manual: 'Entered in app', csv: 'CSV import', warehouse: 'Warehouse confirmed' };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('product_stock').select('*').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: p } = await q.maybeSingle();
  if (!p) notFound();
  const { data: moves } = await sb.from('stock_moves').select('*').eq('product_id', id).order('created_at', { ascending: false }).limit(100);
  return (
    <>
      <Back href="/inventory">Inventory</Back>
      <div className="ep-client-head"><div><h2>{p.sku} · {p.name}</h2><p className="ep-muted">{p.hs_code ? `HS ${p.hs_code}` : 'No HS code yet'} · customs value ${Number(p.customs_value).toFixed(2)}{p.weight_g ? ` · ${p.weight_g} g` : ''}</p></div></div>
      <div className="ep-kpis">
        <div className="ep-kpi"><small>Available</small><b>{Math.max(0, p.on_hand - p.quarantined - p.reserved)}</b></div>
        <div className="ep-kpi"><small>On hand</small><b>{p.on_hand}</b></div>
        <div className="ep-kpi"><small>Reserved</small><b>{p.reserved}</b></div>
        <div className="ep-kpi"><small>Quarantine</small><b>{p.quarantined}</b></div>
        <div className="ep-kpi"><small>Incoming</small><b>{p.incoming}</b></div>
      </div>
      <section className="ep-card">
        <h2>Stock history</h2>
        {(moves ?? []).length === 0 ? <Empty title="No movement yet" text="Stock arrives through inbounds and leaves with orders." /> : (
          <table className="ep-table">
            <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Note</th><th>Source</th><th className="ep-right">Units</th></tr></thead>
            <tbody>{(moves ?? []).map((m) => <tr key={m.id}><td>{fmtDate(m.created_at, true)}</td><td>{TYPES[m.type] ?? m.type}</td><td>{m.ref}</td><td>{m.note}</td><td><small>{SOURCE[m.source] ?? m.source}</small></td><td className="ep-right"><b className={['quarantine', 'release'].includes(m.type) ? 'ep-q' : m.qty < 0 ? 'ep-neg' : 'ep-pos'}>{m.qty > 0 ? '+' : ''}{m.qty}</b></td></tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
