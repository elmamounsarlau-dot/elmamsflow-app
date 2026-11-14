# Elmamsflow — operations notes

## 1. Monthly invoice job (`CRON_SECRET`)

The job at `/api/cron/invoices` runs on the 1st of every month (see `vercel.json`) and drafts last month's invoices.
It only runs when the request carries `Authorization: Bearer <CRON_SECRET>`. Vercel adds that header automatically
when the variable exists. Without the variable every call is refused (`503 CRON_SECRET is not configured`);
a wrong or missing header gets `401`. The User-Agent header is never trusted.

**Set it up (once, about 2 minutes):**

1. Make a random value on your own computer, e.g. in a terminal: `openssl rand -base64 48`
   (or a password manager's generator, 40+ characters). Don't send it to anyone or paste it in chat.
2. Vercel → project **elmamsflow-app** → **Settings → Environment Variables → Add**.
   Key `CRON_SECRET`, value = the random text, environment **Production** (and Preview if you want), mark it **Sensitive**. Save.
3. **Deployments** → latest production deployment → **⋯ → Redeploy**, so the running app reads it.
4. Check: **Settings → Cron Jobs** lists `/api/cron/invoices`; use **Run** there once. The log shows
   `{"month":"YYYY-MM","created":N}`. A run in any month creates nothing new if the drafts already exist.

The value is never printed by the app; refusals only log `not_configured` or `denied`.

## 2. Transactional email (invitations and password resets)

Supabase sends these emails. Until a professional sender is set up, they come from the default Supabase sender or the
old Gmail SMTP, which is unreliable. Recommended: a transactional provider on your own domain.

| Provider | Free tier | Why |
| --- | --- | --- |
| Resend | 3,000 emails/month | Simplest setup, good deliverability |
| Postmark | 100 emails/month, then paid | Best deliverability for transactional mail |
| Google Workspace SMTP | with a Workspace mailbox | If you already pay for Workspace |

**Steps (Resend example):**

1. Create the account, **Domains → Add domain** e.g. `mail.elmamoun.com` (a sub-domain keeps marketing mail separate).
2. Add the DNS records it shows at your domain registrar: **SPF** (TXT), **DKIM** (TXT/CNAME) and a **DMARC** record,
   e.g. `_dmarc.elmamoun.com TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@elmamoun.com"`. Wait until Resend says *Verified*.
3. Create an **API key** with "Sending access" only.
4. Supabase → **Project Settings → Authentication → SMTP Settings → Enable custom SMTP**:
   host `smtp.resend.com`, port `465`, user `resend`, password = the API key,
   sender `no-reply@mail.elmamoun.com`, sender name `Elmamsflow`.
5. Supabase → **Authentication → Email Templates**: paste `supabase/templates/invite.html` into *Invite user* and
   `supabase/templates/recovery.html` into *Reset password*. Subjects: "Your Elmamsflow workspace is ready" /
   "Choose a new Elmamsflow password".
6. Supabase → **Authentication → Rate limits**: raise "emails per hour" (custom SMTP allows it) to e.g. 100.
7. Supabase → **Authentication → Providers → Email**: email OTP expiry `86400` seconds (24 h), matching the links.
8. Test: invite yourself from a test client, then use "Forgot your password". Check both arrive in the inbox (not spam)
   and that the button opens `/set-password`.

You enter the key in Supabase yourself; it never goes in the code or in chat.

## 3. Database migrations

Numbered files in `supabase/migrations/` are applied in order in Supabase → SQL Editor. Each is safe to re-run.
Before applying one to production, run the test suite (below) — it builds a fresh database from every migration.

## 4. Tests

| What | Command | Needs |
| --- | --- | --- |
| Type-check / lint / unit tests | `npm run typecheck`, `npm run lint`, `npm test` | Node 22 |
| Database integrity, permissions, concurrency | `npm run test:db` | a local Postgres you can create databases on |
| Screens at 375 / 768 / desktop + WCAG 2.2 AA | see `.github/workflows/ci.yml`, job `screens` | local stack below |

All three run automatically on GitHub for every push and pull request (`.github/workflows/ci.yml`).

**Local stack** (synthetic data, test sign-ins, never production): `supabase/local/up.sh` builds the database,
`postgrest /tmp/elm-postgrest.conf` serves it, `node supabase/local/gateway.mjs` answers the auth calls,
`node supabase/local/env.mjs` prints the app environment. Test users are in `supabase/local/users.json`.

## 5. Stock reconciliation (owner only)

- **Reverse a shipment** (order page → *Correction*): only when no parcel physically left. Puts the units back,
  cancels the order, keeps the original shipment in the history, and stores your name, the reason and the evidence.
  It does not change the order in Shopify/WooCommerce.
- **Reconcile stock** (product page → *Reconcile*): a + or − correction with a reference, a reason and the evidence
  (count sheet, warehouse message, photo). Stored with your approval.

## 6. Warehouses (migration 0014)

- Stock is kept per product **and per warehouse** (Guangzhou `GZ`, Ningbo `NB`; add more on **Warehouses**).
  Every inbound, movement, order and count names its warehouse. An order ships only from free stock
  (on hand − quarantine − reserved) at its own warehouse; otherwise it's refused.
- Clients have a default warehouse (client page → *Ships from by default*); new orders start there.
  Staff can change it per order (order page, or several at once on Orders → *Set warehouse*) until packed.
- **Transfers** move stock between warehouses in two steps: *sent* (leaves the sender) and *received*
  (counted in at the receiver; shortages are recorded). Cancelling before dispatch moves nothing.
- **Existing stock**: 0014 puts every movement recorded before it in *Unallocated (before warehouses)*.
  Totals don't change and nothing is guessed. Those units can't ship until the owner makes an
  **allocation** (Transfers → New → *Allocate*) with evidence of where they physically are.
- A warehouse can be closed only when it holds no stock and has no open orders, inbounds or transfers.

## 7. Warehouse partner through the bridge store, two-way order status, prepaid balance (migration 0020)

17TRACK was removed (Nov 2026). Tracking links now open the carrier's own page.

**The loop.** client's Shopify / WooCommerce → Elmamsflow → **bridge store** (our own Shopify store, connected to the
partner ST Fulfill) → the partner ships → bridge store → Elmamsflow → client's store. Clients never see the bridge or the partner.

