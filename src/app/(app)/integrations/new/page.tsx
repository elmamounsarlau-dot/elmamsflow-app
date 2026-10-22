import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { getClients } from '@/lib/data';
import { SHOPIFY_SCOPES } from '@/lib/integrations/shopify';
import { Arrow, Back } from '@/components/ui';
import { Submit } from '@/components/client';
import { connectStore } from '../actions';

export const metadata = { title: 'Connect a store' };

export default async function NewStore({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (!ctx.can('integrations.manage')) redirect('/integrations');
  const sp = await searchParams;
  const kind = sp.kind === 'woocommerce' ? 'woocommerce' : 'shopify';
  const mode = sp.mode === 'token' ? 'token' : 'client';
  const clients = ctx.org ? [] : await getClients();

  return (
    <>
      <Back href="/integrations">Stores</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">Connect a store</p>
          <h1>Connect {kind === 'shopify' ? 'Shopify' : 'WooCommerce'}</h1>
          <p>About 5 minutes. Your keys are encrypted and only used to read orders and send tracking back.</p>
        </div>
        <nav className="ep-range">
          <Link href="/integrations/new?kind=shopify" className={kind === 'shopify' ? 'is-on' : ''}>Shopify</Link>
          <Link href="/integrations/new?kind=woocommerce" className={kind === 'woocommerce' ? 'is-on' : ''}>WooCommerce</Link>
        </nav>
      </div>

      <div className="ep-split">
        <section className="ep-card">
          <form action={connectStore} className="ep-form">
            <input type="hidden" name="kind" value={kind} />
            {!ctx.org && (
              <label>Client<select name="org_id" required defaultValue=""><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            )}
            {kind === 'shopify' ? (
              <>
                <label>Store address<input name="store" required placeholder="mybrand.myshopify.com" autoComplete="off" /><small>Find it in Shopify → Settings → Domains (the .myshopify.com one).</small></label>
                {mode === 'client' ? (
                  <>
                    <input type="hidden" name="mode" value="client" />
                    <div className="ep-row2">
                      <label>Client ID<input name="client_id" required autoComplete="off" spellCheck={false} /></label>
                      <label>Client secret<input name="client_secret" type="password" required autoComplete="off" /></label>
                    </div>
                    <small className="ep-muted">Already have an older custom app with an Admin API token (shpat_…)? <Link href="/integrations/new?kind=shopify&mode=token">Use that instead</Link>.</small>
                  </>
                ) : (
                  <>
                    <input type="hidden" name="mode" value="token" />
                    <div className="ep-row2">
                      <label>Admin API access token<input name="token" type="password" required placeholder="shpat_…" autoComplete="off" /></label>
                      <label>API secret key<input name="api_secret" type="password" required autoComplete="off" /><small>Used to check that updates really come from your store.</small></label>
                    </div>
                    <small className="ep-muted"><Link href="/integrations/new?kind=shopify">Back to the Client ID method</Link></small>
                  </>
                )}
              </>
            ) : (
              <>
                <label>Store address<input name="store" required placeholder="https://mystore.com" autoComplete="off" /></label>
                <div className="ep-row2">
                  <label>Consumer key<input name="ck" required placeholder="ck_…" autoComplete="off" spellCheck={false} /></label>
                  <label>Consumer secret<input name="cs" type="password" required placeholder="cs_…" autoComplete="off" /></label>
                </div>
              </>
            )}
            <label>
              Also import open orders from
              <select name="days" defaultValue="0">
                <option value="0">Only new orders from now on</option>
                <option value="3">The last 3 days</option>
                <option value="7">The last 7 days</option>
                <option value="14">The last 14 days</option>
                <option value="30">The last 30 days</option>
              </select>
              <small>Only paid orders that aren’t shipped yet. Pick “only new” if another warehouse still ships your older orders.</small>
            </label>
            <div className="ep-form-foot"><Submit>Connect store <Arrow /></Submit></div>
          </form>
        </section>

        <section className="ep-card ep-card--side">
          <h2>{kind === 'shopify' ? 'Get your Shopify keys' : 'Get your WooCommerce keys'}</h2>
          {kind === 'shopify' ? (
            mode === 'client' ? (
              <ol className="ep-steps-list ep-small" style={{ marginTop: '.8rem' }}>
                <li>Signed in as the store owner, open <b>dev.shopify.com/dashboard</b> and click <b>Create app</b>. Name it “Elmamsflow”.</li>
                <li>In the app version, set the <b>Admin API scopes</b>:<br /><code className="ep-scopes">{SHOPIFY_SCOPES.join(', ')}</code></li>
                <li>Under <b>Protected customer data</b>, allow access to <b>name, email, phone and address</b> — we need them to ship.</li>
                <li><b>Release</b> the version, then <b>Install</b> the app on your store.</li>
                <li>Open the app’s <b>Settings</b> and copy the <b>Client ID</b> and <b>Client secret</b> here.</li>
              </ol>
            ) : (
              <ol className="ep-steps-list ep-small" style={{ marginTop: '.8rem' }}>
                <li>In Shopify admin → <b>Settings → Apps → Develop apps</b>, open your existing custom app.</li>
                <li>Check its Admin API scopes include: <code className="ep-scopes">{SHOPIFY_SCOPES.join(', ')}</code></li>
                <li>In <b>API credentials</b>, copy the <b>Admin API access token</b> and the <b>API secret key</b>.</li>
              </ol>
            )
          ) : (
            <ol className="ep-steps-list ep-small" style={{ marginTop: '.8rem' }}>
              <li>In WordPress → <b>WooCommerce → Settings → Advanced → REST API</b>, click <b>Add key</b>.</li>
              <li>Description “Elmamsflow”, user: a shop manager or admin, permissions: <b>Read/Write</b>.</li>
              <li>Click <b>Generate API key</b> and copy the <b>Consumer key</b> and <b>Consumer secret</b> here (they’re only shown once).</li>
              <li>Your store must use <b>https://</b>, and <b>Settings → Permalinks</b> must not be “Plain”.</li>
            </ol>
          )}
          <p className="ep-note" style={{ marginTop: '1rem' }}>Products are matched by <b>SKU</b>. Use the same SKUs in your store and in Elmamsflow — or import your products from the store after connecting.</p>
        </section>
      </div>
    </>
  );
}
