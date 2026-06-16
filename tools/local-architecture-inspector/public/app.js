const VIEW_TITLES = {
  overview: "概要",
  flow: "フロー図",
  mapping: "API呼び出し",
  routes: "ルート一覧",
  drift: "未解決 / ドリフト",
};

const el = (id) => document.getElementById(id);
const state = {
  snapshot: null,
  view: "overview",
  search: "",
  serviceFilter: "",
  selectedFlowId: null,
};

let mermaidReady = false;
function ensureMermaid() {
  if (mermaidReady || !window.mermaid) return;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "base",
    themeVariables: {
      darkMode: true,
      background: "#0b1220",
      primaryColor: "#1e293b",
      primaryBorderColor: "#475569",
      primaryTextColor: "#e2e8f0",
      lineColor: "#64748b",
      tertiaryColor: "#0f172a",
      clusterBkg: "#0f172a",
      clusterBorder: "#334155",
      fontFamily: "var(--sans)",
      fontSize: "14px",
    },
  });
  mermaidReady = true;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function confidenceTag(confidence) {
  const map = { exact: "一致", prefix: "前方一致", unresolved: "未解決" };
  return `<span class="tag tag-${confidence}">${map[confidence] || confidence}</span>`;
}

async function fetchSnapshot(refresh = false) {
  const res = await fetch(`/api/architecture${refresh ? "?refresh=1" : ""}`);
  if (!res.ok) throw new Error(`architecture ${res.status}`);
  return res.json();
}

function serviceLabel(name) {
  const meta = state.snapshot?.serviceMeta?.find((s) => s.name === name);
  return meta?.label || name;
}

/* ---------- routing ---------- */
function currentView() {
  const hash = location.hash.replace(/^#\//, "");
  return VIEW_TITLES[hash] ? hash : "overview";
}

function syncView() {
  state.view = currentView();
  el("viewTitle").textContent = VIEW_TITLES[state.view];
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("is-active", v.dataset.view === state.view);
  });
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("is-active", n.dataset.view === state.view);
  });
  const showSearch = state.view === "mapping" || state.view === "routes" || state.view === "drift";
  el("searchInput").style.display = showSearch ? "" : "none";
  el("serviceFilter").style.display = state.view === "mapping" ? "" : "none";
  renderActiveView();
}

/* ---------- renderers ---------- */
function renderActiveView() {
  if (!state.snapshot) return;
  if (state.view === "overview") renderOverview();
  else if (state.view === "flow") renderFlow();
  else if (state.view === "mapping") renderMapping();
  else if (state.view === "routes") renderRoutes();
  else if (state.view === "drift") renderDrift();
}

function renderSidebar() {
  const snap = state.snapshot;
  const unresolved = snap.routeCoverage.unresolved;
  const badge = el("navUnresolved");
  badge.textContent = unresolved ? String(unresolved) : "";
  badge.style.display = unresolved ? "" : "none";
  const ts = new Date(snap.generatedAt);
  el("scanMeta").textContent = `更新 ${ts.toLocaleTimeString("ja-JP")} ・ ${snap.scanDetails.scannedFiles} files`;
}

function renderServiceFilter() {
  const sel = el("serviceFilter");
  const current = state.serviceFilter;
  const services = state.snapshot.graph.layers.find((l) => l.id === "backend").nodes;
  sel.innerHTML = `<option value="">全サービス</option>` +
    services.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join("");
  sel.value = current;
}

