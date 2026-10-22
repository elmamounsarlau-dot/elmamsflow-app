import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { orgNames } from '@/lib/data';
import { fmtDate, siteUrl } from '@/lib/format';
import { trackKey, trackQuota } from '@/lib/track17';
import { CopyLink } from '@/components/client';
import { KIND_LABEL, STORE_STATUS, type Integration } from '@/lib/integrations/core';
import { Arrow, Empty } from '@/components/ui';

export const metadata = { title: 'Stores' };


export default async function Stores() {
  const ctx = await requireCtx();
  if (!ctx.can('integrations.manage')) redirect('/?err=' + encodeURIComponent('You don’t have access to stores.'));
  let q = supabaseAdmin().from('integrations').select('id, org_id, kind, store_url, name, status, last_sync_at, last_error, orders_imported, created_at').neq('status', 'disconnected').order('created_at', { ascending: false });
  if (ctx.org) q = q.eq('org_id', ctx.org.id);
  const [{ data }, names] = await Promise.all([q, ctx.backOffice ? orgNames() : Promise.resolve({} as Record<string, string>)]);
  const list = (data ?? []) as Integration[];
  const canConnect = !!ctx.org || ctx.backOffice;
  const showTrack = ctx.staffRole === 'owner' && !ctx.viewingAs;
  const quota = showTrack ? await trackQuota() : null;

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

      {showTrack && (
        <section className="ep-card ep-card--team" style={{ marginBottom: '1.2rem' }}>
          <div className="ep-card-head">
            <h2>Carrier tracking · 17TRACK</h2>
            <span className={`ep-st ep-st--${trackKey() ? (quota ? 'ok' : 'warn') : 'mute'}`}>{trackKey() ? (quota ? 'Connected' : 'Key set, not answering') : 'Not connected'}</span>
          </div>
          <p className="ep-small" style={{ marginBottom: '.8rem' }}>Every parcel that ships with a tracking number is followed automatically. Carrier updates arrive live; Delivered closes the order by itself.</p>
          {trackKey() ? (
            <>
              {quota && <p className="ep-small ep-muted" style={{ marginBottom: '.8rem' }}>Tracking quota: <b>{quota.quota_remain.toLocaleString('en')}</b> of {quota.quota_total.toLocaleString('en')} numbers left (1 per parcel).</p>}
              <p className="ep-small" style={{ marginBottom: '.4rem' }}>Webhook URL — paste it in 17TRACK → Settings → Webhook:</p>
              <CopyLink value={`${siteUrl()}/api/tracking/17track`} label="Copy URL" />
            </>
          ) : (
            <ol className="ep-small" style={{ paddingLeft: '1.2rem', display: 'grid', gap: '.3rem' }}>
              <li>Create an account at api.17track.net and copy your <b>Security Key</b> (Settings).</li>
              <li>Vercel → elmamsflow-app → Settings → Environment Variables: add <code>TRACK17_API_KEY</code> (Production, Sensitive), then redeploy.</li>
              <li>Come back here and copy the webhook URL into 17TRACK.</li>
            </ol>
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
