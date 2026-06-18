# AI CapEx Monitor

This repository contains the first structured version of the AI infrastructure capex forecast model.

The current seed workbook forecasts global AI-related infrastructure investment from 2026 to 2045 and breaks the forecast down by:

- global totals
- country
- sponsor / company
- infrastructure component
- country x company x component bridge
- funding source
- financing cost and ROIC proxy

## Files

- `global_ai_investment_forecast_2026_2045_v7_memory_storage_split.xlsx`  
  Seed workbook generated from the forecasting conversation.
- `scripts/import_aicapex_workbook.py`  
  Imports the workbook into a remote MySQL database using a versioned `run_id`.
- `.env.example`  
  Local environment template. Copy it to `.env` and fill in real credentials locally.

## Local Setup

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
```

Update `.env` with the real MySQL host, port, user, password, database, and workbook path.

`.env` is ignored by Git and must not be committed.

## Import Workbook

```bash
python3 scripts/import_aicapex_workbook.py
```

The importer creates the target database if needed, creates the required tables, then loads the workbook into normalized tables keyed by `run_id`.

## Current Database Shape

The importer writes tables including:

- `model_runs`
- `source_register`
- `global_forecast`
- `forecast_totals`
- `entity_component_forecast`
- `country_company_allocation`
- `country_company_component_forecast`
- `company_funding_terms`
- `company_finance_roic`

The current MySQL user may not have `REFERENCES` privilege, so the importer does not require foreign keys. Integrity is maintained through primary keys and the shared `run_id`.

## Run API And Dashboard

```bash
npm install
npm start
```

Open `http://localhost:8788`.

The dashboard now requires a login. On first startup, set bootstrap credentials in `.env` to create the initial admin user:

```bash
AUTH_BOOTSTRAP_EMAIL=admin@example.com
AUTH_BOOTSTRAP_PASSWORD=change-me
AUTH_BOOTSTRAP_NAME=Administrator
AUTH_BOOTSTRAP_TIER=admin
```

## Authorized Proxy Pool Utility

This repo also includes a standalone proxy pool CLI for proxies you own, operate, or are explicitly authorized to use. It does not scrape public proxy lists.

Create `proxies.txt` from `proxies.example.txt`, then add one proxy URL per line:

```bash
cp proxies.example.txt proxies.txt
```

Batch validate proxies:

```bash
npm run proxy:validate -- --file proxies.txt --target https://api.ipify.org?format=json --out tmp/proxy-health.json --healthy-out tmp/healthy-proxies.txt
```

Start a local rotating proxy with an outbound host allowlist:

```bash
npm run proxy:serve -- --file tmp/healthy-proxies.txt --allow-host api.ipify.org --allow-host httpbin.org --port 8899
```

Use the local endpoint as your HTTP proxy:

```bash
curl -x http://127.0.0.1:8899 https://api.ipify.org?format=json
curl http://127.0.0.1:8899/status
```

The rotator uses round-robin selection across loaded proxies, marks successful requests healthy again, and ejects a proxy after `--max-failures` consecutive failures.

Authentication uses a dedicated AI CapEx auth database by default:

- `aicapex_auth.siteusers`: users, roles, tiers, and subscription status
- `aicapex_auth.usersessions`: hashed login session tokens

Set `AUTH_DATABASE` if the auth schema should use a different database name. The service and `npm run user:create` create this schema and the auth tables if the MySQL account has `CREATE` privileges. The model data remains in `MYSQL_DATABASE` and is not mixed with the auth schema.

Unauthenticated visitors enter as `free` guests and can see the public overview. Registration writes a new `viewer + free` user to `siteusers`. Paid plans require Stripe Checkout; if Stripe is not configured, the API refuses paid upgrades instead of granting access locally. A paid tier is applied only after Stripe sends a verified webhook confirming the checkout session or subscription status.

After the first admin exists, create or update users with:

```bash
npm run user:create -- --email analyst@example.com --password 'change-me-123' --tier pro --username analyst
npm run user:create -- --email ops@example.com --password 'change-me-123' --tier admin --username ops-admin
```

