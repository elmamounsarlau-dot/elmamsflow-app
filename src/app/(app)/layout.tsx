import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { requireCtx } from '@/lib/session';
import { Burger, ClickableRows, Flash, NavCloser } from '@/components/client';
import { Arrow } from '@/components/ui';
import { NavLinks, type NavItem } from './nav';
import { exitViewAs } from './view-as';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const items: NavItem[] = [];
  if (ctx.backOffice) {
    items.push({ href: '/', label: 'Overview', icon: 'home' });
    if (ctx.can('clients.view')) items.push({ href: '/clients', label: 'Clients', icon: 'clients' });
    items.push({ href: '/orders', label: 'Orders', icon: 'orders' }, { href: '/inventory', label: 'Inventory', icon: 'inventory' }, { href: '/inbounds', label: 'Stock inbounds', icon: 'inbounds' }, { href: '/tracking', label: 'Tracking', icon: 'tracking' });
    if (ctx.can('support.reply')) items.push({ href: '/support', label: 'Support', icon: 'support' });
    if (ctx.can('invoices.view')) items.push({ href: '/invoices', label: 'Invoices', icon: 'invoices' });
    if (ctx.can('team.manage')) items.push({ href: '/team', label: 'Team', icon: 'team' });
    if (ctx.can('activity.view')) items.push({ href: '/activity', label: 'Activity', icon: 'activity' });
  } else {
    items.push({ href: '/', label: 'Home', icon: 'home' }, { href: '/orders', label: 'Orders', icon: 'orders' }, { href: '/inventory', label: 'Inventory', icon: 'inventory' }, { href: '/inbounds', label: 'Stock inbounds', icon: 'inbounds' }, { href: '/tracking', label: 'Tracking', icon: 'tracking' });
    if (ctx.can('invoices.view')) items.push({ href: '/invoices', label: 'Invoices', icon: 'invoices' });
    items.push({ href: '/support', label: 'Support', icon: 'support' });
    if ((ctx.clientRole && ctx.can('team.manage')) || ctx.viewingAs) items.push({ href: '/team', label: 'Team', icon: 'team' });
  }
  if (!ctx.viewingAs) items.push({ href: '/settings', label: 'Settings', icon: 'settings' });

  const role = ctx.staffRole ? `Elmamsflow · ${ctx.roleName}` : ctx.roleName;

  return (
    <div className="ep-app">
      {ctx.viewingAs && ctx.org && (
        <div className="ep-asbar">
          <span>
            You’re viewing <b>{ctx.org.name}</b>’s workspace exactly as they see it. Anything you add here is added to their account.
          </span>
          <form action={exitViewAs}>
            <input type="hidden" name="org" value={ctx.org.id} />
            <button className="ep-link" style={{ color: 'var(--navy)', fontWeight: 700 }}>
              Back to back office <Arrow />
            </button>
          </form>
        </div>
      )}
      <div className="ep-shell">
        <aside className="ep-side">
          <Link className="ep-logo" href="/">
            <Image src="/brand/logo.png" alt="Elmamsflow" width={150} height={30} priority />
          </Link>
          <p className="ep-side-label">
            {ctx.backOffice ? 'Back office' : ctx.org?.name}
            {!ctx.backOffice && ctx.org?.code && <small>{ctx.org.code}</small>}
          </p>
          <NavLinks items={items} />
          <div className="ep-side-foot">
            <form action="/auth/signout" method="post">
              <button className="ep-link" style={{ color: 'var(--muted)' }}>
                Sign out
              </button>
            </form>
          </div>
        </aside>
        <div className="ep-main">
          <header className="ep-top">
            <Burger />
            <div className="ep-me">
              <span className="ep-avatar">{ctx.name.slice(0, 1).toUpperCase()}</span>
              <span>
                <b>{ctx.name}</b>
                <small>{role}</small>
              </span>
            </div>
          </header>
          <div className="ep-content">
            <Suspense>
              <Flash />
            </Suspense>
            {children}
          </div>
        </div>
      </div>
      <ClickableRows />
      <NavCloser />
    </div>
  );
}
