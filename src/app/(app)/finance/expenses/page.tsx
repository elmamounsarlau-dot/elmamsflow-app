import Link from 'next/link';
import { addMonths, CAT_LABEL, CAT_SHORT, currentYm, EXPENSE_CATS, monthFinance, monthLabel, REV_GROUPS, ymOk, type ExpenseCat } from '@/lib/finance';
import { financeSettings, MONEY_CURRENCIES } from '@/lib/fx';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getClients } from '@/lib/data';
import { dayKey } from '@/lib/orders-overview';
import { Submit } from '@/components/client';
import { FilesPick } from '@/components/media';
import { Arrow } from '@/components/ui';
import { addExpense, deleteExpense, saveRecurring, updateExpense } from '../actions';
import { CAT_TONE, FinanceNav, fm, fm2, MonthPick, requireFinance, Warnings } from '../ui';

export const metadata = { title: 'Expenses & profit' };

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const change = (a: number, b: number) => (b ? Math.round(((a - b) / Math.abs(b)) * 100) : null);
const Delta = ({ a, b, good = 'up' }: { a: number; b: number; good?: 'up' | 'down' }) => {
  const d = change(a, b);
  if (d === null) return null;
  const ok = good === 'up' ? d >= 0 : d <= 0;
  return <span className={`fn-delta ${ok ? 'fn-up' : 'fn-dn'}`}>{d >= 0 ? '+' : ''}{d}%</span>;
};

