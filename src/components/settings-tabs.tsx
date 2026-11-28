import Link from 'next/link';
import type { Ctx } from '@/lib/session';

export type SettingsTab = 'profile' | 'company' | 'team' | 'stores';

/** Client portal: Profile, Company profile, Team and Stores live under one Settings page with tabs
 *  ("Just you" · "Your company"), so the side menu stays short. The back office keeps its own menu. */
export function clientSettingsTabs(ctx: Ctx) {
  const mine = !ctx.viewingAs ? [{ key: 'profile' as const, href: '/settings', label: 'Profile' }] : [];
  const company = [
    ...(ctx.org ? [{ key: 'company' as const, href: '/settings/company', label: 'Company profile' }] : []),
    ...((ctx.clientRole && ctx.can('team.manage')) || ctx.viewingAs ? [{ key: 'team' as const, href: '/team', label: 'Team' }] : []),
    ...(ctx.can('integrations.manage') ? [{ key: 'stores' as const, href: '/integrations', label: 'Stores' }] : []),
  ];
  return { mine, company };
}

export function SettingsTabs({ ctx, on }: { ctx: Ctx; on: SettingsTab }) {
  if (ctx.backOffice) return null;
  const { mine, company } = clientSettingsTabs(ctx);
  if (mine.length + company.length < 2) return null;
  return (
    <nav className="ep-settabs" aria-label="Settings">
      {mine.length > 0 && (
        <div>
          <small>Just you</small>
          <span>{mine.map((t) => <Link key={t.key} href={t.href} className={t.key === on ? 'is-on' : ''} aria-current={t.key === on ? 'page' : undefined}>{t.label}</Link>)}</span>
        </div>
      )}
      {company.length > 0 && (
        <div>
          <small>Your company</small>
          <span>{company.map((t) => <Link key={t.key} href={t.href} className={t.key === on ? 'is-on' : ''} aria-current={t.key === on ? 'page' : undefined}>{t.label}</Link>)}</span>
        </div>
      )}
    </nav>
  );
}
