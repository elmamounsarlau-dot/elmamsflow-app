import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { orgNames } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { money } from '@/lib/billing';
import { Back, Empty, TeamOnly } from '@/components/ui';
import { decideTopupAction } from '../wallet-actions';

export const metadata = { title: 'Top-ups' };

/** Our billing team: top-ups clients announced, to confirm once the money is in the account. */
export default async function Topups() {
  const ctx = await requireCtx();
  if (!ctx.staffRole || !ctx.can('billing.manage') || ctx.viewingAs) redirect('/invoices');
  const [{ data }, names] = await Promise.all([
    supabaseAdmin().from('wallet_entries').select('id, org_id, amount, currency, method, ref, note, created_at, status, confirmed_at').eq('kind', 'topup').order('created_at', { ascending: false }).limit(200),
    orgNames(),
  ]);
  const rows = data ?? [];
  const waiting = rows.filter((r) => r.status === 'pending');
  const done = rows.filter((r) => r.status !== 'pending').slice(0, 40);
  return (
    <>
      <Back href="/invoices">Invoices</Back>
      <div className="ep-head"><div><p className="ep-crumb">Invoices · Top-ups</p><h1>Top-ups</h1><p>Clients announce a top-up and get a reference. Confirm it when the money is in your account: their balance goes up and any waiting orders go to the warehouse.</p></div></div>
      <section className="ep-card ep-card--team ep-card--flush" style={{ marginBottom: '1.2rem' }}>
        <div className="ep-card-head ep-pad"><h2>To confirm</h2><TeamOnly /></div>
        {!waiting.length ? <Empty title="Nothing waiting" text="New top-ups appear here." /> : (
          <div className="ep-tablewrap"><table className="ep-table">
            <thead><tr><th>Announced</th><th>Client</th><th>Reference</th><th>Method</th><th className="ep-right">Amount</th><th>Arrived?</th></tr></thead>
            <tbody>{waiting.map((e) => (
              <tr key={e.id}>
                <td><small>{fmtDate(e.created_at, true)}</small></td>
                <td><Link className="ep-link" href={`/clients/${e.org_id}#partner`}>{names[e.org_id] ?? '—'}</Link></td>
                <td><b className="ep-mono">{e.ref}</b>{e.note && <small>{e.note}</small>}</td>
                <td><small>{e.method}</small></td>
                <td className="ep-right"><b>{money(Number(e.amount), e.currency)}</b></td>
                <td>
                  <form action={decideTopupAction} className="ep-inline" style={{ gap: '.35rem', flexWrap: 'wrap' }}>
                    <input type="hidden" name="id" value={e.id} /><input type="hidden" name="back" value="/invoices/topups" />
                    <input name="amount" type="number" step="0.01" min="0.01" defaultValue={Number(e.amount)} style={{ width: '6.5rem' }} aria-label="Amount that arrived" />
                    <button className="ep-btn ep-btn--sm" name="decision" value="confirm">Received</button>
                    <button className="ep-btn ep-btn--sm ep-btn--ghost" name="decision" value="reject">Not received</button>
                  </form>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="ep-card ep-card--flush">
        <div className="ep-card-head ep-pad"><h2>Recently handled</h2></div>
        {!done.length ? <Empty title="None yet" text="Confirmed and refused top-ups appear here." /> : (
          <div className="ep-tablewrap"><table className="ep-table">
            <thead><tr><th>Date</th><th>Client</th><th>Reference</th><th className="ep-right">Amount</th><th>Result</th></tr></thead>
            <tbody>{done.map((e) => (
              <tr key={e.id}><td><small>{fmtDate(e.confirmed_at ?? e.created_at, true)}</small></td><td>{names[e.org_id] ?? '—'}</td><td className="ep-mono">{e.ref}</td><td className="ep-right">{money(Number(e.amount), e.currency)}</td><td>{e.status === 'confirmed' ? <span className="ep-st ep-st--ok">Received</span> : <span className="ep-st ep-st--mute">Not received</span>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
