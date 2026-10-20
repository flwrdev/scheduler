# Google Cloud inventory

Project `jhay-510919` (number `1030649952056`), billing account "Delivery Scheduler" (`017072-6E7F55-594170`, USD). Verified 2026-10-12 with read-only `gcloud` commands and the Artifact Registry API. The Cloud Run, Secret Manager, Artifact Registry, Cloud Build and Cloud Storage sections were checked again on 2026-10-17.
Secret values are never recorded here, names only.

## Project IAM: principals and roles
| Principal | Role | Note |
|---|---|---|
| `user:janbradlieapelado@gmail.com` | `roles/owner` | project owner |
| `1030649952056-compute@developer.gserviceaccount.com` | `roles/editor` | default Compute Engine service account; broad role granted by Google at project creation |
| `1030649952056@cloudbuild.gserviceaccount.com` | `roles/cloudbuild.builds.builder` | Cloud Build |
| `service-1030649952056@gcp-sa-cloudbuild.iam.gserviceaccount.com` | `roles/cloudbuild.serviceAgent` | Google-managed |
| `service-1030649952056@gcp-sa-artifactregistry.iam.gserviceaccount.com` | `roles/artifactregistry.serviceAgent` | Google-managed |
| `service-1030649952056@containerregistry.iam.gserviceaccount.com` | `roles/containerregistry.ServiceAgent` | Google-managed |
| `service-1030649952056@gcp-sa-pubsub.iam.gserviceaccount.com` | `roles/pubsub.serviceAgent` | Google-managed |
| `service-1030649952056@serverless-robot-prod.iam.gserviceaccount.com` | `roles/run.serviceAgent` | Google-managed (Cloud Run) |

`delivery-scheduler-runtime` holds no project-level role.

## Service accounts
| Service account | Disabled | User-managed keys | Used for |
|---|---|---|---|
| `delivery-scheduler-runtime@jhay-510919.iam.gserviceaccount.com` | no | 0 | identity of the Cloud Run service |
| `1030649952056-compute@developer.gserviceaccount.com` | no | 0 | default Compute Engine account |

## Cloud Run
Service `delivery-scheduler`, region `us-central1`, URL `https://delivery-scheduler-1030649952056.us-central1.run.app`.
- Revisions: `delivery-scheduler-00007-xgr` (serving 100% of traffic, 2026-10-17 13:09 UTC, digest ending `891cb82bb28b`; Polaris 2.0 UI fixes and the `GOOGLE_MAPS_API_KEY` secret), `00006-xxv` (2026-10-17 07:56 UTC, `d74cdebc2010`; Polaris 2.0 UI), `00005-8h6` (2026-10-14 19:57 UTC, `3333c85d84a8`; the last revision before the Polaris 2.0 UI), `00004-2qx` (2026-10-12 18:20 UTC, `a3b77f54a9cf`), and `host-fix-1013` (13:45 UTC), `00002-2t6` (12:02 UTC), `00001-9mz` (09:27 UTC) on 2026-10-12, digest ending `ae42ba412495`.
- Image: `us-central1-docker.pkg.dev/jhay-510919/cloud-run-source-deploy/delivery-scheduler`, tag `latest` on the digest ending `891cb82bb28b`.
- Runtime service account: `delivery-scheduler-runtime@jhay-510919.iam.gserviceaccount.com`.
- Scaling: minimum 0 instances, maximum 2, concurrency 80, startup CPU boost on. Resources: 1 CPU, 512Mi. Request timeout 300 s. Container port 8080. Ingress: all.
- Service IAM: `roles/run.invoker` for `allUsers` (public). Requests are verified by Shopify signatures and session tokens in the app.

## Secret Manager
All ten secrets are readable by `delivery-scheduler-runtime` (`roles/secretmanager.secretAccessor`, set on the secret, not on the project). On 2026-10-17 the default Compute Engine service account also held that role on `GOOGLE_MAPS_API_KEY` and `SHOPIFY_API_SECRET`; the other eight secrets were not checked. The service reads `latest` when an instance starts, so a changed secret applies only to a new revision.

| Secret | Versions |
|---|---|
| `EMAIL_SMTP_HOST` | v2 enabled; v1 disabled (it ended with a hidden character) |
| `SMPT_PASSWORD` | v2 enabled; v1 destroyed (wrong password) |
| `GOOGLE_MAPS_API_KEY` | v1 enabled (created 2026-10-12 19:27 UTC) |
| the other seven | v1 enabled |

