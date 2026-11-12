import { notFound } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Back } from '@/components/ui';
import { CopyLink } from '@/components/client';
import { money } from '@/lib/billing';
import { fmtDate } from '@/lib/format';
import { walletSettings } from '@/lib/wallet';

export const metadata = { title: 'Top-up' };

export default async function TopupDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const sb = await supabaseServer();
  // Row Level Security: only this client's people (and our billing team) can read it.
  let q = sb.from('wallet_entries').select('id, org_id, amount, currency, status, method, ref, created_at, confirmed_at').eq('id', id).eq('kind', 'topup');
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const { data: e } = await q.maybeSingle();
  if (!e) notFound();
  const m = (await walletSettings()).methods.find((x) => x.label === e.method);
  const done = e.status === 'confirmed';
  return (
    <>
      <Back href="/invoices">Invoices</Back>
      <div className="ep-head"><div><p className="ep-crumb">Invoices · Top up</p><h1>{done ? 'Top-up received' : e.status === 'rejected' ? 'Top-up not received' : 'Send your payment'}</h1>
        <p>{done ? `${money(Number(e.amount), e.currency)} was added to your balance on ${fmtDate(e.confirmed_at, true)}.` : e.status === 'rejected' ? 'We didn’t receive this payment. If you sent it, write to us in Support with the proof.' : `Send ${money(Number(e.amount), e.currency)} using the details below, with your reference. We confirm it as soon as it arrives.`}</p></div></div>
      {!done && e.status !== 'rejected' && (
        <section className="ep-card" style={{ maxWidth: '40rem' }}>
          <p className="ep-eyebrow"><i />Your reference</p>
          <p style={{ fontSize: '1.6rem', fontWeight: 800, letterSpacing: '.04em', margin: '.2rem 0 .6rem' }} className="ep-mono">{e.ref}</p>
          <CopyLink value={e.ref ?? ''} label="Copy reference" />
          <h2 style={{ marginTop: '1.2rem' }}>{e.method}</h2>
          {m ? <pre className="ep-small" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', background: 'var(--soft, #f4f6fb)', padding: '.8rem 1rem', borderRadius: '10px' }}>{m.details}</pre> : <p className="ep-note ep-note--warn">These details changed. Please start a new top-up.</p>}
          <p className="ep-small ep-muted" style={{ marginTop: '.8rem' }}>Announced {fmtDate(e.created_at, true)}. Orders waiting for a top-up are released automatically once we confirm it.</p>
        </section>
      )}
    </>
  );
}
