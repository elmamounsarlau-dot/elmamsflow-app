import Link from 'next/link';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { fmtDate } from '@/lib/format';
import { money } from '@/lib/billing';
import { balanceOf, WALLET_KIND } from '@/lib/wallet';
import { Empty } from '@/components/ui';
import { decideTopupAction } from './wallet-actions';

type Entry = { id: string; kind: string; amount: number; currency: string; status: string; ref: string | null; method: string | null; note: string | null; created_at: string; order_id: string | null; invoice_id: string | null };

export async function walletEntries(orgId: string, limit = 12) {
  const { data } = await supabaseAdmin().from('wallet_entries').select('id, kind, amount, currency, status, ref, method, note, created_at, order_id, invoice_id').eq('org_id', orgId).neq('status', 'rejected').order('created_at', { ascending: false }).limit(limit);
  return (data ?? []) as Entry[];
}

/** The balance cards on the client's Invoices page (and on the client page for our team). */
export async function BalanceCards({ orgId, staff = false }: { orgId: string; staff?: boolean }) {
  const b = await balanceOf(orgId);
  if (!b.prepaid) return null;
  const low = b.balance < b.lowBalance;
  if (staff) return (
    <div className="ep-bal-line">
      <span><small>Balance</small><br /><b className={b.balance < 0 ? 'ep-late' : low ? 'ep-warn' : 'ep-good'}>{money(b.balance, b.currency)}</b></span>
      <span><small>On its way</small><br /><b>{money(b.pending, b.currency)}</b></span>
      {b.creditLimit > 0 && <span><small>Credit</small><br /><b>{money(b.creditLimit, b.currency)}</b></span>}
      <small>{b.balance < 0 ? 'Below zero: new orders wait for a top-up' : low ? `Under ${money(b.lowBalance, b.currency)}` : ''}</small>
    </div>
  );
  return (
    <div className="ep-sum">
      <div className={`ep-sum-card${b.balance < 0 ? ' is-alert' : low ? ' is-warn' : ''}`}>
        <small>Balance</small>
        <b className={`ep-sum-money${b.balance > 0 ? ' ep-good' : ''}`} data-figure="balance" data-value={Math.round(b.balance)}>{money(b.balance, b.currency)}</b>
        <span>{b.balance < 0 ? 'Below zero: new orders wait until you top up' : low ? `Under ${money(b.lowBalance, b.currency)}: time to top up` : 'Each shipped order is paid from it'}</span>
      </div>
      <div className="ep-sum-card">
        <small>On its way</small>
        <b className="ep-sum-money">{money(b.pending, b.currency)}</b>
        <span>{b.pending ? 'Top-ups we haven’t received yet' : 'No top-up waiting'}</span>
      </div>
      {!staff && (
        <Link href="/invoices/topup" className="ep-sum-card ep-sum-card--cta">
          <small>Add money</small>
          <b>Top up</b>
          <span>Bank transfer or USDT · we confirm it on arrival</span>
        </Link>
      )}
      {b.creditLimit > 0 && (
        <div className="ep-sum-card">
          <small>Credit</small>
          <b className="ep-sum-money">{money(b.creditLimit, b.currency)}</b>
          <span>Orders still ship down to −{money(b.creditLimit, b.currency)}</span>
        </div>
      )}
    </div>
  );
}

export function EntriesTable({ rows, staff = false, back = '/invoices' }: { rows: Entry[]; staff?: boolean; back?: string }) {
  if (!rows.length) return <Empty title="No movements yet" text="Top-ups and the orders paid from the balance appear here." />;
  return (
    <div className="ep-tablewrap">
      <table className="ep-table">
        <thead><tr><th>Date</th><th>What</th><th>Details</th><th className="ep-right">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td><small>{fmtDate(e.created_at, true)}</small></td>
              <td><b>{WALLET_KIND[e.kind] ?? e.kind}</b></td>
              <td>
                {e.order_id ? <Link className="ep-link" href={`/orders/${e.order_id}`}>{e.note}</Link> : e.invoice_id ? <Link className="ep-link" href={`/invoices/${e.invoice_id}`}>{e.note}</Link> : e.kind === 'topup' ? <Link className="ep-link" href={`/invoices/topup/${e.id}`}>{e.ref}{e.method ? ` · ${e.method}` : ''}</Link> : e.note}
              </td>
              <td className="ep-right"><b className={Number(e.amount) > 0 ? 'ep-good' : ''}>{Number(e.amount) > 0 ? '+' : ''}{money(Number(e.amount), e.currency)}</b></td>
              <td>
                {e.status === 'pending' ? (
                  staff ? (
                    <form action={decideTopupAction} className="ep-inline" style={{ gap: '.35rem', flexWrap: 'wrap' }}>
                      <input type="hidden" name="id" value={e.id} /><input type="hidden" name="back" value={back} />
                      <input name="amount" type="number" step="0.01" min="0.01" defaultValue={Number(e.amount)} style={{ width: '6.5rem' }} aria-label="Amount that arrived" />
                      <button className="ep-btn ep-btn--sm" name="decision" value="confirm">Received</button>
                      <button className="ep-btn ep-btn--sm ep-btn--ghost" name="decision" value="reject">Not received</button>
                    </form>
                  ) : <span className="ep-st ep-st--warn">Waiting for it</span>
                ) : <span className="ep-st ep-st--ok">Done</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

