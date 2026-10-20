# Runbook

Checked 2026-10-12. Resource names, principals, roles and the secret list are in [gcp-inventory.md](gcp-inventory.md). Secret values are never recorded.

## What runs where
- Shopify app: Dev Dashboard app `delivery-scheduler`, store `hsrwva-nr.myshopify.com`. `shopify.app.production.toml` is the app configuration.
- Backend: Cloud Run service `delivery-scheduler`, project `jhay-510919`, region `us-central1`.
- Database: Neon Postgres through `DATABASE_URL` and `DIRECT_DATABASE_URL`.
- There is no poller, worker, queue or scheduled job. Orders and bulk actions run inside the request. The mailbox is read over IMAP only during a request. The browser refreshes the Orders page on a timer (`app/hooks/useSmartRefresh.ts`).

## Tools on the deploying machine
Node 22.12 or newer and the Shopify CLI (`npm install -g @shopify/cli`). The Google Cloud SDK needs `CLOUDSDK_PYTHON` pointing at its bundled Python on this machine, and `gcloud auth login` once.

## Deploy the backend
```
gcloud run deploy delivery-scheduler --source . --region us-central1 --project jhay-510919 --service-account delivery-scheduler-runtime@jhay-510919.iam.gserviceaccount.com
```
Secrets and environment variables stay on the service. Change one variable without a rebuild:
```
gcloud run services update delivery-scheduler --region us-central1 --project jhay-510919 --update-env-vars NAME=value
```
Check: the revision is `Ready`; the log shows `All migrations have been successfully applied` or `No pending migration`; `/` answers 200.

## Deploy the Shopify configuration and extensions
Run from the repo folder after `npm ci`:
```
shopify app deploy --config shopify.app.production.toml --allow-updates
```
Check: Dev Dashboard > Apps > delivery-scheduler > Versions shows a new Active version whose `application_url` is the Cloud Run URL.

If the Cloud Run URL changes, edit it in `shopify.app.production.toml` (`application_url`, `redirect_urls`, `app_proxy`) and in the `APP_BASE_URL` constants of `extensions/delivery-date-editor/src/index.tsx` and `extensions/delivery-reschedule-customer/src/order-action-modal.tsx` (and its test), then deploy both. `SHOPIFY_API_KEY` on Cloud Run must equal the `client_id` in the toml.

## Verify after a deploy
Open the app from the store admin. `/app/orders` and `/app/scheduler` should load.

## Errors seen and their cause
| Error | Cause |
|---|---|
| "This domain is for use in documentation examples" inside the app | the Active app version has `application_url = https://example.com`; run the Shopify deploy |
| `401 Unauthorized` inside the app | `SHOPIFY_API_KEY` or `SHOPIFY_API_SECRET` on Cloud Run is not the one of the installed app |
| `shopify: command not found` | open a new terminal, or call `%APPDATA%\npm\shopify.cmd` |
| `npm: command not found` | Node is not installed |
| `Python was not found` from gcloud | set `CLOUDSDK_PYTHON` to `<sdk>/platform/bundledpython/python.exe` |
| `You do not have an active account` from gcloud | run `gcloud auth login` |
| `Secret ID ... does not match the expected format` in Git Bash | strip the carriage return from the name (`tr -d '\r'`) |
| `Permission denied on resource project` | the project is deleted or the account has no access; check `gcloud projects describe` |
| deploy fails on `--set-secrets` | a named secret does not exist yet |
| every migration is applied from scratch | the database behind `DIRECT_DATABASE_URL` is empty |
| `Couldn't read the inbox: Socket timeout` on the Orders page | `EMAIL_SMTP_HOST`, `EMAIL_SMTP_USER` or the mailbox password is wrong. A hidden character at the end of a pasted value, or one wrong letter in the password, causes it even when the mail server is healthy. See "Add or replace a secret value" |

## Add or replace a secret value
Pasting a value into the Google Cloud console can bring a hidden character with it (a zero-width space is the bytes `e2 80 8b`). The value then looks right but does not match.

Add the value from the terminal instead, so only the typed text is stored:
```bash
printf '%s' 'the-value' | gcloud secrets versions add NAME --data-file=- --project jhay-510919
gcloud secrets versions disable OLD_VERSION --secret=NAME --project jhay-510919
gcloud run services update delivery-scheduler --region us-central1 --project jhay-510919 --revision-suffix=NEW_NAME
```
The last command is needed because the service reads secrets only when an instance starts. The typed value stays in the terminal history.

To check a stored value without printing it, compare its size with the number of visible characters. A hidden character adds bytes (a zero-width space adds 3):
```bash
gcloud secrets versions access latest --secret=NAME --project jhay-510919 | tr -d '\r' | wc -c
```

## Components and APIs
- Google Cloud APIs enabled for this work: `run`, `cloudbuild`, `artifactregistry`, `iam`, `secretmanager`, `billingbudgets`.
- Shopify Admin GraphQL (`2026-04`), Shopify Storefront API (token), Google Maps JavaScript SDK and Places API (New) in the browser (optional key), SMTP and IMAP on the Private Email mailbox, Neon Postgres through Prisma.
- Routes: `app.*` use the Shopify session; `apps.schedule-rules.*` use the app proxy signature; `public.customer-account.*` verify the customer-account session token with `SHOPIFY_API_SECRET`; `webhooks.*` verify the webhook HMAC.
- Extensions: `delivery-thank-you`, `delivery-date-editor`, `delivery-reschedule-customer`, `delivery-reschedule-action`, `order-delivery-block`, `delivery-fee-checker` (theme).

## Cost guard
Budget `delivery-scheduler-free-guard` (1 USD) only alerts. `min-instances 0`. Artifact Registry keeps the 2 newest images.
