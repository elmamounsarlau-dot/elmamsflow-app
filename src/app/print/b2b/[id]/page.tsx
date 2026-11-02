/* eslint-disable @next/next/no-img-element -- printed pages: plain images print reliably */
import { notFound, redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { countryName } from '@/lib/format';
import { amountEn, amountFr, curMa, KIND_FR, numMa, priceMa, TRANSPORT } from '@/lib/b2b';
import type { DocData } from '@/lib/b2b-data';
import { Flash, PrintButton } from '@/components/client';

export const metadata = { title: 'B2B document' };

const frDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const enDate = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`)) : '');
const intl = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: c === 'MAD' ? 'code' : 'symbol' }).format(n);

type Doc = { id: string; order_id: string; kind: 'devis' | 'facture' | 'invoice'; template: 'ma' | 'a' | 'b'; number: string; issued_on: string; due_on: string | null; currency: string; total: number; status: string; data: DocData };

/** A devis, facture or international invoice on an A4 page: the browser prints it or saves it as a PDF. */
export default async function PrintB2B({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  if (!ctx.staffRole || !ctx.backOffice || !ctx.can('billing.manage')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data } = await supabaseAdmin().from('b2b_docs').select('id, order_id, kind, template, number, issued_on, due_on, currency, total, status, data').eq('id', id).maybeSingle();
  if (!data) notFound();
  const d = data as Doc;
  const page = d.template === 'ma' ? <Morocco d={d} /> : d.template === 'b' ? <IntlB d={d} /> : <IntlA d={d} />;
  return (
    <main className="pi pb">
      <div className="pi-bar ep-noprint"><a href={`/b2b/${d.order_id}#docs`}>← Back to the order</a><PrintButton /></div>
      <div className="ep-noprint pb-flash"><Flash /></div>
      <article className={`pb-page pb-page--${d.template}`}>
        {d.status === 'void' && <div className="pb-void">{d.template === 'ma' ? 'ANNULÉ' : 'CANCELLED'}</div>}
        {page}
      </article>
    </main>
  );
}

