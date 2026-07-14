const DEFAULT_ENDPOINT = "https://script.google.com/a/macros/allofresh.id/s/AKfycbw6aaSke78nstNJdeJ1sGOrvBxlUiKxh03EIlMIPsFnJBpywKw5fZEYrzEa0_jxy4k1/exec";
const endpointInput = document.querySelector("#apiEndpoint");
const statusBox = document.querySelector("#statusBox");
const installButton = document.querySelector("#installApp");
let deferredInstallPrompt = null;

const state = {
  endpoint: localStorage.getItem("dashboard_api_endpoint") || DEFAULT_ENDPOINT,
  activeTab: "scorecard",
};

endpointInput.value = state.endpoint;

function setStatus(message) {
  statusBox.textContent = message;
}

function formatNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "-";
}

function formatPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "-";
}

function formatIDR(value) {
  const n = Number(value || 0);
  if (n >= 1e9) return `Rp ${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `Rp ${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `Rp ${(n / 1e3).toFixed(0)}K`;
  return `Rp ${Math.round(n).toLocaleString()}`;
}

async function apiCall(action, payload = {}) {
  if (!state.endpoint) {
    throw new Error("Set an API endpoint first.");
  }

  const url = new URL(state.endpoint);
  url.searchParams.set("action", action);
  url.searchParams.set("payload", JSON.stringify(payload));
  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function refreshSummary() {
  setStatus("Loading summary...");
  try {
    const filters = currentFilters();
    const [meta, scorecard] = await Promise.all([
      apiCall("metadata"),
      apiCall("scorecard", { filters, group: "channel", minUsers: 50 }),
    ]);
    hydrateFilters(meta);
    renderScorecard(scorecard);
    setStatus("Summary loaded.");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function currentFilters() {
  const channel = document.querySelector("#channelFilter").value;
  return {
    dateFrom: document.querySelector("#dateFrom").value,
    dateTo: document.querySelector("#dateTo").value,
    installChannels: channel ? [channel] : [],
  };
}

function hydrateFilters(meta = {}) {
  if (meta.dateFrom) document.querySelector("#dateFrom").value = meta.dateFrom;
  if (meta.dateTo) document.querySelector("#dateTo").value = meta.dateTo;

  const channels = String(meta.installChannels || "")
    .split("||")
    .filter(Boolean);
  const select = document.querySelector("#channelFilter");
  const selected = select.value;
  select.innerHTML = `<option value="">All channels</option>` +
    channels.map(channel => `<option value="${channel}">${channel}</option>`).join("");
  select.value = channels.includes(selected) ? selected : "";
}

function renderScorecard(rows = []) {
  const body = document.querySelector("#scorecardBody");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7">No scorecard rows returned.</td></tr>`;
    updateKpis({});
    return;
  }

  body.innerHTML = rows.map(row => `
    <tr>
      <td>${row.groupKey || "-"}</td>
      <td>${formatNumber(row.users)}</td>
      <td>${formatPct(Number(row.matured) ? Number(row.repeatCount) / Number(row.matured) : null)}</td>
      <td>${formatIDR(row.gmvPerUser)}</td>
      <td>${formatIDR(row.aov)}</td>
      <td>${formatPct(row.gm)}</td>
      <td>${formatPct(row.nm)}</td>
    </tr>
  `).join("");

  const totals = rows.reduce((acc, row) => {
    acc.users += Number(row.users || 0);
    acc.registered += Number(row.matured || 0);
    acc.transacted += Number(row.users || 0);
    acc.repeat += Number(row.repeatCount || 0);
    return acc;
  }, { users: 0, registered: 0, transacted: 0, repeat: 0 });
  updateKpis(totals);
}

function updateKpis(totals) {
  document.querySelector("#kpiInstalls").textContent = formatNumber(totals.users);
  document.querySelector("#kpiRegistered").textContent = formatNumber(totals.registered);
  document.querySelector("#kpiTransacted").textContent = formatNumber(totals.transacted);
  document.querySelector("#kpiRepeat").textContent = formatNumber(totals.repeat);
}

document.querySelector("#saveEndpoint").addEventListener("click", () => {
  state.endpoint = endpointInput.value.trim();
  localStorage.setItem("dashboard_api_endpoint", state.endpoint);
  setStatus("Endpoint saved.");
});

document.querySelector("#refreshData").addEventListener("click", refreshSummary);

document.querySelectorAll(".tabs button").forEach(button => {
  button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab;
    document.querySelectorAll(".tabs button").forEach(item => item.classList.toggle("active", item === button));
    document.querySelectorAll(".panel").forEach(panel => panel.classList.add("hidden"));
    document.querySelector(`#${state.activeTab}Panel`).classList.remove("hidden");
  });
});

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      setStatus("Service worker registration failed.");
    });
  });
}
