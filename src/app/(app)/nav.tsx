'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ICONS: Record<string, string> = {
  home: 'M3 9l7-6 7 6v8H3z',
  clients: 'M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 17c0-3 2.2-5 5-5s5 2 5 5M13 4.5a3 3 0 0 1 0 5.5M15 12c1.8.6 3 2.4 3 5',
  orders: 'M4 3h12v14H4zM7 7h6M7 10h6M7 13h4',
  inventory: 'M3 6l7-3 7 3v8l-7 3-7-3zM3 6l7 3 7-3M10 9v8',
  inbounds: 'M2 6h10v8H2zM12 9h4l2 3v2h-6',
  tracking: 'M10 18s6-5.3 6-9.5a6 6 0 0 0-12 0C4 12.7 10 18 10 18zM10 10.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  invoices: 'M5 2h10v16l-2-1.5L11 18l-2-1.5L7 18l-2-1.5zM8 7h4M8 10h4',
  support: 'M3 4h14v10H8l-4 3v-3H3z',
  team: 'M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5',
  activity: 'M2 10h3l2-5 3 10 2-5h6',
  bell: 'M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S5 12 5 8z M8.3 16.3a1.8 1.8 0 0 0 3.4 0',
  warehouses: 'M2 8l8-5 8 5v10H2zM6 18v-6h8v6M6 15h8',
  transfers: 'M3 7h12l-3-3M17 13H5l3 3',
  shipping: 'M2 6h10v8H2zM12 9h3.5L18 11.5V14h-6M5 16.5a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM14.5 16.5a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z',
  stores: 'M3 7l1.5-4h11L17 7M3 7v10h14V7M3 7c0 1.4 1.1 2.5 2.5 2.5S8 8.4 8 7c0 1.4 1 2.5 2 2.5s2-1.1 2-2.5c0 1.4 1.1 2.5 2.5 2.5S17 8.4 17 7M8 17v-4h4v4',
  settings: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8',
};

export type NavItem = { href: string; label: string; icon: string };

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav>
      {items.map((it) => {
        const on = it.href === '/' ? path === '/' : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={on ? 'is-on' : ''}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d={ICONS[it.icon]} />
            </svg>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