function renderOverview() {
  const snap = state.snapshot;
  el("kpiApps").textContent = snap.apps.length;
  el("kpiServices").textContent = snap.serviceMeta.length;
  el("kpiFlows").textContent = snap.routeCoverage.total;
  el("kpiUnresolved").textContent = snap.routeCoverage.unresolved;

  const byService = snap.routeCoverage.byService || {};
  const entries = Object.entries(byService).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  el("serviceBars").innerHTML = entries.map(([name, n]) => {
    const isUnresolved = name === "external-or-unknown";
    return `<div class="bar-row">
      <span class="bar-label">${escapeHtml(serviceLabel(name))}</span>
      <span class="bar-track"><span class="bar-fill ${isUnresolved ? "bar-warn" : ""}" style="width:${(n / max) * 100}%"></span></span>
      <span class="bar-value">${n}</span>
    </div>`;
  }).join("") || `<p class="muted">データなし</p>`;

  el("laneSummary").innerHTML = snap.graph.layers.map((layer) => `
    <div class="lane">
      <h3>${escapeHtml(layer.label)} <span class="muted">${layer.nodes.length}</span></h3>
      <ul>${layer.nodes.map((n) => `<li>${escapeHtml(n.label)}</li>`).join("")}</ul>
    </div>`).join("");
}

async function renderFlow() {
  ensureMermaid();
  const target = el("mermaidDiagram");
  const code = state.snapshot.mermaid;
  target.removeAttribute("data-processed");
  try {
    const { svg } = await window.mermaid.render("archGraph", code);
    target.innerHTML = svg;
  } catch (err) {
    target.innerHTML = `<pre class="source">${escapeHtml(code)}</pre>`;
    console.error("mermaid render failed", err);
  }
}

function filteredFlows() {
  const q = state.search.trim().toLowerCase();
  return state.snapshot.appFlows.filter((f) => {
    if (state.serviceFilter && f.service !== state.serviceFilter) return false;
    if (!q) return true;
    return `${f.method} ${f.path} ${f.sourceFile} ${f.sourceApp}`.toLowerCase().includes(q);
  });
}

