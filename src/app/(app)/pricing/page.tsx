import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { CATEGORY, computeCharges, getRateCard, invoiceTz, money, monthBounds, RATE_FIELDS, ymOf } from '@/lib/billing';
import { PageHead } from '@/components/ui';
import { CountUp } from '@/components/orders-overview';
import { Estimator } from '@/components/estimator';

export const metadata = { title: 'Pricing' };

const GROUP_ABOUT: Record<string, string> = {
  Fulfillment: 'Picking every item and packing the parcel.',
  Shipping: 'Door to door, duties and taxes paid (DDP). Your customer never pays at delivery.',
  'Receiving & storage': 'Counting your stock in and keeping it safe on our shelves.',
  Terms: 'How billing works.',
};

export default async function Pricing() {
  const ctx = await requireCtx();
  if (!ctx.org) redirect('/clients');
  if (!ctx.can('invoices.view')) redirect('/?err=' + encodeURIComponent('You don’t have access to pricing.'));
  const rates = await getRateCard(ctx.org.id);
  const tz = await invoiceTz();
  const ym = ymOf(new Date(), tz);
  const { start, end, label } = monthBounds(ym, tz);
  const now = new Date();
  const run = rates ? await computeCharges(ctx.org.id, rates, start, now) : null;
  const cur = rates?.currency ?? 'USD';
  const elapsed = Math.max(1, (now.getTime() - start.getTime()) / 864e5);
  const days = (end.getTime() - start.getTime()) / 864e5;
  const forecast = run ? (run.total / elapsed) * days : 0;
  const byCat = run ? Object.entries(run.lines.reduce<Record<string, number>>((a, l) => ({ ...a, [l.category]: (a[l.category] ?? 0) + l.amount }), {})) : [];
  const perOrder = run && run.stats.orders ? run.lines.filter((l) => ['fulfillment', 'packaging', 'shipping', 'customs'].includes(l.category)).reduce((a, l) => a + l.amount, 0) / run.stats.orders : null;
  const groups = [...new Set(RATE_FIELDS.map((f) => f.group))];
  const max = Math.max(1, ...byCat.map(([, n]) => n));

  return (
    <div className="ep-pricing">
      <PageHead crumb="Billing" title="Your pricing" sub={`Everything we charge ${ctx.org.name}, and what this month costs so far. No hidden fees: invoices are built only from these prices.`}>
        <Link className="ep-btn ep-btn--ghost" href="/invoices">Invoices</Link>
      </PageHead>

      {!rates ? (
        <section className="ep-card ep-pr-empty"><b>Your price list is being prepared</b><p>Your account manager is setting up your prices. They’ll appear here as soon as they are ready.</p></section>
      ) : (
        <>
          <section className="ep-pr-hero">
            <div className="ep-pr-hero-main">
              <p className="ep-eyebrow"><i />{label} so far</p>
              <b className="ep-pr-total">{money(run!.total, cur).replace(/\.\d\d$/, '')}<small>{money(run!.total, cur).match(/\.\d\d$/)?.[0] ?? ''}</small></b>
              <p>{run!.stats.orders ? <><CountUp value={run!.stats.orders} /> orders shipped</> : 'No orders shipped yet this month'}{perOrder ? <> · about <b>{money(perOrder, cur)}</b> per order, shipping included</> : null}</p>
              <div className="ep-pr-forecast">
                <span>At this pace the month ends around <b>{money(forecast, cur)}</b></span>
                <div className="ep-pr-month" aria-hidden="true"><i style={{ width: `${Math.min(100, (elapsed / days) * 100)}%` }} /></div>
                <small>Day {Math.ceil(elapsed)} of {Math.round(days)} · invoiced on the 1st, due {rates.payment_terms_days} days later</small>
              </div>
            </div>
            <ul className="ep-pr-cats">
              {byCat.length === 0 ? <li className="ep-muted">Charges appear here as soon as something happens.</li> : byCat.sort((a, b) => b[1] - a[1]).map(([c, n], i) => (
                <li key={c} style={{ animationDelay: `${i * 70}ms` }}>
                  <span>{CATEGORY[c] ?? c}</span><b>{money(n, cur)}</b>
                  <div className="ep-pr-bar"><i style={{ width: `${(n / max) * 100}%`, animationDelay: `${200 + i * 70}ms` }} /></div>
                </li>
              ))}
            </ul>
          </section>

          <div className="ep-pr-groups">
            {groups.map((g, gi) => (
              <section key={g} className="ep-pr-group" style={{ animationDelay: `${gi * 80}ms` }}>
                <h2>{g}</h2>
                <p>{GROUP_ABOUT[g]}</p>
                <dl>
                  {RATE_FIELDS.filter((f) => f.group === g).map((f) => (
                    <div key={f.key}><dt>{f.label}<small>{f.unit}</small></dt><dd>{Number(rates[f.key]) ? money(Number(rates[f.key]), cur) : <span className="ep-pr-free">Included</span>}</dd></div>
                  ))}
                  {g === 'Terms' && <div><dt>Payment terms<small>after the invoice date</small></dt><dd>{rates.payment_terms_days} days</dd></div>}
                </dl>
              </section>
            ))}
          </div>

          <Estimator rates={rates} />

          <p className="ep-small ep-muted ep-pr-note">Shipping weight: each parcel is rounded up to the next full kilogram (a 300 g parcel counts as 1 kg). Storage is counted every day on the units on our shelves, and charged as a 30-day month. Questions about a charge? <Link href="/support/new?cat=billing">Ask us</Link>.</p>
        </>
      )}
    </div>
  );
}
