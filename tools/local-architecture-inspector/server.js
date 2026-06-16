#!/usr/bin/env node

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = (() => {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  if (portArg) return Number.parseInt(portArg.slice(7), 10);
  if (process.env.PORT) return Number.parseInt(process.env.PORT, 10);
  return 4173;
})();

const HOST = (() => {
  const hostArg = process.argv.find((arg) => arg.startsWith("--host="));
  if (hostArg) return hostArg.slice(7);
  if (process.env.HALUNASU_ARCHITECTURE_HOST) return process.env.HALUNASU_ARCHITECTURE_HOST;
  return "127.0.0.1";
})();

const SCAN_ONCE = process.argv.includes("--scan-once");

const TARGET_APPS = ["charting-web", "fee-web"];
const TARGET_SERVICES = ["charting-gateway", "fee-api", "platform-api", "billing-api-legacy", "referral-api"];
const TARGET_ROUTES = [
  "apps",
  "services",
  "packages",
];

const TARGET_LABELS = {
  "charting-web": "カルテ自動作成（Charting）",
  "fee-web": "診療報酬算定（Fee）",
  "charting-gateway": "charting-gateway",
  "fee-api": "fee-api",
  "platform-api": "platform-api",
  "billing-api-legacy": "billing-api-legacy",
  "referral-api": "referral-api",
};

const EXCLUDED_DIRS = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  ".turbo",
  ".pytest_cache",
  "__pycache__",
  "coverage",
  ".mypy_cache",
  ".venv",
  "build",
  "test",
  "tests",
  "e2e",
  "__tests__",
  "scripts",
]);

const SUPPORTED_EXT = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
]);

const routeToServiceFallback = [
  { pattern: /^\/api\/v1\/?$/, service: "platform-api" },
  { pattern: /\/v1\/organizations\/admin-bootstrap/, service: "platform-api" },
  { pattern: /\/api\/fee(?:\/|$)|\/v1\/fee(?:\/|$)/, service: "fee-api" },
  { pattern: /\/api\/v1\/sessions|\/api\/v1\/operator|\/api\/v1\/mobile|\/api\/v1\/pairings|\/api\/v1\/admin/, service: "charting-gateway" },
  { pattern: /\/api\/v1\/billing|\/api\/v1\/signup|\/api\/v1\/password/, service: "billing-api-legacy" },
  { pattern: /\/api\/v1\/organization|\/api\/v1\/contact-signups|\/api\/v1\/portal|\/v1\/auth|\/api\/v1\/auth|\/v1\/auth/, service: "platform-api" },
  { pattern: /\/api\/v1\/referral|\/v1\/referral/, service: "referral-api" },
  { pattern: /\/api\/(?:platform|core|operator|mobile|internal)\//, service: "charting-gateway" },
  { pattern: /\/api\/v1\/(?:organizations?|billing|auth|contact-signups)/, service: "platform-api" },
];

const __contentType = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
]);

const repoRootCandidates = [
  path.resolve(__dirname, "..", ".."),
  process.env.HALUNASU_REPO_ROOT,
].filter(Boolean);

const repoRoot = (() => {
  for (const candidate of repoRootCandidates) {
    if (fs.existsSync(path.join(candidate, "apps")) && fs.existsSync(path.join(candidate, "services"))) {
      return candidate;
    }
  }
  return process.cwd();
})();

function walkFiles(baseDir, includeExt = true) {
  if (!fs.existsSync(baseDir)) return [];
  const out = [];
  const stack = [path.resolve(baseDir)];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      if (includeExt && !SUPPORTED_EXT.has(path.extname(current))) continue;
      const rel = path.relative(repoRoot, current);
      if (!rel.startsWith("..")) {
        out.push(current);
      }
      continue;
    }
    const base = path.basename(current);
    if (EXCLUDED_DIRS.has(base)) continue;

    const rel = path.relative(repoRoot, current);
    if (rel.startsWith("..")) continue;

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name) && entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (includeExt && SUPPORTED_EXT.has(path.extname(entry.name))) {
        out.push(child);
      }
    }
  }
  return out.sort();
}

