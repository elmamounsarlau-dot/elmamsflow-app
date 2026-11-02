import Link from 'next/link';
import { notFound } from 'next/navigation';
import { b2bOrderFile, b2bSettings, moneyOf } from '@/lib/b2b-data';
import { B2B_KINDS, curMa, DOC_KIND, INCOTERMS, KIND_LABEL, priceMa, totals, TRANSPORT } from '@/lib/b2b';
import { countryName, fmtDate } from '@/lib/format';
import { financeSettings, MONEY_CURRENCIES } from '@/lib/fx';
import { Submit } from '@/components/client';
import { Arrow, Back } from '@/components/ui';
import { addCost, addNote, addPayment, deleteCost, deleteLine, deletePayment, issueDoc, moveLine, saveLine, saveOrder, setStage, voidDoc } from '../actions';
import { flag, money, requireB2B, stageTone } from '../ui';

export const metadata = { title: 'B2B order' };

const METHOD: Record<string, string> = { bank: 'Bank transfer', cash: 'Cash', cheque: 'Cheque', other: 'Other' };

export default async function B2BOrder({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  await requireB2B();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [file, st, fin] = await Promise.all([b2bOrderFile(id), b2bSettings(), financeSettings()]);
  if (!file) notFound();
  const { order: o, client, lines, costs, pays, docs, events } = file;
  const cur = o.currency;
  const t = totals(lines, Number(o.tva_rate), Number(o.discount));
  const m = moneyOf(o, lines, costs, pays, docs, fin);
  const rc = fin.report_currency;
  const morocco = client?.country === 'MA';
  const editing = lines.find((l) => l.id === sp.line) ?? null;
  const stageIdx = st.stages.indexOf(o.stage);
  const today = new Date().toISOString().slice(0, 10);
  const issued = docs.filter((d) => d.status === 'issued');
  const finalLabel = morocco ? 'Facture' : 'Invoice';
  const devisLabel = morocco ? 'Devis' : 'Quotation';

  const priceOf = (l: (typeof lines)[number]) => (l.pct !== null ? `${l.pct}%` : `${priceMa(Number(l.unit_price))} ${curMa(l.price_currency)}`);

  const lineForm = (e: typeof editing) => (
    <form action={saveLine} className="ep-form bb-lineform" id="line-form">
      <input type="hidden" name="order" value={o.id} />
      {e && <input type="hidden" name="line" value={e.id} />}
      <div className="fn-xform-head"><h3 className="fn-h2">{e ? 'Edit the line' : 'Add a line'}</h3>{e && <Link className="ep-link" href={`/b2b/${o.id}#lines`}>Cancel</Link>}</div>
      <div className="bb-lf-grid">
        <label className="bb-lf-kind">What
          <select name="kind" defaultValue={e?.kind ?? (lines.length ? 'freight' : 'goods')}>{B2B_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        </label>
        <label className="bb-lf-desc">Description (as printed)<input name="description" required maxLength={200} defaultValue={e?.description ?? ''} placeholder={morocco ? 'e.g. Carrelage porcelaine 60×60 gris' : 'e.g. Porcelain tiles 60×60, grey'} /></label>
        <label className="bb-lf-hs">HS code<input name="hs_code" maxLength={20} defaultValue={e?.hs_code ?? ''} placeholder="optional" /></label>
        <label className="bb-lf-qty">Quantity<input name="qty" inputMode="decimal" defaultValue={e?.qty ?? ''} placeholder="empty = flat" /></label>
        <label className="bb-lf-unit">Unit<input name="unit" maxLength={20} defaultValue={e?.unit ?? ''} placeholder="m², pcs, kg…" /></label>
        <label className="bb-lf-price">Unit price<input name="price" inputMode="decimal" required defaultValue={e ? (e.pct ?? e.unit_price ?? '') : ''} placeholder="0.00" /></label>
        <label className="bb-lf-cur">In
          <select name="price_as" defaultValue={e ? (e.pct !== null ? '%' : e.price_currency ?? cur) : cur}>
            {MONEY_CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
            <option value="%">% of the lines above</option>
          </select>
        </label>
        <label className="bb-lf-rate">Rate to {cur}<input name="rate" inputMode="decimal" defaultValue={e && e.pct === null && e.price_currency !== cur ? e.rate : ''} placeholder="auto" /></label>
      </div>
      <p className="fn-sub fn-mu">A price in another currency is converted to {cur} with the rate from Finance settings, or the rate you type. A % line (duties, commission) is a share of the lines above it.</p>
      <div className="fn-xform-foot"><Submit className="ep-btn ep-btn--sm">{e ? 'Save the line' : 'Add the line'} <Arrow /></Submit></div>
    </form>
  );

  return (
    <div className="fn bb">
      <Back href="/b2b">B2B orders</Back>
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">B2B · {o.number} · created {fmtDate(o.created_at)}</p>
          <h1>{o.title}</h1>
          <p><span className="bb-flag" aria-hidden="true">{flag(client?.country ?? '')}</span> <Link href={`/b2b/clients?edit=${client?.id}`}><b>{client?.name}</b></Link> · {countryName(client?.country ?? '')}{o.client_ref ? ` · PO ${o.client_ref}` : ''} · in {cur}</p>
        </div>
        <div className="ep-actions">
          {issued.length > 0 && <Link className="ep-btn ep-btn--ghost" href={`/print/b2b/${issued[issued.length - 1].id}`}>Open {DOC_KIND[issued[issued.length - 1].kind].toLowerCase()} {issued[issued.length - 1].number}</Link>}
          <span className={`ep-st ep-st--${stageTone(o.stage, st.stages, o.cancelled)} bb-big-st`}>{o.cancelled ? 'Cancelled' : o.stage}</span>
        </div>
      </div>

      {/* Stages */}
      <section className="fn-t fn-t--plain bb-stages" aria-label="Stage">
        <div className="bb-steps">
          {st.stages.map((s, i) => (
            <form key={s} action={setStage}>
              <input type="hidden" name="id" value={o.id} /><input type="hidden" name="stage" value={s} />
              <button className={`bb-step${i < stageIdx ? ' is-done' : ''}${i === stageIdx && !o.cancelled ? ' is-on' : ''}`} aria-current={i === stageIdx ? 'step' : undefined} disabled={o.cancelled}>
                <i>{i < stageIdx ? '✓' : i + 1}</i><span>{s}</span>
              </button>
            </form>
          ))}
        </div>
        <div className="bb-stage-foot">
          {!st.stages.includes(o.stage) && !o.cancelled && <span className="fn-sub fn-dn">“{o.stage}” is no longer in your stages: pick the right one above.</span>}
          <span className="fn-sub fn-mu">Click a stage to move the order. Every move is kept in the story below.</span>
          <form action={setStage}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="cancel" value={o.cancelled ? '0' : '1'} /><Submit className="ep-btn ep-btn--sm ep-btn--ghost" confirm={o.cancelled ? undefined : `Cancel ${o.number}? You can reopen it later.`}>{o.cancelled ? 'Reopen the order' : 'Cancel the order'}</Submit></form>
        </div>
      </section>

      <div className="bb-grid">
        <div className="bb-main">
          {/* Lines */}
          <section className="fn-t fn-t--plain" id="lines">
            <div className="fn-t-top"><h2 className="fn-h2">What you sell</h2><span className="fn-sub fn-mu">printed on the {devisLabel.toLowerCase()} and the {finalLabel.toLowerCase()}, in {cur}</span></div>
            {lines.length ? (
              <div className="ep-tablewrap"><table className="fn-table bb-lines">
                <thead><tr><th>Description</th><th className="ep-right">Qty</th><th className="ep-right">Unit price</th><th className="ep-right">Amount</th><th className="ep-right"><span className="ep-sr">Actions</span></th></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.id} className={editing?.id === l.id ? 'is-editing' : ''}>
                      <td><b>{l.description}</b><small>{KIND_LABEL[l.kind as keyof typeof KIND_LABEL] ?? l.kind}{l.hs_code ? ` · HS ${l.hs_code}` : ''}</small></td>
                      <td className="ep-right">{l.qty !== null ? `${priceMa(l.qty).replace(/\.00$/, '')} ${l.unit ?? ''}` : l.unit ?? '—'}</td>
                      <td className="ep-right">{priceOf(l)}{l.pct === null && l.price_currency !== cur && <small>× {Number(l.rate)} → {cur}</small>}</td>
                      <td className="ep-right"><b>{money(t.amounts[i], cur)}</b></td>
                      <td className="ep-right">
                        <span className="fn-rowact">
                          <form action={moveLine}><input type="hidden" name="order" value={o.id} /><input type="hidden" name="line" value={l.id} /><input type="hidden" name="dir" value="up" /><button className="ep-btn ep-btn--sm ep-btn--ghost" disabled={i === 0} aria-label={`Move ${l.description} up`}>↑</button></form>
                          <Link className="ep-btn ep-btn--sm ep-btn--ghost" href={`/b2b/${o.id}?line=${l.id}#line-form`}>Edit</Link>
                          <form action={deleteLine}><input type="hidden" name="order" value={o.id} /><input type="hidden" name="line" value={l.id} /><Submit className="ep-btn ep-btn--sm ep-btn--ghost" confirm={`Remove “${l.description}”?`}>Remove</Submit></form>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3}>Total H.T.</td><td className="ep-right" data-figure="b2b-ht" data-value={t.ht}>{money(t.ht, cur)}</td><td /></tr>
                  {t.tva > 0 && <tr><td colSpan={3}>T.V.A. {Number(o.tva_rate)}%</td><td className="ep-right">{money(t.tva, cur)}</td><td /></tr>}
                  {t.discount > 0 && <tr><td colSpan={3}>Discount (remise)</td><td className="ep-right">−{money(t.discount, cur)}</td><td /></tr>}
                  <tr className="bb-ttc"><td colSpan={3}>Total T.T.C.</td><td className="ep-right" data-figure="b2b-ttc" data-value={t.ttc}>{money(t.ttc, cur)}</td><td /></tr>
                </tfoot>
              </table></div>
            ) : <p className="fn-sub fn-mu">Nothing yet. Add the goods first, then freight, customs, transitaire, delivery and your commission.</p>}
            {lineForm(editing)}
          </section>

          {/* Documents */}
          <section className="fn-t fn-t--plain" id="docs">
            <div className="fn-t-top"><h2 className="fn-h2">{devisLabel} &amp; {finalLabel.toLowerCase()}</h2><span className="fn-sub fn-mu">{morocco ? 'your Moroccan layout, in French, numbered 0001/MM/YYYY' : 'in English, for clients abroad'}</span></div>
            <form action={issueDoc} className="ep-form bb-issue">
              <input type="hidden" name="order" value={o.id} />
              <div className="ep-row4">
                <label>Make a
                  <select name="kind" defaultValue={issued.some((d) => d.kind === 'devis') ? 'final' : 'devis'}>
                    <option value="devis">{devisLabel} (quote)</option>
                    <option value="final">{finalLabel}</option>
                  </select>
                </label>
                {!morocco ? (
                  <label>Design
                    <select name="template" defaultValue={st.intl_template}><option value="a">A · Classic</option><option value="b">B · Modern</option></select>
                  </label>
                ) : <span />}
                <label>Date<input name="date" type="date" defaultValue={today} required /></label>
                <label>Due in (days)<input name="due_days" type="number" min="0" max="365" placeholder="optional" /></label>
              </div>
              <div className="bb-issue-foot">
                <span className="fn-sub fn-mu">The document is frozen with today’s lines and totals ({money(t.ttc, cur)}). Change the lines first if needed.</span>
                <Submit confirm={lines.length ? undefined : 'Add lines first.'}>Make it <Arrow /></Submit>
              </div>
            </form>
            {docs.length > 0 && (
              <ul className="bb-docs">
                {[...docs].reverse().map((d) => (
                  <li key={d.id} className={d.status === 'void' ? 'is-void' : ''}>
                    <Link href={`/print/b2b/${d.id}`}><b>{d.kind === 'devis' ? devisLabel : d.kind === 'facture' ? 'Facture' : 'Invoice'} {d.number}</b><small>{fmtDate(d.issued_on)} · {money(Number(d.total), d.currency)}{d.template !== 'ma' ? ` · design ${d.template.toUpperCase()}` : ''}{d.status === 'void' ? ' · cancelled' : ''}</small></Link>
                    {d.status === 'issued' && (
                      <form action={voidDoc}><input type="hidden" name="order" value={o.id} /><input type="hidden" name="doc" value={d.id} /><Submit className="ep-btn ep-btn--sm ep-btn--ghost" confirm={`Cancel ${d.number}? It stays in the list, marked cancelled, and its number is not reused.`}>Cancel</Submit></form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Money */}
          <section className="fn-t fn-t--plain" id="money">
            <div className="fn-t-top"><h2 className="fn-h2">Money</h2><span className="fn-sub fn-mu">only you, managers and finance see this</span></div>
            <div className="bb-money">
              <div><span className="fn-eb fn-eb--blue">Sale (before TVA)</span><b>{money(t.ht - t.discount, cur)}</b></div>
              <div><span className="fn-eb fn-eb--violet">Costs</span><b>{m.costs === null ? '—' : money(m.costs, rc)}</b>{m.costs === null && <small className="fn-dn">add the {m.noRate.join(', ')} rate in Finance settings</small>}</div>
              <div className="bb-money-profit"><span className="fn-eb fn-eb--orange">Profit</span><b className={m.profit !== null && m.profit < 0 ? 'fn-dn' : ''} data-figure="b2b-profit" data-value={m.profit ?? ''}>{m.profit === null ? '—' : money(m.profit, rc)}</b><small>{m.margin === null ? '' : `${m.margin}% margin`}</small></div>
              <div><span className="fn-eb fn-eb--ok">Paid</span><b>{money(m.paid, cur)}</b><small>{m.balance > 0.005 ? `${money(m.balance, cur)} still to pay` : 'nothing left to pay'}</small></div>
            </div>
            {(m.ttc > 0) && <div className="bb-paidbar" aria-hidden="true"><i style={{ width: `${Math.min(100, (m.paid / (m.billed || m.ttc)) * 100)}%` }} /></div>}

            <div className="bb-two">
              <div>
                <h3 className="fn-h2">What it cost you</h3>
                {costs.length ? (
                  <ul className="bb-mlist">
                    {costs.map((c) => (
                      <li key={c.id}><span><b>{c.payee}</b><small>{KIND_LABEL[c.category as keyof typeof KIND_LABEL]} · {fmtDate(c.paid_on)}{c.note ? ` · ${c.note}` : ''}</small></span><em>{money(Number(c.amount), c.currency)}</em>
                        <form action={deleteCost}><input type="hidden" name="order" value={o.id} /><input type="hidden" name="cost" value={c.id} /><Submit className="ep-icon-btn" confirm={`Remove the cost “${c.payee}”?`}><span aria-hidden="true">×</span><span className="ep-sr">Remove {c.payee}</span></Submit></form>
                      </li>
                    ))}
                  </ul>
                ) : <p className="fn-sub fn-mu">Factory, freight, customs, transitaire… what you paid for this order.</p>}
                <form action={addCost} className="ep-form bb-mform">
                  <input type="hidden" name="order" value={o.id} />
                  <div className="ep-row2">
                    <label>For<select name="category" defaultValue="goods">{B2B_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
                    <label>Paid to<input name="payee" required maxLength={120} placeholder="e.g. Foshan factory" /></label>
                  </div>
                  <div className="ep-row3">
                    <label>Amount<input name="amount" inputMode="decimal" required placeholder="0.00" /></label>
                    <label>Currency<select name="currency" defaultValue={fin.cost_currency}>{MONEY_CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select></label>
                    <label>Date<input name="date" type="date" defaultValue={today} required /></label>
                  </div>
                  <label>Note (optional)<input name="note" maxLength={300} /></label>
                  <Submit className="ep-btn ep-btn--sm">Add the cost</Submit>
                </form>
              </div>
              <div>
                <h3 className="fn-h2">What the client paid</h3>
                {pays.length ? (
                  <ul className="bb-mlist">
                    {pays.map((p) => (
                      <li key={p.id}><span><b>{METHOD[p.method]}</b><small>{fmtDate(p.paid_on)}{p.note ? ` · ${p.note}` : ''}</small></span><em className="fn-up">{money(Number(p.amount), p.currency)}</em>
                        <form action={deletePayment}><input type="hidden" name="order" value={o.id} /><input type="hidden" name="payment" value={p.id} /><Submit className="ep-icon-btn" confirm="Remove this payment?"><span aria-hidden="true">×</span><span className="ep-sr">Remove the payment of {p.paid_on}</span></Submit></form>
                      </li>
                    ))}
                  </ul>
                ) : <p className="fn-sub fn-mu">Deposits and the balance, as they arrive.</p>}
                <form action={addPayment} className="ep-form bb-mform">
                  <input type="hidden" name="order" value={o.id} />
                  <div className="ep-row3">
                    <label>Amount ({cur})<input name="amount" inputMode="decimal" required placeholder="0.00" /></label>
                    <label>How<select name="method" defaultValue="bank">{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                    <label>Date<input name="date" type="date" defaultValue={today} required /></label>
                  </div>
                  <label>Note (optional)<input name="note" maxLength={300} placeholder="e.g. deposit 30%" /></label>
                  <Submit className="ep-btn ep-btn--sm">Record the payment</Submit>
                </form>
              </div>
            </div>
          </section>
        </div>

        <aside className="bb-side">
          <section className="fn-t fn-t--plain">
            <h2 className="fn-h2">Order &amp; shipment</h2>
            <form action={saveOrder} className="ep-form">
              <input type="hidden" name="id" value={o.id} />
              <label>What is it?<input name="title" required maxLength={160} defaultValue={o.title} /></label>
              <div className="ep-row2">
                <label>Client pays in<select name="currency" defaultValue={cur}>{MONEY_CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select></label>
                <label>Client’s PO<input name="client_ref" maxLength={80} defaultValue={o.client_ref ?? ''} /></label>
              </div>
              <div className="ep-row2">
                <label>T.V.A. %<input name="tva_rate" inputMode="decimal" defaultValue={Number(o.tva_rate)} /></label>
                <label>Remise ({cur})<input name="discount" inputMode="decimal" defaultValue={Number(o.discount)} /></label>
              </div>
              <div className="ep-row2">
                <label>Incoterm<select name="incoterm" defaultValue={o.incoterm ?? ''}><option value="">—</option>{INCOTERMS.map((x) => <option key={x}>{x}</option>)}</select></label>
                <label>Transport<select name="transport" defaultValue={o.transport ?? ''}><option value="">—</option>{Object.entries(TRANSPORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              </div>
              <div className="ep-row2">
                <label>From<input name="origin" maxLength={120} defaultValue={o.origin ?? ''} /></label>
                <label>To<input name="destination" maxLength={120} defaultValue={o.destination ?? ''} /></label>
              </div>
              <div className="ep-row2">
                <label>Container / AWB / B-L<input name="container" maxLength={80} defaultValue={o.container ?? ''} /></label>
                <label>Carrier / line<input name="carrier" maxLength={80} defaultValue={o.carrier ?? ''} /></label>
              </div>
              <div className="ep-row2">
                <label>Departs (ETD)<input name="etd" type="date" defaultValue={o.etd ?? ''} /></label>
                <label>Arrives (ETA)<input name="eta" type="date" defaultValue={o.eta ?? ''} /></label>
              </div>
              <label>Tracking link or number<input name="tracking" maxLength={300} defaultValue={o.tracking ?? ''} /></label>
              <label>Notes (only for you)<textarea name="notes" rows={3} maxLength={1000} defaultValue={o.notes ?? ''} /></label>
              <Submit className="ep-btn ep-btn--sm">Save</Submit>
            </form>
            {o.tracking && /^https?:\/\//.test(o.tracking) && <p className="fn-sub"><a href={o.tracking} target="_blank" rel="noopener noreferrer">Open the tracking ↗</a></p>}
          </section>

          <section className="fn-t fn-t--plain" id="story">
            <h2 className="fn-h2">Story</h2>
            <form action={addNote} className="ep-form bb-note">
              <input type="hidden" name="id" value={o.id} />
              <input name="text" maxLength={300} placeholder="Add a note (e.g. samples approved)" aria-label="Note" required />
              <Submit className="ep-btn ep-btn--sm">Add</Submit>
            </form>
            <ol className="bb-story">
              {events.map((e) => <li key={e.id} className={e.stage ? 'is-stage' : ''}><i /><span>{e.text}<small>{fmtDate(e.at, true)}</small></span></li>)}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}
