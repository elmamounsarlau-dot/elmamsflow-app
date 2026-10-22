import 'server-only';
import { cookies } from 'next/headers';

/**
 * A freshly created sign-in link is shown once on the next page, without ever travelling in the page address
 * (where it would stay in browser history, logs and shared screenshots). Kept in a short-lived, http-only cookie.
 */
const NAME = 'elm_link';

export async function flashLink(link: string | undefined, email: string) {
  if (!link) return;
  (await cookies()).set(NAME, Buffer.from(JSON.stringify({ link, email })).toString('base64url'), {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 300,
  });
}

export async function readFlashLink(): Promise<{ link: string; email: string } | null> {
  const v = (await cookies()).get(NAME)?.value;
  if (!v) return null;
  try {
    const d = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as { link?: string; email?: string };
    return d.link && d.email ? { link: d.link, email: d.email } : null;
  } catch {
    return null;
  }
}
