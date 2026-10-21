import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { Arrow, Back } from '@/components/ui';
import { Submit } from '@/components/client';
import { openTicket } from '../actions';

export const metadata = { title: 'New ticket' };

export default async function NewTicket({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (!ctx.org) redirect('/support');
  const sp = await searchParams;
  return (
    <>
      <Back href="/support">Support</Back>
      <section className="ep-card ep-card--narrow">
        <h2>New ticket</h2>
        <form action={openTicket} className="ep-form">
          <label>Subject<input name="subject" required placeholder="e.g. Change of address" /></label>
          <label>Order number (optional)<input name="order_ref" defaultValue={sp.ref ?? ''} placeholder="EM-20418" /></label>
          <label>Message<textarea name="body" rows={6} required /></label>
          <div><Submit>Send to the team <Arrow /></Submit></div>
        </form>
      </section>
    </>
  );
}
