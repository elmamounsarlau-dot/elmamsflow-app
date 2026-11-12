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
              <p className="ep-small" style={{ margin: '.6rem 0 .3rem' }}>Clients shipping through it (client code → SKU prefix):</p>
              <p className="ep-small">{(coded ?? []).length ? (coded ?? []).map((c) => <span key={c.id} className="ep-chip" style={{ marginRight: '.35rem' }}><Link href={`/clients/${c.id}#partner`}>{c.client_code} · {c.name}</Link></span>) : <span className="ep-muted">None yet. Open a client and give it a code.</span>}</p>
              {(waiting ?? []).length > 0 && (
                <div className="ep-note ep-note--warn" style={{ marginTop: '.7rem' }}>
                  <b>Needs a look:</b>
                  <ul style={{ margin: '.3rem 0 0 1rem' }}>{(waiting ?? []).map((o) => <li key={o.id}><Link href={`/orders/${o.id}#links`}>#{o.number}</Link> · {o.bridge_error ? `not at the warehouse: ${o.bridge_error}` : `at the warehouse since ${fmtDate(o.bridge_sent_at, true)}, not shipped yet — check ST Fulfill (stock, payment)`}</li>)}</ul>
                </div>
              )}
              {(events ?? []).length > 0 && (
                <details className="ep-edit" style={{ marginTop: '.7rem' }}>
                  <summary><span>Latest activity</span></summary>
                  <ul className="ep-small" style={{ margin: '.4rem 0 0 1rem' }}>{(events ?? []).map((e, k) => <li key={k}>{fmtDate(e.created_at, true)} · {e.detail}</li>)}</ul>
                </details>
              )}
              <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem', flexWrap: 'wrap' }}>
                <form action={bridgeSyncNow}><Submit className="ep-btn ep-btn--sm">Check the warehouse now</Submit></form>
                {ctx.staffRole === 'owner' && <form action={disconnectBridge}><Submit className="ep-btn ep-btn--sm ep-btn--ghost" confirm="Switch off the bridge? New orders will stay here until you connect it again.">Switch off</Submit></form>}
              </div>
            </>
          ) : (
            <>
              <ol className="ep-small" style={{ paddingLeft: '1.2rem', display: 'grid', gap: '.3rem', marginBottom: '.9rem' }}>
                <li>In the bridge Shopify store: <b>Settings → Apps and sales channels → Develop apps → Create an app</b> (name it “Elmamsflow”).</li>
                <li><b>Configure Admin API scopes</b> and tick: <code>{BRIDGE_SCOPES.join(', ')}</code>. Save, then <b>Install app</b>.</li>
                <li>Copy the <b>Admin API access token</b> (shown once) and the <b>API secret key</b>, and paste them below.</li>
                <li>In ST Fulfill, connect this same store (Store Management).</li>
              </ol>
              <form action={connectBridge} className="ep-form" style={{ maxWidth: '34rem' }}>
                <label>Bridge store address<input name="store" placeholder="elmamsflow-bridge.myshopify.com" required autoComplete="off" /></label>
                <label>Admin API access token<input name="token" type="password" required autoComplete="off" /></label>
                <label>API secret key<input name="api_secret" type="password" required autoComplete="off" /></label>
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