Admin users can also manage accounts in the dashboard's Users section. Both paths use the same project-owned `siteusers` and `usersessions` tables.

Available tiers:

- `free`: public overview
- `pro`: free plus entity drilldowns, country-company bridge, funding, ROIC, and hardware breadth
- `enterprise`: pro plus runs, workbook artifacts, external-source snapshots, source register, and model-adjustment audit APIs
- `admin`: enterprise plus update and recalculation controls

Protected API routes require the browser session cookie created by `POST /api/auth/login`; update and recalculation actions still also require `x-recalculate-token`.
For HTTPS production deployment, set `AUTH_COOKIE_SECURE=true`.

Optional Stripe settings:

```bash
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=
STRIPE_PRICE_PRO_ONE_TIME=
STRIPE_PRICE_ENTERPRISE_ONE_TIME=
STRIPE_WEBHOOK_SECRET=
STRIPE_CHECKOUT_LOCALE=auto
STRIPE_ALLOW_PROMOTION_CODES=true
STRIPE_WEBHOOK_TOLERANCE_SECONDS=300
STRIPE_ONE_TIME_ACCESS_DAYS=30
```

Create CNY recurring Stripe Price IDs for the `pro` and `enterprise` monthly plans. To support payment methods that do not work with Checkout subscription mode, also create CNY one-time Price IDs for `STRIPE_PRICE_PRO_ONE_TIME` and `STRIPE_PRICE_ENTERPRISE_ONE_TIME`; successful one-time payments grant `STRIPE_ONE_TIME_ACCESS_DAYS` days of access. Enable the payment methods and promotion codes you want in the Stripe Dashboard, and point a webhook endpoint at:

```text
https://your-domain.example/api/stripe/webhook
```

Handle at least these webhook events:

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

Checkout uses Stripe's dynamic payment methods. Cards are generally available for subscriptions; Alipay and WeChat Pay should be offered through one-time payment Checkout when the Stripe account, customer, currency, product mode, and Dashboard configuration support them.

`STRIPE_PUBLISHABLE_KEY` is safe to expose to the browser, but `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` must stay in private server environment variables and must not be committed.

After filling Stripe environment variables, validate the local configuration without printing secrets:

```bash
npm run stripe:check
```

Configure the Stripe Customer Portal in the Dashboard so paid users can manage billing, payment methods, invoices, and cancellations through `POST /api/subscriptions/portal`.

API examples:

- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/plans`
- `POST /api/subscriptions/checkout`
- `POST /api/subscriptions/portal`
- `POST /api/stripe/webhook`
- `GET /api/health`
- `GET /api/summary`
- `GET /api/global`
- `GET /api/breakdown/country?year=2030`
- `GET /api/entity-components?entity_type=country&entity_name=United%20States&year=2030`
- `GET /api/country-company-components?year=2030&country=United%20States`
- `GET /api/funding?company=Amazon&year=2030`
- `GET /api/finance?company=Amazon`
- `GET /api/hardware-dashboard?year=2030`
- `GET /api/hardware-market-breadth`
- `POST /api/recalculate` with `x-recalculate-token` when `RECALCULATE_ENABLED=true`

The recalculation endpoint runs `scripts/import_aicapex_workbook.py` and reloads the latest workbook into MySQL as a new versioned model run. Keep it disabled unless the service is running in a trusted environment.

## Update Modes

The dashboard exposes a data update panel backed by:

- `GET /api/update/status`
- `POST /api/update/config`
- `POST /api/update/run`

Protected update actions use the same `x-recalculate-token` header as `/api/recalculate`.

Mode `workbook` is Scheme A. It reruns `scripts/import_aicapex_workbook.py` and publishes a new MySQL model run from the configured Excel workbook.

Mode `pipeline` is Scheme B. By default it runs `scripts/run_dynamic_pipeline.py`, which fetches external data, adjusts the workbook drivers, archives the generated workbook, and publishes the adjusted model run. To replace it with a different production pipeline, set `PIPELINE_UPDATE_COMMAND` to that command. The dashboard/API contract stays the same.

The default Scheme B pipeline now performs the full automated loop:

1. reads `config/external_data_sources.json`
2. fetches configured external sources from FRED and SEC company facts
3. converts source observations into driver-adjustment signals
4. copies the configured Excel workbook into `outputs/model_runs/<pipeline_id>/`
5. updates the copied workbook's `Drivers` sheet and appends a `Dynamic_Update_Log`
6. imports that generated workbook into MySQL as a new model run
7. stores generated workbook paths, source snapshots, and driver adjustments in MySQL

Additional audit APIs:

- `GET /api/artifacts`
- `GET /api/external-sources`
- `GET /api/model-adjustments`

Hardware breadth and optical split:

- `config/hardware_tracks.json` defines AI hardware track baskets, public-company constituents, and optical split assumptions.
- `scripts/import_aicapex_workbook.py` now writes derived `hardware_track_*` and `optical_*` tables for each model run.
- `/api/hardware-dashboard` derives track capex exposure and the optical investment split from the current model run.
- `/api/hardware-market-breadth` reads the latest persisted hardware-market breadth snapshot.
- `POST /api/hardware-market-breadth/refresh` manually fetches recent public-company prices, calculates each track's percent of constituents above their 20-day and 50-day moving averages, and stores the latest complete breadth snapshot in MySQL.
- The server schedules this same hardware-market refresh daily at `06:30` Asia/Shanghai by default. If the scheduled run does not advance the latest compatible snapshot date, it retries automatically because market-data vendors may publish the full U.S. close later than 06:30. Configure with `HARDWARE_MARKET_AUTO_REFRESH_ENABLED`, `HARDWARE_MARKET_REFRESH_TIME`, `HARDWARE_MARKET_SEED_ON_START`, `HARDWARE_MARKET_CATCHUP_RETRY_MINUTES`, and `HARDWARE_MARKET_CATCHUP_MAX_RETRIES`.

Optional scheduler settings:

```bash
AUTO_UPDATE_ENABLED=false
AUTO_UPDATE_MODE=workbook
AUTO_UPDATE_SCHEDULE_TYPE=interval
AUTO_UPDATE_INTERVAL_HOURS=24
AUTO_UPDATE_WEEKLY_DAY=0
AUTO_UPDATE_WEEKLY_TIME=00:00
AUTO_UPDATE_RUN_ON_START=false
HARDWARE_MARKET_AUTO_REFRESH_ENABLED=true
HARDWARE_MARKET_REFRESH_TIME=06:30
HARDWARE_MARKET_SEED_ON_START=true
HARDWARE_MARKET_CATCHUP_RETRY_MINUTES=120
HARDWARE_MARKET_CATCHUP_MAX_RETRIES=8
UPDATE_CONFIG_PATH=tmp/update-config.json
PIPELINE_UPDATE_COMMAND=
EXTERNAL_SOURCE_CONFIG_PATH=config/external_data_sources.json
MODEL_ARCHIVE_DIR=outputs/model_runs
PIPELINE_TIMEOUT_SECONDS=20
PIPELINE_FETCH_CONCURRENCY=4
SEC_USER_AGENT=aicapex-monitor/0.1 admin@example.com
AUTH_COOKIE_NAME=aicapex_session
AUTH_SESSION_TTL_SECONDS=604800
AUTH_COOKIE_SECURE=false
AUTH_MIN_PASSWORD_LENGTH=6
AUTH_DATABASE=aicapex_auth
AUTH_BOOTSTRAP_EMAIL=admin@example.com
AUTH_BOOTSTRAP_USERNAME=admin
AUTH_BOOTSTRAP_PASSWORD=change-me
AUTH_BOOTSTRAP_NAME=Administrator
AUTH_BOOTSTRAP_TIER=admin
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_PRICE_PRO=
STRIPE_PRICE_ENTERPRISE=
STRIPE_PRICE_PRO_ONE_TIME=
STRIPE_PRICE_ENTERPRISE_ONE_TIME=
STRIPE_WEBHOOK_SECRET=
STRIPE_CHECKOUT_LOCALE=auto
STRIPE_ALLOW_PROMOTION_CODES=true
STRIPE_WEBHOOK_TOLERANCE_SECONDS=300
STRIPE_ONE_TIME_ACCESS_DAYS=30
```
