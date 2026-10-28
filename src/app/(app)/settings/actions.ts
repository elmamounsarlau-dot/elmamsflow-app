'use server';

import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { logActivity } from '@/lib/log';
import { editsCompany, getCtx } from '@/lib/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { IMAGES, removeFile, saveFile } from '@/lib/files';
import { str, withMsg } from '@/lib/format';

export async function saveProfile(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const sb = await supabaseServer();
  await sb.from('profiles').update({ full_name: str(fd, 'name'), phone: str(fd, 'phone') || null }).eq('id', ctx.userId);
  redirect(withMsg('/settings', 'Profile saved.'));
}

export async function changePassword(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx) redirect('/login');
  const p1 = String(fd.get('pass1') ?? '');
  if (p1.length < 8 || p1 !== String(fd.get('pass2') ?? '')) redirect(withMsg('/settings', 'The new password needs at least 8 characters, typed the same twice.', 'err'));
  const sb = await supabaseServer();
  const { error: e1 } = await sb.auth.signInWithPassword({ email: ctx.email, password: String(fd.get('current') ?? '') });
  if (e1) redirect(withMsg('/settings', 'Your current password is not right.', 'err'));
  const { error } = await sb.auth.updateUser({ password: p1 });
  if (error) redirect(withMsg('/settings', error.message, 'err'));
  await logActivity(sb, ctx.userId, ctx.clientRole ? ctx.org!.id : null, 'password_changed');
  redirect(withMsg('/settings', 'Password changed.'));
}

/** The brand's company profile: printed on its invoices and shown across its workspace. */
export async function saveCompany(fd: FormData) {
  const ctx = await getCtx();
  if (!ctx || !editsCompany(ctx)) redirect(withMsg('/settings/company', 'Only an admin of your workspace can change the company profile.', 'err'));
  const orgId = ctx.org!.id;
  const to = '/settings/company';
  const email = str(fd, 'invoice_email').toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect(withMsg(to, 'The invoice email doesn’t look right.', 'err'));
  let site = str(fd, 'website');
  if (site && !/^https?:\/\//i.test(site)) site = `https://${site}`;
  if (site) { try { new URL(site); } catch { redirect(withMsg(to, 'The website address doesn’t look right.', 'err')); } }
  const patch: Record<string, string | null> = {
    legal_name: str(fd, 'legal_name').slice(0, 160) || null,
    billing_address: str(fd, 'billing_address').slice(0, 500) || null,
    vat_number: str(fd, 'vat_number').toUpperCase().replace(/\s+/g, ' ').slice(0, 40) || null,
    invoice_email: email.slice(0, 160) || null,
    website: site.slice(0, 200) || null,
    phone: str(fd, 'phone').slice(0, 40) || null,
  };
  const admin = supabaseAdmin();
  const { data: cur } = await admin.from('organizations').select('logo_path').eq('id', orgId).maybeSingle();
  const logo = fd.get('logo');
  if (logo instanceof File && logo.size) {
    try {
      patch.logo_path = (await saveFile('brand', orgId, logo, { types: IMAGES, maxMb: 2, what: 'logo' })).path;
    } catch (e) {
      redirect(withMsg(to, (e as Error).message, 'err'));
    }
  } else if (str(fd, 'remove_logo') === '1') patch.logo_path = null;
  const { error } = await admin.from('organizations').update(patch).eq('id', orgId).eq('kind', 'client');
  if (error) redirect(withMsg(to, error.message, 'err'));
  if ('logo_path' in patch && cur?.logo_path && cur.logo_path !== patch.logo_path) await removeFile('brand', cur.logo_path);
  await logActivity(admin, ctx.userId, orgId, 'company_profile');
  redirect(withMsg(to, 'Company profile saved. Your next invoices use it.'));
}
