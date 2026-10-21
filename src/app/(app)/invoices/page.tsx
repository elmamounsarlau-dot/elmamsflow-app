import { requireCtx } from '@/lib/session';
import { supabaseServer } from '@/lib/supabase/server';
import { Empty, Kpi } from '@/components/ui';

export const metadata = { title: 'Invoices' };

export default async function Invoices() {
  const ctx = await requireCtx();
  const sb = await supabaseServer();
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  let q1 = sb.from('orders').select('id', { count: 'exact', head: true }).gte('shipped_at', start.toISOString());
  let q2 = sb.from('stock_moves').select('qty').eq('type', 'inbound').gte('created_at', start.toISOString());
  if (ctx.org) {
    q1 = q1.eq('org_id', ctx.org.id);
    q2 = q2.eq('org_id', ctx.org.id);
  }
  const [{ count }, { data: moves }] = await Promise.all([q1, q2]);
  return (
    <>
      <h1 className="ep-page-title">Invoices</h1>
      <div className="ep-kpis ep-kpis--3">
        <Kpi label="Orders shipped this month" value={count ?? 0} />
        <Kpi label="Units received this month" value={(moves ?? []).reduce((a, m) => a + m.qty, 0)} />
        <Kpi label="Wallet balance" value="—" />
      </div>
      <section className="ep-card">
        <Empty title="Invoices arrive with billing" text="Your monthly invoice, every charge line and your wallet will show here. Until then, your Elmamsflow team sends invoices by email." />
      </section>
    </>
  );
}
