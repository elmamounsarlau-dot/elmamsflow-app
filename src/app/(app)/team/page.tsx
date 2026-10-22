import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { permsFor, roleCan, roleLabel, type Perm } from '@/lib/roles';
import { fmtDate } from '@/lib/format';
import { Arrow, PageHead } from '@/components/ui';
import { CopyLink, Submit } from '@/components/client';
import { PendingLink } from '@/components/access';
import type { AccessLink } from '@/lib/invite';
import { Fragment } from 'react';
import { memberLink } from '../clients/actions';
import { changeRole, createRole, deleteRole, inviteMember, removeMember, saveRole, teamScope, toggleMember } from './actions';

export const metadata = { title: 'Team' };


export default async function Team({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  const s = await teamScope(ctx);
  if (!s) redirect('/');
  const sp = await searchParams;
  const { data } = await supabaseAdmin().from('memberships').select('user_id, role, status, created_at, profile:profiles(full_name, email)').eq('org_id', s.orgId).order('created_at');
  const members = data ?? [];
  const showLinks = s.staff && (ctx.staffRole === 'owner' || ctx.staffRole === 'manager');
  const { data: links } = showLinks ? await supabaseAdmin().from('access_links').select('*').eq('org_id', s.orgId) : { data: [] as AccessLink[] };
  const linkFor = new Map(((links ?? []) as AccessLink[]).map((l) => [l.user_id, l]));
  const defs = s.defs;
  const perms = permsFor(s.staff);
  const used = (key: string) => members.filter((m) => m.role === key).length;
  return (
    <>
      <PageHead crumb="Team" title={s.staff ? 'Your team' : `${s.orgName} team`} sub="Invite people, choose their role, and decide what each role can do." />
      {sp.link && (
        <div className="ep-linkbox">
          <div><p className="ep-eyebrow"><i />Private link for {sp.for}</p><p>Copy it and send it privately (WhatsApp, WeChat). It works once and is also kept on your Home page until they set their password.</p></div>
          <CopyLink value={sp.link} />
        </div>
      )}
      <div className="ep-split">
        <div className="ep-card--grow">
          <section className="ep-card">
            <div className="ep-card-head"><h2>People</h2><span className="ep-muted">{members.length}</span></div>
            <table className="ep-table">
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Since</th><th></th></tr></thead>
              <tbody>
                {members.map((m) => {
                  const p = m.profile as unknown as { full_name: string; email: string } | null;
                  const me = m.user_id === ctx.userId;
                  const locked = me || (m.role === 'owner' && ctx.staffRole !== 'owner');
                  const kept = m.status === 'invited' ? linkFor.get(m.user_id) : undefined;
                  return (
                    <Fragment key={m.user_id}>
                    <tr className={kept ? 'ep-row--nb' : ''}>
                      <td><b>{p?.full_name || p?.email}{me && <span className="ep-tag">You</span>}</b><small>{p?.email}</small></td>
                      <td>
                        {locked ? roleLabel(m.role) : (
                          <form action={changeRole} className="ep-member-actions" style={{ justifyContent: 'flex-start' }}>
                            <input type="hidden" name="user" value={m.user_id} />
                            <select name="role" defaultValue={m.role}>{s.roles.map((r) => <option key={r} value={r}>{roleLabel(r, defs)}</option>)}</select>
                            <Submit className="ep-link">Save</Submit>
                          </form>
                        )}
                      </td>
                      <td>{m.status === 'invited' ? <span className="ep-st ep-st--warn">Invited</span> : m.status === 'paused' ? <span className="ep-st ep-st--mute">Paused</span> : <span className="ep-st ep-st--ok">Active</span>}</td>
                      <td>{fmtDate(m.created_at)}</td>
                      <td className="ep-right">
                        {!locked && (
                          <div className="ep-member-actions">
                            <form action={memberLink}><input type="hidden" name="user" value={m.user_id} /><input type="hidden" name="org" value={s.orgId} /><input type="hidden" name="back" value="/team" /><Submit className="ep-link">Email link</Submit></form>
                            <form action={memberLink}><input type="hidden" name="user" value={m.user_id} /><input type="hidden" name="org" value={s.orgId} /><input type="hidden" name="back" value="/team" /><input type="hidden" name="mode" value="copy" /><Submit className="ep-link">Copy link</Submit></form>
                            <form action={toggleMember}><input type="hidden" name="user" value={m.user_id} /><Submit className="ep-link">{m.status === 'paused' ? 'Restore' : 'Pause'}</Submit></form>
                            <form action={removeMember}><input type="hidden" name="user" value={m.user_id} /><Submit className="ep-link" confirm="Remove this person from the team?">Remove</Submit></form>
                          </div>
                        )}
                      </td>
                    </tr>
                    {kept && <tr><td colSpan={5}><PendingLink link={kept} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>
          <section className="ep-card" id="roles">
            <div className="ep-card-head">
              <h2>What each role can do</h2>
              <span className="ep-muted ep-small">{s.canEditRoles ? 'Tick or untick to adjust a role, or add your own below.' : s.staff ? 'Only the owner can adjust roles.' : 'Run the roles update in Supabase to adjust roles.'}</span>
            </div>
            <div className="ep-tablewrap">
              <table className="ep-table ep-matrix">
                <thead><tr><th></th>{defs.map((r) => <th key={r.key}>{r.label}</th>)}</tr></thead>
                <tbody>
                  {perms.map((p) => (
                    <tr key={p.key}><td>{p.label}</td>{defs.map((r) => <td key={r.key}>{roleCan(r, p.key as Perm, s.staff) ? <span className="ep-yes">✓</span> : <span className="ep-no">—</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {s.canEditRoles && (
            <section className="ep-card">
              <h2>Adjust roles</h2>
              <div className="ep-rolecards">
                {defs.map((r) => (
                  <details key={r.key} className="ep-rolecard">
                    <summary>
                      <b>{r.label}</b>
                      <span>{r.locked ? 'Always everything' : `${perms.filter((p) => r.perms.includes(p.key)).length} of ${perms.length} permissions`} · {used(r.key)} {used(r.key) === 1 ? 'person' : 'people'}{r.system ? '' : ' · your role'}</span>
                    </summary>
                    <form action={saveRole} className="ep-form">
                      <input type="hidden" name="key" value={r.key} />
                      <div className="ep-row2">
                        <label>Name<input name="label" defaultValue={r.label} maxLength={40} required /></label>
                        <label>Short description<input name="about" defaultValue={r.about ?? ''} maxLength={160} /></label>
                      </div>
                      {r.locked ? (
                        <p className="ep-small ep-muted">{r.label} can always do everything, so nobody can lock themselves out.</p>
                      ) : (
                        <div className="ep-permgrid">
                          {perms.map((p) => (
                            <label key={p.key} className="ep-check"><input type="checkbox" name="perm" value={p.key} defaultChecked={r.perms.includes(p.key)} />{p.label}</label>
                          ))}
                        </div>
                      )}
                      <div className="ep-member-actions" style={{ justifyContent: 'flex-start' }}>
                        <Submit className="ep-btn">Save role</Submit>
                      </div>
                    </form>
                    {!r.system && (
                      <form action={deleteRole} style={{ marginTop: '.6rem' }}>
                        <input type="hidden" name="key" value={r.key} />
                        <Submit className="ep-link" confirm={`Delete the role “${r.label}”?`}>Delete this role</Submit>
                      </form>
                    )}
                  </details>
                ))}
              </div>
              <details className="ep-rolecard ep-rolecard--new">
                <summary><b>+ Add a role</b><span>e.g. Packer, Team lead, Accountant</span></summary>
                <form action={createRole} className="ep-form">
                  <div className="ep-row2">
                    <label>Name<input name="label" maxLength={40} required placeholder="e.g. Team lead" /></label>
                    <label>Start from<select name="copy" defaultValue=""><option value="">Nothing ticked</option>{defs.map((r) => <option key={r.key} value={r.key}>Same as {r.label}</option>)}</select></label>
                  </div>
                  <label>Short description<input name="about" maxLength={160} placeholder="What this person does" /></label>
                  <p className="ep-small ep-muted">Tick what this role can do (or leave all empty and pick “Start from”).</p>
                  <div className="ep-permgrid">
                    {perms.map((p) => <label key={p.key} className="ep-check"><input type="checkbox" name="perm" value={p.key} />{p.label}</label>)}
                  </div>
                  <Submit className="ep-btn">Add role <Arrow /></Submit>
                </form>
              </details>
            </section>
          )}
        </div>
        <section className="ep-card ep-card--side">
          <h2>Invite someone</h2>
          <p className="ep-muted ep-small" style={{ marginBottom: '1rem' }}>They receive an email with a private link to choose their password.</p>
          <form action={inviteMember} className="ep-form">
            <label>Name<input name="name" placeholder="e.g. Li Wei" /></label>
            <label>Email<input type="email" name="email" required /></label>
            <div className="ep-roles">
              {s.roles.map((r, i) => (
                <label key={r} className="ep-role">
                  <input type="radio" name="role" value={r} defaultChecked={i === (s.staff ? 1 : 1)} />
                  <b>{roleLabel(r, defs)}</b>
                  <span>{defs.find((d) => d.key === r)?.about}</span>
                </label>
              ))}
            </div>
            <Submit className="ep-btn ep-btn--full">Send invitation <Arrow /></Submit>
          </form>
        </section>
      </div>
    </>
  );
}
