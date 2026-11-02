import Link from 'next/link';
import { b2bClients, b2bOrders } from '@/lib/b2b-data';
import { countryList, countryName } from '@/lib/format';
import { financeSettings, MONEY_CURRENCIES, toReport } from '@/lib/fx';
import { Submit } from '@/components/client';
import { Arrow } from '@/components/ui';
import { archiveClient, saveClient } from '../actions';
import { B2BNav, flag, money, requireB2B } from '../ui';

export const metadata = { title: 'B2B clients' };

export default async function B2BClients({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  await requireB2B();
  const sp = await searchParams;
  const [clients, orders, fin] = await Promise.all([b2bClients(true), b2bOrders(), financeSettings()]);
  const e = clients.find((c) => c.id === sp.edit) ?? null;
  const countries = countryList(e?.country ?? 'MA');
  const rc = fin.report_currency;
  const stats = (id: string) => {
    const mine = orders.filter((o) => o.client_id === id && !o.cancelled);
    return {
      n: mine.length,
      value: mine.reduce((s, o) => s + (toReport(o.money.ttc, o.currency, fin) ?? 0), 0),
      owed: mine.reduce((s, o) => s + (toReport(Math.max(0, o.money.billed - o.money.paid), o.currency, fin) ?? 0), 0),
    };
  };
  const shown = clients.filter((c) => (sp.archived ? c.archived : !c.archived));

  return (
    <div className="fn bb">
      <div className="ep-head fn-head">
        <div>
          <p className="ep-crumb">B2B · clients</p>
          <h1>B2B clients</h1>
          <p>Your wholesale clients, separate from the 3PL brands. They don’t have a login.</p>
        </div>
        <div className="ep-actions"><Link className="ep-btn" href="/b2b/new">New B2B order <Arrow /></Link></div>
      </div>
      <B2BNav on="/b2b/clients" />

      <div className="fn-xgrid">
        <section className="fn-t fn-t--plain" id="client-form">
          <form action={saveClient} className="ep-form">
            {e && <input type="hidden" name="id" value={e.id} />}
            <div className="fn-xform-head"><h2 className="fn-h2">{e ? `Edit ${e.name}` : 'Add a client'}</h2>{e && <Link className="ep-link" href="/b2b/clients">Cancel</Link>}</div>
            <label>Company name<input name="name" required maxLength={160} defaultValue={e?.name ?? ''} /></label>
            <div className="ep-row2">
              <label>Country<select name="country" defaultValue={e?.country ?? 'MA'}>{countries.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
              <label>Usually pays in<select name="currency" defaultValue={e?.currency ?? 'MAD'}>{MONEY_CURRENCIES.map((x) => <option key={x}>{x}</option>)}</select></label>
            </div>
            <div className="ep-row2">
              <label>I.C.E. (Morocco)<input name="ice" maxLength={40} defaultValue={e?.ice ?? ''} /></label>
              <label>VAT number (abroad)<input name="vat" maxLength={40} defaultValue={e?.vat_number ?? ''} /></label>
            </div>
            <label>Address<textarea name="address" rows={2} maxLength={400} defaultValue={e?.address ?? ''} /></label>
            <div className="ep-row2">
              <label>Contact person<input name="contact" maxLength={120} defaultValue={e?.contact ?? ''} /></label>
              <label>Phone<input name="phone" maxLength={60} defaultValue={e?.phone ?? ''} /></label>
            </div>
            <label>Email<input name="email" type="email" maxLength={160} defaultValue={e?.email ?? ''} /></label>
            <label>Notes (only for you)<textarea name="notes" rows={2} maxLength={600} defaultValue={e?.notes ?? ''} /></label>
            <div className="fn-xform-foot"><Submit>{e ? 'Save' : 'Add the client'} <Arrow /></Submit></div>
          </form>
          {e && (
            <form action={archiveClient} className="bb-archive">
              <input type="hidden" name="id" value={e.id} /><input type="hidden" name="archive" value={e.archived ? '0' : '1'} />
              <Submit className="ep-btn ep-btn--sm ep-btn--ghost" confirm={e.archived ? undefined : `Archive ${e.name}? Their orders stay; they just leave the list.`}>{e.archived ? 'Restore the client' : 'Archive the client'}</Submit>
            </form>
          )}
        </section>

        <section className="fn-t fn-t--plain">
          <div className="fn-chips" role="group" aria-label="Show">
            <Link className={`fn-chip${!sp.archived ? ' is-on' : ''}`} href="/b2b/clients">Active <small>{clients.filter((c) => !c.archived).length}</small></Link>
            <Link className={`fn-chip${sp.archived ? ' is-on' : ''}`} href="/b2b/clients?archived=1">Archived <small>{clients.filter((c) => c.archived).length}</small></Link>
          </div>
          {shown.length ? (
            <div className="ep-tablewrap"><table className="fn-table">
              <thead><tr><th>Client</th><th>Country</th><th className="ep-right">Orders</th><th className="ep-right">Value</th><th className="ep-right">Owes you</th><th className="ep-right"><span className="ep-sr">Actions</span></th></tr></thead>
              <tbody>
                {shown.map((c) => {
                  const s = stats(c.id);
                  return (
                    <tr key={c.id} className={e?.id === c.id ? 'is-editing' : ''}>
                      <td><b>{c.name}</b><small>{c.ice ? `ICE ${c.ice}` : c.vat_number ? `VAT ${c.vat_number}` : c.contact ?? ''}</small></td>
                      <td><span aria-hidden="true">{flag(c.country)}</span> {countryName(c.country)}</td>
                      <td className="ep-right">{s.n}</td>
                      <td className="ep-right">{money(s.value, rc, true)}</td>
                      <td className={`ep-right${s.owed > 0.5 ? ' fn-dn' : ''}`}>{money(s.owed, rc, true)}</td>
                      <td className="ep-right"><span className="fn-rowact"><Link className="ep-btn ep-btn--sm ep-btn--ghost" href={`/b2b/clients?edit=${c.id}#client-form`}>Edit</Link><Link className="ep-btn ep-btn--sm ep-btn--ghost" href={`/b2b/new?client=${c.id}`}>New order</Link></span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          ) : <p className="fn-sub fn-mu">{sp.archived ? 'No archived client.' : 'No client yet. Add one here, or while creating an order.'}</p>}
        </section>
      </div>
    </div>
  );
}
