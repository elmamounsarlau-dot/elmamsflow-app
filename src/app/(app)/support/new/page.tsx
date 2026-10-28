import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { TICKET_CATEGORY } from '@/lib/format';
import { Arrow, Back } from '@/components/ui';
import { Submit } from '@/components/client';
import { FilesPick } from '@/components/media';
import { openTicket } from '../actions';

export const metadata = { title: 'New ticket' };

const ICON: Record<string, string> = {
  order: 'M4 3.5h12v13H4z M7 7.5h6 M7 10.5h6 M7 13.5h3',
  damaged: 'M3 6.5l7-3.5 7 3.5v7l-7 3.5-7-3.5v-7z M10 7v4 M10 13.5v.01',
  inbound: 'M2.5 6h9v7h-9z M11.5 9h3.5l2.5 2.5V13h-6 M5.5 15.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z M14.5 15.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z',
  stock: 'M3 6.5l7-3.5 7 3.5v7l-7 3.5-7-3.5v-7z M3 6.5l7 3.5 7-3.5 M10 10v7',
  billing: 'M5.5 2.5h9v15l-2-1.4-2.5 1.4-2.5-1.4-2 1.4z M8 7h4 M8 10h4',
  account: 'M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5',
  other: 'M3.5 5.5h13v8h-7l-3.5 3v-3H3.5v-8z',
};

export default async function NewTicket({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (!ctx.org) redirect('/support');
  const sp = await searchParams;
  const cat = sp.cat && sp.cat in TICKET_CATEGORY ? sp.cat : sp.ref ? 'order' : '';
  return (
    <>
      <Back href="/support">Support</Back>
      <div className="ep-head"><div><p className="ep-crumb">Support</p><h1>How can we help?</h1><p>A real person on our team answers, usually within the hour during working hours (China time).</p></div></div>
      <section className="ep-card ep-tk-new">
        <form action={openTicket} className="ep-form">
          <fieldset className="ep-fs">
            <legend className="ep-tk-legend">What is it about?</legend>
            <div className="ep-tk-cats">
              {Object.entries(TICKET_CATEGORY).map(([k, [l, h]]) => (
                <label key={k}>
                  <input type="radio" name="category" value={k} defaultChecked={k === cat} required />
                  <span>
                    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[k]} /></svg>
                    <b>{l}</b><small>{h}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="ep-row2">
            <label>Subject<input name="subject" required maxLength={140} placeholder="e.g. Parcel arrived with a broken bottle" /></label>
            <label>Order number (optional)<input name="order_ref" defaultValue={sp.ref ?? ''} placeholder="EM-20418" maxLength={40} /></label>
          </div>
          <label>Message<textarea name="body" rows={6} required placeholder="Tell us what happened. For damaged goods, a photo of the item and of the box helps us claim it from the carrier." /></label>
          <div className="ep-tk-files"><span className="ep-ipick-label">Photos or documents</span><FilesPick name="files" /></div>
          <div className="ep-form-foot"><Submit>Send to the team <Arrow /></Submit></div>
        </form>
      </section>
    </>
  );
}
