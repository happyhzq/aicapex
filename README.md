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

After the first admin exists, create or update users with:

```bash
npm run user:create -- --email analyst@example.com --password 'change-me' --tier pro --name 'Analyst'
npm run user:create -- --email ops@example.com --password 'change-me' --tier admin --name 'Ops Admin'
```

Available tiers:

- `basic`: overview and source register
- `pro`: basic plus entity drilldowns, country-company bridge, funding, and ROIC
- `enterprise`: pro plus runs, workbook artifacts, external-source snapshots, and model-adjustment audit APIs
- `admin`: enterprise plus update and recalculation controls

Most API routes require the browser session cookie created by `POST /api/auth/login`; update and recalculation actions still also require `x-recalculate-token`.
For HTTPS production deployment, set `AUTH_COOKIE_SECURE=true`.

API examples:

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
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
- The server schedules this same hardware-market refresh daily at `06:30` Asia/Shanghai by default. Configure with `HARDWARE_MARKET_AUTO_REFRESH_ENABLED`, `HARDWARE_MARKET_REFRESH_TIME`, and `HARDWARE_MARKET_SEED_ON_START`.

Optional scheduler settings:

```bash
AUTO_UPDATE_ENABLED=false
AUTO_UPDATE_MODE=workbook
AUTO_UPDATE_SCHEDULE_TYPE=interval
AUTO_UPDATE_INTERVAL_HOURS=24
AUTO_UPDATE_WEEKLY_DAY=0
AUTO_UPDATE_WEEKLY_TIME=00:00
AUTO_UPDATE_RUN_ON_START=false
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
AUTH_BOOTSTRAP_EMAIL=admin@example.com
AUTH_BOOTSTRAP_PASSWORD=change-me
AUTH_BOOTSTRAP_NAME=Administrator
AUTH_BOOTSTRAP_TIER=admin
```
