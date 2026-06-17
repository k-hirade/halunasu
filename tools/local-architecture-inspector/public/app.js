import { CORE_FLOWS, KIND_META } from "/core-flows.js";

const VIEW_TITLES = {
  overview: "概要",
  core: "コア機能",
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
  coreFeature: "fee",
  coreStep: 1,
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
  el("featureSelect").style.display = state.view === "core" ? "" : "none";
  renderActiveView();
}

/* ---------- renderers ---------- */
function renderActiveView() {
  if (state.view === "core") { renderCore(); return; } // 静的データなのでsnapshot不要
  if (!state.snapshot) return;
  if (state.view === "overview") renderOverview();
  else if (state.view === "flow") renderFlow();
  else if (state.view === "mapping") renderMapping();
  else if (state.view === "routes") renderRoutes();
  else if (state.view === "drift") renderDrift();
}

/* ---------- core feature flows ---------- */
function renderCore() {
  const sel = el("featureSelect");
  if (!sel.options.length) {
    sel.innerHTML = Object.values(CORE_FLOWS)
      .map((f) => `<option value="${f.id}">${escapeHtml(f.title)}</option>`)
      .join("");
  }
  sel.value = state.coreFeature;

  const flow = CORE_FLOWS[state.coreFeature];
  if (!flow) return;

  el("coreTitle").textContent = flow.title;
  el("coreTagline").textContent = flow.tagline;
  el("coreSummary").textContent = flow.summary;
  el("corePrinciple").innerHTML =
    `<span class="core-principle-label">設計思想</span> ${escapeHtml(flow.principle)}`;

  if (!flow.steps.some((s) => s.no === state.coreStep)) state.coreStep = flow.steps[0].no;

  el("coreStepper").innerHTML = flow.steps.map((s) => {
    const meta = KIND_META[s.kind] || { label: s.kind, color: "#64748b" };
    const active = s.no === state.coreStep ? "is-active" : "";
    return `<li class="step ${active}" data-step="${s.no}" style="--kind:${meta.color}">
      <span class="step-no">${s.no}</span>
      <span class="step-main">
        <span class="step-title">${escapeHtml(s.title)}</span>
        <span class="step-meta"><span class="step-kind" style="--kind:${meta.color}">${escapeHtml(meta.label)}</span><span class="step-actor">${escapeHtml(s.actor)}</span></span>
      </span>
    </li>`;
  }).join("");

  el("coreStepper").querySelectorAll(".step").forEach((li) => {
    li.addEventListener("click", () => {
      state.coreStep = Number(li.dataset.step);
      renderCore();
    });
  });

  renderCoreDetail(flow.steps.find((s) => s.no === state.coreStep));
}

function renderCoreDetail(step) {
  const card = el("coreDetailCard");
  if (!step) { card.innerHTML = `<p class="muted">ステップを選択してください</p>`; return; }
  const meta = KIND_META[step.kind] || { label: step.kind, color: "#64748b" };
  const paras = step.detail.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  card.innerHTML = `
    <div class="detail-head">
      <span class="step-kind" style="--kind:${meta.color}">${escapeHtml(meta.label)}</span>
      <h2>Step ${step.no} ・ ${escapeHtml(step.title)}</h2>
    </div>
    <p class="detail-oneliner">${escapeHtml(step.oneLiner)}</p>
    <div class="detail-io">
      <div class="io-box"><span class="io-label">担当</span><span>${escapeHtml(step.actor)}</span></div>
      <div class="io-box"><span class="io-label">入力</span><span>${escapeHtml(step.input)}</span></div>
      <div class="io-box io-arrow">→</div>
      <div class="io-box"><span class="io-label">出力</span><span>${escapeHtml(step.output)}</span></div>
    </div>
    <div class="detail-body">${paras}</div>
    ${Array.isArray(step.branches) && step.branches.length ? `
      <div class="detail-branches">
        <h3>分岐</h3>
        ${step.branches.map((b) => `<div class="branch-row"><span class="branch-cond">${escapeHtml(b.cond)}</span><span class="branch-arrow">→</span><span class="branch-path">${escapeHtml(b.path)}</span></div>`).join("")}
      </div>` : ""}
    ${step.sourceFile ? `<button class="btn btn-ghost detail-src-btn" data-src="${escapeHtml(step.sourceFile)}">該当コードを表示 · ${escapeHtml(step.sourceFile)}</button><pre class="source" id="coreSource" hidden></pre>` : ""}`;

  const btn = card.querySelector(".detail-src-btn");
  if (btn) btn.addEventListener("click", () => loadCoreSource(btn.dataset.src));
}

async function loadCoreSource(srcPath) {
  const pre = el("coreSource");
  if (!pre) return;
  if (!pre.hidden) { pre.hidden = true; return; }
  pre.hidden = false;
  pre.textContent = "読み込み中…";
  try {
    const res = await fetch(`/api/source?path=${encodeURIComponent(srcPath)}`);
    if (!res.ok) throw new Error(String(res.status));
    const { text } = await res.json();
    const lines = text.split("\n").slice(0, 400);
    pre.innerHTML = lines.map((line, i) =>
      `<span class="src-line"><span class="src-no">${i + 1}</span>${escapeHtml(line)}</span>`).join("\n");
  } catch {
    pre.textContent = "ソースを取得できませんでした(ディレクトリ指定の場合は表示できません)";
  }
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

// server.js の safe() と同一: ノードIDを図中IDへ変換
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_]/g, "_");

function nodeIndex() {
  // safeId -> { id, label, layer, kind }
  const map = new Map();
  for (const layer of state.snapshot.graph.layers) {
    for (const n of layer.nodes) {
      map.set(safeId(n.id), { id: n.id, label: n.label, layer: layer.id, kind: n.kind || layer.id });
    }
  }
  return map;
}

