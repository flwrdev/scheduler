# CLAUDE.md

## Commands

```bash
npm run dev               # shopify app dev with shopify.app.production.toml, the only app config; does NOT auto-apply migrations
npm run typecheck         # react-router typegen + tsc
npm test                  # vitest: test/**/*.test.{ts,tsx}
npm run test:extensions   # vitest: extensions/*/tests/**/*.test.{ts,tsx}
npm run setup             # prisma generate && prisma migrate deploy
npm run deploy:prod       # app config + extensions to the PROD app (explicit go required)
gcloud run deploy delivery-scheduler --source . --region us-central1 --project jhay-510919 --service-account delivery-scheduler-runtime@jhay-510919.iam.gserviceaccount.com   # backend (explicit go required); secrets and env vars stay on the service, see docs/gcp-inventory.md
```

After creating or pulling a Prisma migration, state that `npm run setup` must run before the next `npm run dev`.

The container start command (Dockerfile `CMD`) runs `prisma migrate deploy`, then `react-router-serve`. `prisma generate` runs only at image build. A migration in the image is applied to the database by the deploy itself. `migrate deploy` ignores migrations recorded in `_prisma_migrations` whose folders were deleted. The runtime image installs only the root production dependencies (`npm ci --omit=dev --workspaces=false`).

There is no CI: `.github/workflows/` (`ci.yml`, `deploy.yml`) was deleted in commit 7f89d04. The merchant deploys with the `gcloud` command above. Production runs in Google Cloud project `jhay-510919`. The old project `lalamove-map` has been `DELETE_REQUESTED` since 2026-10-05 and is not used.

The database behind `DATABASE_URL` and `DIRECT_DATABASE_URL` had no applied migrations at the 2026-10-12 deploy: all 11 were applied from scratch. Which Neon project and branch it is has not been verified. Neon "block public connections" must stay off: Cloud Run connects over the public internet.

## Current shape (merchant decisions, 2026-09-25 unless noted)

- Every endpoint is verified by Shopify: webhook HMAC, app-proxy signature, or session token. There are no internal endpoints with their own secrets and no pollers. Merchant: "dapat ang mga verification ay ang external logical na may shopify-Hmac at hindi ang internal logic."
- Google Cloud project `jhay-510919` has one Cloud Run service, `delivery-scheduler`, scaled to zero (`min-instances 0`). It has no Cloud Scheduler job and no Cloud Tasks queue; neither API is enabled (checked 2026-10-12).
- `orders/create` writes the delivery metafields and the schedule tags inline, and answers 500 on a failed step so Shopify redelivers.
- The schedule tags are the bare date and slot (`2026-10-03`, `9AM-12PM`). The app writes them on `orders/create` and on every reschedule. No Shopify Flow writes them: every delivery-tag workflow in Flow is inactive, and "Tag orders with delivery date and time" was turned off on 2026-05-01 (checked 2026-10-02). The Orders page date tabs and date filter search by these tags, and the merchant's Shopify Orders list, order email notifications and analytics use them. Merchant (2026-10-02): "kung babaguhin mo ang order tag ay pwede masira date picker logic kaya dahilan ng pa sulat pa ng app ng order tag" and "yung tag ginagamit ko sa automate sa ibang paraan … tulad ng mga order email notification at ibang analytics na sa order tag bumabase."
- Slot capacity limits are on only for Valentine's Day and Mother's Day. Merchant (2026-10-02): "no capacity yet and its intentional because the capacity is for valentine and mothersday only.. at hindi ito napupuno sa totoong buhay."
- Postgres (`neondb`) holds only `Session`, `DeliveryScheduleConfig`, `EmailSendLog`, and `_prisma_migrations`.
- Removed on merchant request: Lalamove tracking (poll, webhook, Order ID field, table), the delivery-sync queue and hourly sweep, bulk-action jobs, and the COD Settings page. Bulk actions run inline, 10 orders at most.
- The COD fee system was removed on merchant request (2026-10-20): the `cod-eligibility` function, the `cod-fee-notice` extension, the COD part of `delivery-thank-you`, and the code that added the fee line item. The `COD-FEE` SKU product in Shopify and old orders that already carry a fee line were not touched.
- Orders page auto-refreshes every 20 minutes on every view, and the mailbox is read again after each refresh.
- Incoming customer email is read from the Private Email mailbox over IMAP, read-only, only during a request: Orders page load, Refresh, opening the bell, and opening an order panel. There is no IDLE connection and no poller. IMAP reuses `EMAIL_SMTP_USER`/`EMAIL_SMTP_PASSWORD`; `EMAIL_IMAP_HOST` and `EMAIL_IMAP_PORT` are optional.
- Email state lives in Shopify, not Postgres: `$app.email_reply_seen_at` (order metafield, date_time) and `$app.quick_replies` (shop metafield, json, edited on the Delivery Scheduler page).
- The `flowercart_marketing` database on `production` stays, for safe storage with no access by anyone else. It is written from outside this repo. Do not modify or delete it.
- Before any deploy, push to `main`, or database write, show the exact command or change and wait for the merchant (2026-09-26: "ipakita mo muna saakin yung exact command").

## Code map

| Path | What lives there |
|---|---|
| `app/routes` | pages, resource routes, app proxy endpoints, webhooks (file-system routing) |
| `app/services` | everything that talks to Shopify, Postgres or the mailbox (`*.server.ts`) |
| `app/lib` | pure logic: rules engine, tag vocabulary, order helpers, email parsing |
| `app/components` | Polaris web components (Polaris 2.0) screens for the Orders page and the Scheduler page |
| `app/hooks` | refresh, diff, bulk-modal and clipboard hooks |
| `app/data` | the Metro Manila ZIP and barangay list for the fee checker |
| `extensions` | Shopify extensions (checkout, order status, customer account, admin, theme block) |
| `prisma` | schema and migrations |
| `test` | unit tests (vitest) |

Where to look first
- A new order arrives: `app/routes/webhooks.orders.create.ts`.
- What the storefront can book, validate and reschedule: `app/routes/apps.schedule-rules*.ts` (app proxy) and `app/services/delivery-bookings.server.ts`.
- The Orders page: `app/routes/app.orders.tsx`; its 20-minute refresh: `app/hooks/useSmartRefresh.ts`.
- The Scheduler (rules) page: `app/routes/app.scheduler.tsx`.
- Customer email: `app/services/customer-inbox.server.ts` (reads the mailbox) and `app/routes/app.orders_.inbox.ts` (what the bell loads).
- Secrets and settings on Cloud Run: `docs/gcp-inventory.md`.

#Hard Rules - Huwag galawin ang tag, attribute, fulfillment, metafield, o ang ibang umiiral na flow



## Comments in code

Every time code is added or changed, write or update the comment above it. The comment says what the code does, in plain English that a grade 8 student 

