# Elmamsflow — notes for Claude

Read this first in every session. It replaces the long chat history this project was built in.

## Who you work with

- **Yasser**, founder of EL MAMOUN SHIPPING & TRADING SARL-AU (China → Europe, USA, Canada, Australia; sourcing, 3PL,
  B2B import to Morocco). **Call him "aschiri" in every reply.**
- Not a developer: explain in plain words, short, with tables when comparing. Give him exact click paths.
- **Ask before building.** A question from him ("shall we…?", "how would…?") is not a go. Build only after a clear
  "go" / "do it". Explain what you'll make and why first when it is new.
- He runs database updates himself: give him the SQL (or the migration file) to paste in **Supabase → SQL Editor**,
  wait for "done", then merge.

## Hard rules

- Never ask for, print, log or paste keys, tokens, passwords or the Supabase service_role key. He pastes secrets
  himself into Vercel / Supabase / the app. Never type a password into a website.
- No destructive production changes, no deleting data (test orders included) without his explicit OK.
- Ask before touching the public website (Hostinger) or anything live outside this repo.
- Clients must never see costs, the partner (ST Fulfill / YunExpress), the bridge store, or any Vercel link.
- The partner must not learn Elmamsflow is a 3PL: keep partner-facing data neutral (he chose to keep store-name
  prefixes like `TOF-…`, `LUM-…`).

## The product

- **app.elmamsflow.com** — Next.js 15 / React 19, Supabase (Postgres + RLS), Vercel project `elmamsflow-app`,
  repo `elmamounsarlau-dot/elmamsflow-app`. Brand: Elmamsflow; original app style (`ep-*` classes in `globals.css`).
- Back office (staff roles: owner, manager, warehouse, shipper; custom roles) and client portal (each client = an
  organization; client roles with permissions).
- Main areas: Orders, Inventory (items + kits/bundles), Stock inbounds, Transfers, Warehouses (Guangzhou, Ningbo),
  Tracking, Invoices (monthly drafts, prepaid wallet), Finance, B2B (sourcing/import deals), Stores, Support,
  Team, Activity, Settings, **Shipping rates** (calculator) and **Settings → Shipping prices** (team only).

### Fulfilment partner: ST Fulfill (no API) via a bridge store

- Client store (Shopify / WooCommerce) → Elmamsflow → our own Shopify **"Elmamsflow - Bridge"** store → ST Fulfill
  picks orders there. Status/tracking flow back: bridge webhooks → `partner_set_status` → Elmamsflow → client store.
- Code: `src/lib/integrations/` (`bridge.ts`, `store-sync.ts`, `flow.ts` → `afterOrderChange`, `sweepOrders`).
- Bridge products are created by Elmamsflow (SKU `CODE-SKU`, stock not tracked); orders link by variant ID, so
  Yasser may rename SKUs **inside the bridge store** to match ST. Don't delete/recreate bridge products.
- ST does not switch shipping line per order; each product has a default line in ST (Product Connection).
- Client store mirroring: on hold / released / in progress / fulfilled + tracking / delivered / cancelled
  (Shopify fulfillment APIs; WooCommerce status + customer notes). 17TRACK was removed.
- **Shopify one-link install** (`/api/shopify/install`, `/api/shopify/callback`, table `shopify_installs`): staff
  prepare a custom-distribution app per client store and send the client the install link.
- Thrive on Five (WooCommerce, code TOF): subscriptions are kits of WC-1843 (90-day = 3 boxes).

### Wallet / billing

- Clients are **prepaid** (top-ups confirmed by staff) or **invoice**. Orders wait "Top up needed" without balance.
  `src/lib/wallet.ts`. Top-up methods: RedotPay / USDT (Settings → Billing).

### Shipping rates (latest work)

- Partner price sheets (YunExpress via ST) per **line** (Standard, Priority, Express = last-mile carrier,
  Large parcel, US remote areas, Courier) × product type (general, battery, clothing, cosmetics).
- Formula: billed kg = max(weight typed, L×W×H/8000, minimum) rounded to the row's step;
  cost = kg × per-kg + per-parcel; Japan tables are per 0.5 kg step; zoned countries use the highest zone.
  Client price = cost × (1 + margin %) + margin per parcel (client margin can override).
- Prices come from **one .xlsx upload** (Shipping prices → Upload the price file). Tab names decide the line/type:
  `1-Standard General`, `2-Standard Battery`, … `13-Express General`, `14-Express Battery`. Excel limits tab names
  to 31 characters. Code: `src/lib/shipping-rates.ts`, `shipping-xlsx.ts`, `shipping-db.ts`.
- **Known gap:** the YunExpress sheet is higher than ST's own **STF-** lines (e.g. Germany 140 g: sheet $12.52,
  ST page STF-Standard $6.11). Yasser asked Red (ST) for the STF price list; when it arrives, upload it in the
  same format. If ST has none, the fallback idea is per-product prices read from ST product pages.

## Open items (as of 27 Nov 2026)

1. PR **#21** (xlsx upload, price check, no packaging added) — needs migration `0025_shipping_packed_weight.sql`
   run by Yasser, then merge.
2. ST's STF price list → upload; compare in the Price check table.
3. Charge real orders at their line's price; map each store's checkout shipping option to a line; list orders
   whose line differs from the product's ST default so staff select it in ST.
4. Products: fill shipping type and packed size (L×W×H).
5. Optional: NextSmartShip has an API (possible direct integration instead of the bridge).
6. Handover pack update; website placeholders; professional email sender (docs/operations.md §2).

## Working on the code

- Branch from `main`, open a PR, wait for CI (type-check/lint/unit/build, database tests, screens at 375/768/desktop
  with WCAG 2.2 AA), then merge. Commit messages end with the attribution lines the session asks for.
- New database change = new file in `supabase/migrations/` (never edit an applied one) + tests in
  `supabase/tests/tests.sql`. Partner prices and secrets live in server-only tables (no client policies).
- Tests: `npm test` (unit), `npm run test:db` (Postgres), `npm run test:stack` (local Supabase stand-in:
  `supabase/local/up.sh`, PostgREST, `supabase/local/gateway.mjs`, env from `supabase/local/env.mjs`),
  `e2e/` for screens. Never point tests at production.
- More operating notes: `docs/operations.md`.
