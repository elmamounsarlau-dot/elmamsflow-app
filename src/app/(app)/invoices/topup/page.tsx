import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { Back } from '@/components/ui';
import { Submit } from '@/components/client';
import { money } from '@/lib/billing';
import { balanceOf, walletSettings } from '@/lib/wallet';
import { startTopup } from '../wallet-actions';

export const metadata = { title: 'Top up' };

export default async function Topup() {
  const ctx = await requireCtx();
  if (!ctx.org || !ctx.can('invoices.view')) redirect('/invoices');
  const [b, s] = await Promise.all([balanceOf(ctx.org.id), walletSettings()]);
  return (
    <>
      <Back href="/invoices">Invoices</Back>
      <div className="ep-head"><div><p className="ep-crumb">Invoices · Top up</p><h1>Top up your balance</h1><p>Your balance pays for each order when it ships. Current balance: <b>{money(b.balance, b.currency)}</b>.</p></div></div>
      <section className="ep-card" style={{ maxWidth: '40rem' }}>
        {!s.methods.length ? <p className="ep-note ep-note--warn">Payment details are being set up. Please contact us in Support.</p> : (
          <form action={startTopup} className="ep-form">
            <label>Amount ({b.currency})<input name="amount" type="number" min={s.min_topup || 1} step="0.01" required inputMode="decimal" placeholder={String(s.min_topup || 100)} /><small className="ep-muted">Minimum {money(s.min_topup, b.currency)}.</small></label>
            <label>How you’ll pay<select name="method" defaultValue={s.methods[0].label} required>{s.methods.map((m) => <option key={m.label}>{m.label}</option>)}</select></label>
            <label>Note for us (optional)<input name="note" maxLength={300} placeholder="e.g. paid from our Wise account" /></label>
            <Submit className="ep-btn ep-btn--full">Show the payment details</Submit>
            <p className="ep-small ep-muted">Next you get the account details and your own reference. Put the reference on the payment; we confirm it as soon as it arrives and your balance goes up.</p>
          </form>
        )}
        {s.note && <p className="ep-small" style={{ marginTop: '.8rem' }}>{s.note}</p>}
      </section>
    </>
  );
}
