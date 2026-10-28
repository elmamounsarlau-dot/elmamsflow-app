'use client';

import { useMemo, useState } from 'react';

type Rates = { currency: string; pick_pack_order: number; pick_pack_extra_unit: number; packaging_order: number; shipping_base: number; shipping_per_kg: number; ddp_order: number };

const fmt = (n: number, c: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: c || 'USD' }).format(n);

/** "What would an order cost?" — move the sliders, see the price per order and per month. */
export function Estimator({ rates }: { rates: Rates }) {
  const [items, setItems] = useState(1);
  const [grams, setGrams] = useState(450);
  const [orders, setOrders] = useState(300);
  const one = useMemo(() => {
    const kg = Math.max(1, Math.ceil(grams / 1000));
    const parts = [
      ['Pick & pack', rates.pick_pack_order + Math.max(0, items - 1) * rates.pick_pack_extra_unit],
      ['Packaging', rates.packaging_order],
      ['Shipping', rates.shipping_base + kg * rates.shipping_per_kg],
      ['DDP customs', rates.ddp_order],
    ] as [string, number][];
    return { parts: parts.filter(([, n]) => n > 0), total: parts.reduce((a, [, n]) => a + n, 0), kg };
  }, [items, grams, rates]);
  const c = rates.currency;
  return (
    <section className="ep-est" aria-labelledby="est-h">
      <div className="ep-est-in">
        <h2 id="est-h">What does one order cost?</h2>
        <p>Move the sliders to match a typical order.</p>
        <label>
          <span>Items in the parcel <b>{items}</b></span>
          <input type="range" min={1} max={10} value={items} onChange={(e) => setItems(+e.target.value)} />
        </label>
        <label>
          <span>Parcel weight <b>{grams >= 1000 ? `${(grams / 1000).toFixed(1)} kg` : `${grams} g`}</b><small>billed as {one.kg} kg</small></span>
          <input type="range" min={100} max={5000} step={50} value={grams} onChange={(e) => setGrams(+e.target.value)} />
        </label>
        <label>
          <span>Orders a month <b>{orders.toLocaleString('en')}</b></span>
          <input type="range" min={10} max={5000} step={10} value={orders} onChange={(e) => setOrders(+e.target.value)} />
        </label>
      </div>
      <div className="ep-est-out" aria-live="polite">
        <small>Per order, door to door</small>
        <b>{fmt(one.total, c)}</b>
        <ul>{one.parts.map(([l, n]) => <li key={l}><span>{l}</span><span>{fmt(n, c)}</span></li>)}</ul>
        <div className="ep-est-month"><span>{orders.toLocaleString('en')} orders a month</span><b>{fmt(one.total * orders, c)}</b></div>
        <small>Plus receiving and storage for the stock you send us.</small>
      </div>
    </section>
  );
}
