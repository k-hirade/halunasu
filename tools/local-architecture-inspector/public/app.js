const scanButton = document.getElementById("scanBtn");
const copyMermaidButton = document.getElementById("copyMermaidBtn");
const searchInput = document.getElementById("searchInput");
const serviceFilter = document.getElementById("serviceFilter");
const confidenceFilter = document.getElementById("confidenceFilter");
const generatedAtEl = document.getElementById("generatedAt");
const mermaidEl = document.getElementById("mermaidDiagram");
const flowTable = document.getElementById("flowTable");
const appList = document.getElementById("appList");
const serviceList = document.getElementById("serviceList");
const unresolvedPanel = document.getElementById("unresolvedPanel");
const sourceViewer = document.getElementById("sourceViewer");
const selectedCall = document.getElementById("selectedCall");
const statApps = document.querySelector("#stat-apps strong");
const statServices = document.querySelector("#stat-services strong");
const statFlows = document.querySelector("#stat-flows strong");
const statUnresolved = document.querySelector("#stat-unresolved strong");
const statScanTime = document.querySelector("#stat-scan-time strong");
const serviceBars = document.getElementById("serviceBars");

const labelMap = {
  "charting-web": "カルテ自動作成",
  "fee-web": "診療報酬算定",
  "charting-gateway": "charting-gateway",
  "fee-api": "fee-api",
  "platform-api": "platform-api",
  "billing-api-legacy": "billing-api-legacy",
  "referral-api": "referral-api",
  "external-or-unknown": "外部/未分類",
};

const state = {
  snapshot: null,
  flows: [],
  selectedFlowId: null,
};

function toLabel(value) {
  return labelMap[value] || value;
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function confidenceChip(value) {
  const el = document.createElement("span");
  const level = value || "unresolved";
  el.className = `badge ${level}`;
  el.textContent = level;
  return el;
}

function routeMethodChip(method) {
  const el = document.createElement("span");
  el.className = "badge";
  el.textContent = method;
  return el;
}

function createFlowRow(flow) {
  const tr = document.createElement("tr");
  tr.dataset.id = flow.id;
  if (flow.id === state.selectedFlowId) {
    tr.classList.add("active");
  }

  const app = document.createElement("td");
  app.textContent = toLabel(flow.sourceApp);

  const src = document.createElement("td");
  const openSource = document.createElement("button");
  openSource.className = "link-button";
  openSource.textContent = flow.sourceFile;
  openSource.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await openSourceViewer(flow);
  });
  src.appendChild(openSource);

  const method = document.createElement("td");
  method.appendChild(routeMethodChip(flow.method));

  const path = document.createElement("td");
  const pathCode = document.createElement("code");
  pathCode.textContent = flow.path;
  path.appendChild(pathCode);

  const service = document.createElement("td");
  service.textContent = toLabel(flow.service);

  const confidence = document.createElement("td");
  confidence.appendChild(confidenceChip(flow.confidence));

  tr.appendChild(app);
  tr.appendChild(src);
  tr.appendChild(method);
  tr.appendChild(path);
  tr.appendChild(service);
  tr.appendChild(confidence);

  tr.addEventListener("click", () => openSourceViewer(flow));
  return tr;
}

function renderApps(apps) {
  appList.innerHTML = "";
  for (const app of apps) {
    const wrapper = document.createElement("div");
    wrapper.className = "entity-card";

    const title = document.createElement("h3");
    title.textContent = app.label;

    const detail = document.createElement("p");
    detail.textContent = `pages: ${app.pageCount}, api: ${app.apiRouteCount}`;

    const routePreview = document.createElement("ul");
    const preview = app.pages.slice(0, 8);
    for (const page of preview) {
      const li = document.createElement("li");
      li.textContent = `${page.route} (${page.label})`;
      routePreview.appendChild(li);
    }

    const remain = app.pages.length - preview.length;
    if (remain > 0) {
      const more = document.createElement("li");
      more.textContent = `ほか ${remain} ページ...`;
      routePreview.appendChild(more);
    }

    wrapper.append(title, detail, routePreview);
    appList.appendChild(wrapper);
  }
}

function renderServices(serviceMeta) {
  serviceList.innerHTML = "";
  for (const meta of serviceMeta) {
    const wrapper = document.createElement("div");
    wrapper.className = "entity-card";

    const title = document.createElement("h3");
    title.textContent = meta.label || meta.name;

    const detail = document.createElement("p");
    detail.textContent = `routes: ${meta.routeCount}`;

    const prefixTitle = document.createElement("div");
    prefixTitle.className = "small";
    prefixTitle.textContent = "主要プレフィックス";

    const prefixes = document.createElement("ul");
    for (const item of meta.routePrefixes || []) {
      const li = document.createElement("li");
      li.textContent = `${item.prefix}: ${item.count}件`;
      prefixes.appendChild(li);
    }

    wrapper.append(title, detail, prefixTitle, prefixes);
    serviceList.appendChild(wrapper);
  }
}

function renderUnresolved(unresolvedFlows) {
  if (!unresolvedFlows.length) {
    unresolvedPanel.textContent = "未解決API呼び出しはありません。";
    unresolvedPanel.className = "notice";
    return;
  }

  unresolvedPanel.className = "chips";
  unresolvedPanel.innerHTML = "";
  unresolvedFlows.forEach((flow) => {
    const chip = document.createElement("code");
    chip.className = "chip";
    chip.textContent = `${flow.sourceApp} ${flow.method} ${flow.path}`;
    unresolvedPanel.appendChild(chip);
  });
}