// ---------------------------------------------------------------------
// Morocco: the owner's own Devis / Facture layout, in French, amounts in words
// ---------------------------------------------------------------------
function Morocco({ d }: { d: Doc }) {
  const x = d.data, c = d.currency;
  const devis = d.kind === 'devis';
  return (
    <div className="pm">
      <div className="pm-top">
        <img src="/brand/elmamoun-letterhead.png" alt="EL MAMOUN SHIPPING & TRADING Sarl-AU — Négoce, Distribution & Import-Export — Meknès (Maroc) — I.C.E. 00347.58620.00002" className="pm-letterhead" />
        <div className="pm-boxes">
          <div className="pm-box pm-num">{devis ? <><span className="pm-devis">D E V I S</span> <i>N° :</i></> : <span className="pm-fac">F<small>ACTURE</small> N° :</span>} <b>{d.number}</b></div>
          <div className="pm-box pm-date"><span>Date :</span> {frDate(d.issued_on)}</div>
        </div>
      </div>
      <div className="pm-client"><b>Client:</b>&nbsp; {x.client.name}{x.client.ice ? <><br /><b>I.C.E.:</b>&nbsp; {x.client.ice}</> : null}</div>
      <table className="pm-t">
        <thead><tr><th className="pm-c1">DESIGNATION</th><th className="pm-c2">QUANTITE</th><th className="pm-c3">P.U. ht</th><th className="pm-c4">P. TOTAL<br /><u>ht</u></th></tr></thead>
        <tbody>
          {x.lines.map((l, i) => (
            <tr key={i} className={i === 0 ? 'pm-first' : i === x.lines.length - 1 ? 'pm-last' : ''}>
              <td><span className="pm-lead"><span>*-&nbsp;</span><b>{l.description || KIND_FR[l.kind as keyof typeof KIND_FR]}</b></span></td>
              <td className="pm-mid"><span className="pm-lead pm-lead--c">{l.qty !== null ? <><span>…&nbsp;</span><b>{numMa(l.qty, l.qty % 1 ? 2 : 0)}{l.unit ? ` ${l.unit}` : ''}</b></> : '…'}</span></td>
              <td className="pm-mid"><span className="pm-lead pm-lead--c">{l.pct !== null ? <><span>…&nbsp;</span><b>{numMa(l.pct, l.pct % 1 ? 2 : 0)} %</b></> : l.qty !== null ? <><span>…&nbsp;</span><b>{priceMa(Number(l.unit_price))} {curMa(l.price_currency)}</b></> : '…'}</span></td>
              <td className="pm-r"><b>{numMa(l.amount)} {curMa(c)}</b></td>
            </tr>
          ))}
          <tr className="pm-sum">
            <td><b className="pm-arrete">Arrêté {devis ? 'le présent DEVIS' : 'la présente FACTURE'} à la somme de :</b> <span className="pm-words">… {amountFr(x.ttc, c)}</span><span className="pm-dots" /></td>
            <td />
            <td className="pm-labels">Total H.T.<br />Mt. T.V.A.<br />Remise.<br />Mt. T.T.C.</td>
            <td className="pm-r pm-tot">{numMa(x.ht)} {curMa(c)}<br />{numMa(x.tva)} {curMa(c)}<br />{numMa(x.discount)} {curMa(c)}<br />{numMa(x.ttc)} {curMa(c)}</td>
          </tr>
        </tbody>
      </table>
      <div className={`pm-total${devis ? ' pm-total--devis' : ''}`}>
        <div className="pm-box">{devis ? <><div className="pm-total-l">TOTAL T.T.C. &nbsp;DU PRESENT <u>DEVIS</u> :</div><div className="pm-total-v">{numMa(x.ttc)} {curMa(c)}</div></> : <><span className="pm-total-l">TOTAL T.T.C. &nbsp;:</span> <span className="pm-total-v">{numMa(x.ttc)} {curMa(c)}</span></>}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Abroad, design A (classic)
// ---------------------------------------------------------------------
function Parties({ x, dark = false }: { x: DocData; dark?: boolean }) {
  const o = x.order;
  const route = [o.origin, o.destination].filter(Boolean).join(' → ');
  return (
    <div className={`pa-parties${dark ? ' pa-parties--b' : ''}`}>
      <div><div className="pa-sec">Bill to</div><b>{x.client.name}</b>{x.client.address && <span className="pa-pre">{x.client.address}</span>}<span>{countryName(x.client.country)}</span>{x.client.vat_number && <span>VAT {x.client.vat_number}</span>}</div>
      <div><div className="pa-sec">Order</div><b>{o.number}{o.client_ref ? ` · PO ${o.client_ref}` : ''}</b><span>{o.title}</span>{o.incoterm && <span>Incoterm <b>{o.incoterm}</b></span>}</div>
      <div><div className="pa-sec">Shipment</div>{o.transport ? <b>{TRANSPORT[o.transport]}{route ? ` · ${route}` : ''}</b> : route ? <b>{route}</b> : <span>—</span>}{o.container && <span>{o.transport === 'air' ? 'AWB' : 'Container / B-L'} {o.container}</span>}{o.carrier && <span>{o.carrier}</span>}{o.eta && <span>ETA {enDate(o.eta)}</span>}</div>
    </div>
  );
}

function Items({ x, c }: { x: DocData; c: string }) {
  return (
    <table className="pa-items">
      <thead><tr><th>Description</th><th>HS code</th><th className="r">Qty</th><th className="r">Unit price</th><th className="r">Amount</th></tr></thead>
      <tbody>
        {x.lines.map((l, i) => (
          <tr key={i}>
            <td><b>{l.description}</b></td>
            <td>{l.hs_code ?? '—'}</td>
            <td className="r">{l.qty !== null ? `${Number(l.qty).toLocaleString('en')}${l.unit ? ` ${l.unit}` : ''}` : l.pct !== null ? `${l.pct}%` : '1'}</td>
            <td className="r">{l.pct !== null ? '—' : l.price_currency && l.price_currency !== c ? `${Number(l.unit_price).toLocaleString('en', { maximumFractionDigits: 4 })} ${l.price_currency}` : intl(Number(l.unit_price), c)}</td>
            <td className="r">{intl(l.amount, c)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Bank({ x, number }: { x: DocData; number: string }) {
  return (
    <div className="pa-bank">
      <div className="pa-sec">Payment details</div>
      {x.bank ? <span className="pa-pre">{x.bank}</span> : <span className="pa-mu">Bank details: add them in B2B settings.</span>}
      <span>Account name: EL MAMOUN SHIPPING &amp; TRADING SARL-AU · Reference: {number}</span>
    </div>
  );
}

function IntlA({ d }: { d: Doc }) {
  const x = d.data, c = d.currency;
  const quote = d.kind === 'devis';
  return (
    <div className="pa">
      <div className="pa-head">
        <div>
          <img src="/brand/elmamoun-logo.png" alt="EL MAMOUN Shipping & Trading" className="pa-logo" />
          <p className="pa-from">EL MAMOUN SHIPPING &amp; TRADING SARL-AU<br />Trading, Distribution &amp; Import-Export<br />Magasin N° 117 Bis, Riad Ouislan 02, Lot Farah, Ouislane, Meknes, Morocco<br />R.C. 61.465 · I.F. 6592.2130 · I.C.E. 00347.58620.00002{x.email ? <><br />{x.email}</> : null}</p>
        </div>
        <div className="pa-meta">
          <h1>{quote ? 'QUOTATION' : 'INVOICE'}</h1>
          <p>No. <b>{d.number}</b><br />Date: {enDate(d.issued_on)}{d.due_on ? <><br />Due: {enDate(d.due_on)}</> : null}{quote ? <><br />Valid 30 days</> : null}</p>
        </div>
      </div>
      <div className="pa-rule" />
      <Parties x={x} />
      <Items x={x} c={c} />
      <div className="pa-foot">
        <div className="pa-words">Amount in words: <b>{amountEn(x.ttc, c)}</b>{x.tva === 0 && <><br /><br />Export of goods, not subject to Moroccan VAT.</>}</div>
        <div className="pa-totals">
          <div><span>Subtotal</span><b>{intl(x.ht, c)}</b></div>
          {x.discount > 0 && <div><span>Discount</span><b>−{intl(x.discount, c)}</b></div>}
          <div><span>VAT{x.tva_rate ? ` ${x.tva_rate}%` : ''}</span><b>{x.tva ? intl(x.tva, c) : '0%'}</b></div>
          <div className="pa-total"><span>{quote ? 'Total' : 'Total due'}</span><b>{intl(x.ttc, c)}</b></div>
          {!quote && x.payments.map((p, i) => <div key={i} className="pa-paid"><span>Paid {enDate(p.paid_on)}</span><b>−{intl(p.amount, c)}</b></div>)}
          {!quote && x.paid > 0 && <div className="pa-bal"><span>Balance</span><b>{intl(x.balance, c)}</b></div>}
        </div>
      </div>
      {!quote && <Bank x={x} number={d.number} />}
      <div className="pa-end"><span>Thank you for your business.</span><span>{d.number}</span></div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Abroad, design B (modern, payment schedule)
// ---------------------------------------------------------------------
function IntlB({ d }: { d: Doc }) {
  const x = d.data, c = d.currency;
  const quote = d.kind === 'devis';
  const paidPct = x.ttc > 0 ? Math.min(100, Math.round((x.paid / x.ttc) * 100)) : 0;
  const label = quote ? 'QUOTATION' : x.paid > 0 && x.balance > 0.005 ? `BALANCE INVOICE · ${100 - paidPct}%` : 'INVOICE';
  return (
    <div className="pbm">
      <div className="pbm-head">
        <div className="pbm-row">
          <div><img src="/brand/elmamoun-logo.png" alt="EL MAMOUN Shipping & Trading" className="pa-logo" /><p className="pa-from">EL MAMOUN SHIPPING &amp; TRADING SARL-AU<br />Meknes, Morocco · ICE 00347.58620.00002{x.email ? ` · ${x.email}` : ''}</p></div>
          <div className="pbm-meta"><span className="pbm-kicker">{label}</span><h1>{d.number}</h1><span>Issued {enDate(d.issued_on)}{d.due_on ? ` · due ${enDate(d.due_on)}` : ''}</span></div>
        </div>
        <Parties x={x} dark />
      </div>
      <div className="pbm-body">
        <Items x={x} c={c} />
        <div className="pbm-grid">
          {!quote ? (
            <div className="pbm-sched">
              <div className="pa-sec">Payment schedule</div>
              <div className="pbm-bar"><i style={{ width: `${paidPct}%` }} /><b style={{ width: `${100 - paidPct}%` }} /></div>
              {x.payments.map((p, i) => <div key={i} className="pbm-line"><span>Received {enDate(p.paid_on)}</span><b className="pbm-ok">{intl(p.amount, c)}</b></div>)}
              <div className="pbm-line pbm-line--due"><span>{x.paid > 0 ? 'Balance · this invoice' : 'Due · this invoice'}</span><b>{intl(x.balance, c)}</b></div>
            </div>
          ) : <div className="pbm-sched"><div className="pa-sec">Validity</div><div className="pbm-line"><span>This quotation is valid for 30 days.</span></div></div>}
          <div>
            <div className="pbm-line"><span>Order total</span><b>{intl(x.ht, c)}</b></div>
            {x.discount > 0 && <div className="pbm-line"><span>Discount</span><b>−{intl(x.discount, c)}</b></div>}
            <div className="pbm-line"><span>VAT{x.tva ? ` ${x.tva_rate}%` : ' (export)'}</span><b>{x.tva ? intl(x.tva, c) : '0%'}</b></div>
            {!quote && x.paid > 0 && <div className="pbm-line"><span>Less received</span><b>−{intl(x.paid, c)}</b></div>}
            <div className="pbm-due"><span>{quote ? 'TOTAL' : 'AMOUNT DUE'}</span><b>{intl(quote ? x.ttc : x.balance, c)}</b></div>
          </div>
        </div>
        <p className="pbm-words">In words: <b>{amountEn(quote ? x.ttc : x.balance, c)}</b></p>
        {!quote && (
          <div className="pbm-two">
            <Bank x={x} number={d.number} />
            <div><div className="pa-sec">Terms</div><span>Balance due before release of the goods at destination. Goods remain our property until paid in full.</span></div>
          </div>
        )}
      </div>
      <div className="pa-end pbm-end"><span>EL MAMOUN Shipping &amp; Trading · One stop for all your cargo</span><span>{d.number}</span></div>
    </div>
  );
}
