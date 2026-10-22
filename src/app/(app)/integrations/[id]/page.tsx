import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { fmtDate } from '@/lib/format';
import { KIND_LABEL, STORE_STATUS, type Integration } from '@/lib/integrations/core';
import { webhookUrl } from '@/lib/integrations/service';
import { Arrow, Back, Empty } from '@/components/ui';
import { Submit } from '@/components/client';
import { disconnectStore, importStoreProducts, repairWebhooks, saveStoreSettings, syncNow } from '../actions';

const EVENT: Record<string, [string, string]> = {
  connected: ['Connected', 'ok'], imported: ['Order in', 'go'], cancelled: ['Cancelled', 'mute'], tracking_pushed: ['Tracking sent', 'ok'],
  products_imported: ['Products', 'pk'], error: ['Problem', 'err'],
};

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  if (!ctx.can('integrations.manage')) redirect('/');
  const { id } = await params;
  const admin = supabaseAdmin();
  const { data } = await admin.from('integrations').select('id, org_id, kind, store_url, name, status, settings, last_sync_at, last_error, orders_imported, created_at, organizations(name)').eq('id', id).neq('status', 'disconnected').maybeSingle();
  if (!data || (!ctx.staffRole && ctx.org?.id !== data.org_id) || (ctx.org && ctx.org.id !== data.org_id)) notFound();
  const i = data as unknown as Integration & { organizations: { name: string } | null };
  const [{ data: events }, { count: held }, { count: today }] = await Promise.all([
    admin.from('integration_events').select('id, kind, detail, created_at').eq('integration_id', id).order('created_at', { ascending: false }).limit(25),
    admin.from('orders').select('id', { count: 'exact', head: true }).eq('integration_id', id).eq('status', 'on_hold'),
    admin.from('orders').select('id', { count: 'exact', head: true }).eq('integration_id', id).gte('created_at', new Date(Date.now() - 864e5).toISOString()),
  ]);
  const [label, tone] = STORE_STATUS[i.status] ?? ['—', 'mute'];
  const s = i.settings ?? {};

  return (
    <>
      <Back href="/integrations">Stores</Back>
      <div className="ep-head">
        <div>
          <p className="ep-crumb">{ctx.backOffice && i.organizations ? `${i.organizations.name} · ` : ''}{KIND_LABEL[i.kind]}</p>
          <h1>{i.name ?? i.store_url} <span className={`ep-st ep-st--${tone}`}>{label}</span></h1>
          <p>{i.store_url.replace(/^https:\/\//, '')} · connected {fmtDate(i.created_at)}</p>
        </div>
        <div className="ep-actions">
          <Link className="ep-btn ep-btn--ghost" href={`/orders?src=${i.kind}`}>See its orders</Link>
        </div>
      </div>

      {i.last_error && (
        <div className="ep-fixbar" style={{ cursor: 'default' }}>
          <span><b>Last problem:</b> {i.last_error}</span>
          <form action={repairWebhooks}><input type="hidden" name="id" value={i.id} /><Submit className="ep-btn ep-btn--sm">Try again</Submit></form>
        </div>
      )}

      <div className="ep-sum">
        <div className="ep-sum-card"><small>Orders imported</small><b>{i.orders_imported.toLocaleString('en')}</b><span>Since it was connected</span></div>
        <div className="ep-sum-card"><small>Last 24 hours</small><b>{today ?? 0}</b><span>New orders from this store</span></div>
        <Link href={`/orders?t=attention&src=${i.kind}`} className={`ep-sum-card${held ? ' is-warn' : ''}`}><small>On hold</small><b>{held ?? 0}</b><span>{held ? 'Unknown SKU or customs info missing' : 'Nothing blocked'}</span></Link>
        <div className="ep-sum-card"><small>Last full check</small><b className="ep-sum-money">{i.last_sync_at ? fmtDate(i.last_sync_at, true) : '—'}</b><span>New orders also arrive live</span></div>
      </div>

      <div className="ep-grid2 ep-grid2--wide">
        <section className="ep-card ep-card--flush">
          <div className="ep-card-head ep-pad"><h2>What happened</h2><span className="ep-muted ep-small">Latest 25 events</span></div>
          {(events ?? []).length === 0 ? <Empty title="Waiting for the first order" text="Paid orders appear here as soon as your customers check out." /> : (
            <ul className="ep-events">
              {(events ?? []).map((e) => {
                const [l, t] = EVENT[e.kind] ?? [e.kind, 'mute'];
                return <li key={e.id}><span className={`ep-st ep-st--${t}`}>{l}</span><span>{e.detail}</span><small>{fmtDate(e.created_at, true)}</small></li>;
              })}
            </ul>
          )}
        </section>

        <div>
          <section className="ep-card">
            <h2>Check for orders now</h2>
            <p className="ep-small ep-muted" style={{ margin: '.3rem 0 .9rem' }}>New orders arrive by themselves. Use this if something seems missing — orders already here are never duplicated.</p>
            <form action={syncNow} className="ep-inline">
              <input type="hidden" name="id" value={i.id} />
              <select name="days" defaultValue="7" aria-label="How far back to check"><option value="1">Last 24 hours</option><option value="3">Last 3 days</option><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select>
              <Submit>Check now</Submit>
            </form>
          </section>

          {ctx.can('products.edit') && (
            <section className="ep-card">
              <h2>Import products</h2>
              <p className="ep-small ep-muted" style={{ margin: '.3rem 0 .9rem' }}>Adds every store product that isn’t in Elmamsflow yet, with its name, barcode and weight. Products without a SKU get one (SH-… / WC-…) and stay linked to the store, so their orders still match. Existing products are never changed.</p>
              <form action={importStoreProducts}><input type="hidden" name="id" value={i.id} /><Submit className="ep-btn ep-btn--ghost ep-btn--full">Import products from {KIND_LABEL[i.kind]}</Submit></form>
            </section>
          )}

          <section className="ep-card">
            <h2>Settings</h2>
            <form action={saveStoreSettings} className="ep-form" style={{ marginTop: '.6rem' }}>
              <input type="hidden" name="id" value={i.id} />
              <label className="ep-check"><input type="checkbox" name="auto_import" defaultChecked={s.auto_import !== false} />Import new paid orders automatically</label>
              <label className="ep-check"><input type="checkbox" name="push_tracking" defaultChecked={s.push_tracking !== false} />Send tracking to {KIND_LABEL[i.kind]} when an order ships</label>
              <label className="ep-check"><input type="checkbox" name="paused" defaultChecked={i.status === 'paused'} />Pause this connection</label>
              <Submit className="ep-btn ep-btn--ghost">Save settings</Submit>
            </form>
          </section>

          <section className="ep-card">
            <h2>Connection</h2>
            <dl className="ep-dl ep-dl--tight">
              <dt>Platform</dt><dd>{KIND_LABEL[i.kind]}</dd>
              <dt>Live updates</dt><dd><code className="ep-scopes">{webhookUrl(i).replace(/^https:\/\//, '')}</code></dd>
            </dl>
            <div className="ep-inline" style={{ marginTop: '1rem', justifyContent: 'space-between' }}>
              <form action={repairWebhooks}><input type="hidden" name="id" value={i.id} /><Submit className="ep-link">Set up live updates again</Submit></form>
              <form action={disconnectStore}><input type="hidden" name="id" value={i.id} /><Submit className="ep-link" confirm="Disconnect this store? Orders already imported stay here.">Disconnect</Submit></form>
            </div>
          </section>
        </div>
      </div>
      <p className="ep-small ep-muted ep-foot-note">Need help connecting? <Link href="/support/new">Ask us in Support</Link> <Arrow /></p>
    </>
  );
}
