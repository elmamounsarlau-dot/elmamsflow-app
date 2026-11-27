-- 0025 · Shipping rates use the packed weight as typed (like the partner's own quotes): no packaging added on top.
alter table public.shipping_settings alter column packaging_g set default 0;
update public.shipping_settings set packaging_g = 0;
