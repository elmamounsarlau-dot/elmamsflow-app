import { redirect } from 'next/navigation';
import { shippingOnly } from '@/lib/session';
import { requirePerm } from '@/lib/guard';
import { supabaseServer } from '@/lib/supabase/server';
import { COUNTRIES, fmtDate } from '@/lib/format';
import { Arrow, Empty, PageHead } from '@/components/ui';
import { Submit } from '@/components/client';
import { createClient } from './actions';

export const metadata = { title: 'Clients' };

export default async function Clients() {
  const ctx = await requirePerm('clients.view', '/clients');
  if (shippingOnly(ctx)) redirect('/shipping');
  const sb = await supabaseServer();
  const { data: orgs } = await sb.from('organizations').select('id, name, code, status, country, created_at, memberships(count)').eq('kind', 'client').order('created_at', { ascending: false });
  const list = orgs ?? [];
  return (
    <>
      <PageHead crumb="Back office" title="Clients" sub="Every brand you work for, who has access, and since when." />
      <div className="ep-split">
        <section className="ep-card ep-card--grow">
          <div className="ep-card-head"><h2>All clients</h2><span className="ep-muted">{list.length} workspaces</span></div>
          {list.length === 0 ? <Empty title="No clients yet" text="Create the first workspace on the right. We email their admin a private link." /> : (
            <table className="ep-table">
              <thead><tr><th>Client</th><th>Code</th><th>Country</th><th>People</th><th>Access</th><th>Since</th></tr></thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id} data-href={`/clients/${o.id}`}>
                    <td><b>{o.name}</b></td>
                    <td>{o.code}</td>
                    <td>{o.country ? COUNTRIES[o.country] ?? o.country : '—'}</td>
                    <td>{(o.memberships as unknown as { count: number }[])?.[0]?.count ?? 0}</td>
                    <td>{o.status === 'paused' ? <span className="ep-st ep-st--mute">Paused</span> : <span className="ep-st ep-st--ok">Active</span>}</td>
                    <td>{fmtDate(o.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        {ctx.can('clients.manage') && (
          <section className="ep-card ep-card--side" id="new-client">
            <h2>New client workspace</h2>
            <p className="ep-muted ep-small" style={{ marginBottom: '1rem' }}>Only brands you approve get access. Their admin receives a private link by email and can then invite their own team.</p>
            <form action={createClient} className="ep-form">
              <label>Company or brand<input name="company" required placeholder="e.g. Luma Candles" /></label>
              <label>Admin name<input name="name" placeholder="e.g. Sara Martin" /></label>
              <label>Admin email<input type="email" name="email" required placeholder="sara@brand.com" /></label>
              <div className="ep-row2">
                <label>Phone<input name="phone" /></label>
                <label>Country<select name="country" defaultValue=""><option value="">—</option>{Object.entries(COUNTRIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              </div>
              <Submit className="ep-btn ep-btn--full">Create and email the link <Arrow /></Submit>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
