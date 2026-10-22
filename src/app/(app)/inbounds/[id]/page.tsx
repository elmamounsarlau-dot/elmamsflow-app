import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate, INBOUND_STATUS } from '@/lib/format';
import { Arrow, Back, Badge, TeamOnly } from '@/components/ui';
import { Submit } from '@/components/client';
import { STEPS, STEP_OF } from '@/components/steps';
import { updateInbound } from '../actions';

const STATUS_OF_STEP = ['announced', 'in_transit', 'receiving', 'counted', 'received'];

export default async function InboundPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('inbounds').select('*, organizations(name)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: b } = await q.maybeSingle();
  if (!b) notFound();
  const [{ data: items }, { data: logs }] = await Promise.all([
    sb.from('inbound_items').select('id, expected, received, products(id, sku, name)').eq('inbound_id', id),
    sb.from('activity_log').select('action, detail, created_at').eq('org_id', b.org_id).in('action', ['inbound_created', 'inbound_status', 'inbound_counted', 'inbound_received']).like('detail', `${b.ref}%`).order('created_at'),
  ]);

  // Date each step was reached (from the activity log).
  const reached: (string | null)[] = [b.created_at, null, null, null, b.received_at];
  for (const l of (logs ?? []) as { action: string; detail: string; created_at: string }[]) {
    const st = l.action === 'inbound_counted' ? 'counted' : l.action === 'inbound_received' ? 'received' : l.action === 'inbound_status' ? l.detail.split('→ ')[1]?.trim() : null;
    const i = st ? STATUS_OF_STEP.indexOf(st) : -1;
    if (i > 0) reached[i] = l.created_at;
  }

  const order = Object.keys(INBOUND_STATUS);
  const pos = STEP_OF[b.status] ?? 0;
  const done = b.status === 'received';
  const receiving = ctx.can('inbounds.receive') && !done;
  const rows = (items ?? []) as unknown as { id: string; expected: number; received: number; products: { id: string; sku: string; name: string } | null }[];
  const expected = rows.reduce((a, i) => a + i.expected, 0);
  const counted = rows.reduce((a, i) => a + i.received, 0);
  const showCount = b.status === 'counted' || done;
  const today = new Date().toISOString().slice(0, 10);
  const late = !done && b.eta && b.eta < today ? Math.round((Date.parse(today) - Date.parse(b.eta)) / 864e5) : 0;
  const client = (b.organizations as unknown as { name: string } | null)?.name;

  return (
    <>
      <Back href="/inbounds">All stock inbounds</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">{ctx.backOffice && client ? `${client} · ` : ''}Stock inbound</p>
          <h1><span className="ep-mono">{b.ref}</span> <Badge map={INBOUND_STATUS} value={b.status} />{late > 0 && <span className="ep-st ep-st--err">{late} day{late === 1 ? '' : 's'} late</span>}</h1>
          <p>Write <b>{b.ref}</b> on every carton so the warehouse can match it on arrival.</p>
        </div>
      </div>

      <section className="ep-card">
        <div className="ep-card-head"><h2>Receiving progress</h2><span className="ep-muted ep-small">{done ? `Sellable since ${fmtDate(b.received_at, true)}` : `Now: ${STEPS[pos]}`}</span></div>
        <ol className="ep-timeline">
          {STEPS.map((s, i) => (
            <li key={s} className={done || i < pos ? 'done' : i === pos ? 'now' : ''}>
              <i />
              <b>{s}</b>
              <small>{reached[i] && (done || i <= pos) ? fmtDate(reached[i]!, true) : i === 1 && b.eta && !done ? `ETA ${fmtDate(b.eta)}` : ' '}</small>
            </li>
          ))}
        </ol>
      </section>

      <div className="ep-grid2 ep-grid2--wide">
        <section className="ep-card">
          <h2>Shipment information</h2>
          <dl className="ep-dl">
            {ctx.backOffice && <><dt>Client</dt><dd>{client}</dd></>}
            <dt>Supplier</dt><dd>{b.supplier || '—'}</dd>
            <dt>Reference</dt><dd className="ep-mono">{b.ref}</dd>
            <dt>Cartons</dt><dd>{b.cartons || '—'}</dd>
            <dt>Created</dt><dd>{fmtDate(b.created_at)}</dd>
            <dt>Expected arrival</dt><dd>{b.eta ? fmtDate(b.eta) : 'Not set'}{late > 0 && <span className="ep-late"> · {late} days late</span>}</dd>
            {b.received_at && <><dt>Sellable since</dt><dd>{fmtDate(b.received_at, true)}</dd></>}
            {b.notes && <><dt>Notes</dt><dd>{b.notes}</dd></>}
          </dl>
        </section>
        <section className="ep-card ep-stock-sum">
          <h2>Stock summary</h2>
          <b>{(showCount ? counted : expected).toLocaleString('en')} <i>units</i></b>
          <span>{rows.length} SKU{rows.length === 1 ? '' : 's'}{showCount ? ` · ${expected.toLocaleString('en')} announced` : ' announced'}</span>
          {showCount && counted !== expected && (
            <p className={`ep-note ep-note--${counted < expected ? 'warn' : 'ok'}`}>{counted < expected ? `${(expected - counted).toLocaleString('en')} units short` : `${(counted - expected).toLocaleString('en')} units more than announced`}</p>
          )}
          {showCount && counted === expected && <p className="ep-note ep-note--ok">Everything announced arrived.</p>}
        </section>
      </div>

      <section className={`ep-card ep-card--flush${receiving ? ' ep-card--team' : ''}`}>
        <div className="ep-card-head ep-pad">
          <h2>{receiving ? (b.status === 'counted' ? 'Check the count' : 'Count what arrived') : 'Items'}</h2>
          {receiving && <TeamOnly />}
        </div>
        <form action={updateInbound}>
          <input type="hidden" name="id" value={b.id} />
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>SKU</th><th>Product</th><th className="ep-right">Announced</th><th className="ep-right">{showCount || receiving ? 'Counted' : 'Received'}</th>{showCount && <th className="ep-right">Difference</th>}</tr></thead>
              <tbody>
                {rows.map((it) => {
                  const diff = it.received - it.expected;
                  return (
                    <tr key={it.id}>
                      <td><b>{it.products?.sku}</b></td><td>{it.products?.name}</td><td className="ep-right">{it.expected.toLocaleString('en')}</td>
                      <td className="ep-right">{receiving ? <input className="ep-qty" type="number" min={0} aria-label="Units counted" name={`rcv_${it.id}`} defaultValue={showCount ? it.received : it.expected} /> : showCount ? <b>{it.received.toLocaleString('en')}</b> : <span className="ep-zero">—</span>}</td>
                      {showCount && <td className="ep-right">{diff === 0 ? <span className="ep-zero">0</span> : <b className={diff < 0 ? 'ep-neg' : 'ep-pos'}>{diff > 0 ? '+' : ''}{diff}</b>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {receiving && (
            <div className="ep-pad">
              <div className="ep-inbound-actions">
                <label className="ep-inbound-status">
                  <span>Move to</span>
                  <select name="status" defaultValue={b.status === 'counted' ? 'received' : order[Math.min(order.indexOf(b.status) + 1, order.length - 1)]}>
                    {order.map((k) => <option key={k} value={k}>{INBOUND_STATUS[k][0]}{k === 'counted' ? ' — save the count' : k === 'received' ? ' — add to stock' : ''}</option>)}
                  </select>
                </label>
                <Submit>Update <Arrow /></Submit>
              </div>
              <p className="ep-small ep-muted" style={{ marginTop: '.6rem', textAlign: 'right' }}>“Counted” saves the quantities without touching stock. “Available” adds them to stock straight away.</p>
            </div>
          )}
        </form>
      </section>
    </>
  );
}