function normalizeRouteSegment(segment) {
  if (!segment || segment === "page" || segment === "layout") return null;
  if (segment.startsWith("(") && segment.endsWith(")")) return null;
  if (segment.startsWith("[...") && segment.endsWith("]")) return "*";
  if (segment.startsWith("[") && segment.endsWith("]")) return `:${segment.slice(1, -1)}`;
  return segment.replace(/_/g, " ");
}

function toRouteFromAppFile(filePath, appName) {
  const appDir = path.join(repoRoot, "apps", appName, "app");
  const rel = path.relative(appDir, filePath);
  if (rel.startsWith("..") || rel === filePath) return null;

  const parts = rel.split(path.sep).filter(Boolean);
  const filename = parts.pop();
  const base = filename.replace(/\.[^.]+$/, "");
  const filtered = parts.map(normalizeRouteSegment).filter(Boolean);
  const fileName = path.parse(filename).name;
  if (fileName === "layout") {
    return "/";
  }
  if (base === "page") {
    return `/${filtered.join("/")}`.replace(/\/+/g, "/");
  }
  if (base === "route") {
    return `/${filtered.join("/")}`.replace(/\/+/g, "/") || "/";
  }
  return `/${filtered.join("/")}`.replace(/\/+/g, "/") || "/";
}

function uniqBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseAppRoutes(appName) {
  const appDir = path.join(repoRoot, "apps", appName, "app");
  const files = walkFiles(appDir);
  const pages = [];
  const apiRoutes = [];

  for (const file of files) {
    const fileName = path.basename(file);
    if (![".js", ".jsx", ".ts", ".tsx"].includes(path.extname(fileName))) continue;
    const route = toRouteFromAppFile(file, appName);
    if (!route) continue;

    if (fileName.startsWith("page.")) {
      pages.push({
        id: `${appName}:page:${route}`,
        app: appName,
        kind: "page",
        route,
        file: path.relative(repoRoot, file),
        label: `${TARGET_LABELS[appName]} page`,
      });
      continue;
    }

    if (fileName.startsWith("route.")) {
      const text = fs.readFileSync(file, "utf8");
      const methods = [];
      const matches = [...text.matchAll(/export\s+(?:const|async function)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS)\b/g)];
      for (const m of matches) methods.push(m[1].toUpperCase());
      apiRoutes.push({
        id: `${appName}:api:${route}`,
        app: appName,
        kind: "api",
        route,
        file: path.relative(repoRoot, file),
        methods: methods.length ? methods : ["UNKNOWN"],
      });
    }
  }

  return {
    pages: pages.sort((a, b) => a.route.localeCompare(b.route)),
    apiRoutes: apiRoutes.sort((a, b) => a.route.localeCompare(b.route)),
  };
}

function parseServiceRoutes(serviceName) {
  const serverFile = path.join(repoRoot, "services", serviceName, "src", "server.js");
  if (!fs.existsSync(serverFile)) return [];
  const text = fs.readFileSync(serverFile, "utf8");
  const routes = [];
  const regex = /(?:app|router|express|api)\.(get|post|put|patch|delete|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const match of text.matchAll(regex)) {
    const method = match[1].toUpperCase();
    const route = canonicalizeRoute(match[2].trim());
    routes.push({
      id: `${serviceName}:${method} ${route}`,
      service: serviceName,
      method,
      path: route,
      file: path.relative(repoRoot, serverFile),
      key: `${method} ${route}`,
    });
  }
  return uniqBy(routes, (r) => r.key).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function canonicalizeRoute(input) {
  if (!input) return "/";
  let value = String(input).trim();
  value = value.replace(/\$\{[^}]+\}/g, ":param");
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      value = new URL(value).pathname;
    } catch {
      return "/";
    }
  }
  const q = value.indexOf("?");
  if (q >= 0) value = value.slice(0, q);
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/+/g, "/");
  return value.endsWith("/") && value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function splitPath(value) {
  return String(value || "").replace(/^\//, "").split("/").filter(Boolean);
}

function scoreRouteMatch(pattern, candidate) {
  const p = splitPath(pattern);
  const c = splitPath(candidate);
  if (p.length > c.length + 1) return -1;
  let score = 0;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i];
    const b = c[i];
    if (a === "*") return score + 0.5;
    if (a.startsWith(":")) return score + 0.3;
    if (!b) return -1;
    if (a !== b) return -1;
    score += 2;
  }
  return score;
}

