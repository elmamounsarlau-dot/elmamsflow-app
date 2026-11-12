import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { fmtDate } from '@/lib/format';
import { money } from '@/lib/billing';
import { balanceOf, WALLET_KIND } from '@/lib/wallet';
import { Empty, Kpi } from '@/components/ui';
import { decideTopupAction } from './wallet-actions';

type Entry = { id: string; kind: string; amount: number; currency: string; status: string; ref: string | null; method: string | null; note: string | null; created_at: string; order_id: string | null; invoice_id: string | null };

export async function walletEntries(orgId: string, limit = 12) {
  const { data } = await supabaseAdmin().from('wallet_entries').select('id, kind, amount, currency, status, ref, method, note, created_at, order_id, invoice_id').eq('org_id', orgId).neq('status', 'rejected').order('created_at', { ascending: false }).limit(limit);
  return (data ?? []) as Entry[];
}

/** Our team, on the client page: the balance as the app's usual figure tiles. */
export async function BalanceKpis({ orgId }: { orgId: string }) {
  const b = await balanceOf(orgId);
  if (!b.prepaid) return null;
  return (
    <div className="ep-kpis ep-kpis--3">
      <Kpi label="Balance" value={<span className={b.balance < 0 ? 'ep-late' : b.balance < b.lowBalance ? 'ep-warn' : ''}>{money(b.balance, b.currency)}</span>} figure="balance" num={Math.round(b.balance)} />
      <Kpi label="Top-ups on their way" value={money(b.pending, b.currency)} href="/invoices/topups" />
      <Kpi label="Credit allowed" value={money(b.creditLimit, b.currency)} />
    </div>
  );
}

export function EntriesTable({ rows, staff = false, back = '/invoices', compact = false }: { rows: Entry[]; staff?: boolean; back?: string; compact?: boolean }) {
  if (!rows.length) return <Empty title="No movements yet" text="Top-ups and the orders paid from the balance appear here." />;
  return (
    <div className="ep-tablewrap">
      <table className="ep-table">
        <thead><tr><th>Date</th>{!compact && <th>What</th>}<th>Details</th><th className="ep-right">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td><small>{fmtDate(e.created_at, !compact)}</small></td>
              {!compact && <td><b>{WALLET_KIND[e.kind] ?? e.kind}</b></td>}
              <td>
                {compact && <small>{WALLET_KIND[e.kind] ?? e.kind} · </small>}
                {e.order_id ? <Link className="ep-link" href={`/orders/${e.order_id}`}>{e.note}</Link> : e.invoice_id ? <Link className="ep-link" href={`/invoices/${e.invoice_id}`}>{e.note}</Link> : e.kind === 'topup' ? <Link className="ep-link" href={`/invoices/topup/${e.id}`}>{e.ref}{e.method ? ` · ${e.method}` : ''}</Link> : e.note}
              </td>
              <td className="ep-right"><b className={Number(e.amount) > 0 ? 'ep-good' : ''}>{Number(e.amount) > 0 ? '+' : ''}{money(Number(e.amount), e.currency)}</b></td>
              <td>
                {e.status === 'pending' ? (
                  staff ? (
                    <form action={decideTopupAction} className="ep-row-actions">
                      <input type="hidden" name="id" value={e.id} /><input type="hidden" name="back" value={back} />
                      <input name="amount" type="number" step="0.01" min="0.01" defaultValue={Number(e.amount)} className="ep-amount-in" aria-label="Amount that arrived" />
                      <button className="ep-btn ep-btn--sm" name="decision" value="confirm">Received</button>
                      <button className="ep-btn ep-btn--sm ep-btn--ghost" name="decision" value="reject">Not received</button>
                    </form>
                  ) : compact ? <Link className="ep-st ep-st--warn" href="/invoices/topups">To confirm</Link> : <span className="ep-st ep-st--warn">Waiting for it</span>
                ) : <span className="ep-st ep-st--ok">Done</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

