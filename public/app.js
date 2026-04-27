const state = {
  options: null,
  selectedYear: 2030,
  mixDimension: "country",
  breakdownDimension: "country",
  entityType: "country",
  entityName: "United States",
  bridgeCountry: "",
  bridgeCompany: "",
  financeCompany: "Amazon",
};

const colors = ["#2563eb", "#0f766e", "#b45309", "#7c3aed", "#dc2626", "#0891b2"];

function $(id) {
  return document.getElementById(id);
}

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function fmtUsd(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1000) return `$${(number / 1000).toFixed(2)}T`;
  return `$${number.toFixed(1)}B`;
}

function fmtPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setSelectOptions(select, values, selected, includeAll = false) {
  const options = includeAll ? ["All", ...values] : values;
  select.innerHTML = options
    .map((value) => {
      const optionValue = value === "All" ? "" : value;
      return `<option value="${esc(optionValue)}"${optionValue === selected ? " selected" : ""}>${esc(value)}</option>`;
    })
    .join("");
}

function renderKpis(summary) {
  const byYear = new Map(summary.key_years.map((row) => [row.year_num, row]));
  const cards = [
    ["2026 investment", fmtUsd(byYear.get(2026)?.total_usd_bn), "Starting model year"],
    ["2030 investment", fmtUsd(byYear.get(2030)?.total_usd_bn), `${fmtPct(byYear.get(2030)?.yoy_growth)} YoY`],
    ["2045 investment", fmtUsd(byYear.get(2045)?.total_usd_bn), `${fmtPct(byYear.get(2045)?.yoy_growth)} YoY`],
    ["2026-2045 cumulative", fmtUsd(summary.cumulative_usd_bn), `${summary.source_count} source records`],
  ];
  $("kpiGrid").innerHTML = cards
    .map(
      ([label, value, note]) => `
        <div class="kpi">
          <span>${esc(label)}</span>
          <strong>${esc(value)}</strong>
          <small>${esc(note)}</small>
        </div>`,
    )
    .join("");
}

function renderLineChart(containerId, rows, valueKey, { yFormat = fmtUsd, color = "#2563eb", secondaryKey = null } = {}) {
  const container = $(containerId);
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }
  const width = 760;
  const height = 320;
  const pad = { top: 22, right: 24, bottom: 34, left: 62 };
  const values = rows.map((row) => Number(row[valueKey] || 0));
  const minYear = Math.min(...rows.map((row) => row.year_num));
  const maxYear = Math.max(...rows.map((row) => row.year_num));
  const maxValue = Math.max(...values) * 1.08;
  const minValue = Math.min(0, Math.min(...values));
  const x = (year) => pad.left + ((year - minYear) / (maxYear - minYear)) * (width - pad.left - pad.right);
  const y = (value) =>
    height - pad.bottom - ((value - minValue) / (maxValue - minValue || 1)) * (height - pad.top - pad.bottom);
  const points = rows.map((row) => `${x(row.year_num).toFixed(2)},${y(Number(row[valueKey] || 0)).toFixed(2)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const gy = pad.top + t * (height - pad.top - pad.bottom);
    const val = maxValue - t * (maxValue - minValue);
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}" stroke="#e5e9ed"/><text x="8" y="${gy + 4}" fill="#68727c" font-size="11">${esc(yFormat(val))}</text>`;
  });
  const labels = rows
    .filter((row) => [2026, 2030, 2035, 2040, 2045].includes(row.year_num))
    .map((row) => `<text x="${x(row.year_num)}" y="${height - 10}" fill="#68727c" font-size="11" text-anchor="middle">${row.year_num}</text>`);
  const dots = rows
    .filter((row) => [2026, 2030, 2045].includes(row.year_num))
    .map((row) => {
      const cx = x(row.year_num);
      const cy = y(Number(row[valueKey] || 0));
      return `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}"><title>${row.year_num}: ${yFormat(row[valueKey])}</title></circle>`;
    });
  let secondary = "";
  if (secondaryKey) {
    const secMax = Math.max(...rows.map((row) => Number(row[secondaryKey] || 0)), 0.01) * 1.2;
    const secY = (value) => height - pad.bottom - (value / secMax) * (height - pad.top - pad.bottom);
    const secPoints = rows.map((row) => `${x(row.year_num).toFixed(2)},${secY(Number(row[secondaryKey] || 0)).toFixed(2)}`).join(" ");
    secondary = `<polyline points="${secPoints}" fill="none" stroke="#b45309" stroke-width="2" stroke-dasharray="5 5"/>`;
  }
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">
      ${grid.join("")}
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" stroke="#cfd6dc"/>
      ${labels.join("")}
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"/>
      ${secondary}
      ${dots.join("")}
    </svg>`;
}

function renderBars(containerId, rows, { labelKey = "item_name", valueKey = "amount_usd_bn", maxRows = 10, valueFormat = fmtUsd } = {}) {
  const container = $(containerId);
  const data = rows.slice(0, maxRows);
  if (!data.length) {
    container.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }
  const max = Math.max(...data.map((row) => Number(row[valueKey] || 0)), 1);
  container.innerHTML = data
    .map((row, index) => {
      const value = Number(row[valueKey] || 0);
      const width = Math.max(1, (value / max) * 100);
      return `
        <div class="bar-row">
          <div class="label" title="${esc(row[labelKey])}">${esc(row[labelKey])}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${colors[index % colors.length]}"></div></div>
          <div class="value">${esc(valueFormat(value, row))}</div>
        </div>`;
    })
    .join("");
}

function renderBreakdownTable(rows) {
  $("breakdownTable").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.item_name)}</td>
          <td class="num">${fmtPct(row.share_of_global, 2)}</td>
          <td class="num">${fmtUsd(row.amount_usd_bn)}</td>
        </tr>`,
    )
    .join("");
}

