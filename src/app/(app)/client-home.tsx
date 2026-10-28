import Link from 'next/link';
import type { Ctx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { allRows, available, getProductsWithKits } from '@/lib/data';
import { fmtDays, runway, salesByProduct } from '@/lib/insights';
import { CARRIER_STATUS, countryName, fmtDate, greeting } from '@/lib/format';
import { CATEGORY, computeCharges, getRateCard, invoiceTz, money, monthBounds, ymOf } from '@/lib/billing';
import { getNotices } from '@/lib/notifications';
import { dayKey } from '@/lib/orders-overview';
import { NoticeIcon } from '@/components/notices';
import { CountUp } from '@/components/orders-overview';
import { Bars, FlowChart, PipeRing } from '@/components/viz';
import { MiniSteps } from '@/components/steps';
import { Arrow, Thumb } from '@/components/ui';
import { Reveal } from '@/components/client';

const TZ = 'Asia/Shanghai';
const DAYS = 30;

type Lite = { id: string; status: string; created_at: string; shipped_at: string | null; delivered_at: string | null; country: string };
type Moving = { id: string; number: string; city: string | null; country: string; tracking_status: string | null; tracking_last_event: string | null; tracking_last_location: string | null; tracking_last_event_at: string | null; shipped_at: string | null; tracking_eta: string | null };

/** The brand's home: one long, calm page that tells the story of their business with us, top to bottom. */
export async function ClientHome({ ctx, welcome }: { ctx: Ctx; welcome: boolean }) {
  const org = ctx.org!;
  const sb = await supabaseServer();
  const now = Date.now();
  const since = new Date(now - DAYS * 864e5).toISOString();
  const tz = await invoiceTz();
  const billing = ctx.can('invoices.view');

  const [{ products }, sales30, recent, open, moving, inbounds, notices, co, stores, everInbound, rates] = await Promise.all([
    getProductsWithKits(ctx),
    salesByProduct(ctx, DAYS),
    allRows<Lite>(() => sb.from('orders').select('id, status, created_at, shipped_at, delivered_at, country').eq('org_id', org.id)
      .or(`created_at.gte.${since},shipped_at.gte.${since},delivered_at.gte.${since}`).order('created_at').order('id')),
    allRows<{ id: string; status: string }>(() => sb.from('orders').select('id, status').eq('org_id', org.id).in('status', ['new', 'on_hold', 'packed', 'shipped']).order('id')),
    sb.from('orders').select('id, number, city, country, tracking_status, tracking_last_event, tracking_last_location, tracking_last_event_at, shipped_at, tracking_eta')
      .eq('org_id', org.id).eq('status', 'shipped').order('tracking_last_event_at', { ascending: false, nullsFirst: false }).limit(5),
    sb.from('inbounds').select('id, ref, status, eta, supplier, inbound_items(expected)').eq('org_id', org.id).neq('status', 'received').order('eta', { ascending: true, nullsFirst: false }).limit(4),
    getNotices(ctx),
    sb.from('organizations').select('legal_name, billing_address, invoice_email, vat_number, logo_path').eq('id', org.id).maybeSingle(),
    ctx.can('integrations.manage') ? supabaseAdmin().from('integrations').select('id, kind, name, status, last_sync_at, orders_imported').eq('org_id', org.id).neq('status', 'disconnected') : Promise.resolve({ data: [] as { id: string; kind: string; name: string | null; status: string; last_sync_at: string | null; orders_imported: number }[] }),
    sb.from('inbounds').select('id', { count: 'exact', head: true }).eq('org_id', org.id),
    billing ? getRateCard(org.id) : Promise.resolve(null),
  ]);

  // ---------- Orders: today, the last 30 days, right now ----------
  const today = dayKey(new Date());
  const keys = Array.from({ length: DAYS }, (_, i) => dayKey(new Date(now - (DAYS - 1 - i) * 864e5)));
  const rec = new Map(keys.map((k) => [k, 0]));
  const out = new Map(keys.map((k) => [k, 0]));
  let todayIn = 0, todayOut = 0, delivered7 = 0;
  for (const o of recent) {
    const c = dayKey(o.created_at);
    if (o.status !== 'cancelled' && rec.has(c)) { rec.set(c, rec.get(c)! + 1); if (c === today) todayIn++; }
    if (o.shipped_at && ['shipped', 'delivered'].includes(o.status)) { const s = dayKey(o.shipped_at); if (out.has(s)) out.set(s, out.get(s)! + 1); if (s === today) todayOut++; }
    if (o.delivered_at && o.status === 'delivered' && now - Date.parse(o.delivered_at) < 7 * 864e5) delivered7++;
  }
  const series = keys.map((k) => ({ label: new Date(`${k}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), received: rec.get(k)!, shipped: out.get(k)! }));
  const month = series.reduce((a, d) => a + d.received, 0);
  const pipe = { new: 0, on_hold: 0, packed: 0, shipped: 0 } as Record<string, number>;
  for (const o of open) pipe[o.status]++;

  // ---------- Delivery ----------
  const trips = recent.filter((o) => o.delivered_at && o.shipped_at && o.status === 'delivered' && Date.parse(o.delivered_at) >= Date.parse(since))
    .map((o) => (Date.parse(o.delivered_at!) - Date.parse(o.shipped_at!)) / 864e5);
  const avgTrip = trips.length ? trips.reduce((a, b) => a + b, 0) / trips.length : null;
  const onTime = trips.length ? Math.round((trips.filter((d) => d <= 9).length / trips.length) * 100) : null;
  const markets = new Map<string, number>();
  for (const o of recent) if (o.shipped_at && Date.parse(o.shipped_at) >= Date.parse(since)) markets.set(o.country, (markets.get(o.country) ?? 0) + 1);
  const topMarkets = [...markets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // ---------- Stock ----------
  const items = products.filter((p) => p.kind !== 'bundle');
  const health = items.map((p) => ({ p, r: runway(p, sales30.get(p.id) ?? 0) }));
  const sellable = items.reduce((a, p) => a + available(p), 0);
  const incoming = items.reduce((a, p) => a + p.incoming, 0);
  const reorder = health.filter((x) => x.r.health === 'critical' || x.r.health === 'out').sort((a, b) => (a.r.days ?? -1) - (b.r.days ?? -1));
  const daily = items.reduce((a, p) => a + (sales30.get(p.id) ?? 0), 0) / DAYS;
  const coverDays = daily > 0 ? sellable / daily : null;
  const best = health.filter((x) => x.r.sold30 > 0).sort((a, b) => b.r.sold30 - a.r.sold30).slice(0, 5);
  const healthy = health.filter((x) => x.r.health === 'healthy').length;

  // ---------- This month's bill ----------
  let bill: Awaited<ReturnType<typeof computeCharges>> | null = null;
  if (rates) {
    const { start } = monthBounds(ymOf(new Date(), tz), tz);
    bill = await computeCharges(org.id, rates, start, new Date()).catch(() => null);
  }
  const billCats = bill ? Object.entries(bill.lines.reduce<Record<string, number>>((a, l) => ({ ...a, [l.category]: (a[l.category] ?? 0) + l.amount }), {})).sort((a, b) => b[1] - a[1]) : [];
  const monthName = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: TZ }).format(new Date());

  // ---------- Story line ----------
  const urgent = notices.filter((n) => n.level === 'action');
  const name = ctx.viewingAs ? org.name : ctx.name.split(' ')[0];
  const dateLine = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(new Date());
  const profile = co.data;
  const profileDone = profile ? [profile.legal_name, profile.billing_address, profile.invoice_email, profile.vat_number, profile.logo_path].filter(Boolean).length : 0;
  const started = products.length > 0 && (everInbound.count ?? 0) > 0 && (month > 0 || open.length > 0);
  const storeList = stores.data ?? [];

  return (
    <div className="ep-ch">
      {/* 1 · Hello */}
      <header className="ep-ch-hero">
        <div className="ep-ch-hero-txt">
          <p className="ep-crumb">{dateLine}</p>
          <h1>{greeting()}, {name}.</h1>
          <p className="ep-ch-lede">
            {pipe.shipped > 0 ? <><b><CountUp value={pipe.shipped} /> parcel{pipe.shipped === 1 ? '' : 's'}</b> on the way to your customers</> : month ? <>Your last {DAYS} days at a glance</> : <>Welcome to your fulfilment centre in China</>}
            {pipe.new + pipe.packed > 0 ? <>, <b>{(pipe.new + pipe.packed).toLocaleString('en')}</b> being prepared</> : null}
            {urgent.length ? <>, and <a href="#needs" className="ep-crit">{urgent.length} thing{urgent.length === 1 ? '' : 's'} need{urgent.length === 1 ? 's' : ''} you</a>.</> : <>. <span className="ep-good">Everything is on track.</span></>}
          </p>
          <div className="ep-ch-cta">
            {ctx.can('orders.create') && <Link className="ep-btn" href="/orders/new">New order <Arrow /></Link>}
            {ctx.can('inbounds.create') && <Link className="ep-btn ep-btn--ghost" href="/inbounds/new">Send us stock</Link>}
            {ctx.can('orders.create') && <Link className="ep-btn ep-btn--ghost" href="/orders/import">Import orders</Link>}
          </div>
        </div>
        <div className="ep-ch-today" aria-label="Today">
          <div><small>Received today</small><b><CountUp value={todayIn} /></b></div>
          <div><small>Shipped today</small><b><CountUp value={todayOut} /></b></div>
          <div><small>Delivered · 7 days</small><b><CountUp value={delivered7} /></b></div>
          <div><small>Sellable units</small><b><CountUp value={sellable} /></b></div>
        </div>
      </header>

      {(welcome || !started) && (
        <section className="ep-ch-start ep-reveal">
          <p className="ep-eyebrow"><i />Getting started</p>
          <h2>Three steps to your first parcel.</h2>
          <ol>
            <li className={products.length ? 'done' : ''}><span>1</span><b>Add your products</b><small>SKU, weight, HS code and customs value — or import them from your store.</small><Link href="/inventory/new">Add a product →</Link></li>
            <li className={everInbound.count ? 'done' : ''}><span>2</span><b>Send us your stock</b><small>Tell us what your factory is sending, so we can receive it fast.</small><Link href="/inbounds/new">Announce an inbound →</Link></li>
            <li className={month || open.length ? 'done' : ''}><span>3</span><b>Ship your first order</b><small>Connect your store, import a CSV, or create one by hand.</small><Link href="/orders/new">Create an order →</Link></li>
          </ol>
        </section>
      )}

      {/* 2 · What needs you */}
      <section className="ep-ch-sec ep-reveal" id="needs">
        <div className="ep-ch-title"><p className="ep-eyebrow"><i />For you</p><h2>{notices.length ? 'A few things need you.' : 'Nothing needs you.'}</h2><p>{notices.length ? 'Each item disappears by itself once it’s fixed.' : 'Orders are flowing, stock is in, invoices are paid. Enjoy the calm.'}</p></div>
        {notices.length > 0 ? (
          <ul className="ep-ch-needs">
            {notices.slice(0, 6).map((n, i) => (
              <li key={n.key} className={`is-${n.level}`} style={{ animationDelay: `${i * 60}ms` }}>
                <NoticeIcon kind={n.kind} level={n.level} />
                <span><b>{n.title}</b><small>{n.detail}</small></span>
                <Link className="ep-ch-pill" href={n.href}>{n.cta}</Link>
              </li>
            ))}
            {notices.length > 6 && <li className="ep-ch-more"><Link href="/notifications">See all {notices.length} →</Link></li>}
          </ul>
        ) : (
          <div className="ep-ch-calm"><span aria-hidden="true">✓</span><b>All clear</b></div>
        )}
      </section>

      {/* 3 · Orders */}
      <section className="ep-ch-sec ep-reveal">
        <div className="ep-ch-title"><p className="ep-eyebrow"><i />Orders</p><h2>{month ? <><CountUp value={month} /> orders in {DAYS} days.</> : 'Your orders, right now.'}</h2><p>Every order from your store, CSV or by hand, from the moment it lands to the day it’s delivered.</p></div>
        <div className="ep-ch-grid">
          <div className="ep-ch-panel"><FlowChart series={series} names={['Received', 'Shipped']} every={5} /></div>
          <div className="ep-ch-panel">
            <PipeRing parts={[
              ['To pack', pipe.new, 'var(--blue)', '/orders?s=new'],
              ['On hold', pipe.on_hold, 'var(--warn-2)', '/orders?t=attention'],
              ['Packed', pipe.packed, 'var(--violet)', '/orders?s=packed'],
              ['On the way', pipe.shipped, 'var(--ok)', '/tracking'],
            ]} />
          </div>
        </div>
        <p className="ep-ch-more-link"><Link href="/orders">All orders <Arrow /></Link></p>
      </section>

      {/* 4 · On the road */}
      <section className="ep-ch-sec ep-reveal">
        <div className="ep-ch-title"><p className="ep-eyebrow"><i />Delivery</p><h2>{avgTrip !== null ? <>Door to door in {avgTrip.toFixed(1)} days.</> : 'On the road.'}</h2><p>Duties and taxes paid (DDP) — your customers never pay at the door. Live updates from the carrier.</p></div>
        <div className="ep-ch-grid ep-ch-grid--road">
          <div className="ep-ch-panel ep-ch-speed">
            <div className="ep-ch-gauge" style={{ ['--p' as string]: onTime ?? 0 }}><b>{onTime !== null ? `${onTime}%` : '—'}</b><small>within 9 days</small></div>
            <p>{trips.length ? `${trips.length.toLocaleString('en')} parcels delivered in the last ${DAYS} days.` : 'Delivery times appear after your first parcels arrive.'}</p>
            {topMarkets.length > 0 && <Bars rows={topMarkets.map(([c, n]) => ({ key: c, label: countryName(c), n }))} />}
          </div>
          <div className="ep-ch-panel">
            <h3>Latest from the carriers</h3>
            {(moving.data ?? []).length === 0 ? <p className="ep-muted ep-small">No parcel on the road right now.</p> : (
              <ol className="ep-ch-road">
                {((moving.data ?? []) as Moving[]).map((o) => (
                  <li key={o.id}>
                    <Link href={`/orders/${o.id}#carrier`}>
                      <span className={`ep-ch-dot ep-ch-dot--${CARRIER_STATUS[o.tracking_status ?? '']?.[1] ?? 'go'}`} aria-hidden="true" />
                      <span><b>#{o.number} · {[o.city, countryName(o.country)].filter(Boolean).join(', ')}</b><small>{o.tracking_last_event ?? 'Handed to the carrier'}{o.tracking_last_location ? ` · ${o.tracking_last_location}` : ''}</small></span>
                      <em>{o.tracking_last_event_at ? fmtDate(o.tracking_last_event_at) : fmtDate(o.shipped_at)}</em>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
            <p className="ep-ch-more-link"><Link href="/tracking">All tracking <Arrow /></Link></p>
          </div>
        </div>
      </section>

      {/* 5 · Stock */}
      <section className="ep-ch-sec ep-reveal">
        <div className="ep-ch-title"><p className="ep-eyebrow"><i />Inventory</p><h2>{coverDays !== null ? <>Enough stock for {coverDays >= 365 ? 'over a year' : coverDays >= 60 ? `${Math.round(coverDays / 30)} months` : `${Math.floor(coverDays)} days`}.</> : items.length ? 'Your stock, on our shelves.' : 'Your shelves are ready.'}</h2><p>{items.length ? `${sellable.toLocaleString('en')} units ready to ship across ${items.length} product${items.length === 1 ? '' : 's'}${incoming ? `, ${incoming.toLocaleString('en')} more on the way` : ''}.` : 'Add your products and send us stock to get started.'}</p></div>
        <div className="ep-ch-grid">
          <div className="ep-ch-panel">
            <h3>{reorder.length ? 'Time to reorder' : 'Stock health'}</h3>
            {reorder.length === 0 ? (
              <div className="ep-ch-health"><b>{healthy}</b><span>of {items.length} products have more than 6 weeks of stock.</span></div>
            ) : (
              <ul className="ep-ch-reorder">
                {reorder.slice(0, 4).map(({ p, r }) => (
                  <li key={p.id}>
                    <Thumb id={p.id} photo={p.photo_path} name={p.name} size={40} />
                    <Link href={`/inventory/${p.id}`}><b>{p.name}</b><small>{p.sku} · {r.health === 'out' ? 'out of stock' : `${fmtDays(r.days)} left`}</small></Link>
                    <span><small>Send</small><b>{r.reorder.toLocaleString('en')}</b></span>
                  </li>
                ))}
              </ul>
            )}
            {reorder.length > 0 && ctx.can('inbounds.create') && <Link className="ep-btn ep-btn--sm" href="/inbounds/new" style={{ marginTop: '.8rem' }}>Send stock <Arrow /></Link>}
          </div>
          <div className="ep-ch-panel">
            <h3>On its way to us</h3>
            {(inbounds.data ?? []).length === 0 ? <p className="ep-muted ep-small">No inbound on the way. Announce one when your factory ships, and we’ll be ready to receive it.</p> : (
              <ul className="ep-ch-in">
                {(inbounds.data ?? []).map((b) => {
                  const late = !!b.eta && b.eta < new Date().toISOString().slice(0, 10);
                  return (
                    <li key={b.id}>
                      <Link href={`/inbounds/${b.id}`}><b className="ep-mono">{b.ref}</b><small>{(b.inbound_items as { expected: number }[]).reduce((a, i) => a + i.expected, 0).toLocaleString('en')} units{b.supplier ? ` · ${b.supplier}` : ''}</small></Link>
                      <MiniSteps status={b.status} overdue={late} />
                      <small className={late ? 'ep-late' : ''}>{b.eta ? `${late ? 'Late · ' : 'ETA '}${fmtDate(b.eta)}` : 'No ETA'}</small>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* 6 · Best sellers */}
      {best.length > 0 && (
        <section className="ep-ch-sec ep-reveal">
          <div className="ep-ch-title"><p className="ep-eyebrow"><i />Best sellers</p><h2>What your customers love.</h2><p>Units shipped in the last {DAYS} days.</p></div>
          <ol className="ep-ch-best">
            {best.map(({ p, r }, i) => (
              <li key={p.id} style={{ animationDelay: `${i * 70}ms` }}>
                <span className="ep-ch-rank">{i + 1}</span>
                <Thumb id={p.id} photo={p.photo_path} name={p.name} size={56} />
                <Link href={`/inventory/${p.id}`}><b>{p.name}</b><small>{p.sku}</small></Link>
                <span className="ep-ch-best-bar" aria-hidden="true"><i style={{ width: `${(r.sold30 / best[0].r.sold30) * 100}%`, animationDelay: `${200 + i * 70}ms` }} /></span>
                <span className="ep-ch-best-n"><b>{r.sold30.toLocaleString('en')}</b><small>{r.days !== null ? `${fmtDays(r.days)} of stock` : 'units'}</small></span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 7 · Money */}
      {billing && (
        <section className="ep-ch-sec ep-reveal">
          <div className="ep-ch-title"><p className="ep-eyebrow"><i />Billing</p><h2>{bill ? <>{monthName} so far: {money(bill.total, rates!.currency)}.</> : 'Simple, monthly billing.'}</h2><p>{bill ? `${bill.stats.orders} order${bill.stats.orders === 1 ? '' : 's'} shipped this month${bill.stats.orders ? `, about ${money((bill.lines.filter((l) => ['fulfillment', 'packaging', 'shipping', 'customs'].includes(l.category)).reduce((a, l) => a + l.amount, 0)) / bill.stats.orders, rates!.currency)} each, shipping included` : ''}. One invoice on the 1st.` : 'Your price list is being set up by your account manager.'}</p></div>
          {bill && billCats.length > 0 && <div className="ep-ch-panel"><Bars rows={billCats.map(([c, n]) => ({ key: c, label: CATEGORY[c] ?? c, n: Math.round(n) }))} unit={rates!.currency} /></div>}
          <p className="ep-ch-more-link"><Link href="/pricing">Your pricing <Arrow /></Link><Link href="/invoices">Invoices <Arrow /></Link></p>
        </section>
      )}

      {/* 8 · Your brand */}
      <section className="ep-ch-sec ep-reveal">
        <div className="ep-ch-title"><p className="ep-eyebrow"><i />Your workspace</p><h2>Everything in one place.</h2></div>
        <div className="ep-ch-tiles">
          <Link href="/reports" className="ep-ch-tile"><b>Monthly report</b><small>Orders, delivery, best sellers and costs — ready to print.</small></Link>
          <Link href="/settings/company" className="ep-ch-tile"><b>Company profile</b><small>{profileDone === 5 ? 'Complete. Used on every invoice.' : `${profileDone} of 5 details filled in`}</small><span className="ep-ch-tile-meter" aria-hidden="true"><i style={{ width: `${profileDone * 20}%` }} /></span></Link>
          {ctx.can('integrations.manage') && <Link href="/integrations" className="ep-ch-tile"><b>Stores</b><small>{storeList.length ? `${storeList.length} connected · ${storeList.reduce((a, s) => a + (s.orders_imported ?? 0), 0).toLocaleString('en')} orders imported` : 'Connect Shopify or WooCommerce: orders arrive by themselves.'}</small></Link>}
          <Link href="/support/new" className="ep-ch-tile"><b>Talk to us</b><small>A real person replies, usually within the hour.</small></Link>
        </div>
      </section>

      <Reveal />
    </div>
  );
}