| Secret | Environment variable |
|---|---|
| `SHOPIFY_API_SECRET` | `SHOPIFY_API_SECRET` |
| `DATABASE_URL` | `DATABASE_URL` |
| `DIRECT_DATABASE_URL` | `DIRECT_DATABASE_URL` |
| `SMPT_PASSWORD` | `EMAIL_SMTP_PASSWORD` |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN` | `SHOPIFY_STOREFRONT_ACCESS_TOKEN` |
| `EMAIL_SMTP_HOST` | `EMAIL_SMTP_HOST` |
| `EMAIL_SMTP_PORT` | `EMAIL_SMTP_PORT` |
| `EMAIL_SMTP_USER` | `EMAIL_SMTP_USER` |
| `EMAIL_FROM_NAME` | `EMAIL_FROM_NAME` |
| `GOOGLE_MAPS_API_KEY` | `GOOGLE_MAPS_API_KEY` |

`GOOGLE_MAPS_API_KEY` is mapped from revision `00007-xgr` on. The browser uses it for the address suggestions in the Edit details modal.

## Plain environment variables on the service
`SHOPIFY_API_KEY` (`192d50677bb4239697e25fd7ad097c50`), `SHOPIFY_APP_URL` (`https://delivery-scheduler-1030649952056.us-central1.run.app`), `SHOP_DOMAIN` (`hsrwva-nr.myshopify.com`), `SCOPES`. `SHOP_CUSTOM_DOMAIN` is unset.

## Artifact Registry
Repository `cloud-run-source-deploy` (docker, standard, `us-central1`). Cleanup policy: keep the 2 most recent versions, delete the rest.

Image `delivery-scheduler` has ten entries in the listing, from four deploys (2026-10-12 18:20, 2026-10-14 19:57, 2026-10-17 07:56 and 13:09 UTC). Current: tag `latest`, digest ending `891cb82bb28b`. The digest ending `ae42ba412495` (revisions 00001, 00002, host-fix-1013) is no longer listed.

Contents of the image built on 2026-10-12 09:27 UTC (digest ending `ae42ba412495`, no longer listed). Later images are built from the same Dockerfile; their size was not measured:
| Layer | Compressed size | What it is |
|---|---|---|
| 1 | 3.7 MB | Alpine 3.24 base |
| 2 | 53.0 MB | Node 22.23 |
| 3 to 7 | 4.0 MB | Yarn, node entrypoint, `openssl`, `WORKDIR /app`, `package.json` and `package-lock.json` |
| 8 | 113.3 MB | `npm ci --omit=dev --workspaces=false` (production dependencies) |
| 9 | 0.4 MB | `build/` (the React Router client and server build) |
| 10 | 0.0 MB | `prisma/` (schema and migrations) |
| 11 | 0.0 MB | `prisma.config.ts` |

Image settings: working directory `/app`; environment `PATH`, `NODE_VERSION`, `YARN_VERSION`, `NODE_ENV`; start command `sh -c "prisma migrate deploy && exec react-router-serve ./build/server/index.js"`.
The image holds no source of `app/`, `extensions/` or `test/`, no `.env` file and no secret value.

## Cloud Build
Nine builds in `us-central1`. SUCCESS: `d5c2c6d9` (2026-10-12 09:23), `bc228380` (2026-10-12 18:15), `20be46d4` (2026-10-14 19:52), `c2133271` (2026-10-17 07:52), `ec4cc011` (2026-10-17 13:05) UTC. FAILURE: `2b2efdf6` (15:24), `85a4c8b6` (15:48), `d4a46ebc` (15:57), `b7ef4e40` (16:28) UTC on 2026-10-14. The causes of the failures were not looked into.

## Cloud Storage
Bucket `run-sources-jhay-510919-us-central1` (`us-central1`): one source zip per deploy, 9 objects, 8.24 MiB in total.

## Enabled APIs
Enabled for this work: `run`, `cloudbuild`, `artifactregistry`, `iam`, `secretmanager`, `billingbudgets`.
Also enabled (present at project creation or added as dependencies): `analyticshub`, `apptopology`, `bigquery`, `bigqueryconnection`, `bigquerydatapolicy`, `bigquerydatatransfer`, `bigquerymigration`, `bigqueryreservation`, `bigquerystorage`, `cloudapis`, `cloudtrace`, `containerregistry`, `dataform`, `dataplex`, `datastore`, `iamcredentials`, `logging`, `monitoring`, `pubsub`, `servicemanagement`, `serviceusage`, `sql-component`, `storage`, `storage-api`, `storage-component`, `telemetry` (all under `googleapis.com`).
The Cloud Scheduler and Cloud Tasks APIs are not enabled.

## Budget
`delivery-scheduler-free-guard`, 1 USD, email alerts at 50%, 90%, 100% and 100% forecast. It alerts only and does not stop spending.

## Shopify app
Dev Dashboard organization `163673913`, app `delivery-scheduler` (id `433770856449`), Client ID `192d50677bb4239697e25fd7ad097c50`, store `hsrwva-nr.myshopify.com`. Active version `delivery-scheduler-2` (2026-10-12) holds the Cloud Run URL, 3 webhooks (`orders/create`, `app/uninstalled`, `app/scopes_update`), the app proxy and 8 extensions. The earlier client ID `a9127e5f8228762411a021805a397069` is not used.

## Previous project
`lalamove-map` (number `299861709433`) is `DELETE_REQUESTED` since 2026-10-05 12:22 UTC and is not used.
