import Link from 'next/link';
import { Submit } from '@/components/client';
import { Arrow } from '@/components/ui';
import { sendReset } from './actions';

export const metadata = { title: 'Reset password' };

export default async function Forgot({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  return (
    <>
      <h2>New password</h2>
      {sp.sent ? (
        <p className="ep-note">If an account exists for that email, a private link is on its way. It works once.</p>
      ) : (
        <>
          <p className="ep-muted">Enter your email and we’ll send you a private link to choose a new password.</p>
          <form action={sendReset} className="ep-form">
            <label>
              Email
              <input type="email" name="email" required autoFocus />
            </label>
            <Submit className="ep-btn ep-btn--full">
              Send me a link <Arrow />
            </Submit>
          </form>
        </>
      )}
      <p className="ep-muted ep-small">
        <Link href="/login">Back to sign in</Link>
      </p>
    </>
  );
}