function mapToService(candidatePath, serviceRoutesByName) {
  const candidate = canonicalizeRoute(candidatePath);
  for (const entry of routeToServiceFallback) {
    if (entry.pattern.test(candidate)) {
      return {
        service: entry.service,
        matched: null,
        confidence: "heuristic",
      };
    }
  }

  let best = null;
  let bestScore = -1;
  for (const [serviceName, routes] of Object.entries(serviceRoutesByName)) {
    for (const route of routes) {
      const score = scoreRouteMatch(route.path, candidate);
      if (score <= 0) continue;
      if (score > bestScore) {
        best = { service: serviceName, matched: route.path, confidence: "pattern" };
        bestScore = score;
      }
    }
  }
  if (!best) {
    return {
      service: "external-or-unknown",
      matched: null,
      confidence: "unresolved",
    };
  }
  return best;
}

function canonicalizeCallRoute(raw) {
  if (!raw) return null;
  if (!raw.startsWith("/")) {
    if (/^https?:\/\//.test(raw)) {
      try {
        raw = new URL(raw).pathname;
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  return canonicalizeRoute(raw);
}

const API_CALL_CANDIDATE_NAMES = new Set([
  "fetch",
  "api",
  "feeApi",
  "platformApi",
  "fetchWithOperatorAuth",
  "fetchWithAuth",
  "fetchWithSessionAuth",
  "fetchWithCsrf",
  "request",
]);

function methodFromLineOrOptions(methodHint, chunk) {
  const m = methodHint || chunk.match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|OPTIONS)["'`]/i);
  if (m) return m[1].toUpperCase();
  return "GET";
}

function splitTopLevel(expr, delimiter) {
  const out = [];
  const values = [];
  let depth = 0;
  let inString = false;
  let quote = "";
  let escape = false;
  let templateDepth = 0;
  let lineComment = false;
  let blockComment = false;

  const push = () => {
    const value = expr.slice(values[0] || 0, values[1] || expr.length);
    out.push(expr.slice(values[0] || 0, values[1] || expr.length));
  };

  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    const prev = expr[i - 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (prev === "*" && ch === "/") blockComment = false;
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (!inString) {
      if (ch === "/" && expr[i + 1] === "/") {
        lineComment = true;
        continue;
      }
      if (ch === "/" && expr[i + 1] === "*") {
        blockComment = true;
        continue;
      }
    }

    if (inString) {
      if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      quote = ch;
      if (ch === "`") templateDepth += 1;
      continue;
    }

    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;

    if (ch === delimiter && !inString && depth === 0 && !lineComment && !blockComment) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  if (inString && templateDepth > 1) {
    return [expr];
  }
  return out;
}

function extractStringOrTemplateLiteral(expr) {
  const t = expr.trim();
  if (!t) return null;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  if (t.startsWith("`") && t.endsWith("`")) {
    const replaced = t.slice(1, -1).replace(/\$\{[^}]*\}/g, "");
    return replaced;
  }
  return null;
}

function extractApiRouteFromExpression(expr) {
  if (!expr) return null;
  const raw = expr.trim();
  if (!raw) return null;

  let text = raw;
  if (raw.startsWith("(") && raw.endsWith(")")) {
    const middle = raw.slice(1, -1).trim();
    if (middle && !middle.startsWith("...") && middle !== raw) {
      text = middle;
    }
  }
  if (!text) return null;

  const direct = extractStringOrTemplateLiteral(text);
  if (direct) {
    const route = canonicalizeCallRoute(direct);
    if (route && (route.includes("/api/") || route.includes("/v1/") || route.startsWith("/admin/"))) {
      return route;
    }
    return null;
  }

  const callMatch = text.match(/^([A-Za-z_$][\w$]*)\s*\((.*)\)$/s);
  if (callMatch) {
    const inner = splitTopLevel(callMatch[2], ",")[0];
    const nested = extractApiRouteFromExpression(inner || "");
    if (nested) return nested;

    if (!text.includes("+")) {
      return null;
    }
  }

  const plusSplit = splitTopLevel(text, "+");
  for (const piece of plusSplit) {
    if (piece.trim() === text.trim()) continue;
    const route = extractApiRouteFromExpression(piece);
    if (route) return route;
  }

  return null;
}

function walkArguments(callText) {
  const argsText = callText.slice(callText.indexOf("(") + 1, -1);
  return splitTopLevel(argsText, ",");
}

function extractCallExpression(fullText, openParenIndex) {
  let level = 0;
  let inString = false;
  let quote = "";
  let escape = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openParenIndex + 1; i < fullText.length; i += 1) {
    const ch = fullText[i];
    const prev = fullText[i - 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (prev === "*" && ch === "/") blockComment = false;
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (!inString) {
      if (ch === "/" && fullText[i + 1] === "/") {
        lineComment = true;
        continue;
      }
      if (ch === "/" && fullText[i + 1] === "*") {
        blockComment = true;
        continue;
      }
    }

    if (inString) {
      if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "(") {
      level += 1;
      continue;
    }

    if (ch === ")") {
      if (level === 0) {
        return fullText.slice(openParenIndex, i + 1);
      }
      level -= 1;
    }
  }
  return "";
}

function collectApiCallsForApp(appName, pages) {
  const appDir = path.join(repoRoot, "apps", appName);
  const files = walkFiles(appDir, true);
  const calls = [];

  const callDetector = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, "utf8").replace(/\r/g, "");
    for (const match of text.matchAll(callDetector)) {
      const fullName = match[1];
      const callee = fullName.split(".").at(-1);
      const openIndex = match.index + match[0].length - 1;

      const nameLooksApi = /api\b|api[A-Z]/i;
      if (!(fullName === "fetch" || fullName.startsWith("axios.") || API_CALL_CANDIDATE_NAMES.has(callee) || nameLooksApi.test(fullName))) {
        continue;
      }

      const callText = extractCallExpression(text, openIndex);
      if (!callText) continue;

      const args = walkArguments(callText);
      if (!args.length) continue;

      const route = extractApiRouteFromExpression(args[0] || "");
      if (!route) continue;

      let method = "GET";
      if (fullName.startsWith("axios.")) {
        const methodName = fullName.split(".").at(-1);
        method = methodName.toUpperCase();
      } else {
        method = methodFromLineOrOptions("", args[1] || "");
        if (fullName.startsWith("fetch")) {
          method = methodFromLineOrOptions("", callText);
        }
      }

      const sourceRoute =
        pages.find((entry) => rel.startsWith(entry.file.replace(/page\.[^.]+$/, "")))?.route || "/";
      calls.push({
        sourceApp: appName,
        sourceFile: rel,
        sourceRoute,
        method: method || "GET",
        path: route,
      });
    }
  }

  return uniqBy(calls, (item) => `${item.sourceFile}|${item.method}|${item.path}`);
}

function buildMermaidDiagram(snapshot) {
  const lines = ["flowchart LR", "  direction LR", "", "  subgraph Apps[フロントアプリ]", "    C[charting-web]", "    F[fee-web]", "  end", "  subgraph Services[Backend]", "    GW[charting-gateway]", "    FE[fee-api]", "    PA[platform-api]", "    BI[billing-api-legacy]", "    RF[referral-api]", "    EX[external-api]", "  end", ""];
  const edgeSet = new Set();
  for (const flow of snapshot.appFlows) {
    const from = flow.sourceApp === "charting-web" ? "C" : "F";
    const toMap = {
      "charting-gateway": "GW",
      "fee-api": "FE",
      "platform-api": "PA",
      "billing-api-legacy": "BI",
      "referral-api": "RF",
      "external-or-unknown": "EX",
    };
    const to = toMap[flow.service] || "EX";
    const label = `${flow.method} ${flow.path}`;
    const edgeKey = `${from}-${to}-${label}`;
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);
    lines.push(`  ${from} -->|${label}| ${to}`);
  }
  lines.push("");
  lines.push("  FE -->|masterLookup| R1[(SQLite/CSV)]");
  lines.push("  FE -->|OpenAI| R2[(OpenAI)]");
  lines.push("  GW -->|pairing/audio| R3[(Firestore)]");
  return lines.join("\n");
}