function renderMapping() {
  renderServiceFilter();
  const flows = filteredFlows();
  const body = el("flowTable");
  body.innerHTML = flows.map((f) => `
    <tr data-flow="${escapeHtml(f.id)}" class="${f.id === state.selectedFlowId ? "is-selected" : ""}">
      <td>${escapeHtml(serviceLabel(f.sourceApp))}</td>
      <td><span class="method method-${f.method}">${escapeHtml(f.method)}</span></td>
      <td class="mono">${escapeHtml(f.path)}</td>
      <td>${escapeHtml(serviceLabel(f.service))}</td>
      <td>${confidenceTag(f.confidence)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">該当なし</td></tr>`;

  body.querySelectorAll("tr[data-flow]").forEach((tr) => {
    tr.addEventListener("click", () => selectFlow(tr.dataset.flow));
  });
}

async function selectFlow(flowId) {
  state.selectedFlowId = flowId;
  const flow = state.snapshot.appFlows.find((f) => f.id === flowId);
  document.querySelectorAll("#flowTable tr").forEach((tr) =>
    tr.classList.toggle("is-selected", tr.dataset.flow === flowId));
  if (!flow) return;
  el("selectedCall").innerHTML =
    `<span class="method method-${flow.method}">${flow.method}</span> <span class="mono">${escapeHtml(flow.path)}</span><br><span class="muted">${escapeHtml(flow.sourceFile)}</span>`;
  const viewer = el("sourceViewer");
  viewer.textContent = "読み込み中…";
  try {
    const res = await fetch(`/api/source?path=${encodeURIComponent(flow.sourceFile)}`);
    if (!res.ok) throw new Error(String(res.status));
    const { text } = await res.json();
    viewer.innerHTML = highlightSource(text, flow.path);
  } catch {
    viewer.textContent = "ソースを取得できませんでした";
  }
}

function highlightSource(text, needlePath) {
  const lines = text.split("\n");
  const token = needlePath.split("/").filter(Boolean).slice(-1)[0] || needlePath;
  return lines.map((line, i) => {
    const hit = needlePath && line.includes(token);
    return `<span class="src-line ${hit ? "src-hit" : ""}"><span class="src-no">${i + 1}</span>${escapeHtml(line)}</span>`;
  }).join("\n");
}

function renderRoutes() {
  const q = state.search.trim().toLowerCase();
  const match = (s) => !q || s.toLowerCase().includes(q);
  const snap = state.snapshot;

  el("appList").innerHTML = snap.apps.map((app) => {
    const pages = app.pages.filter((p) => match(`${p.route} ${p.file}`));
    const apis = app.apiRoutes.filter((r) => match(`${r.route} ${r.file}`));
    if (!pages.length && !apis.length) return "";
    return `<div class="list-group">
      <h3>${escapeHtml(app.label)} <span class="muted">${app.pageCount}画面 / ${app.apiRouteCount}API</span></h3>
      ${pages.map((p) => `<div class="list-item"><span class="chip chip-page">画面</span><span class="mono">${escapeHtml(p.route)}</span></div>`).join("")}
      ${apis.map((r) => `<div class="list-item"><span class="chip chip-api">API</span><span class="mono">${escapeHtml(r.route)}</span><span class="muted">${escapeHtml(r.methods.join(", "))}</span></div>`).join("")}
    </div>`;
  }).join("") || `<p class="muted">該当なし</p>`;

  el("serviceList").innerHTML = snap.serviceMeta.map((svc) => {
    const routes = svc.routes.filter((r) => match(`${r.method} ${r.path}`));
    if (!routes.length) return "";
    return `<div class="list-group">
      <h3>${escapeHtml(svc.label)} <span class="muted">${svc.routeCount}ルート</span></h3>
      ${routes.map((r) => `<div class="list-item"><span class="method method-${r.method}">${escapeHtml(r.method)}</span><span class="mono">${escapeHtml(r.path)}</span></div>`).join("")}
      ${svc.moreRoutes > 0 ? `<p class="muted">他 ${svc.moreRoutes} ルート</p>` : ""}
    </div>`;
  }).join("") || `<p class="muted">該当なし</p>`;
}

function renderDrift() {
  const q = state.search.trim().toLowerCase();
  const items = state.snapshot.appFlows
    .filter((f) => f.confidence === "unresolved")
    .filter((f) => !q || `${f.method} ${f.path} ${f.sourceFile}`.toLowerCase().includes(q));
  el("driftList").innerHTML = items.length
    ? items.map((f) => `<div class="drift-item">
        <div><span class="method method-${f.method}">${escapeHtml(f.method)}</span> <span class="mono">${escapeHtml(f.path)}</span></div>
        <div class="muted">${escapeHtml(serviceLabel(f.sourceApp))} ← ${escapeHtml(f.sourceFile)}</div>
      </div>`).join("")
    : `<p class="muted">未解決の呼び出しはありません 🎉</p>`;
}

/* ---------- events ---------- */
async function loadAndRender(refresh = false) {
  state.snapshot = await fetchSnapshot(refresh);
  renderSidebar();
  syncView();
}

function init() {
  window.addEventListener("hashchange", syncView);
  el("searchInput").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderActiveView();
  });
  el("serviceFilter").addEventListener("change", (e) => {
    state.serviceFilter = e.target.value;
    renderMapping();
  });
  el("scanBtn").addEventListener("click", async () => {
    const btn = el("scanBtn");
    btn.disabled = true;
    btn.textContent = "スキャン中…";
    try {
      await loadAndRender(true);
    } finally {
      btn.disabled = false;
      btn.textContent = "再スキャン";
    }
  });
  el("copyMermaidBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.snapshot.mermaid);
    const btn = el("copyMermaidBtn");
    const prev = btn.textContent;
    btn.textContent = "コピーしました";
    setTimeout(() => (btn.textContent = prev), 1200);
  });
  if (!location.hash) location.hash = "#/overview";
  loadAndRender().catch((err) => {
    el("viewTitle").textContent = "読み込み失敗";
    console.error(err);
  });
}

init();
