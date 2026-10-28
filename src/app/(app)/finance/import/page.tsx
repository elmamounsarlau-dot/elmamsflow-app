import { financeSettings, MONEY_CURRENCIES } from '@/lib/fx';
import { BankImport } from '@/components/finance';
import { importBankLines } from '../actions';
import { FinanceNav, requireFinance } from '../ui';

export const metadata = { title: 'Import bank statement' };

export default async function Import() {
  await requireFinance();
  const s = await financeSettings();
  return (
    <div className="fn">
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">Finance</p>
          <h1>Import a bank statement</h1>
          <p>Export the statement from your bank as a CSV file. Tick the payments that are business expenses, check the category, import. A line imported twice is skipped.</p>
        </div>
      </div>
      <FinanceNav on="/finance/import" />
      <section className="fn-t fn-t--plain">
        <BankImport currency={s.report_currency} currencies={MONEY_CURRENCIES} action={importBankLines} />
      </section>
    </div>
  );
}