function buildSnapshot() {
  const apps = [];
  const appByName = {};
  let scannedFiles = 0;
  const appFlows = [];
  const serviceRoutesByName = {};
  const serviceMeta = [];
  const allServiceRoutes = [];

  for (const appName of TARGET_APPS) {
    const { pages, apiRoutes } = parseAppRoutes(appName);
    const appData = {
      name: appName,
      label: TARGET_LABELS[appName] || appName,
      root: `apps/${appName}`,
      pages,
      apiRoutes,
      pageCount: pages.length,
      apiRouteCount: apiRoutes.length,
    };
    apps.push(appData);
    appByName[appName] = appData;

    const calls = collectApiCallsForApp(appName, [...pages, ...apiRoutes]);
    scannedFiles += walkFiles(path.join(repoRoot, "apps", appName)).length;
    appFlows.push(...calls);
  }

  for (const service of TARGET_SERVICES) {
    const routes = parseServiceRoutes(service);
    serviceRoutesByName[service] = routes;
    allServiceRoutes.push(...routes.map((r) => ({ ...r, service })));
    serviceMeta.push({
      name: service,
      label: TARGET_LABELS[service] || service,
      file: `services/${service}/src/server.js`,
      routeCount: routes.length,
      routePrefixes: summarizePrefixes(routes),
      routes: routes.slice(0, 50),
      moreRoutes: routes.length - 50,
    });
  }

  const flows = [];
  for (const call of appFlows) {
    const mapped = mapToService(call.path, serviceRoutesByName);
    flows.push({
      id: createId(`${call.sourceFile}|${call.method}|${call.path}`),
      sourceApp: call.sourceApp,
      sourceFile: call.sourceFile,
      sourceRoute: call.sourceRoute,
      method: call.method,
      path: call.path,
      service: mapped.service,
      matchedServiceRoute: mapped.matched,
      confidence: mapped.confidence,
    });
  }

  const unresolved = flows.filter((item) => item.confidence === "unresolved");

  scannedFiles += walkFiles(path.join(repoRoot, "services")).length;

  return {
    generatedAt: new Date().toISOString(),
    repo: repoRoot,
    targetApps: TARGET_APPS,
    targetServices: TARGET_SERVICES,
    apps,
    appFlows: flows,
    serviceMeta,
    serviceRoutes: allServiceRoutes,
    scanDetails: {
      scannedFiles,
      targetRoot: TARGET_ROUTES,
      excludedDirs: [...EXCLUDED_DIRS],
    },
    routeCoverage: {
      total: flows.length,
      resolved: flows.length - unresolved.length,
      unresolved: unresolved.length,
      byService: flows.reduce((acc, item) => {
        acc[item.service] = (acc[item.service] || 0) + 1;
        return acc;
      }, {}),
      unresolvedTopExamples: unresolved.slice(0, 30),
    },
    mermaid: buildMermaidDiagram({
      appFlows: flows,
    }),
  };
}

