import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { fmtDate } from '@/lib/format';
import { CATEGORY, INVOICE_STATUS, isOverdue, money, stripeReady } from '@/lib/billing';
import { Arrow, Back, Badge, TeamOnly } from '@/components/ui';
import { CopyLink, Submit } from '@/components/client';
import { addLine, deleteDraft, issueInvoice, markPaid, payByCard, recalcDraft, removeLine, voidInvoice } from '../actions';

type L = { id: string; category: string; description: string; qty: number; unit_price: number; amount: number; position: number };

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sp = await searchParams;
  const sb = await supabaseServer();
  let q = sb.from('invoices').select('*, organizations(name, code)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id).neq('status', 'draft');
  const { data: inv } = await q.maybeSingle();
  if (!inv || !ctx.can('invoices.view')) notFound();
  const [{ data: lines }, { data: settings }] = await Promise.all([
    sb.from('invoice_lines').select('*').eq('invoice_id', id).order('position'),
    sb.from('billing_settings').select('*').eq('id', 1).maybeSingle(),
  ]);
  const rows = (lines ?? []) as L[];
  const manage = !!ctx.staffRole && ctx.can('billing.manage') && !ctx.viewingAs;
  const status = isOverdue(inv) ? 'overdue' : inv.status;
  const cur = inv.currency as string;
  const org = inv.organizations as unknown as { name: string; code: string } | null;
  const period = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${inv.period_start}T00:00:00Z`));
  const bank = settings?.[`bank_${cur.toLowerCase()}`] as string | null | undefined;
  const byCat = rows.reduce<Record<string, number>>((a, l) => ({ ...a, [l.category]: (a[l.category] ?? 0) + Number(l.amount) }), {});
  const daysLeft = inv.due_date ? Math.round((Date.parse(inv.due_date) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5) : null;

  return (
    <>
      <Back href="/invoices">All invoices</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">{ctx.backOffice && org ? `${org.name} · ` : ''}Invoice · {period}</p>
          <h1><span className="ep-mono">{inv.number}</span> <Badge map={INVOICE_STATUS} value={status} /></h1>
          <p>
            {inv.status === 'draft' ? 'Draft — only your team sees it until you issue it.'
              : inv.status === 'paid' ? `Paid on ${fmtDate(inv.paid_at)}${inv.paid_method ? ` by ${inv.paid_method === 'card' ? 'card' : inv.paid_method === 'bank' ? 'bank transfer' : 'other means'}` : ''}.`
              : inv.status === 'void' ? `Voided. ${inv.notes ?? ''}`
              : `Issued ${fmtDate(inv.issued_at)} · due ${fmtDate(inv.due_date)}${daysLeft !== null ? (daysLeft < 0 ? ` · ${-daysLeft} days late` : daysLeft === 0 ? ' · due today' : ` · in ${daysLeft} days`) : ''}`}
          </p>
        </div>
        <div className="ep-actions">
          <a className="ep-btn ep-btn--ghost" href={`/print/invoice/${inv.id}`} target="_blank" rel="noreferrer">Download PDF</a>
          {inv.status === 'open' && !ctx.backOffice && <a className="ep-btn" href="#pay">Pay {money(inv.total, cur)} <Arrow /></a>}
        </div>
      </div>

      {sp.paid && inv.status !== 'paid' && <p className="ep-note">Thank you — your card payment went through. This invoice turns to Paid within a minute.</p>}

      <div className="ep-grid2 ep-grid2--wide">
        <section className="ep-card ep-card--flush">
          <div className="ep-card-head ep-pad"><h2>Charges</h2><span className="ep-muted ep-small">{period}</span></div>
          {rows.length === 0 ? <p className="ep-pad ep-muted" style={{ paddingBottom: '1.2rem' }}>No charges for this period.</p> : (
            <div className="ep-tablewrap">
              <table className="ep-table ep-lines">
                <thead><tr><th>Service</th><th>Description</th><th className="ep-right">Qty</th><th className="ep-right">Unit price</th><th className="ep-right">Amount</th>{manage && inv.status === 'draft' && <th />}</tr></thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.id}>
                      <td><span className={`ep-cat ep-cat--${l.category}`}>{CATEGORY[l.category] ?? l.category}</span></td>
                      <td>{l.description}</td>
                      <td className="ep-right">{Number(l.qty).toLocaleString('en', { maximumFractionDigits: 3 })}</td>
                      <td className="ep-right"><small>{money(l.unit_price, cur)}</small></td>
                      <td className="ep-right"><b>{money(l.amount, cur)}</b></td>
                      {manage && inv.status === 'draft' && (
                        <td className="ep-right"><form action={removeLine}><input type="hidden" name="id" value={inv.id} /><input type="hidden" name="line" value={l.id} /><Submit className="ep-link">Remove</Submit></form></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="ep-total"><span>Total due</span><b>{money(inv.total, cur)}</b></div>
        </section>

        <div>
          <section className="ep-card">
            <h2>Summary</h2>
            <ul className="ep-sumlist">
              {Object.entries(byCat).map(([c, n]) => <li key={c}><span>{CATEGORY[c] ?? c}</span><b>{money(n, cur)}</b></li>)}
              <li className="is-total"><span>Total</span><b>{money(inv.total, cur)}</b></li>
            </ul>
            <dl className="ep-dl ep-dl--tight">
              {ctx.backOffice && org && <><dt>Client</dt><dd>{org.name} · {org.code}</dd></>}
              <dt>Period</dt><dd>{fmtDate(inv.period_start)} – {fmtDate(inv.period_end)}</dd>
              <dt>Currency</dt><dd>{cur}</dd>
              {inv.paid_ref && <><dt>Payment ref.</dt><dd className="ep-mono">{inv.paid_ref}</dd></>}
            </dl>
          </section>

          {inv.status === 'open' && (
            <section className="ep-card ep-card--hl" id="pay">
              <h2>Pay this invoice</h2>
              <p className="ep-small ep-muted" style={{ margin: '.3rem 0 1rem' }}>Use <b>{inv.number}</b> as the payment reference.</p>
              {stripeReady() && (
                <form action={payByCard} style={{ marginBottom: '1rem' }}>
                  <input type="hidden" name="id" value={inv.id} />
                  <Submit className="ep-btn ep-btn--full">Pay {money(inv.total, cur)} by card <Arrow /></Submit>
                </form>
              )}
              <div className="ep-bank">
                <small>Bank transfer · {cur}</small>
                {bank ? <><pre>{bank}</pre><CopyLink value={bank.replace(/\s*\n\s*/g, ' · ')} label="Copy" /></> : <p className="ep-small ep-muted">Bank details for {cur} will appear here. Ask us in Support meanwhile.</p>}
              </div>
            </section>
          )}

          {manage && inv.status === 'draft' && (
            <section className="ep-card ep-card--team">
              <h2>Review and issue</h2>
              <TeamOnly />
              <form action={issueInvoice} className="ep-form">
                <input type="hidden" name="id" value={inv.id} />
                <label>Note on the invoice (optional)<input name="notes" defaultValue={inv.notes ?? ''} placeholder="e.g. Thank you for your business" /></label>
                <Submit className="ep-btn ep-btn--full" confirm={`Issue ${inv.number} for ${money(inv.total, cur)}? The client will see it.`}>Issue invoice <Arrow /></Submit>
              </form>
              <div className="ep-inline" style={{ marginTop: '.8rem', justifyContent: 'space-between' }}>
                <form action={recalcDraft}><input type="hidden" name="id" value={inv.id} /><Submit className="ep-link">Recalculate from latest data</Submit></form>
                <form action={deleteDraft}><input type="hidden" name="id" value={inv.id} /><Submit className="ep-link" confirm="Delete this draft?">Delete draft</Submit></form>
              </div>
            </section>
          )}

          {manage && inv.status === 'open' && (
            <section className="ep-card ep-card--team">
              <h2>Record a payment</h2>
              <TeamOnly />
              <form action={markPaid} className="ep-form">
                <input type="hidden" name="id" value={inv.id} />
                <div className="ep-row2">
                  <label>Paid by<select name="method" defaultValue="bank"><option value="bank">Bank transfer</option><option value="card">Card</option><option value="other">Other</option></select></label>
                  <label>Date received<input type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} /></label>
                </div>
                <label>Reference (optional)<input name="ref" placeholder="Bank reference" /></label>
                <Submit className="ep-btn ep-btn--full">Mark as paid</Submit>
              </form>
              <form action={voidInvoice} className="ep-inline" style={{ marginTop: '.8rem' }}>
                <input type="hidden" name="id" value={inv.id} />
                <input name="reason" placeholder="Reason to void" style={{ flex: 1 }} />
                <Submit className="ep-btn ep-btn--ghost" confirm="Void this invoice? It stays in the history but no longer needs paying.">Void</Submit>
              </form>
            </section>
          )}
        </div>
      </div>

      {manage && inv.status === 'draft' && (
        <section className="ep-card ep-card--team">
          <h2>Add a line</h2>
          <TeamOnly />
          <form action={addLine} className="ep-form">
            <input type="hidden" name="id" value={inv.id} />
            <div className="ep-row4 ep-row4--line">
              <label>Service<select name="category" defaultValue="other">{Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>Description<input name="description" required placeholder="e.g. Relabelling 200 units" /></label>
              <label>Qty<input type="number" name="qty" step="0.001" min={0} defaultValue={1} /></label>
              <label>Unit price ({cur})<input type="number" name="unit_price" step="0.001" required placeholder="Use − for a discount" /></label>
            </div>
            <div className="ep-form-foot"><Submit className="ep-btn ep-btn--ghost">Add line</Submit></div>
          </form>
        </section>
      )}
    </>
  );
}
