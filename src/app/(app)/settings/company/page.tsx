import Link from 'next/link';
import { redirect } from 'next/navigation';
import { editsCompany, requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { countryName } from '@/lib/format';
import { PageHead } from '@/components/ui';
import { Submit } from '@/components/client';
import { ImagePick } from '@/components/media';
import { saveCompany } from '../actions';

export const metadata = { title: 'Company profile' };

type Co = { id: string; name: string; code: string | null; country: string | null; phone: string | null; legal_name: string | null; billing_address: string | null; vat_number: string | null; invoice_email: string | null; website: string | null; logo_path: string | null };

export default async function Company() {
  const ctx = await requireCtx();
  if (!ctx.org) redirect('/settings');
  const sb = await supabaseServer();
  const { data } = await sb.from('organizations').select('id, name, code, country, phone, legal_name, billing_address, vat_number, invoice_email, website, logo_path').eq('id', ctx.org.id).maybeSingle();
  const c = data as Co | null;
  if (!c) redirect('/settings');
  const edit = editsCompany(ctx);
  const filled = [c.legal_name, c.billing_address, c.vat_number, c.invoice_email, c.logo_path].filter(Boolean).length;
  const logo = c.logo_path ? `/files/logo/${c.id}?v=${encodeURIComponent(c.logo_path.split('/').pop() ?? '')}` : null;
  return (
    <div className="ep-co">
      <PageHead crumb="Settings" title="Company profile" sub="How your brand appears on every invoice and across your workspace." >
        <Link className="ep-btn ep-btn--ghost" href="/settings">Personal settings</Link>
      </PageHead>

      <div className="ep-co-grid">
        <aside className="ep-co-preview" aria-label="Preview on your invoices">
          <p className="ep-eyebrow"><i />On your invoices</p>
          <div className="ep-co-paper">
            <div className="ep-co-paper-top">
              <span className="ep-co-logo">{logo
                // eslint-disable-next-line @next/next/no-img-element -- private file served by our own route
                ? <img src={logo} alt={`${c.name} logo`} />
                : <i>{c.name.slice(0, 1).toUpperCase()}</i>}</span>
              <small>Billed to</small>
            </div>
            <b>{c.legal_name || c.name}</b>
            {c.billing_address ? <p>{c.billing_address}</p> : <p className="ep-co-ghost">Billing address</p>}
            <p>{c.vat_number ? `VAT ${c.vat_number}` : <span className="ep-co-ghost">VAT number</span>}{c.country && !(c.billing_address ?? '').toLowerCase().includes(countryName(c.country).toLowerCase()) ? ` · ${countryName(c.country)}` : ''}</p>
            <p>{c.invoice_email || <span className="ep-co-ghost">invoices@yourbrand.com</span>}</p>
            <div className="ep-co-lines"><i /><i /><i /></div>
          </div>
          <div className="ep-co-meter">
            <div className="ep-meter ep-meter--ok"><i style={{ width: `${(filled / 5) * 100}%` }} /></div>
            <span>{filled === 5 ? 'Complete — your invoices are ready for your accountant.' : `${filled} of 5 filled in`}</span>
          </div>
        </aside>

        <section className="ep-card ep-co-form">
          {!edit && <p className="ep-note ep-note--warn" style={{ marginBottom: '1rem' }}>Only an admin of your workspace can change these details.</p>}
          <form action={saveCompany} className="ep-form">
            <fieldset disabled={!edit} className="ep-fs">
              <div className="ep-co-logo-row">
                <ImagePick name="logo" current={logo} label="Logo" hint="PNG, JPG or WEBP, up to 2 MB. A square logo looks best." round={false} />
                {logo && edit && <label className="ep-check"><input type="checkbox" name="remove_logo" value="1" /> Remove the logo</label>}
              </div>
              <div className="ep-row2">
                <label>Brand name<input value={c.name} disabled /><small>Set by Elmamsflow{c.code ? ` · client code ${c.code}` : ''}</small></label>
                <label>Legal company name<input name="legal_name" defaultValue={c.legal_name ?? ''} placeholder={`${c.name} Ltd`} maxLength={160} /></label>
              </div>
              <label>Billing address<textarea name="billing_address" rows={3} defaultValue={c.billing_address ?? ''} placeholder={'Street and number\nPostcode, City\nCountry'} maxLength={500} /></label>
              <div className="ep-row2">
                <label>VAT / tax number<input name="vat_number" defaultValue={c.vat_number ?? ''} placeholder="e.g. FR12345678901" maxLength={40} /></label>
                <label>Invoice email<input type="email" name="invoice_email" defaultValue={c.invoice_email ?? ''} placeholder="accounts@yourbrand.com" maxLength={160} /><small>Where invoices should go</small></label>
              </div>
              <div className="ep-row2">
                <label>Website<input name="website" defaultValue={c.website ?? ''} placeholder="yourbrand.com" maxLength={200} /></label>
                <label>Phone<input name="phone" defaultValue={c.phone ?? ''} maxLength={40} /></label>
              </div>
            </fieldset>
            {edit && <div className="ep-form-foot"><Submit>Save company profile</Submit></div>}
          </form>
        </section>
      </div>
    </div>
  );
}
