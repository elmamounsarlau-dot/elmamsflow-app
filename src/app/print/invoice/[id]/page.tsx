import { notFound, redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { countryName, fmtDate } from '@/lib/format';
import { CATEGORY, isOverdue, money } from '@/lib/billing';
import { PrintNow } from '@/components/client';

export const metadata = { title: 'Invoice' };

/** A clean A4 page for an invoice: the browser saves it as a PDF. */
export default async function PrintInvoice({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const { id } = await params;
  const sb = await supabaseServer();
  let q = sb.from('invoices').select('*, organizations(id, name, code, country, phone, legal_name, billing_address, vat_number, invoice_email, logo_path)').eq('id', id);
  if (ctx.org) q = q.eq('org_id', ctx.org.id).neq('status', 'draft');
  const { data: inv } = await q.maybeSingle();
  if (!inv || !ctx.can('invoices.view')) notFound();
  const [{ data: lines }, { data: s }] = await Promise.all([
    sb.from('invoice_lines').select('*').eq('invoice_id', id).order('position'),
    sb.from('billing_settings').select('*').eq('id', 1).maybeSingle(),
  ]);
  const cur = inv.currency as string;
  const org = inv.organizations as unknown as { id: string; name: string; code: string; country: string | null; phone: string | null; legal_name: string | null; billing_address: string | null; vat_number: string | null; invoice_email: string | null; logo_path: string | null } | null;
  const bank = s?.[`bank_${cur.toLowerCase()}`] as string | null | undefined;
  const status = inv.status === 'paid' ? 'PAID' : inv.status === 'draft' ? 'DRAFT' : inv.status === 'void' ? 'VOID' : isOverdue(inv) ? 'OVERDUE' : 'DUE';
  return (
    <main className="pi">
      <div className="pi-bar ep-noprint"><a href={`/invoices/${inv.id}`}>← Back to the invoice</a><PrintNow /></div>
      <article className="pi-page">
        <header className="pi-head">
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element -- printed page: a plain image prints reliably */}
            <img src="/brand/logo.png" alt="Elmamsflow" className="pi-logo" />
            <p className="pi-from"><b>{s?.company || 'Elmamsflow'}</b>{s?.address ? <><br />{s.address}</> : null}{s?.tax_id ? <><br />Tax ID {s.tax_id}</> : null}{s?.email ? <><br />{s.email}</> : null}</p>
          </div>
          <div className="pi-meta">
            <h1>Invoice</h1>
            <p className="pi-num">{inv.number}</p>
            <span className={`pi-stamp pi-stamp--${status.toLowerCase()}`}>{status}</span>
          </div>
        </header>

        <section className="pi-parties">
          <div className="pi-to">
            {/* eslint-disable-next-line @next/next/no-img-element -- printed page: a plain image prints reliably */}
            {org?.logo_path && <img src={`/files/logo/${org.id}`} alt="" className="pi-to-logo" />}
            <small>Billed to</small><b>{org?.legal_name || org?.name}</b>
            {org?.legal_name && org.legal_name !== org.name && <span>{org.name}</span>}
            {org?.billing_address && <span style={{ whiteSpace: 'pre-line' }}>{org.billing_address}</span>}
            {org?.vat_number && <span>VAT {org.vat_number}</span>}
            {org?.invoice_email && <span>{org.invoice_email}</span>}
            <span>Client {org?.code}{org?.country ? ` · ${countryName(org.country)}` : ''}</span>
          </div>
          <div><small>Period</small><b>{fmtDate(inv.period_start)} – {fmtDate(inv.period_end)}</b></div>
          <div><small>Issued</small><b>{inv.issued_at ? fmtDate(inv.issued_at) : '—'}</b></div>
          <div><small>{inv.status === 'paid' ? 'Paid' : 'Due'}</small><b>{inv.status === 'paid' ? fmtDate(inv.paid_at) : fmtDate(inv.due_date)}</b></div>
        </section>

        <table className="pi-table">
          <thead><tr><th>Service</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
          <tbody>
            {(lines ?? []).map((l) => (
              <tr key={l.id}><td>{CATEGORY[l.category] ?? l.category}</td><td>{l.description}</td><td>{Number(l.qty).toLocaleString('en', { maximumFractionDigits: 3 })}</td><td>{money(l.unit_price, cur)}</td><td>{money(l.amount, cur)}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="pi-total"><span>Total {cur}</span><b>{money(inv.total, cur)}</b></div>

        {inv.status !== 'paid' && (
          <section className="pi-pay">
            <small>How to pay</small>
            <p>Bank transfer with reference <b>{inv.number}</b>{bank ? ':' : '.'}</p>
            {bank && <pre>{bank}</pre>}
            <p>Or pay by card from your Elmamsflow dashboard → Invoices.</p>
          </section>
        )}
        {inv.notes && <p className="pi-note">{inv.notes}</p>}
        <footer className="pi-foot">{s?.footer || 'Thank you for shipping with Elmamsflow.'}</footer>
      </article>
    </main>
  );
}
