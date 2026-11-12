import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { Back } from '@/components/ui';
import Link from 'next/link';
import { money } from '@/lib/billing';
import { balanceOf } from '@/lib/wallet';
import { EntriesTable, walletEntries } from '../wallet';

export const metadata = { title: 'Balance' };

export default async function BalancePage() {
  const ctx = await requireCtx();
  if (!ctx.org || !ctx.can('invoices.view')) redirect('/invoices');
  const [rows, b] = await Promise.all([walletEntries(ctx.org.id, 500), balanceOf(ctx.org.id)]);
  return (
    <>
      <Back href="/invoices">Invoices</Back>
      <div className="ep-head">
        <div><p className="ep-crumb">Invoices · Balance</p><h1>Balance history</h1><p>Every top-up and every order paid from your balance. Balance now: <b>{money(b.balance, b.currency)}</b>{b.pending ? ` · ${money(b.pending, b.currency)} on its way` : ''}.</p></div>
        <div className="ep-actions"><Link className="ep-btn" href="/invoices/topup">Top up</Link></div>
      </div>
      <section className="ep-card ep-card--flush"><EntriesTable rows={rows} /></section>
    </>
  );
}
