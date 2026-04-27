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

Open `http://localhost:3000`.

API examples:

- `GET /api/health`
- `GET /api/summary`
- `GET /api/global`
- `GET /api/breakdown/country?year=2030`
- `GET /api/entity-components?entity_type=country&entity_name=United%20States&year=2030`
- `GET /api/country-company-components?year=2030&country=United%20States`
- `GET /api/funding?company=Amazon&year=2030`
- `GET /api/finance?company=Amazon`
- `POST /api/recalculate` with `x-recalculate-token` when `RECALCULATE_ENABLED=true`

The recalculation endpoint runs `scripts/import_aicapex_workbook.py` and reloads the latest workbook into MySQL as a new versioned model run. Keep it disabled unless the service is running in a trusted environment.