async function renderFlow() {
  ensureMermaid();
  const target = el("mermaidDiagram");
  const nodes = nodeIndex();
  // クリック用ディレクティブを描画時のみ付与(コピー用の生diagramは汚さない)
  const clickLines = [...nodes.keys()].map((sid) => `  click ${sid} __archNodeClick`);
  const code = `${state.snapshot.mermaid}\n${clickLines.join("\n")}`;
  window.__archNodeClick = (sid) => openNodeDrawer(sid);
  target.removeAttribute("data-processed");
  try {
    const { svg, bindFunctions } = await window.mermaid.render("archGraph", code);
    target.innerHTML = svg;
    if (bindFunctions) bindFunctions(target);
    target.querySelectorAll(".node").forEach((g) => g.classList.add("clickable"));
  } catch (err) {
    target.innerHTML = `<pre class="source">${escapeHtml(state.snapshot.mermaid)}</pre>`;
    console.error("mermaid render failed", err);
  }
}

/* ---------- node drawer ---------- */
function uniqueCalls(flows) {
  const seen = new Set();
  const out = [];
  for (const f of flows) {
    const k = `${f.method} ${f.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function callRows(flows) {
  return uniqueCalls(flows).map((f) =>
    `<div class="call-row"><span class="method method-${f.method}">${escapeHtml(f.method)}</span><span class="mono">${escapeHtml(f.path)}</span>${f.confidence === "unresolved" ? confidenceTag(f.confidence) : ""}</div>`
  ).join("");
}

function drawerSection(title, count, inner) {
  return `<section class="drawer-sec"><h3>${escapeHtml(title)}${count != null ? ` <span class="muted">${count}</span>` : ""}</h3>${inner || `<p class="muted">なし</p>`}</section>`;
}

function buildDrawerBody(node) {
  const snap = state.snapshot;
  const flows = snap.appFlows;
  const parts = [];

  if (node.layer === "frontend") {
    const out = flows.filter((f) => f.sourceApp === node.id);
    const byService = new Map();
    for (const f of out) {
      const key = f.service;
      if (!byService.has(key)) byService.set(key, []);
      byService.get(key).push(f);
    }
    const groups = [...byService.entries()].sort((a, b) => b[1].length - a[1].length);
    const inner = groups.map(([svc, fl]) =>
      `<div class="drawer-group"><div class="drawer-group-head">→ ${escapeHtml(serviceLabel(svc))} <span class="muted">${uniqueCalls(fl).length}</span></div>${callRows(fl)}</div>`
    ).join("");
    parts.push(drawerSection("呼び出すAPI", out.length, inner));
  } else if (node.layer === "backend" && node.id !== "external-or-unknown") {
    const incoming = flows.filter((f) => f.service === node.id);
    const byApp = new Map();
    for (const f of incoming) {
      if (!byApp.has(f.sourceApp)) byApp.set(f.sourceApp, []);
      byApp.get(f.sourceApp).push(f);
    }
    const inner = [...byApp.entries()].map(([app, fl]) =>
      `<div class="drawer-group"><div class="drawer-group-head">← ${escapeHtml(serviceLabel(app))} <span class="muted">${uniqueCalls(fl).length}</span></div>${callRows(fl)}</div>`
    ).join("");
    parts.push(drawerSection("受けているAPI呼び出し", incoming.length, inner));

    const deps = snap.graph.dataEdges.filter((e) => e.from === node.id);
    const depInner = deps.map((e) => {
      const target = nodeIndex().get(safeId(e.to));
      return `<div class="call-row"><span class="chip chip-data">${escapeHtml(e.via)}</span><span>${escapeHtml(target ? target.label : e.to)}</span></div>`;
    }).join("");
    parts.push(drawerSection("依存データ / 外部", deps.length, depInner));
  } else if (node.layer === "data") {
    const users = snap.graph.dataEdges.filter((e) => e.to === node.id);
    const inner = users.map((e) =>
      `<div class="call-row"><span>${escapeHtml(serviceLabel(e.from))}</span><span class="chip chip-data">${escapeHtml(e.via)}</span></div>`
    ).join("");
    parts.push(drawerSection("利用元サービス", users.length, inner));
  } else if (node.id === "external-or-unknown") {
    const un = flows.filter((f) => f.confidence === "unresolved");
    parts.push(drawerSection("未解決 / 外部呼び出し", un.length, callRows(un)));
  }
  return parts.join("");
}

const KIND_LABEL = { frontend: "Frontend", backend: "Backend / API", data: "Data / External" };

function openNodeDrawer(sid) {
  const node = nodeIndex().get(sid);
  if (!node) return;
  el("drawerKind").textContent = KIND_LABEL[node.layer] || node.layer;
  el("drawerTitle").textContent = node.label;
  el("drawerBody").innerHTML = buildDrawerBody(node);
  const drawer = el("drawer");
  const backdrop = el("drawerBackdrop");
  drawer.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  drawer.setAttribute("aria-hidden", "false");
}

function closeDrawer() {
  const drawer = el("drawer");
  const backdrop = el("drawerBackdrop");
  drawer.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  setTimeout(() => {
    drawer.hidden = true;
    backdrop.hidden = true;
  }, 220);
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
  el("featureSelect").addEventListener("change", (e) => {
    state.coreFeature = e.target.value;
    state.coreStep = 1;
    renderCore();
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
  el("drawerClose").addEventListener("click", closeDrawer);
  el("drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  if (!location.hash) location.hash = "#/overview";
  syncView(); // コア機能は静的データなのでsnapshot前に即描画
  loadAndRender().catch((err) => {
    el("viewTitle").textContent = "読み込み失敗";
    console.error(err);
  });
}

init();
