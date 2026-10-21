# Elmamsflow platform

The client platform and back office for Elmamsflow (EL MAMOUN Shipping & Trading).
Next.js on Vercel, Supabase for the database and sign-in. The public website stays on WordPress.

## Who sees what

- **Elmamsflow team** (back office): Owner, Manager, Warehouse, Customer service, Finance.
- **Client brands** (portal): Admin, Operations, Customer support, Finance. A client admin invites their own team.
- Every client only ever sees its own data. This is enforced inside the database (Row Level Security), not only in the screens.
- The roles and what they can do live in `src/lib/roles.ts` and in `supabase/migrations/0001_init.sql`.

## First-time setup

1. **Database** — Supabase → SQL Editor → paste `supabase/migrations/0001_init.sql` → Run.
2. **Sign-in settings** — Supabase → Authentication:
   - *Sign In / Providers → Email*: turn **off** “Allow new users to sign up” (access is by invitation only).
   - *URL Configuration*: Site URL = your app address (for example `https://app.elmamsflow.com`), and add it to Redirect URLs.
   - *Emails → Templates*: paste `supabase/templates/invite.html` into **Invite user** and `supabase/templates/recovery.html` into **Reset password**.
   - *Emails → SMTP*: connect a sending service (for example Resend) so invitations reach real inboxes.
3. **Your owner account** — Supabase → Authentication → Users → *Add user* (your email and a password), then in the SQL Editor run:
   `select public.make_owner('you@yourmail.com');`
4. **Vercel** — import this repository, connect the Supabase integration (it adds the keys), and set `NEXT_PUBLIC_SITE_URL` to the app address.

## Environment

See `.env.example`. `SUPABASE_SERVICE_ROLE_KEY` is secret: only in Vercel, never in the code.

## Develop

```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```
