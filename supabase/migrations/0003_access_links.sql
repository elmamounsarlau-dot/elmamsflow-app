-- =====================================================================
-- 0003 — Keep each invitation / sign-in link so the owner can copy it later
-- =====================================================================
-- One row per person who has not set their password yet. Removed automatically once they do.
create table if not exists public.access_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid references public.organizations (id) on delete cascade,
  email text not null,
  link text not null,
  emailed boolean not null default false,
  email_error text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);
alter table public.access_links enable row level security;
-- Only the Elmamsflow owner and managers can read these links. Clients never can.
drop policy if exists access_links_read on public.access_links;
create policy access_links_read on public.access_links for select using (public.staff_role() in ('owner', 'manager'));
