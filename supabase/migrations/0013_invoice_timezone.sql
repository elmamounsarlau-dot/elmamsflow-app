-- =====================================================================
-- 0013 — Which clock decides the invoice month
-- 'UTC' keeps today's behaviour. 'Asia/Shanghai' (China time, UTC+8) puts a parcel shipped
-- on the 1st before 08:00 China time into the new month, matching the warehouse's own day.
-- =====================================================================
alter table public.billing_settings add column if not exists invoice_timezone text not null default 'UTC';
alter table public.billing_settings drop constraint if exists billing_settings_invoice_timezone_check;
alter table public.billing_settings add constraint billing_settings_invoice_timezone_check check (invoice_timezone in ('UTC', 'Asia/Shanghai'));