- A client ships through the bridge when it has a **client code** (Clients → client → *Warehouse partner & payment*).
  Its products go to the bridge store as `CODE-SKU` (a SKU already starting with the code is kept as is). The partner
  must hold the client's stock under exactly those SKUs ("Copy SKU list for ST").
- Bridge orders are real, paid orders (manual payment, no money moves), **without the customer's email**, with no
  notifications, tagged with the client code and noted with the Elmamsflow number.
- Whatever changes on a bridge order (on hold, in progress, fulfilled + tracking, carrier journey, delivered, cancelled)
  arrives by webhook, updates the Elmamsflow order (`partner_set_status`, service role only) and is mirrored to the
  client's store: On hold, released, In progress, Fulfilled + tracking (customer emailed by their store), shipment
  events (In transit, Out for delivery, Delivered…), Cancelled (refund in their store only if chosen).
- Backup: `/api/cron/sync` (daily, `CRON_SECRET`), "Check the warehouse now" on Stores, and an automatic light pass at
  most every 3 minutes while the team uses Orders / Overview. Orders at the partner for 48 h without shipping, or not
  sent, show under *Needs action* and on Stores.

**Connect the bridge store (once).** Stores → *Warehouse partner · bridge store*: create a custom app in the bridge
Shopify store with the scopes listed there, install it, paste the Admin API access token and API secret key.
Client stores need `write_orders` and `write_fulfillments` too for the new statuses: existing Shopify connections must
be re-approved once (Dev Dashboard app: add the scopes and reinstall; custom app: tick them and reinstall).

**Prepaid balance.** Clients set to *Prepaid* top up first (Invoices → Top up → method + amount → their own
reference). Billing confirms it on *Invoices → Top-ups* (the amount that arrived can be corrected). Each shipped order
is charged at the client's price list; the month's invoice takes the rest (storage, receiving, duties, minimum) from
the balance and is marked paid. When the balance (+ allowed credit) can't cover a new order, it waits ("Top up
needed") and is not sent to the partner; a confirmed top-up releases waiting orders, oldest first. Payment methods
and the minimum are in Settings → Billing details → *Top-ups*. Existing clients stay on monthly invoices until switched.

## 8. One-link Shopify connection (migration 0021)

A client connects its Shopify store by clicking one install link — no Dev Dashboard on their side.

Per client store, in **your** Shopify Dev Dashboard (Stores → Connect Shopify → "Send the client one install link" shows the exact values):

1. Create an app "Elmamsflow". App URL `https://app.elmamsflow.com/api/shopify/install`, embedding off, legacy install flow off.
2. Redirect URL `https://app.elmamsflow.com/api/shopify/callback`; the client-store scopes; protected customer data (name, email, phone, address); release.
3. IP allowlist (required for custom apps on stores outside your organization from 20 Nov 2026 for new installs, 1 Jan 2027 for existing): ASN 16509, country India (Vercel region `bom1`). Check the app's logs if Shopify starts answering 403.
4. Distribution → Custom distribution → the client's `.myshopify.com` → Generate link.
5. Paste Client ID, Client secret and the link in Elmamsflow, save, send the link.

The client clicks Install: `/api/shopify/install` checks Shopify's signature and asks for the permissions; `/api/shopify/callback` checks the signature and the one-time state, saves the store's token (encrypted), registers the order webhooks and imports the products. The table `shopify_installs` is readable by the server only (it holds the app secrets).
