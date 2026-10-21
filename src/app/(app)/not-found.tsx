import Link from 'next/link';
import { getCtx } from '@/lib/session';

export default async function NotFound() {
  const ctx = await getCtx();
  return (
    <section className="ep-card ep-notfound">
      <p className="ep-eyebrow"><i />Not found</p>
      <h2>This page isn’t here</h2>
      <p className="ep-muted">
        {ctx?.viewingAs && ctx.org
          ? `You’re viewing ${ctx.org.name}’s workspace, so you only see their orders, stock and inbounds. This one may belong to another client.`
          : 'It may have been removed, or the link is wrong.'}
      </p>
      <div className="ep-inline" style={{ marginTop: '1.2rem' }}>
        {ctx?.viewingAs ? <a className="ep-btn" href="/back-office?to=/">Back to back office</a> : <Link className="ep-btn" href="/">Go home</Link>}
      </div>
    </section>
  );
}
