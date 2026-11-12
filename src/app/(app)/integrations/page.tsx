import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { orgNames } from '@/lib/data';
import { fmtDate } from '@/lib/format';
import { Submit } from '@/components/client';
import { BRIDGE_SCOPES } from '@/lib/integrations/bridge';
import { bridgeSyncNow, connectBridge, disconnectBridge } from './actions';
import { KIND_LABEL, STORE_STATUS, type Integration } from '@/lib/integrations/core';
import { Arrow, Empty } from '@/components/ui';

export const metadata = { title: 'Stores' };


export default async function Stores() {
  const ctx = await requireCtx();
  if (!ctx.can('integrations.manage')) redirect('/?err=' + encodeURIComponent('You don’t have access to stores.'));
  let q = supabaseAdmin().from('integrations').select('id, org_id, kind, role, store_url, name, status, last_sync_at, last_error, orders_imported, created_at').neq('status', 'disconnected').eq('role', 'store').order('created_at', { ascending: false });
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data }, names] = await Promise.all([q, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const list = (data ?? []) as Integration[];
  const canConnect = !!ctx.org || ctx.backOffice;
  const showBridge = !!ctx.staffRole && ['owner', 'manager'].includes(ctx.staffRole) && !ctx.viewingAs;
  const admin = supabaseAdmin();
  const [{ data: bridge }, { data: coded }, { data: waiting }] = showBridge ? await Promise.all([
    admin.from('integrations').select('id, store_url, name, status, last_error, created_at').eq('role', 'bridge').eq('status', 'active').maybeSingle(),
    admin.from('organizations').select('id, name, client_code').not('client_code', 'is', null).order('client_code'),
    admin.from('orders').select('id, number, bridge_error, bridge_sent_at, status').or('bridge_error.not.is.null,and(bridge_sent_at.lt.' + new Date(Date.now() - 48 * 3600e3).toISOString() + ',status.in.(new,packed))').limit(20),
  ]) : [{ data: null }, { data: null }, { data: null }];
  const { data: events } = bridge ? await admin.from('integration_events').select('kind, detail, created_at').eq('integration_id', bridge.id).order('created_at', { ascending: false }).limit(8) : { data: null };

  return (
    <>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">Stores</p>
          <h1>Connected stores</h1>
          <p>{ctx.backOffice ? 'Every client store sending orders to the warehouse.' : 'Connect your store once: paid orders arrive here by themselves, and your customers get their tracking number when the parcel leaves.'}</p>
        </div>
      </div>

      {canConnect && (
        <div className="ep-connect-grid">
          {(['shopify', 'woocommerce'] as const).map((k) => (
            <Link key={k} href={`/integrations/new?kind=${k}`} className="ep-connect">
              <span className={`ep-store-mark ep-store-mark--${k}`} aria-hidden="true">{k === 'shopify' ? 'S' : 'W'}</span>
              <div>
                <b>{KIND_LABEL[k]}</b>
                <small>{k === 'shopify' ? 'Orders in, tracking and fulfilment back to Shopify.' : 'Orders in, order completed with the tracking note.'}</small>
              </div>
              <span className="ep-btn ep-btn--sm">Connect <Arrow /></span>
            </Link>
          ))}
        </div>
      )}

      <section className="ep-card ep-card--flush">
        <div className="ep-card-head ep-pad"><h2>Your stores</h2><span className="ep-muted ep-small">{list.length} connected</span></div>
        {list.length === 0 ? (
          <Empty title="No store connected yet" text="Pick Shopify or WooCommerce above. It takes about 5 minutes." />
        ) : (
          <div className="ep-tablewrap">
            <table className="ep-table">
              <thead><tr><th>Store</th>{ctx.backOffice && <th>Client</th>}<th>Platform</th><th className="ep-right">Orders imported</th><th>Last check</th><th>Status</th></tr></thead>
              <tbody>
                {list.map((i) => {
                  const [l, tone] = STORE_STATUS[i.status] ?? ['—', 'mute'];
                  return (
                    <tr key={i.id} data-href={`/integrations/${i.id}`}>
                      <td><b>{i.name ?? i.store_url}</b><small>{i.store_url.replace(/^https:\/\//, '')}</small></td>
                      {ctx.backOffice && <td><small className="ep-client">{names[i.org_id]}</small></td>}
                      <td><span className={`ep-store-chip ep-store-chip--${i.kind}`}>{KIND_LABEL[i.kind]}</span></td>
                      <td className="ep-right"><b>{i.orders_imported.toLocaleString('en')}</b></td>
                      <td><small>{i.last_sync_at ? fmtDate(i.last_sync_at, true) : 'Live updates only'}</small></td>
                      <td><span className={`ep-st ep-st--${i.last_error && i.status === 'active' ? 'warn' : tone}`}>{i.last_error && i.status === 'active' ? 'Check' : l}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showBridge && (
        <section className="ep-card ep-card--team" id="bridge" style={{ marginBottom: '1.2rem' }}>
          <div className="ep-card-head">
            <h2>Warehouse partner · bridge store</h2>
            <span className={`ep-st ep-st--${bridge ? (bridge.last_error ? 'warn' : 'ok') : 'mute'}`}>{bridge ? (bridge.last_error ? 'Check' : 'Connected') : 'Not connected'}</span>
          </div>
          <p className="ep-small" style={{ marginBottom: '.8rem' }}>Clients’ orders are copied to your own Shopify store (the bridge), where the partner (ST Fulfill) picks them up. Whatever the partner does there — on hold, shipped with tracking, delivered, cancelled — comes back here and then to the client’s store. Clients never see the bridge or the partner.</p>
          {bridge ? (
            <>
              <p className="ep-small"><b>{bridge.name}</b> · {bridge.store_url} · connected {fmtDate(bridge.created_at)}</p>
              {bridge.last_error && <p className="ep-note ep-note--warn">{bridge.last_error}</p>}
              <div className="ep-subblock">
                <div className="ep-card-head"><h3>Clients shipping through it</h3><span className="ep-muted ep-small">{(coded ?? []).length}</span></div>
                {(coded ?? []).length === 0 ? <Empty title="None yet" text="Open a client and give it a client code (Warehouse partner & payment)." /> : (
                  <div className="ep-tablewrap"><table className="ep-table">
                    <thead><tr><th>Code</th><th>Client</th></tr></thead>
                    <tbody>{(coded ?? []).map((c) => <tr key={c.id} data-href={`/clients/${c.id}#partner`}><td><b className="ep-mono">{c.client_code}</b></td><td><Link href={`/clients/${c.id}#partner`}>{c.name}</Link></td></tr>)}</tbody>
                  </table></div>
                )}
              </div>
              {(waiting ?? []).length > 0 && (
                <div className="ep-subblock">
                  <div className="ep-card-head"><h3>Needs a look</h3><span className="ep-st ep-st--warn">{(waiting ?? []).length}</span></div>
                  <div className="ep-tablewrap"><table className="ep-table">
                    <thead><tr><th>Order</th><th>What’s wrong</th></tr></thead>
                    <tbody>{(waiting ?? []).map((o) => (
                      <tr key={o.id} data-href={`/orders/${o.id}#links`}><td><Link href={`/orders/${o.id}#links`}><b>#{o.number}</b></Link></td><td><small>{o.bridge_error ? `Not at the warehouse: ${o.bridge_error}` : `At the warehouse since ${fmtDate(o.bridge_sent_at, true)}, not shipped — check stock and payment in ST Fulfill`}</small></td></tr>
                    ))}</tbody>
                  </table></div>
                </div>
              )}
              {(events ?? []).length > 0 && (
                <details className="ep-edit">
                  <summary><span>Latest activity</span><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5.5 8l4.5 4.5L14.5 8" /></svg></summary>
                  <ul className="ep-activity">{(events ?? []).map((e, k) => <li key={k}><b>{e.kind === 'error' ? 'Problem' : 'Update'}</b><span>{e.detail}</span><small>{fmtDate(e.created_at, true)}</small></li>)}</ul>
                </details>
              )}
              <div className="ep-form-foot" style={{ gap: '.5rem' }}>
                <form action={bridgeSyncNow}><Submit className="ep-btn ep-btn--sm">Check the warehouse now</Submit></form>
                {ctx.staffRole === 'owner' && <form action={disconnectBridge}><Submit className="ep-btn ep-btn--sm ep-btn--ghost" confirm="Switch off the bridge? New orders will stay here until you connect it again.">Switch off</Submit></form>}
              </div>
            </>
          ) : (
            <>
              <ol className="ep-small" style={{ paddingLeft: '1.2rem', display: 'grid', gap: '.3rem', marginBottom: '.9rem' }}>
                <li>Signed in as the owner of the bridge store, open <b>dev.shopify.com/dashboard</b> and click <b>Create app</b>. Name it “Elmamsflow”.</li>
                <li>In the app version, set the <b>Admin API scopes</b>:<br /><code className="ep-scopes">{BRIDGE_SCOPES.join(', ')}</code></li>
                <li>Under <b>Protected customer data</b>, allow access to <b>name, phone and address</b> — the warehouse needs them to ship.</li>
                <li><b>Release</b> the version, then <b>Install</b> the app on the bridge store.</li>
                <li>Open the app’s <b>Settings</b> and copy the <b>Client ID</b> and <b>Client secret</b> below.</li>
                <li>In ST Fulfill, connect this same store (Store Management).</li>
              </ol>
              <form action={connectBridge} className="ep-form" style={{ maxWidth: '34rem' }}>
                <label>Bridge store address<input name="store" placeholder="elmamsflow-bridge.myshopify.com" required autoComplete="off" /></label>
                <label>Client ID<input name="client_id" autoComplete="off" /></label>
                <label>Client secret<input name="client_secret" type="password" autoComplete="off" /></label>
                <details className="ep-edit">
                  <summary><span>Older custom app instead (Admin API token)</span></summary>
                  <label>Admin API access token<input name="token" type="password" autoComplete="off" /></label>
                  <label>API secret key<input name="api_secret" type="password" autoComplete="off" /></label>
                </details>
                <Submit className="ep-btn">Connect the bridge store</Submit>
              </form>
            </>
          )}
        </section>
      )}

      <section className="ep-card">
        <h2>How it works</h2>
        <ol className="ep-how">
          <li><b>Paid orders come in</b><span>As soon as a customer pays, the order appears in Orders, matched to your products by SKU.</span></li>
          <li><b>We pick, pack and ship</b><span>Stock is reserved and the warehouse ships it from China.</span></li>
          <li><b>Tracking goes back</b><span>The order is marked fulfilled in your store with the tracking number, and your customer is notified.</span></li>
          <li><b>Nothing gets lost</b><span>Unknown SKUs or missing customs info put the order on hold here, with the reason, until it’s fixed.</span></li>
        </ol>
      </section>
    </>
  );
}
