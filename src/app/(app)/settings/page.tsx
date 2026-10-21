import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { roleLabel } from '@/lib/roles';
import { PasswordField, Submit } from '@/components/client';
import { changePassword, saveProfile } from './actions';

export const metadata = { title: 'Settings' };

export default async function Settings() {
  const ctx = await requireCtx();
  const sb = await supabaseServer();
  const { data: p } = await sb.from('profiles').select('full_name, phone').eq('id', ctx.userId).maybeSingle();
  return (
    <>
      <h1 className="ep-page-title">Settings</h1>
      <div className="ep-split">
        <section className="ep-card ep-card--grow ep-card--narrow">
          <h2>Your profile</h2>
          <form action={saveProfile} className="ep-form">
            <label>Name<input name="name" defaultValue={p?.full_name ?? ''} /></label>
            <label>Email<input defaultValue={ctx.email} disabled /></label>
            <label>Phone<input name="phone" defaultValue={p?.phone ?? ''} /></label>
            <label>Role<input defaultValue={`${ctx.staffRole ? 'Elmamsflow · ' : `${ctx.org?.name} · `}${roleLabel(ctx.staffRole ?? ctx.clientRole ?? '')}`} disabled /></label>
            <div><Submit>Save profile</Submit></div>
          </form>
        </section>
        <section className="ep-card ep-card--side">
          <h2>Change password</h2>
          <form action={changePassword} className="ep-form">
            <PasswordField name="current" label="Current password" autoComplete="current-password" />
            <PasswordField name="pass1" label="New password" strength />
            <PasswordField name="pass2" label="Type it again" />
            <Submit className="ep-btn ep-btn--full">Change password</Submit>
          </form>
        </section>
      </div>
    </>
  );
}