function renderBridgeTable(rows) {
  $("bridgeTable").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.country_name)}</td>
          <td>${esc(row.company_name)}</td>
          <td>${esc(row.component_name)}</td>
          <td class="num">${fmtUsd(row.amount_usd_bn)}</td>
        </tr>`,
    )
    .join("");
}

function renderSources(rows) {
  $("sourcesTable").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.source_id)}</td>
          <td>${esc(row.theme)}</td>
          <td>${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noreferrer">${esc(row.key_fact)}</a>` : esc(row.key_fact)}</td>
          <td>${esc(row.source_type)}</td>
        </tr>`,
    )
    .join("");
}

async function loadOverview() {
  const [health, summary, global] = await Promise.all([api("/api/health"), api("/api/summary"), api("/api/global")]);
  $("healthStatus").textContent = health.ok ? "Connected" : "Degraded";
  $("healthStatus").className = `status-pill ${health.ok ? "ok" : "error"}`;
  $("runLabel").textContent = summary.run.run_id;
  renderKpis(summary);
  renderLineChart("globalLine", global.rows, "total_usd_bn");
  await loadMix();
}

async function loadMix() {
  const data = await api(`/api/breakdown/${state.mixDimension}?year=2030&limit=10`);
  renderBars("mixBars", data.rows, { maxRows: 10 });
}

async function loadEntityComponents() {
  const params = new URLSearchParams({
    entity_type: state.entityType,
    entity_name: state.entityName,
    year: state.selectedYear,
  });
  const data = await api(`/api/entity-components?${params}`);
  $("componentTitle").textContent = `${state.entityName} Component Allocation`;
  renderBars("componentBars", data.rows, {
    labelKey: "component_name",
    maxRows: 18,
    valueFormat: (value, row) => `${fmtUsd(value)} · ${fmtPct(row.component_share)}`,
  });
}

async function loadBreakdown() {
  const data = await api(`/api/breakdown/${state.breakdownDimension}?year=${state.selectedYear}&limit=16`);
  $("breakdownCaption").textContent = `${state.breakdownDimension} ranking for ${state.selectedYear}`;
  renderBreakdownTable(data.rows);
}

async function loadBridge() {
  const params = new URLSearchParams({ year: state.selectedYear, limit: 80 });
  if (state.bridgeCountry) params.set("country", state.bridgeCountry);
  if (state.bridgeCompany) params.set("company", state.bridgeCompany);
  const data = await api(`/api/country-company-components?${params}`);
  $("bridgeCaption").textContent = `${state.selectedYear} allocation rows`;
  renderBridgeTable(data.rows);
}

async function loadFinance() {
  const [funding, finance] = await Promise.all([
    api(`/api/funding?company=${encodeURIComponent(state.financeCompany)}&year=${state.selectedYear}`),
    api(`/api/finance?company=${encodeURIComponent(state.financeCompany)}`),
  ]);
  $("fundingCaption").textContent = `${state.financeCompany}, ${state.selectedYear}`;
  renderBars("fundingBars", funding.rows, {
    labelKey: "funding_source",
    valueKey: "amount_funded_usd_bn",
    maxRows: 8,
    valueFormat: (value, row) => `${fmtUsd(value)} · ${fmtPct(row.share_of_annual_investment)}`,
  });
  renderLineChart("roicLine", finance.rows, "implied_roic", {
    yFormat: (value) => fmtPct(value),
    color: "#0f766e",
    secondaryKey: "weighted_all_in_funding_cost",
  });
}

async function loadSources() {
  const data = await api("/api/sources?limit=80");
  renderSources(data.rows);
}

function wireControls() {
  $("mixTabs").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.mixDimension = button.dataset.dimension;
    document.querySelectorAll("#mixTabs button").forEach((item) => item.classList.toggle("active", item === button));
    await loadMix();
  });

  $("breakdownTabs").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.breakdownDimension = button.dataset.dimension;
    document.querySelectorAll("#breakdownTabs button").forEach((item) => item.classList.toggle("active", item === button));
    await loadBreakdown();
  });

  $("entityTypeSelect").addEventListener("change", async (event) => {
    state.entityType = event.target.value;
    const list = state.entityType === "country" ? state.options.countries : state.options.companies;
    state.entityName = list[0];
    setSelectOptions($("entityNameSelect"), list, state.entityName);
    await loadEntityComponents();
  });

  $("entityNameSelect").addEventListener("change", async (event) => {
    state.entityName = event.target.value;
    await loadEntityComponents();
  });

  $("yearSelect").addEventListener("change", async (event) => {
    state.selectedYear = Number(event.target.value);
    await Promise.all([loadEntityComponents(), loadBreakdown(), loadBridge(), loadFinance()]);
  });

  $("bridgeCountrySelect").addEventListener("change", async (event) => {
    state.bridgeCountry = event.target.value;
    await loadBridge();
  });

  $("bridgeCompanySelect").addEventListener("change", async (event) => {
    state.bridgeCompany = event.target.value;
    await loadBridge();
  });

  $("financeCompanySelect").addEventListener("change", async (event) => {
    state.financeCompany = event.target.value;
    await loadFinance();
  });
}

async function init() {
  try {
    state.options = await api("/api/options");
    state.entityName = state.options.countries.includes("United States") ? "United States" : state.options.countries[0];
    state.financeCompany = state.options.companies.includes("Amazon") ? "Amazon" : state.options.companies[0];
    setSelectOptions($("yearSelect"), state.options.years.map(String), String(state.selectedYear));
    setSelectOptions($("entityNameSelect"), state.options.countries, state.entityName);
    setSelectOptions($("bridgeCountrySelect"), state.options.countries, "", true);
    setSelectOptions($("bridgeCompanySelect"), state.options.companies, "", true);
    setSelectOptions($("financeCompanySelect"), state.options.companies, state.financeCompany);
    wireControls();
    await Promise.all([loadOverview(), loadEntityComponents(), loadBreakdown(), loadBridge(), loadFinance(), loadSources()]);
  } catch (error) {
    console.error(error);
    $("healthStatus").textContent = "Error";
    $("healthStatus").className = "status-pill error";
    $("kpiGrid").innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
  }
}

init();
