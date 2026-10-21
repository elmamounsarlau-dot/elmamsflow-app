import { notFound } from 'next/navigation';
import { requirePerm } from '@/lib/guard';
import { supabaseServer } from '@/lib/supabase/server';
import { COUNTRIES, fmtDate } from '@/lib/format';
import { ACTIVITY_LABELS } from '@/lib/log';
import { roleLabel } from '@/lib/roles';
import { getOrgRoles } from '@/lib/roles-db';
import { computeCharges, CURRENCIES, getRateCard, lastMonth, money, monthBounds, RATE_FIELDS, ymOf } from '@/lib/billing';
import { createInvoice, saveRateCard } from '../../invoices/actions';
import { Arrow, Back, Empty, Kpi, TeamOnly } from '@/components/ui';
import { CopyLink, Submit } from '@/components/client';
import { PendingLink } from '@/components/access';
import type { AccessLink } from '@/lib/invite';
import { Fragment } from 'react';
import { inviteClientMember, memberLink, toggleClient, updateClient } from '../actions';
import { viewAs } from '../../view-as';

export default async function ClientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const ctx = await requirePerm('clients.view', `/clients/${encodeURIComponent(id)}`);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const { data: org } = await sb.from('organizations').select('*').eq('id', id).eq('kind', 'client').maybeSingle();
  if (!org) notFound();
  const [{ data: members }, { data: log }, { data: links }, ...counts] = await Promise.all([
    sb.from('memberships').select('user_id, role, status, created_at, profile:profiles(full_name, email)').eq('org_id', id).order('created_at'),
    sb.from('activity_log').select('*').eq('org_id', id).order('created_at', { ascending: false }).limit(15),
    ctx.staffRole === 'owner' || ctx.staffRole === 'manager' ? sb.from('access_links').select('*').eq('org_id', id) : Promise.resolve({ data: [] as AccessLink[] }),
    ...['products', 'orders', 'inbounds', 'tickets'].map((t) => sb.from(t).select('id', { count: 'exact', head: true }).eq('org_id', id)),
  ]);
  const manage = ctx.can('clients.manage');
  const { roles: defs } = await getOrgRoles(id, false);
  const billingOn = !!ctx.staffRole && ctx.can('billing.manage');
  const rates = billingOn ? await getRateCard(id) : null;
  const running = rates ? await computeCharges(id, rates, monthBounds(ymOf(new Date())).start, new Date()) : null;
  const groups = [...new Set(RATE_FIELDS.map((f) => f.group))];
  const linkFor = new Map(((links ?? []) as AccessLink[]).map((l) => [l.user_id, l]));
  const back = `/clients/${id}`;
  return (
    <>
      <Back href="/clients">All clients</Back>
      <div className="ep-client-head">
        <div>
          <h2>{org.name} {org.status === 'paused' && <span className="ep-st ep-st--mute">Paused</span>}</h2>
          <p className="ep-muted">{org.code} · since {fmtDate(org.created_at)}{org.country ? ` · ${COUNTRIES[org.country] ?? org.country}` : ''}</p>
        </div>
        <form action={viewAs}><input type="hidden" name="org" value={org.id} /><Submit>View as client <Arrow /></Submit></form>
      </div>
      {sp.link && (
        <div className="ep-linkbox">
          <div><p className="ep-eyebrow"><i />Private link for {sp.for}</p><p>Copy it and send it privately (WhatsApp, WeChat). It works once and is also kept on your Home page under “Waiting to sign in” until they set their password.</p></div>
          <CopyLink value={sp.link} />
        </div>
      )}
      <div className="ep-split">
        <div className="ep-card--grow">
          <div className="ep-kpis ep-kpis--4">
            {['Products', 'Orders', 'Inbounds', 'Tickets'].map((l, i) => <Kpi key={l} label={l} value={(counts[i] as { count: number | null }).count ?? 0} />)}
          </div>
          <section className="ep-card">
            <div className="ep-card-head"><h2>People in this workspace</h2><span className="ep-muted ep-small">Their admin can invite more from their Team page</span></div>
            <table className="ep-table">
              <thead><tr><th>Name</th><th>Role</th><th>Status</th>{manage && <th></th>}</tr></thead>
              <tbody>
                {(members ?? []).map((m) => {
                  const p = m.profile as unknown as { full_name: string; email: string } | null;
                  const kept = m.status === 'invited' ? linkFor.get(m.user_id) : undefined;
                  return (
                    <Fragment key={m.user_id}>
                    <tr className={kept ? 'ep-row--nb' : ''}>
                      <td><b>{p?.full_name || p?.email}</b><small>{p?.email}</small></td>
                      <td>{roleLabel(m.role, defs)}</td>
                      <td>{m.status === 'invited' ? <span className="ep-st ep-st--warn">Link not used yet</span> : m.status === 'paused' ? <span className="ep-st ep-st--mute">Paused</span> : <span className="ep-st ep-st--ok">Active</span>}</td>
                      {manage && (
                        <td className="ep-right">
                          <div className="ep-member-actions">
                            <form action={memberLink}><input type="hidden" name="user" value={m.user_id} /><input type="hidden" name="org" value={id} /><input type="hidden" name="back" value={back} /><Submit className="ep-link">Email again</Submit></form>
                            <form action={memberLink}><input type="hidden" name="user" value={m.user_id} /><input type="hidden" name="org" value={id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="mode" value="copy" /><Submit className="ep-link">New private link</Submit></form>
                          </div>
                        </td>
                      )}
                    </tr>
                    {kept && <tr><td colSpan={manage ? 4 : 3}><PendingLink link={kept} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>
          {billingOn && (
            <section className="ep-card ep-card--team" id="prices">
              <div className="ep-card-head">
                <h2>Price list</h2>
                {running && <span className="ep-muted ep-small">This month so far: <b>{money(running.total, rates!.currency)}</b></span>}
              </div>
              <TeamOnly />
              {!rates && <p className="ep-note ep-note--warn" style={{ margin: '.6rem 0 1rem' }}>No prices yet. Set them so this client’s invoices are calculated automatically every month.</p>}
              <form action={saveRateCard} className="ep-form">
                <input type="hidden" name="org" value={org.id} />
                <div className="ep-row4">
                  <label>Currency<select name="currency" defaultValue={rates?.currency ?? 'USD'}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></label>
                  <label>Pay within (days)<input type="number" name="payment_terms_days" min={0} max={90} defaultValue={rates?.payment_terms_days ?? 14} /></label>
                </div>
                {groups.map((g) => (
                  <fieldset key={g} className="ep-rates">
                    <legend>{g}</legend>
                    <div className="ep-row4">
                      {RATE_FIELDS.filter((f) => f.group === g).map((f) => (
                        <label key={f.key}>{f.label}<input type="number" min={0} step={f.step} name={f.key} defaultValue={rates ? Number(rates[f.key]) : ''} placeholder="0.00" /><small>{f.unit}</small></label>
                      ))}
                    </div>
                  </fieldset>
                ))}
                <div className="ep-form-foot" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="ep-small ep-muted">Storage is charged per unit per day (monthly price ÷ 30). Shipping weight uses the parcel weight, or product weights if none was recorded.</span>
                  <Submit>Save prices</Submit>
                </div>
              </form>
              {rates && (
                <form action={createInvoice} className="ep-inline" style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed var(--line)', alignItems: 'center', justifyContent: 'space-between' }}>
                  <input type="hidden" name="org" value={org.id} />
                  <input type="hidden" name="month" value={lastMonth()} />
                  <span className="ep-small">Invoices are drafted automatically on the 1st. Need it now?</span>
                  <Submit className="ep-btn ep-btn--ghost">Create {monthBounds(lastMonth()).label} invoice</Submit>
                </form>
              )}
            </section>
          )}
          <section className="ep-card">
            <h2>Activity</h2>
            {(log ?? []).length === 0 ? <Empty title="Nothing yet" text="Everything this client and your team do shows here." /> : (
              <ul className="ep-activity">{(log ?? []).map((a) => <li key={a.id}><b>{ACTIVITY_LABELS[a.action] ?? a.action}</b><span>{a.detail}</span><small>{fmtDate(a.created_at, true)}</small></li>)}</ul>
            )}
          </section>
        </div>
        {manage && (
          <div className="ep-card--side">
            <section className={`ep-card ep-card--team${(members ?? []).length === 0 ? ' ep-card--hl' : ''}`}>
              <h2>{(members ?? []).length === 0 ? 'Invite their admin' : 'Add someone'}</h2>
              <TeamOnly />
              {(members ?? []).length === 0 && <p className="ep-small" style={{ marginBottom: '.8rem' }}>Nobody is attached to this workspace yet. Invite the person who will manage it.</p>}
              <form action={inviteClientMember} className="ep-form">
                <input type="hidden" name="org" value={org.id} />
                <label>Name<input name="name" /></label>
                <label>Email<input type="email" name="email" required /></label>
                <label>Role<select name="role" defaultValue="admin">{defs.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
                <Submit className="ep-btn ep-btn--full">Send invitation <Arrow /></Submit>
              </form>
            </section>
            <section className="ep-card ep-card--team">
              <h2>Access</h2>
              <TeamOnly />
              <p className="ep-small" style={{ marginBottom: '1rem' }}>{org.status === 'paused' ? 'Nobody in this workspace can sign in.' : 'Everyone invited to this workspace can sign in.'}</p>
              <form action={toggleClient}><input type="hidden" name="org" value={org.id} /><Submit className="ep-btn ep-btn--ghost ep-btn--full" confirm={org.status === 'paused' ? 'Restore access for this client?' : 'Pause access for everyone in this workspace?'}>{org.status === 'paused' ? 'Restore access' : 'Pause access'}</Submit></form>
            </section>
            <section className="ep-card ep-card--team">
              <h2>Details</h2>
              <TeamOnly />
              <form action={updateClient} className="ep-form">
                <input type="hidden" name="org" value={org.id} />
                <label>Company or brand<input name="company" defaultValue={org.name} required /></label>
                <div className="ep-row2">
                  <label>Phone<input name="phone" defaultValue={org.phone ?? ''} /></label>
                  <label>Country<select name="country" defaultValue={org.country ?? ''}><option value="">—</option>{Object.entries(COUNTRIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                </div>
                <label>Internal notes<textarea name="notes" rows={3} defaultValue={org.notes ?? ''} placeholder="Only your team sees this" /></label>
                <Submit className="ep-btn ep-btn--full">Save details</Submit>
              </form>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
