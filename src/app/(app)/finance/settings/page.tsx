import { financeSettings, MONEY_CURRENCIES } from '@/lib/fx';
import { Submit } from '@/components/client';
import { saveFinanceSettings } from '../actions';
import { FinanceNav, requireFinance } from '../ui';

export const metadata = { title: 'Finance settings' };

export default async function FinanceSettings() {
  await requireFinance();
  const s = await financeSettings();
  return (
    <div className="fn">
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">Finance</p>
          <h1>Finance settings</h1>
          <p>One currency for every total, the exchange rates you use, and how duties are billed.</p>
        </div>
      </div>
      <FinanceNav on="/finance/settings" />
      <form action={saveFinanceSettings} className="ep-form fn-settings">
        <section className="fn-t fn-t--plain">
          <h2 className="fn-h2">Currencies</h2>
          <div className="ep-row2">
            <label>Show every total in
              <select name="report_currency" defaultValue={s.report_currency}>{MONEY_CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
              <small>Invoices stay in each client’s own currency; Finance converts them with the rates below.</small>
            </label>
            <label>The team pays carriers and customs in
              <select name="cost_currency" defaultValue={s.cost_currency}>{MONEY_CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select>
              <small>The currency already chosen when the shipper types a label cost or duties.</small>
            </label>
          </div>
        </section>
        <section className="fn-t fn-t--plain">
          <h2 className="fn-h2">Exchange rates</h2>
          <p className="fn-sub fn-mu">How much 1 unit of each currency is worth in {s.report_currency}. Update them when you like: totals use the rate in force when you look. Leave a currency empty if you never use it.</p>
          <div className="fn-fx">
            {MONEY_CURRENCIES.filter((c) => c !== s.report_currency).map((c) => (
              <label key={c}>1 {c} =
                <span className="fn-fx-in"><input name={`fx_${c}`} type="number" step="0.000001" min="0" inputMode="decimal" defaultValue={s.fx[c] ?? ''} placeholder="not set" /><em>{s.report_currency}</em></span>
              </label>
            ))}
          </div>
          <p className="fn-sub fn-mu">Changing the main currency converts these rates for you (it needs the rate of the new main currency).</p>
        </section>
        <section className="fn-t fn-t--plain">
          <h2 className="fn-h2">Duties for DDP orders</h2>
          <label className="ep-check"><input type="checkbox" name="bill_duties" defaultChecked={s.bill_duties} /> Put the duties we paid on the client’s monthly invoice, at cost</label>
          <p className="fn-sub fn-mu">The line reads “Duties &amp; taxes paid for you”, converted to the client’s currency. Drafts already created keep their lines until you recalculate them.</p>
        </section>
        <div className="fn-xform-foot"><Submit>Save finance settings</Submit></div>
      </form>
    </div>
  );
}
