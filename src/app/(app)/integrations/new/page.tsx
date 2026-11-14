import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { getClients } from '@/lib/data';
import { SHOPIFY_SCOPES } from '@/lib/integrations/shopify';
import { Arrow, Back } from '@/components/ui';
import { CopyButton, Submit } from '@/components/client';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { fmtDate } from '@/lib/format';
import { installAppUrl, installCallbackUrl } from '@/lib/integrations/shopify-install';
import { cancelShopifyInstall, connectStore, prepareShopifyInstall } from '../actions';

export const metadata = { title: 'Connect a store' };

export default async function NewStore({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  if (!ctx.can('integrations.manage')) redirect('/integrations');
  const sp = await searchParams;
  const kind = sp.kind === 'woocommerce' ? 'woocommerce' : 'shopify';
  const mode = sp.mode === 'token' ? 'token' : 'client';
  const clients = ctx.org ? [] : await getClients();
  const staffLink = kind === 'shopify' && !ctx.org && !!ctx.staffRole;
  const { data: installs } = staffLink
    ? await supabaseAdmin().from('shopify_installs').select('id, org_id, shop, install_link, status, last_error, created_at, installed_at').neq('status', 'cancelled').order('created_at', { ascending: false }).limit(20)
    : { data: null };
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

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

      {staffLink && (
        <section className="ep-card" id="link" style={{ marginBottom: '1.2rem' }}>
          <div className="ep-card-head"><h2>Send the client one install link</h2><span className="ep-st ep-st--ok">Recommended</span></div>
          <p className="ep-small" style={{ marginBottom: '.8rem' }}>The client only clicks the link and <b>Install</b> — no Dev Dashboard, no keys. You prepare it once per client store, in your own Shopify Dev Dashboard.</p>
          <div className="ep-split">
            <ol className="ep-steps-list ep-small">
              <li>In <b>dev.shopify.com/dashboard</b> (your account), click <b>Create app</b>. Name it “Elmamsflow”.</li>
              <li><b>App URL</b>: <code className="ep-scopes">{installAppUrl()}</code> <CopyButton value={installAppUrl()} className="ep-btn ep-btn--sm ep-btn--ghost" /><br />Untick <b>Embed app in Shopify admin</b>. Leave <b>legacy install flow</b> unticked.</li>
              <li><b>Redirect URL</b>: <code className="ep-scopes">{installCallbackUrl()}</code> <CopyButton value={installCallbackUrl()} className="ep-btn ep-btn--sm ep-btn--ghost" /></li>
              <li><b>Scopes</b>: <code className="ep-scopes">{SHOPIFY_SCOPES.join(',')}</code> <CopyButton value={SHOPIFY_SCOPES.join(',')} className="ep-btn ep-btn--sm ep-btn--ghost" /></li>
              <li>Click <b>Release</b>. Then in <b>Protected customer data</b>, allow <b>name, email, phone and address</b> (the warehouse ships with them).</li>
              <li><b>IP allowlist</b> (required by Shopify for stores outside your organization): add ASN <b>16509</b> and country <b>India</b> — where Elmamsflow’s servers run.</li>
              <li><b>Distribution → Custom distribution</b>: enter the client’s <b>.myshopify.com</b> address and <b>Generate link</b>.</li>
              <li>Paste the app’s <b>Client ID</b>, <b>Client secret</b> and the <b>install link</b> here, save, and send the link to the client.</li>
            </ol>
            <form action={prepareShopifyInstall} className="ep-form">
              <label>Client<select name="org_id" required defaultValue=""><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>Client’s store address<input name="store" required placeholder="brand.myshopify.com" autoComplete="off" /></label>
              <div className="ep-row2">
                <label>Client ID<input name="client_id" required autoComplete="off" spellCheck={false} /></label>
                <label>Client secret<input name="client_secret" type="password" required autoComplete="off" /></label>
              </div>
              <label>Install link from Shopify<input name="install_link" type="url" placeholder="https://admin.shopify.com/…" autoComplete="off" /><small>Optional — saved here so you can copy it again later.</small></label>
              <div className="ep-form-foot"><Submit>Save — ready to send <Arrow /></Submit></div>
            </form>
          </div>
          {(installs ?? []).length > 0 && (
            <div className="ep-subblock">
              <div className="ep-card-head"><h3>Install links</h3><span className="ep-muted ep-small">{(installs ?? []).length}</span></div>
              <div className="ep-tablewrap"><table className="ep-table">
                <thead><tr><th>Client</th><th>Store</th><th>Status</th><th>Link</th><th></th></tr></thead>
                <tbody>{(installs ?? []).map((x) => (
                  <tr key={x.id}>
                    <td><b>{nameOf.get(x.org_id) ?? '—'}</b><small>prepared {fmtDate(x.created_at)}</small></td>
                    <td><small>{x.shop}</small></td>
                    <td>{x.status === 'installed'
                      ? <span className="ep-st ep-st--ok">Connected {x.installed_at ? fmtDate(x.installed_at) : ''}</span>
                      : <span className={`ep-st ep-st--${x.last_error ? 'warn' : 'mute'}`}>{x.last_error ? 'Check' : 'Waiting for the client'}</span>}
                      {x.last_error && x.status === 'waiting' && <small>{x.last_error}</small>}</td>
                    <td>{x.install_link ? <CopyButton value={x.install_link} label="Copy link" className="ep-btn ep-btn--sm ep-btn--ghost" /> : <small className="ep-muted">—</small>}</td>
                    <td>{x.status === 'waiting' && <form action={cancelShopifyInstall}><input type="hidden" name="id" value={x.id} /><Submit className="ep-btn ep-btn--sm ep-btn--ghost">Cancel</Submit></form>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          )}
        </section>
      )}

      {staffLink && <h2 className="ep-small ep-muted" style={{ margin: '0 0 .6rem' }}>Or connect with the client’s own keys</h2>}
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
