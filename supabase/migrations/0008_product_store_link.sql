-- =====================================================================
-- 0008 — Link products to their store variant, so orders match even
--         when the store product has no SKU.
-- =====================================================================
alter table public.products add column if not exists ext_ref text;
create index if not exists products_ext_ref on public.products (org_id, ext_ref) where ext_ref is not null;
