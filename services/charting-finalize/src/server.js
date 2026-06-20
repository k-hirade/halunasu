import http from "node:http";
import { createChartingStoreFromEnv } from "@halunasu/charting-api/store/create-store";

export function createChartingFinalizeServer(options = {}) {
  const startedAt = new Date();
  const chartingStore = options.chartingStore || createChartingStoreFromEnv();
  const internalSecret = options.internalSecret ?? process.env.CHARTING_FINALIZE_INTERNAL_SECRET ?? "";

  return http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const response = await handleChartingFinalizeRequest({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
        chartingStore,
        internalSecret,
        startedAt
      });

      sendJson(res, response.statusCode, response.body, response.headers);
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(res, statusCode, {
        error: statusCode === 500 ? "internal_error" : "error",
        message: statusCode === 500 ? "Internal server error" : error.message
      });
    }
  });
}

export async function handleChartingFinalizeRequest(input = {}) {
  try {
    return await routeChartingFinalizeRequest(input);
  } catch (error) {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return {
      statusCode,
      body: {
        error: statusCode === 500 ? "internal_error" : "error",
        message: statusCode === 500 ? "Internal server error" : error.message
      }
    };
  }
}

async function routeChartingFinalizeRequest(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");

  if (method === "GET" && url.pathname === "/healthz") {
    return ok({ status: "ok", service: "charting-finalize" });
  }

  if (method === "GET" && url.pathname === "/readyz") {
    return ok({
      status: "ok",
      service: "charting-finalize",
      startedAt: input.startedAt instanceof Date ? input.startedAt.toISOString() : new Date().toISOString()
    });
  }

  if (method === "POST" && url.pathname === "/internal/charting/finalize") {
    requireInternalSecret(input);
    const orgId = requiredString(input.body?.orgId, "orgId");
    const encounterId = requiredString(input.body?.encounterId, "encounterId");
    const result = await input.chartingStore.createSoapDraft(orgId, encounterId, {
      transcript: input.body?.transcript,
      notes: input.body?.notes
    });

    return ok(result);
  }

  return {
    statusCode: 404,
    body: { error: "not_found", message: "Route not found" }
  };
}

function requireInternalSecret(input) {
  const expected = input.internalSecret || "";
  if (!expected) {
    return;
  }

  const actual = headerValue(input.headers || {}, "x-internal-secret");
  if (actual !== expected) {
    const error = new Error("Invalid internal secret");
    error.statusCode = 401;
    throw error;
  }
}

async function readJsonBody(req) {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  return rawBody ? JSON.parse(rawBody) : {};
}

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function ok(body, headers = {}) {
  return { statusCode: 200, body, headers };
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} is required`);
    error.statusCode = 400;
    throw error;
  }

  return value.trim();
}

function headerValue(headers, name) {
  const direct = headers[name];
  if (direct !== undefined) {
    return Array.isArray(direct) ? direct.join("; ") : direct;
  }

  const foundKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = foundKey ? headers[foundKey] : undefined;
  return Array.isArray(value) ? value.join("; ") : value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CHARTING_FINALIZE_PORT || process.env.PORT || 8084);
  createChartingFinalizeServer().listen(port, () => {
    console.log(`charting-finalize listening on :${port}`);
  });
}