function summarizePrefixes(routes) {
  const bag = new Map();
  for (const r of routes) {
    const parts = splitPath(r.path);
    if (!parts.length) continue;
    const key = parts[0];
    bag.set(key, (bag.get(key) || 0) + 1);
  }
  return [...bag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([prefix, count]) => ({ prefix, count }));
}

let cached = null;
let cachedAt = 0;
function getSnapshot(force = false) {
  if (!force && cached && Date.now() - cachedAt < 3000) {
    return cached;
  }
  cached = buildSnapshot();
  cachedAt = Date.now();
  return cached;
}

function createId(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, data, status = 200, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function html(res, body, status = 200) {
  text(res, body, status, "text/html; charset=utf-8");
}

async function serveStaticFile(reqPath) {
  const normalized = reqPath === "/" ? "/index.html" : reqPath;
  const publicRoot = path.join(__dirname, "public");
  const filePath = path.join(publicRoot, decodeURIComponent(normalized));
  if (!filePath.startsWith(publicRoot)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const ext = path.extname(filePath);
  const body = await fsPromises.readFile(filePath);
  const type = __contentType.get(ext) || "application/octet-stream";
  return { body, type };
}

async function readSource(relPath) {
  if (!relPath || relPath.includes("..") || relPath.startsWith("/")) return null;
  const target = path.join(repoRoot, relPath);
  if (!target.startsWith(repoRoot)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  const text = await fsPromises.readFile(target, "utf8");
  return {
    path: relPath,
    text,
  };
}

async function handleRequest(req, res) {
  const parsed = new url.URL(req.url || "", `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  if (pathname === "/api/architecture") {
    const refresh = parsed.searchParams.get("refresh") === "1";
    return json(res, getSnapshot(refresh));
  }

  if (pathname === "/api/mermaid") {
    const snapshot = getSnapshot();
    return text(res, snapshot.mermaid);
  }

  if (pathname === "/api/scan/now") {
    const snapshot = getSnapshot(true);
    return json(res, {
      ok: true,
      generatedAt: snapshot.generatedAt,
      totalRoutes: snapshot.routeCoverage.total,
      unresolved: snapshot.routeCoverage.unresolved,
    });
  }

  if (pathname === "/api/source") {
    const relPath = parsed.searchParams.get("path");
    const source = await readSource(relPath);
    if (!source) return text(res, "File not found", 404);
    return json(res, source);
  }

  if (pathname === "/api/health") {
    const snapshot = getSnapshot();
    return json(res, {
      ok: true,
      generatedAt: snapshot.generatedAt,
      routes: snapshot.routeCoverage.total,
    });
  }

  if (pathname.startsWith("/api")) {
    return text(res, "api not found", 404);
  }

  const fileResponse = await serveStaticFile(pathname);
  if (!fileResponse) {
    return text(res, "Not found", 404);
  }
  res.writeHead(200, {
    "Content-Type": fileResponse.type,
    "Cache-Control": "no-store",
    "Content-Length": fileResponse.body.length,
  });
  return res.end(fileResponse.body);
}

if (SCAN_ONCE) {
  const data = getSnapshot(true);
  console.log(`Target repos: ${path.relative(process.cwd(), repoRoot) || "."}`);
  console.log(`Scanned routes: ${data.routeCoverage.total}, unresolved: ${data.routeCoverage.unresolved}`);
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    json(res, { error: error.message }, 500);
  });
});

server.listen(PORT, HOST, () => {
  const data = getSnapshot(true);
  console.log(`Architecture Inspector running: http://${HOST}:${PORT}`);
  console.log(`Target repos: ${path.relative(process.cwd(), repoRoot) || "."}`);
  console.log(`Scanned routes: ${data.routeCoverage.total}, unresolved: ${data.routeCoverage.unresolved}`);
});