function renderServiceBars(snapshot) {
  serviceBars.innerHTML = "";
  const total = snapshot.routeCoverage.total || 1;
  const byService = snapshot.routeCoverage.byService || {};
  const entries = Object.entries(byService).sort((a, b) => b[1] - a[1]);

  for (const [service, count] of entries) {
    const row = document.createElement("div");
    row.className = "service-bar";

    const header = document.createElement("div");
    header.className = "label";
    const name = document.createElement("span");
    name.textContent = toLabel(service);
    const cnt = document.createElement("span");
    cnt.className = "muted";
    cnt.textContent = `${count} / ${total}`;
    header.append(name, cnt);

    const track = document.createElement("div");
    track.className = "bar-track";

    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(3, (count / total) * 100)}%`;
    track.appendChild(fill);

    row.append(header, track);
    serviceBars.appendChild(row);
  }
}

function applyFilters(flows) {
  const q = (searchInput.value || "").trim().toLowerCase();
  const service = serviceFilter.value;
  const confidence = confidenceFilter.value;

  return flows.filter((flow) => {
    if (service !== "all" && flow.service !== service) return false;
    if (confidence !== "all" && flow.confidence !== confidence) return false;
    if (!q) return true;
    const joined = [flow.sourceFile, flow.path, flow.method, flow.sourceApp, flow.service, flow.sourceRoute]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return joined.includes(q);
  });
}

function renderFlows(flows) {
  flowTable.innerHTML = "";
  if (!flows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "small";
    td.textContent = "条件に一致するフローがありません。";
    tr.appendChild(td);
    flowTable.appendChild(tr);
    selectedCall.textContent = "未選択";
    sourceViewer.textContent = "";
    return;
  }

  for (const flow of flows) {
    flowTable.appendChild(createFlowRow(flow));
  }

  if (!flows.find((flow) => flow.id === state.selectedFlowId)) {
    openSourceViewer(flows[0]);
  }
}

async function openSourceViewer(flow) {
  if (!flow) {
    selectedCall.textContent = "未選択";
    sourceViewer.textContent = "";
    return;
  }

  state.selectedFlowId = flow.id;

  for (const row of flowTable.querySelectorAll("tr")) {
    if (!row.dataset.id) continue;
    row.classList.toggle("active", row.dataset.id === flow.id);
  }

  selectedCall.textContent = `${flow.sourceApp} / ${flow.method} ${flow.path} (${flow.sourceFile})`;

  try {
    const source = await fetch(`/api/source?path=${encodeURIComponent(flow.sourceFile)}`).then((r) => r.json());
    sourceViewer.textContent = source.text || `No source found: ${flow.sourceFile}`;
  } catch {
    sourceViewer.textContent = `Failed to load source: ${flow.sourceFile}`;
  }
}

async function updateMermaid() {
  const mermaidText = await fetch("/api/mermaid").then((r) => r.text());
  mermaidEl.textContent = mermaidText;
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
    window.mermaid.run({ nodes: [mermaidEl] });
  }
}

function formatTime(dateValue) {
  if (!dateValue) return "-";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function render(snapshot) {
  setText(statApps, String(snapshot.targetApps?.length || 0));
  setText(statServices, String(snapshot.targetServices?.length || 0));
  setText(statFlows, String(snapshot.routeCoverage?.total || 0));
  setText(statUnresolved, String(snapshot.routeCoverage?.unresolved || 0));
  setText(statScanTime, formatTime(snapshot.generatedAt));
  setText(generatedAtEl, `更新: ${formatTime(snapshot.generatedAt)}`);

  state.snapshot = snapshot;
  state.flows = snapshot.appFlows || [];

  renderApps(snapshot.apps || []);
  renderServices(snapshot.serviceMeta || []);
  renderServiceBars(snapshot);
  renderUnresolved((snapshot.appFlows || []).filter((flow) => flow.confidence === "unresolved"));

  const filteredFlows = applyFilters(snapshot.appFlows || []);
  renderFlows(filteredFlows);
  updateMermaid();
}

async function loadData(refresh = false) {
  setLoading(true);
  try {
    const endpoint = `/api/architecture${refresh ? "?refresh=1" : ""}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
      throw new Error(`architecture API failed (${res.status})`);
    }
    const snapshot = await res.json();
    render(snapshot);
  } catch (error) {
    alert(`読み込みエラー: ${error.message}`);
    console.error(error);
  } finally {
    setLoading(false);
  }
}

function setLoading(isLoading) {
  scanButton.disabled = isLoading;
  scanButton.textContent = isLoading ? "スキャン中..." : "再スキャン";
}

copyMermaidButton.addEventListener("click", async () => {
  try {
    const text = await fetch("/api/mermaid").then((r) => r.text());
    await navigator.clipboard.writeText(text);
    copyMermaidButton.textContent = "コピー完了";
    setTimeout(() => {
      copyMermaidButton.textContent = "Mermaidコピー";
    }, 1100);
  } catch (error) {
    console.error(error);
    copyMermaidButton.textContent = "コピー失敗";
    setTimeout(() => {
      copyMermaidButton.textContent = "Mermaidコピー";
    }, 1200);
  }
});

scanButton.addEventListener("click", () => loadData(true));

searchInput.addEventListener("input", () => {
  if (!state.snapshot) return;
  render(state.snapshot);
});
serviceFilter.addEventListener("change", () => {
  if (!state.snapshot) return;
  render(state.snapshot);
});
confidenceFilter.addEventListener("change", () => {
  if (!state.snapshot) return;
  render(state.snapshot);
});

loadData(true).catch((error) => {
  console.error(error);
  alert(`起動時の読み込みに失敗しました: ${error.message}`);
});
