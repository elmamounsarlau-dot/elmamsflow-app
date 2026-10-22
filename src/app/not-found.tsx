import Link from 'next/link';

export default function NotFound() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--mist)', fontFamily: 'var(--body, system-ui)', color: 'var(--navy)', padding: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '.8rem', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--orange)', fontWeight: 700 }}>Not found</p>
        <h1 style={{ fontSize: '1.8rem', margin: '.4rem 0 1rem' }}>This page isn’t here</h1>
        <Link href="/" className="ep-btn">Go to Elmamsflow</Link>
      </div>
    </main>
  );
}
