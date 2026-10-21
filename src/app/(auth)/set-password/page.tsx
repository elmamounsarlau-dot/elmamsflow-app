import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { PasswordField, Submit } from '@/components/client';
import { Arrow } from '@/components/ui';
import { setPassword } from './actions';

export const metadata = { title: 'Choose your password' };

export default async function SetPassword({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const sp = await searchParams;
  return (
    <>
      <h2>Choose your password</h2>
      <p className="ep-muted">Hi {ctx.name}, pick a password to open your workspace.</p>
      {sp.err && <p className="ep-note ep-note--err">{sp.err}</p>}
      <form action={setPassword} className="ep-form">
        <label>
          Email
          <input value={ctx.email} disabled />
        </label>
        <PasswordField name="pass1" label="New password" strength autoFocus />
        <PasswordField name="pass2" label="Type it again" />
        <Submit className="ep-btn ep-btn--full">
          Open my workspace <Arrow />
        </Submit>
      </form>
      <p className="ep-muted ep-small">At least 8 characters. You can change it any time in Settings.</p>
    </>
  );
}
