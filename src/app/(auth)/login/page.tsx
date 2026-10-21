import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/session';
import { PasswordField, Submit } from '@/components/client';
import { Arrow } from '@/components/ui';
import { signIn } from './actions';

export const metadata = { title: 'Sign in' };

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  if (await getCtx()) redirect('/');
  const sp = await searchParams;
  return (
    <>
      <h2>Sign in</h2>
      <p className="ep-muted">Welcome back. Use the email your Elmamsflow team set up for you.</p>
      {sp.bye && <p className="ep-note">You’re signed out.</p>}
      {sp.err && <p className="ep-note ep-note--err">{sp.err}</p>}
      <form action={signIn} className="ep-form">
        <label>
          Email
          <input type="email" name="email" autoComplete="username" required autoFocus defaultValue={sp.email ?? ''} />
        </label>
        <PasswordField name="password" label="Password" autoComplete="current-password" />
        <Submit className="ep-btn ep-btn--full">
          Sign in <Arrow />
        </Submit>
      </form>
      <p className="ep-muted ep-small">
        Forgot your password? <Link href="/forgot">Get a new link by email</Link>.
      </p>
    </>
  );
}
