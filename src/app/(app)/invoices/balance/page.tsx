import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { Back } from '@/components/ui';
import { BalanceCards, EntriesTable, walletEntries } from '../wallet';

export const metadata = { title: 'Balance' };

export default async function BalancePage() {
  const ctx = await requireCtx();
  if (!ctx.org || !ctx.can('invoices.view')) redirect('/invoices');
  const rows = await walletEntries(ctx.org.id, 500);
  return (
    <>
      <Back href="/invoices">Invoices</Back>
      <div className="ep-head"><div><p className="ep-crumb">Invoices · Balance</p><h1>Balance history</h1><p>Every top-up and every order paid from your balance.</p></div></div>
      <BalanceCards orgId={ctx.org.id} />
      <section className="ep-card ep-card--flush"><EntriesTable rows={rows} /></section>
    </>
  );
}
