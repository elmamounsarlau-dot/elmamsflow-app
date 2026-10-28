import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { isOwner, requireCtx, shippingOnly } from '@/lib/session';
import { Burger, ClickableRows, Flash, NavCloser, ResponsiveTables, SettleNudge } from '@/components/client';
import { Arrow } from '@/components/ui';
import { NavLinks, type NavItem } from './nav';
import { exitViewAs } from './view-as';
import { ThemeSwitch } from '@/components/theme';
import { themeMode } from '@/lib/theme';
import { getNotices } from '@/lib/notifications';
import { Bell } from '@/components/notices';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const items: NavItem[] = [];
  if (ctx.backOffice) {
    const shipper = shippingOnly(ctx);
    if (!shipper) items.push({ href: '/', label: 'Overview', icon: 'home' });
    if (ctx.can('orders.warehouse')) items.push({ href: '/shipping', label: 'Shipping', icon: 'shipping' });
    if (ctx.can('clients.view')) items.push({ href: '/clients', label: 'Clients', icon: 'clients' });
    items.push({ href: '/orders', label: 'Orders', icon: 'orders' });
    if (!shipper) items.push({ href: '/inventory', label: 'Inventory', icon: 'inventory' }, { href: '/inbounds', label: 'Stock inbounds', icon: 'inbounds' }, { href: '/transfers', label: 'Transfers', icon: 'transfers' }, { href: '/warehouses', label: 'Warehouses', icon: 'warehouses' });
    items.push({ href: '/tracking', label: 'Tracking', icon: 'tracking' });
    if (ctx.can('support.reply')) items.push({ href: '/support', label: 'Support', icon: 'support' });
    if (ctx.can('invoices.view')) items.push({ href: '/invoices', label: 'Invoices', icon: 'invoices' });
    if (ctx.can('billing.manage')) items.push({ href: '/finance', label: 'Finance', icon: 'finance' });
    if (ctx.can('integrations.manage')) items.push({ href: '/integrations', label: 'Stores', icon: 'stores' });
    if (ctx.can('team.manage')) items.push({ href: '/team', label: 'Team', icon: 'team' });
    if (isOwner(ctx)) items.push({ href: '/activity', label: 'Activity', icon: 'activity' });
  } else {
    items.push({ href: '/', label: 'Home', icon: 'home' }, { href: '/notifications', label: 'Notifications', icon: 'bell' }, { href: '/orders', label: 'Orders', icon: 'orders' }, { href: '/inventory', label: 'Inventory', icon: 'inventory' }, { href: '/inbounds', label: 'Stock inbounds', icon: 'inbounds' }, { href: '/tracking', label: 'Tracking', icon: 'tracking' });
    items.push({ href: '/reports', label: 'Monthly report', icon: 'reports' });
    if (ctx.can('invoices.view')) items.push({ href: '/invoices', label: 'Invoices', icon: 'invoices' }, { href: '/pricing', label: 'Pricing', icon: 'pricing' });
    if (ctx.can('integrations.manage')) items.push({ href: '/integrations', label: 'Stores', icon: 'stores' });
    items.push({ href: '/support', label: 'Support', icon: 'support' });
    if ((ctx.clientRole && ctx.can('team.manage')) || ctx.viewingAs) items.push({ href: '/team', label: 'Team', icon: 'team' });
  }
  if (ctx.org) items.push({ href: '/settings/company', label: 'Company profile', icon: 'company' });
  if (!ctx.viewingAs) items.push({ href: '/settings', label: 'Settings', icon: 'settings' });

  const role = ctx.staffRole ? `Elmamsflow · ${ctx.roleName}` : ctx.roleName;
  const notices = ctx.org ? await getNotices(ctx).catch(() => []) : [];

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
            <ThemeSwitch initial={await themeMode()} />
            {ctx.org && <Bell count={notices.length} urgent={notices.filter((n) => n.level === 'action').length} />}
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
      <ResponsiveTables />
      <NavCloser />
      <SettleNudge />
    </div>
  );
}
