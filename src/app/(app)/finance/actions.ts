'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logActivity } from '@/lib/log';
import { str, withMsg } from '@/lib/format';
import { removeFile, saveFile } from '@/lib/files';
import { sha256 } from '@/lib/csv';
import { financeSettings, MONEY_CURRENCIES } from '@/lib/fx';
import { EXPENSE_CATS, ymOk } from '@/lib/finance';

// Finance entries are logged without a client (clients can read their own activity, never our costs).
/** Finance is for the owner, managers and finance (billing.manage), in the back office only. */
async function finance(back: string) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  if (!ctx.staffRole || !ctx.backOffice || !ctx.can('billing.manage')) redirect(withMsg(back, 'Only the owner, managers and finance can change the finances.', 'err'));
  return ctx;
}

const RECEIPT = { types: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'], maxMb: 8, what: 'receipt' };
const dateOk = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const amountOf = (v: string) => Math.round((parseFloat(v.replace(/[\s,](?=\d{3}\b)/g, '').replace(',', '.')) || 0) * 100) / 100;

async function orgOk(id: string) {
  if (!id) return null;
  const { data } = await supabaseAdmin().from('organizations').select('id').eq('id', id).eq('kind', 'client').maybeSingle();
  return data?.id ?? null;
}

type Fields = { spent_on: string; category: string; payee: string; amount: number; currency: string; org_id: string | null; note: string | null };
async function readFields(fd: FormData, back: string): Promise<Fields> {
  const spent_on = dateOk(str(fd, 'date'));
  const category = str(fd, 'category');
  const payee = str(fd, 'payee').slice(0, 120);
  const amount = amountOf(str(fd, 'amount'));
  const currency = str(fd, 'currency');
  if (!spent_on) redirect(withMsg(back, 'Choose the date it was paid.', 'err'));
  if (!(EXPENSE_CATS as readonly string[]).includes(category)) redirect(withMsg(back, 'Choose what the expense is for.', 'err'));
  if (!payee) redirect(withMsg(back, 'Write who it was paid to.', 'err'));
  if (!(amount > 0)) redirect(withMsg(back, 'Write the amount paid (more than 0).', 'err'));
  if (!(MONEY_CURRENCIES as readonly string[]).includes(currency)) redirect(withMsg(back, 'Choose the currency.', 'err'));
  return { spent_on, category, payee, amount, currency, org_id: await orgOk(str(fd, 'org')), note: str(fd, 'note').slice(0, 300) || null };
}

const backTo = (fd: FormData) => {
  const ym = ymOk(str(fd, 'ym'));
  return `/finance/expenses${ym ? `?m=${ym}` : ''}`;
};

export async function addExpense(fd: FormData) {
  const back = backTo(fd);
  const ctx = await finance(back);
  const f = await readFields(fd, back);
  const admin = supabaseAdmin();
  let receipt: string | null = null;
  const file = fd.get('receipt');
  if (file instanceof File && file.size) {
    try { receipt = (await saveFile('finance', 'receipts', file, RECEIPT)).path; } catch (e) { redirect(withMsg(back, (e as Error).message, 'err')); }
  }
  const month = `${f.spent_on.slice(0, 7)}-01`;
  let recurring: string | null = null;
  if (fd.get('repeat')) {
    const { data, error } = await admin.from('recurring_expenses').insert({
      category: f.category, payee: f.payee, amount: f.amount, currency: f.currency, org_id: f.org_id, note: f.note,
      day_of_month: Math.min(28, Number(f.spent_on.slice(8, 10))), start_month: month, generated_until: month, created_by: ctx.userId,
    }).select('id').single();
    if (error) { await removeFile('finance', receipt); redirect(withMsg(back, error.message, 'err')); }
    recurring = data.id;
  }
  const { error } = await admin.from('expenses').insert({
    ...f, receipt_path: receipt, created_by: ctx.userId,
    ...(recurring ? { source: 'recurring', recurring_id: recurring, recurring_month: month } : {}),
  });
  if (error) {
    await removeFile('finance', receipt);
    if (recurring) await admin.from('recurring_expenses').delete().eq('id', recurring);
    redirect(withMsg(back, error.message, 'err'));
  }
  await logActivity(admin, ctx.userId, null, 'expense_added', `${f.payee} · ${f.amount} ${f.currency}`);
  revalidatePath('/finance');
  redirect(withMsg(`/finance/expenses?m=${f.spent_on.slice(0, 7)}`, recurring ? 'Expense saved. It will be added again every month on the same day.' : 'Expense saved.'));
}

export async function updateExpense(fd: FormData) {
  const back = backTo(fd);
  const ctx = await finance(back);
  const id = str(fd, 'id');
  const admin = supabaseAdmin();
  const { data: old } = await admin.from('expenses').select('id, receipt_path').eq('id', id).maybeSingle();
  if (!old) redirect(withMsg(back, 'That expense no longer exists.', 'err'));
  const f = await readFields(fd, back);
  const patch: Record<string, unknown> = { ...f };
  const file = fd.get('receipt');
  if (file instanceof File && file.size) {
    try { patch.receipt_path = (await saveFile('finance', 'receipts', file, RECEIPT)).path; } catch (e) { redirect(withMsg(back, (e as Error).message, 'err')); }
  } else if (fd.get('remove_receipt')) patch.receipt_path = null;
  const { error } = await admin.from('expenses').update(patch).eq('id', id);
  if (error) { if (patch.receipt_path) await removeFile('finance', patch.receipt_path as string); redirect(withMsg(back, error.message, 'err')); }
  if ('receipt_path' in patch && old.receipt_path) await removeFile('finance', old.receipt_path);
  await logActivity(admin, ctx.userId, null, 'expense_edited', `${f.payee} · ${f.amount} ${f.currency}`);
  revalidatePath('/finance');
  redirect(withMsg(`/finance/expenses?m=${f.spent_on.slice(0, 7)}`, 'Expense updated.'));
}

export async function deleteExpense(fd: FormData) {
  const back = backTo(fd);
  const ctx = await finance(back);
  const admin = supabaseAdmin();
  const { data: old } = await admin.from('expenses').select('id, payee, amount, currency, receipt_path, org_id').eq('id', str(fd, 'id')).maybeSingle();
  if (!old) redirect(withMsg(back, 'That expense no longer exists.', 'err'));
  const { error } = await admin.from('expenses').delete().eq('id', old.id);
  if (error) redirect(withMsg(back, error.message, 'err'));
  await removeFile('finance', old.receipt_path);
  await logActivity(admin, ctx.userId, null, 'expense_deleted', `${old.payee} · ${old.amount} ${old.currency}`);
  revalidatePath('/finance');
  redirect(withMsg(back, 'Expense removed.'));
}

export async function saveRecurring(fd: FormData) {
  const back = `${backTo(fd)}#repeating`;
  const ctx = await finance(back);
  const admin = supabaseAdmin();
  const id = str(fd, 'id');
  if (fd.get('stop')) {
    const { error } = await admin.from('recurring_expenses').update({ active: false }).eq('id', id);
    if (error) redirect(withMsg(back, error.message, 'err'));
    await logActivity(admin, ctx.userId, null, 'expense_repeat_stopped', str(fd, 'payee'));
    revalidatePath('/finance');
    redirect(withMsg(back, 'Stopped. Months already recorded stay as they are.'));
  }
  const amount = amountOf(str(fd, 'amount'));
  const day = Math.min(28, Math.max(1, parseInt(str(fd, 'day'), 10) || 1));
  const payee = str(fd, 'payee').slice(0, 120);
  if (!payee || !(amount > 0)) redirect(withMsg(back, 'Write who it is paid to and an amount above 0.', 'err'));
  const { error } = await admin.from('recurring_expenses').update({ amount, day_of_month: day, payee }).eq('id', id);
  if (error) redirect(withMsg(back, error.message, 'err'));
  await logActivity(admin, ctx.userId, null, 'expense_repeat_saved', `${payee} · ${amount}`);
  revalidatePath('/finance');
  redirect(withMsg(back, 'Saved. The change applies from the next month.'));
}

export async function saveFinanceSettings(fd: FormData) {
  const back = '/finance/settings';
  const ctx = await finance(back);
  const report = str(fd, 'report_currency');
  const cost = str(fd, 'cost_currency');
  if (!(MONEY_CURRENCIES as readonly string[]).includes(report) || !(MONEY_CURRENCIES as readonly string[]).includes(cost)) redirect(withMsg(back, 'Choose the currencies.', 'err'));
  // The rates on the form are "1 unit = so much of the CURRENT main currency".
  const was = (await financeSettings()).report_currency;
  const typed: Record<string, number> = {};
  for (const c of MONEY_CURRENCIES) {
    if (c === was) continue;
    const v = parseFloat(str(fd, `fx_${c}`).replace(',', '.'));
    if (v > 0) typed[c] = Math.round(v * 1e6) / 1e6;
  }
  let fx: Record<string, number> = typed;
  let note = '';
  if (report !== was) {
    // Switching the main currency: rebase every rate on the new one, so totals stay right.
    const base = typed[report];
    if (base) {
      fx = { [was]: Math.round((1 / base) * 1e6) / 1e6 };
      for (const [c, v] of Object.entries(typed)) if (c !== report) fx[c] = Math.round((v / base) * 1e6) / 1e6;
    } else {
      fx = {};
      note = ` Add the rates against ${report} now: without the ${report} rate the old ones couldn’t be converted.`;
    }
  }
  const { error } = await supabaseAdmin().from('finance_settings').update({
    report_currency: report, cost_currency: cost, fx, bill_duties: !!fd.get('bill_duties'), updated_at: new Date().toISOString(), updated_by: ctx.userId,
  }).eq('id', 1);
  if (error) redirect(withMsg(back, error.message, 'err'));
  await logActivity(supabaseAdmin(), ctx.userId, null, 'finance_settings', `${report}`);
  revalidatePath('/finance');
  redirect(withMsg(back, `Finance settings saved.${note}`, note ? 'warn' : 'ok'));
}

/** Bank statement lines chosen on the import screen (the browser read the file; we check every value again). */
export async function importBankLines(fd: FormData) {
  const back = '/finance/import';
  const ctx = await finance(back);
  let lines: { date: string; amount: number; payee: string; category: string; currency: string; ref: string }[] = [];
  try { lines = JSON.parse(str(fd, 'lines')); } catch { /* handled below */ }
  if (!Array.isArray(lines) || !lines.length) redirect(withMsg(back, 'Choose at least one line to import.', 'err'));
  if (lines.length > 2000) redirect(withMsg(back, 'Import up to 2,000 lines at a time.', 'err'));
  const rows: Record<string, unknown>[] = [];
  for (const l of lines) {
    const d = dateOk(String(l.date ?? ''));
    const amount = Math.round(Math.abs(Number(l.amount) || 0) * 100) / 100;
    const payee = String(l.payee ?? '').trim().slice(0, 120);
    const currency = String(l.currency ?? '');
    const category = (EXPENSE_CATS as readonly string[]).includes(String(l.category)) ? String(l.category) : 'other';
    if (!d || !(amount > 0) || !payee || !(MONEY_CURRENCIES as readonly string[]).includes(currency)) continue;
    // Same date, amount, text and reference = the same bank line: importing the statement twice adds nothing.
    const import_hash = await sha256(`${d}|${amount.toFixed(2)}|${currency}|${payee.toLowerCase()}|${String(l.ref ?? '').trim()}`);
    rows.push({ spent_on: d, amount, currency, payee, category, source: 'import', import_hash, created_by: ctx.userId });
  }
  if (!rows.length) redirect(withMsg(back, 'None of the chosen lines had a date, an amount and a description.', 'err'));
  const admin = supabaseAdmin();
  const known = new Set<string>();
  for (let i = 0; i < rows.length; i += 200) {
    const { data } = await admin.from('expenses').select('import_hash').in('import_hash', rows.slice(i, i + 200).map((r) => r.import_hash as string));
    for (const r of data ?? []) known.add(r.import_hash);
  }
  const fresh = rows.filter((r, i, all) => !known.has(r.import_hash as string) && all.findIndex((x) => x.import_hash === r.import_hash) === i);
  if (fresh.length) {
    const { error } = await admin.from('expenses').insert(fresh);
    if (error) redirect(withMsg(back, error.message, 'err'));
  }
  await logActivity(admin, ctx.userId, null, 'expenses_imported', `${fresh.length} lines`);
  revalidatePath('/finance');
  const skipped = rows.length - fresh.length;
  const month = String(fresh[0]?.spent_on ?? rows[0].spent_on).slice(0, 7);
  redirect(withMsg(`/finance/expenses?m=${month}`, `${fresh.length} expense${fresh.length === 1 ? '' : 's'} imported${skipped ? ` · ${skipped} already there, skipped` : ''}.`));
}
