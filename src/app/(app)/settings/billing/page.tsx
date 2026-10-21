import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { stripeReady } from '@/lib/billing';
import { siteUrl } from '@/lib/format';
import { Back } from '@/components/ui';
import { CopyLink, Submit } from '@/components/client';
import { saveBillingSettings } from '../../invoices/actions';

export const metadata = { title: 'Billing details' };

export default async function BillingSettings() {
  const ctx = await requireCtx();
  if (!ctx.staffRole || !ctx.can('billing.manage')) redirect('/settings');
  const { data: s } = await supabaseAdmin().from('billing_settings').select('*').eq('id', 1).maybeSingle();
  const card = stripeReady();
  return (
    <>
      <Back href="/invoices">Invoices</Back>
      <div className="ep-head"><div><p className="ep-crumb">Settings</p><h1>Billing details</h1><p>Printed on every invoice, and shown to clients when they pay.</p></div></div>
      <div className="ep-split">
        <section className="ep-card">
          <form action={saveBillingSettings} className="ep-form">
            <div className="ep-row2"><label>Company name<input name="company" defaultValue={s?.company ?? ''} /></label><label>Tax / registration number<input name="tax_id" defaultValue={s?.tax_id ?? ''} placeholder="ICE / RC / VAT" /></label></div>
            <label>Address<textarea name="address" rows={2} defaultValue={s?.address ?? ''} /></label>
            <label>Billing email<input type="email" name="email" defaultValue={s?.email ?? ''} placeholder="billing@…" /></label>
            <h2 style={{ marginTop: '.6rem' }}>Bank details for transfers</h2>
            <p className="ep-small ep-muted">One block per currency. Clients see the one matching their invoice.</p>
            {(['usd', 'eur', 'gbp'] as const).map((c) => (
              <label key={c}>{c.toUpperCase()} account<textarea name={`bank_${c}`} rows={3} defaultValue={(s?.[`bank_${c}`] as string) ?? ''} placeholder={'Bank name\nAccount holder\nIBAN / account number · SWIFT'} /></label>
            ))}
            <label>Footer line<input name="footer" defaultValue={s?.footer ?? ''} placeholder="Thank you for shipping with Elmamsflow." /></label>
            <div className="ep-form-foot"><Submit>Save billing details</Submit></div>
          </form>
        </section>
        <section className="ep-card ep-card--side">
          <h2>Card payments</h2>
          <p className={`ep-note ep-note--${card ? 'ok' : 'warn'}`} style={{ margin: '.8rem 0 1rem' }}>{card ? 'On. Clients see “Pay by card” on open invoices.' : 'Off. Clients can pay by bank transfer for now.'}</p>
          {!card && (
            <ol className="ep-steps-list ep-small">
              <li>Create a free account at <b>stripe.com</b> and activate payments.</li>
              <li>In Stripe → Developers → API keys, copy the <b>Secret key</b>.</li>
              <li>In Stripe → Developers → Webhooks, add this endpoint and choose the event <b>checkout.session.completed</b>:</li>
            </ol>
          )}
          <CopyLink value={`${siteUrl()}/api/stripe/webhook`} label="Copy" />
          {!card && (
            <ol className="ep-steps-list ep-small" start={4}>
              <li>Copy the webhook’s <b>Signing secret</b>.</li>
              <li>In Vercel → elmamsflow-app → Settings → Environment Variables, add <b>STRIPE_SECRET_KEY</b> and <b>STRIPE_WEBHOOK_SECRET</b>, then redeploy.</li>
            </ol>
          )}
          <p className="ep-small ep-muted" style={{ marginTop: '1rem' }}>Paid invoices turn to Paid automatically. Bank transfers are recorded by your team with “Mark as paid”.</p>
        </section>
      </div>
    </>
  );
}
