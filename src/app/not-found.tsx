export default function NotFound() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#F6F8FB', fontFamily: 'var(--body, system-ui)', color: '#0B1F3A' }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: '.8rem', letterSpacing: '.12em', textTransform: 'uppercase', color: '#F7941D', fontWeight: 700 }}>Not found</p>
        <h1 style={{ fontSize: '1.8rem', margin: '.4rem 0 1rem' }}>This page isn’t here</h1>
        <a href="/" style={{ display: 'inline-block', padding: '.8rem 1.4rem', borderRadius: 999, background: '#0B1F3A', color: '#fff', textDecoration: 'none' }}>Go to Elmamsflow</a>
      </div>
    </main>
  );
}
