import { b2bSettings } from '@/lib/b2b-data';
import { docNumber } from '@/lib/b2b';
import { MONEY_CURRENCIES } from '@/lib/fx';
import { Submit } from '@/components/client';
import { Arrow } from '@/components/ui';
import { saveB2BSettings } from '../actions';
import { B2BNav, requireB2B } from '../ui';

export const metadata = { title: 'B2B settings' };

export default async function B2BSettings() {
  await requireB2B();
  const st = await b2bSettings();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="fn bb">
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">B2B · settings</p>
          <h1>Stages, numbers &amp; bank</h1>
          <p>How your wholesale orders move, how the documents are numbered, and the bank details printed on them.</p>
        </div>
      </div>
      <B2BNav on="/b2b/settings" />
      <form action={saveB2BSettings} className="ep-form bb-settings">
        <section className="fn-t fn-t--plain">
          <h2 className="fn-h2">Stages</h2>
          <label>One stage per line, in order. The first is where new orders start; the last means “done”.
            <textarea name="stages" rows={10} defaultValue={st.stages.join('\n')} required />
          </label>
          <p className="fn-sub fn-mu">Renaming or removing a stage doesn’t change orders already at it: they keep it until you move them.</p>
        </section>
        <section className="fn-t fn-t--plain">
          <h2 className="fn-h2">Next numbers</h2>
          <p className="fn-sub fn-mu">Set these once to continue from your paper numbers (for example your last facture was 0113: put 114).</p>
          <div className="ep-row4">
            <label>Order<input name="next_order" type="number" min="1" defaultValue={st.next_order} required /><small>→ {docNumber('order', st.next_order, today)}</small></label>
            <label>Devis<input name="next_devis" type="number" min="1" defaultValue={st.next_devis} required /><small>→ {docNumber('devis', st.next_devis, today)}</small></label>
            <label>Facture (Morocco)<input name="next_facture" type="number" min="1" defaultValue={st.next_facture} required /><small>→ {docNumber('facture', st.next_facture, today)}</small></label>
            <label>Invoice (abroad)<input name="next_invoice" type="number" min="1" defaultValue={st.next_invoice} required /><small>→ {docNumber('invoice', st.next_invoice, today)}</small></label>
          </div>
          <label>Design for clients outside Morocco
            <select name="intl_template" defaultValue={st.intl_template}><option value="a">A · Classic</option><option value="b">B · Modern (payment schedule)</option></select>
            <small>You can still pick the other one each time you make an invoice.</small>
          </label>
        </section>
        <section className="fn-t fn-t--plain">
          <h2 className="fn-h2">Bank details on the documents</h2>
          <p className="fn-sub fn-mu">Printed on the invoice in the same currency as the order. Leave empty to print nothing.</p>
          <div className="ep-row2">
            {MONEY_CURRENCIES.map((c) => (
              <label key={c}>{c} account<textarea name={`bank_${c}`} rows={3} maxLength={400} defaultValue={st.bank[c] ?? ''} placeholder={'Bank name\nIBAN / RIB\nSWIFT'} /></label>
            ))}
            <label>Email on international invoices<input name="email" type="email" maxLength={160} defaultValue={st.email ?? ''} placeholder="elmamounsarlau@gmail.com" /></label>
          </div>
        </section>
        <div className="fn-xform-foot"><Submit>Save settings <Arrow /></Submit></div>
      </form>
    </div>
  );
}
