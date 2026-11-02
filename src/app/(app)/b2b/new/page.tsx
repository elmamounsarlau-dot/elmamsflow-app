import Link from 'next/link';
import { b2bClients, b2bSettings } from '@/lib/b2b-data';
import { INCOTERMS, TRANSPORT } from '@/lib/b2b';
import { countryList } from '@/lib/format';
import { MONEY_CURRENCIES } from '@/lib/fx';
import { Submit } from '@/components/client';
import { Arrow, Back } from '@/components/ui';
import { createOrder } from '../actions';
import { flag, requireB2B } from '../ui';

export const metadata = { title: 'New B2B order' };

export default async function NewB2B({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireB2B();
  const sp = await searchParams;
  const [clients, st] = await Promise.all([b2bClients(), b2bSettings()]);
  const countries = countryList('MA');
  const pre = clients.find((c) => c.id === sp.client)?.id ?? '';
  return (
    <div className="fn bb">
      <Back href="/b2b">B2B orders</Back>
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">B2B · new order · starts at “{st.stages[0]}”</p>
          <h1>New B2B order</h1>
          <p>Who it’s for and what it is. You add the goods, costs and payments on the next page.</p>
        </div>
      </div>
      <form action={createOrder} className="ep-form fn-t fn-t--plain bb-new">
        <fieldset className="bb-fs">
          <legend>Client</legend>
          {clients.length > 0 && (
            <label>Choose the client
              <select name="client" defaultValue={pre}>
                <option value="">— A new client (fill in below) —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{flag(c.country)} {c.name}</option>)}
              </select>
            </label>
          )}
          <details className="bb-newclient" open={clients.length === 0}>
            <summary>{clients.length ? 'Client not in the list? Add it here' : 'The client'}</summary>
            <div className="ep-row2">
              <label>Company name<input name="name" maxLength={160} placeholder="e.g. Atlas Distribution SARL" /></label>
              <label>Country
                <select name="country" defaultValue="MA">{countries.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
                <small>Morocco gets your Devis and Facture in French; other countries get the English invoice.</small>
              </label>
            </div>
            <div className="ep-row2">
              <label>I.C.E. (Morocco)<input name="ice" maxLength={40} inputMode="numeric" placeholder="15 digits" /></label>
              <label>VAT number (abroad)<input name="vat" maxLength={40} placeholder="e.g. FR 12 345678901" /></label>
            </div>
            <label>Address<textarea name="address" rows={2} maxLength={400} /></label>
            <div className="ep-row3">
              <label>Contact person<input name="contact" maxLength={120} /></label>
              <label>Email<input name="email" type="email" maxLength={160} /></label>
              <label>Phone<input name="phone" maxLength={60} /></label>
            </div>
          </details>
        </fieldset>

        <fieldset className="bb-fs">
          <legend>The order</legend>
          <div className="ep-row2">
            <label>What is it?<input name="title" required maxLength={160} placeholder="e.g. Porcelain tiles 60×60, 1 × 40HQ" /></label>
            <label>Client’s PO / reference (optional)<input name="client_ref" maxLength={80} /></label>
          </div>
          <div className="ep-row4">
            <label>Client pays in
              <select name="currency" defaultValue=""><option value="">The client’s currency</option>{MONEY_CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select>
            </label>
            <label>Incoterm<select name="incoterm" defaultValue=""><option value="">—</option>{INCOTERMS.map((x) => <option key={x}>{x}</option>)}</select></label>
            <label>Transport<select name="transport" defaultValue="sea"><option value="">—</option>{Object.entries(TRANSPORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <span />
          </div>
          <div className="ep-row2">
            <label>From<input name="origin" maxLength={120} placeholder="e.g. Foshan / Shekou" /></label>
            <label>To<input name="destination" maxLength={120} placeholder="e.g. Casablanca → Meknès" /></label>
          </div>
          <label>Notes (only for you)<textarea name="notes" rows={2} maxLength={1000} /></label>
        </fieldset>
        <div className="fn-xform-foot"><Link className="ep-btn ep-btn--ghost" href="/b2b">Cancel</Link><Submit>Create the order <Arrow /></Submit></div>
      </form>
    </div>
  );
}