export default async function Expenses({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireFinance();
  const sp = await searchParams;
  const cur = await currentYm();
  const ym = ymOk(sp.m) && sp.m! <= cur ? sp.m! : cur;
  const prevYm = addMonths(ym, -1);
  const [f, p, fin, clients, { data: recs }] = await Promise.all([
    monthFinance(ym), monthFinance(prevYm), financeSettings(), getClients(),
    supabaseAdmin().from('recurring_expenses').select('id, category, payee, amount, currency, day_of_month, org_id, active, start_month').order('active', { ascending: false }).order('day_of_month'),
  ]);
  const c = f.currency;
  const names = Object.fromEntries(clients.map((x) => [x.id, x.name])) as Record<string, string>;
  const cat = (EXPENSE_CATS as readonly string[]).includes(sp.cat ?? '') ? (sp.cat as ExpenseCat) : null;
  const { exp, rev } = f;
  const editing = sp.edit ? exp.rows.find((e) => e.id === sp.edit) ?? null : null;
  const today = dayKey(new Date());
  const defDate = ym === today.slice(0, 7) ? today : `${ym}-01`;

  // One list: what was typed in, and what orders cost (grouped per day), newest first.
  type Item = { key: string; day: string; payee: string; note: string; category: ExpenseCat; who: string; amount: string; report: number | null; receipt: string | null; id: string | null; tag: string | null; foreign: boolean };
  const items: Item[] = [
    ...exp.rows.map((e): Item => ({
      key: e.id, day: e.spent_on, payee: e.payee, note: [e.note, e.source === 'recurring' ? 'repeats monthly' : e.source === 'import' ? 'from the bank statement' : ''].filter(Boolean).join(' · '),
      category: e.category, who: e.org_id ? names[e.org_id] ?? 'Client' : 'all', amount: fm2(e.amount, e.currency),
      report: e.report, receipt: e.receipt_path ? `/files/receipt/${e.id}` : null, id: e.id, tag: null, foreign: e.currency !== c,
    })),
    ...exp.auto.map((a, i): Item => ({
      key: `auto-${i}`, day: a.day, payee: a.payee, note: `${a.category === 'carrier' ? 'shipping labels' : 'DDP duties'} · ${a.orders} parcel${a.orders === 1 ? '' : 's'}`,
      category: a.category, who: a.org_id ? names[a.org_id] ?? 'Client' : 'by order', amount: fm2(a.report, c), report: a.report, receipt: null, id: null, tag: 'automatic', foreign: false,
    })),
  ].sort((a, b) => b.day.localeCompare(a.day));
  const shown = cat ? items.filter((i) => i.category === cat) : items;
  const shownTotal = shown.reduce((a, i) => a + (i.report ?? 0), 0);
  const count = (k: ExpenseCat | null) => (k ? items.filter((i) => i.category === k).length : items.length);
  const chip = (k: ExpenseCat | null) => `/finance/expenses?m=${ym}${k ? `&cat=${k}` : ''}`;

  const pnlOut: [string, number, number][] = [
    [CAT_LABEL.carrier, exp.cats.carrier, p.exp.cats.carrier],
    ['Duties paid (DDP)', exp.cats.duties, p.exp.cats.duties],
    ['Rent · salaries', exp.cats.rent + exp.cats.salaries, p.exp.cats.rent + p.exp.cats.salaries],
    ['Packaging · software · other', exp.cats.packaging + exp.cats.software + exp.cats.other, p.exp.cats.packaging + p.exp.cats.software + p.exp.cats.other],
  ];

  const form = (e: typeof editing) => (
    <form action={e ? updateExpense : addExpense} className="ep-form fn-xform" id="add">
      <input type="hidden" name="ym" value={ym} />
      {e && <input type="hidden" name="id" value={e.id} />}
      <div className="fn-xform-head"><h2>{e ? 'Edit the expense' : 'Add an expense'}</h2>{e && <Link className="ep-link" href={`/finance/expenses?m=${ym}`}>Cancel</Link>}</div>
      <div className="ep-row2 fn-amount">
        <label>Amount<input name="amount" type="number" step="0.01" min="0.01" inputMode="decimal" required defaultValue={e?.amount ?? ''} placeholder="0.00" /></label>
        <label>Currency
          <select name="currency" defaultValue={e?.currency ?? c}>{MONEY_CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select>
        </label>
      </div>
      <fieldset className="fn-cats">
        <legend>What is it?</legend>
        {EXPENSE_CATS.map((k) => (
          <label key={k} className="fn-cat"><input type="radio" name="category" value={k} defaultChecked={(e?.category ?? 'carrier') === k} required /><span><i className={`fn-d fn-c-bg--${CAT_TONE[k]}`} />{CAT_SHORT[k]}</span></label>
        ))}
      </fieldset>
      <div className="ep-row2">
        <label>Date paid<input name="date" type="date" required defaultValue={e?.spent_on ?? defDate} max={today} /></label>
        <label>Paid to<input name="payee" required maxLength={120} defaultValue={e?.payee ?? ''} placeholder="e.g. Ningbo warehouse" /></label>
      </div>
      <label>For a client (optional)
        <select name="org" defaultValue={e?.org_id ?? ''}>
          <option value="">All clients (shared cost)</option>
          {clients.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <small>A cost for one client counts in that client’s profit. Shared costs are split by orders shipped.</small>
      </label>
      <label>Note (optional)<input name="note" maxLength={300} defaultValue={e?.note ?? ''} placeholder="Invoice number, what it covers…" /></label>
      <div className="fn-receipt">
        <span className="fn-flabel">Receipt or invoice (optional)</span>
        {e?.receipt_path && <p className="fn-sub"><a href={`/files/receipt/${e.id}`} target="_blank" rel="noopener">Open the current receipt</a> · <label className="ep-check fn-inline-check"><input type="checkbox" name="remove_receipt" /> remove it</label></p>}
        <FilesPick name="receipt" max={1} what="Drop the receipt here, or" hint="Photo or PDF · kept with the expense" />
      </div>
      {!e && <label className="ep-check"><input type="checkbox" name="repeat" /> Repeat every month on the same day</label>}
      <div className="fn-xform-foot"><Submit>{e ? 'Save changes' : 'Save expense'} <Arrow /></Submit></div>
    </form>
  );

  return (
    <div className="fn">
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">Finance · in {c}</p>
          <h1>Expenses &amp; profit</h1>
          <p>What the business spends. Label costs and duties typed when shipping are added by themselves, on the right client.</p>
        </div>
        <div className="ep-actions">
          <MonthPick base="/finance/expenses" label={monthLabel(ym)} prev={prevYm} next={ym < cur ? addMonths(ym, 1) : null} />
          <Link className="ep-btn ep-btn--ghost" href="/finance/import">Import bank statement (CSV)</Link>
          <Link className="ep-btn" href={`/finance/export?m=${ym}`} prefetch={false}>Export for my accountant</Link>
        </div>
      </div>
      <FinanceNav on="/finance/expenses" m={ym} />
      <Warnings items={[f.noRate.length > 0 && <>Amounts in <b>{f.noRate.join(', ')}</b> are left out of the totals until you add the exchange rate in <Link href="/finance/settings">Finance settings</Link>.</>]} />

      <div className="fn-xgrid">
        <section className="fn-t fn-t--plain">{form(editing)}</section>

        <section className="fn-t fn-t--plain fn-xlist">
          <div className="fn-t-top">
            <h2 className="fn-h2">{monthLabel(ym)} · {count(null)} expense{count(null) === 1 ? '' : 's'} · <span data-figure="expenses" data-value={Math.round(exp.total)}>{fm(exp.total, c)}</span></h2>
          </div>
          <div className="fn-chips" role="group" aria-label="Category">
            <Link className={`fn-chip${!cat ? ' is-on' : ''}`} href={chip(null)}>All</Link>
            {EXPENSE_CATS.filter((k) => count(k) > 0 || k === cat).map((k) => <Link key={k} className={`fn-chip${cat === k ? ' is-on' : ''}`} href={chip(k)}>{CAT_SHORT[k]} <small>{count(k)}</small></Link>)}
          </div>
          {shown.length ? (
            <div className="ep-tablewrap"><table className="fn-table fn-xtable">
              <thead><tr><th>Date</th><th>Paid to</th><th>Category</th><th>Client</th><th className="ep-right">Amount</th><th>Receipt</th><th className="ep-right"><span className="ep-sr">Actions</span></th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.key} className={editing?.id === i.id ? 'is-editing' : ''}>
                    <td>{day(i.day)}</td>
                    <td><b>{i.payee}</b>{i.note && <small>{i.note}</small>}</td>
                    <td><span className={`fn-cat-pill fn-c-soft--${CAT_TONE[i.category]}`}>{CAT_SHORT[i.category]}</span>{i.tag && <small>{i.tag}</small>}</td>
                    <td>{i.who}</td>
                    <td className="ep-right"><b>{i.amount}</b>{i.report !== null && i.foreign && <small>≈ {fm2(i.report, c)}</small>}{i.report === null && <small className="fn-dn">no rate</small>}</td>
                    <td>{i.receipt ? <a href={i.receipt} target="_blank" rel="noopener">Open</a> : <span className="ep-muted">—</span>}</td>
                    <td className="ep-right">
                      {i.id && (
                        <span className="fn-rowact">
                          <Link className="ep-btn ep-btn--sm ep-btn--ghost" href={`/finance/expenses?m=${ym}&edit=${i.id}#add`}>Edit</Link>
                          <form action={deleteExpense}><input type="hidden" name="id" value={i.id} /><input type="hidden" name="ym" value={ym} /><Submit className="ep-btn ep-btn--sm ep-btn--ghost" confirm={`Remove “${i.payee}” (${i.amount})?`}>Remove</Submit></form>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {cat && <tfoot><tr><td colSpan={4}>{CAT_SHORT[cat]} total</td><td className="ep-right"><b>{fm2(shownTotal, c)}</b></td><td colSpan={2} /></tr></tfoot>}
            </table></div>
          ) : <p className="fn-sub fn-mu fn-empty">Nothing {cat ? `in ${CAT_SHORT[cat]} ` : ''}for {monthLabel(ym)} yet.</p>}
          <p className="fn-callout"><b>Carrier costs fill in by themselves.</b> When the shipper adds the tracking number, he also types what the label cost (and the duties for DDP). It lands here, on the right client, with no typing for you. Don’t also add the carrier’s monthly bill, or it counts twice.</p>
        </section>

        <section className="fn-t fn-t--plain fn-pnl" id="pnl">
          <div className="fn-t-top"><h2 className="fn-h2">Profit &amp; loss</h2><span className="fn-sub fn-mu">{monthLabel(ym, true)} · vs {monthLabel(prevYm, true)}</span></div>
          <div className="fn-pl-block">
            <span className="fn-eb fn-eb--blue">Money in</span>
            {REV_GROUPS.filter(([k]) => rev.groups[k] || p.rev.groups[k]).map(([k, label]) => <div key={k} className="fn-pl"><span>{label}</span><b>{fm(rev.groups[k], c)}</b></div>)}
            <div className="fn-pl fn-pl--tot"><span>Revenue</span><b data-figure="revenue" data-value={Math.round(rev.total)}>{fm(rev.total, c)} <Delta a={rev.total} b={p.rev.total} /></b></div>
          </div>
          <div className="fn-pl-block">
            <span className="fn-eb fn-eb--violet">Money out</span>
            {pnlOut.map(([label, a]) => <div key={label} className="fn-pl"><span>{label}</span><b>{fm(a, c)}</b></div>)}
            <div className="fn-pl fn-pl--tot"><span>Expenses</span><b>{fm(exp.total, c)} <Delta a={exp.total} b={p.exp.total} good="down" /></b></div>
          </div>
          <div className="fn-pl-profit">
            <span className="fn-eb fn-eb--orange">Profit</span>
            <div><b className={f.profit < 0 ? 'fn-dn' : ''} data-figure="profit" data-value={Math.round(f.profit)}>{fm(f.profit, c)}</b><span>{f.margin === null ? '—' : `${f.margin}%`}</span></div>
          </div>
          {rev.current && <p className="fn-sub fn-mu">The month isn’t over: revenue is what is billable so far.</p>}
        </section>

        <section className="fn-t fn-t--plain fn-rec" id="repeating">
          <div className="fn-t-top"><h2 className="fn-h2">Every month, automatically</h2><span className="fn-sub fn-mu">Added on their day each month</span></div>
          {(recs ?? []).length ? (
            <ul className="fn-reclist">
              {(recs ?? []).map((r) => (
                <li key={r.id} className={r.active ? '' : 'is-off'}>
                  <details>
                    <summary>
                      <i className={`fn-d fn-c-bg--${CAT_TONE[r.category]}`} />
                      <span><b>{r.payee}</b><small>{CAT_SHORT[r.category as ExpenseCat]}{r.org_id ? ` · ${names[r.org_id] ?? 'Client'}` : ''}{r.active ? '' : ' · stopped'}</small></span>
                      <em>{fm2(Number(r.amount), r.currency)} · {r.day_of_month}{['th', 'st', 'nd', 'rd'][(r.day_of_month % 10 > 3 || [11, 12, 13].includes(r.day_of_month % 100)) ? 0 : r.day_of_month % 10]}</em>
                    </summary>
                    {r.active && (
                      <form action={saveRecurring} className="ep-form fn-recform">
                        <input type="hidden" name="id" value={r.id} /><input type="hidden" name="ym" value={ym} />
                        <div className="ep-row3">
                          <label>Paid to<input name="payee" defaultValue={r.payee} required maxLength={120} /></label>
                          <label>Amount ({r.currency})<input name="amount" type="number" step="0.01" min="0.01" defaultValue={Number(r.amount)} required /></label>
                          <label>Day of the month<input name="day" type="number" min="1" max="28" defaultValue={r.day_of_month} required /></label>
                        </div>
                        <div className="fn-recform-foot">
                          <Submit className="ep-btn ep-btn--sm">Save</Submit>
                          <button className="ep-btn ep-btn--sm ep-btn--ghost" name="stop" value="1" formNoValidate>Stop repeating</button>
                        </div>
                      </form>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          ) : <p className="fn-sub fn-mu">Tick “Repeat every month” when you add rent, salaries or software, and they’ll be added here.</p>}
          <p className="fn-sub fn-mu">Costs from orders are in {fin.cost_currency} unless the shipper picked another currency.</p>
        </section>
      </div>
    </div>
  );
}
