import { after } from 'next/server';
import { sweepSoon } from '@/lib/integrations/flow';
import { redirect } from 'next/navigation';
import { requireCtx, shippingOnly } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { ViewReady, ViewSwitch } from '@/components/home-view';
import { ClientHome } from './client-home';
import { ClientQuick } from './client-quick';
import { OwnerHome } from './owner-home';

export const metadata = { title: 'Overview' };

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const ctx = await requireCtx();
  // While the team works, keep the warehouse partner, balances and clients' stores in step (at most every 3 min).
  if (ctx.staffRole) after(() => sweepSoon());
  if (shippingOnly(ctx)) redirect('/shipping');
  const sp = await searchParams;
  // Our team: the whole business on one page.
  if (ctx.backOffice) return <OwnerHome ctx={ctx} />;
  // A brand (or our team viewing as one): the Full view, or the Quick view if this person chose it.
  const { data } = await (await supabaseServer()).from('profiles').select('home_view').eq('id', ctx.userId).maybeSingle();
  const view = data?.home_view === 'quick' && !sp.welcome ? 'quick' : 'full';
  if (view === 'quick') return <ClientQuick ctx={ctx} />;
  return (
    <div className="ds-full" data-view="full">
      <ViewReady view="full" />
      <div className="ds-switchbar"><ViewSwitch view="full" /></div>
      <ClientHome ctx={ctx} welcome={!!sp.welcome} />
    </div>
  );
}
