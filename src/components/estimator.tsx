'use client';

import { useEffect, useMemo, useState } from 'react';
import { quoteParcel, type ShipOption } from '@/app/(app)/pricing/actions';

type Rates = { currency: string; pick_pack_order: number; pick_pack_extra_unit: number; packaging_order: number; ddp_order: number };
type Opt = [string, string];

const fmt = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(n);

/** "What does one order cost?" — move the sliders, see the price per order and per month. Shipping is the client's
 *  price on each shipping line (same as the Shipping rates page), to the gram, worked out on the server. */
export function Estimator({ rates, countries, types }: { rates: Rates; countries: Opt[]; types: Opt[] }) {
  const [items, setItems] = useState(1);
  const [grams, setGrams] = useState(450);
  const [orders, setOrders] = useState(300);
  const [country, setCountry] = useState(countries.find(([k]) => k === 'US')?.[0] ?? countries[0]?.[0] ?? '');
  const [type, setType] = useState(types[0]?.[0] ?? 'general');
  const [ship, setShip] = useState<{ key: string; options: ShipOption[]; error?: string } | null>(null);
  const key = `${country}|${type}|${grams}`;

  useEffect(() => {
    if (!country) return;
    let live = true;
    const t = setTimeout(() => {
      quoteParcel(country, type, grams)
        .then((r) => { if (live) setShip('error' in r ? { key, options: [], error: r.error } : { key, options: r.options }); })
        .catch(() => { if (live) setShip({ key, options: [], error: 'Could not load shipping prices.' }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [country, type, grams, key]);

  const loading = !!country && ship?.key !== key;
  const best = !loading ? ship?.options[0] ?? null : null;
  const one = useMemo(() => {
    const parts = [
      ['Pick & pack', rates.pick_pack_order + Math.max(0, items - 1) * rates.pick_pack_extra_unit],
      ['Packaging', rates.packaging_order],
      [best ? `Shipping · ${best.label}` : 'Shipping', best?.price ?? 0],
      ['DDP customs', rates.ddp_order],
    ] as [string, number][];
    return { parts: parts.filter(([, n]) => n > 0), total: parts.reduce((a, [, n]) => a + n, 0) };
  }, [items, best, rates]);
  const c = rates.currency;
  const weight = grams >= 1000 ? `${(grams / 1000).toFixed(2)} kg` : `${grams} g`;

  return (
    <section className="ep-est" aria-labelledby="est-h">
      <div className="ep-est-in">
        <h2 id="est-h">What does one order cost?</h2>
        <p>Move the sliders to match a typical order.</p>
        <div className="ep-est-pick">
          <label><span>Ship to</span>
            <select value={country} onChange={(e) => setCountry(e.target.value)} disabled={!countries.length}>
              {countries.length ? countries.map(([k, n]) => <option key={k} value={k}>{n}</option>) : <option value="">No countries yet</option>}
            </select>
          </label>
          <label><span>Product type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>{types.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
          </label>
        </div>
        <label>
          <span>Items in the parcel <b>{items}</b></span>
          <input type="range" min={1} max={10} value={items} onChange={(e) => setItems(+e.target.value)} />
        </label>
        <label>
          <span>Parcel weight <b>{weight}</b><small>{best ? `billed as ${best.kg.toFixed(3)} kg` : 'billed to the gram'}</small></span>
          <input type="range" min={50} max={5000} step={10} value={grams} onChange={(e) => setGrams(+e.target.value)} />
        </label>
        <label>
          <span>Orders a month <b>{orders.toLocaleString('en')}</b></span>
          <input type="range" min={10} max={5000} step={10} value={orders} onChange={(e) => setOrders(+e.target.value)} />
        </label>
      </div>
      <div className="ep-est-out" aria-live="polite" aria-busy={loading}>
        <small>Per order, door to door</small>
        <b>{fmt(one.total, c)}</b>
        <ul>{one.parts.map(([l, n]) => <li key={l}><span>{l}</span><span>{fmt(n, c)}</span></li>)}</ul>
        {loading ? <p className="ep-est-ship">Checking shipping prices…</p>
          : ship?.error ? <p className="ep-est-ship">{ship.error}</p>
          : !best ? <p className="ep-est-ship">No shipping price for this weight and country yet. Ask us and we’ll quote it.</p>
          : ship!.options.length > 1 && (
            <ul className="ep-est-lines" aria-label="Other shipping options">
              {ship!.options.slice(1).map((o) => <li key={o.label}><span>{o.label}<small>{o.transit}</small></span><span>{fmt(o.price, c)}</span></li>)}
            </ul>
          )}
        <div className="ep-est-month"><span>{orders.toLocaleString('en')} orders a month</span><b>{fmt(one.total * orders, c)}</b></div>
        <small>Cheapest shipping option shown. Plus receiving and storage for the stock you send us.</small>
      </div>
    </section>
  );
}
