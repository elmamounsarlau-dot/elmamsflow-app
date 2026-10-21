export const metadata = { title: 'No access' };

export default function NoAccess() {
  return (
    <main className="ep-auth-main" style={{ minHeight: '100vh' }}>
      <div className="ep-auth-card">
        <h2>No access right now</h2>
        <p className="ep-muted" style={{ margin: '1rem 0 1.6rem' }}>
          Your workspace is paused or your account isn’t linked to one yet. Please contact your Elmamsflow team.
        </p>
        <form action="/auth/signout" method="post">
          <button className="ep-btn ep-btn--ghost">Sign out</button>
        </form>
      </div>
    </main>
  );
}
