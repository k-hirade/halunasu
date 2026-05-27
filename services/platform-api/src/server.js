import http from "node:http";
import { MemoryPlatformStore } from "./store/memory-store.js";

export function createPlatformApiServer(options = {}) {
  const startedAt = new Date();
  const env = options.env || process.env.HALUNASU_ENV || process.env.NODE_ENV || "local";
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT || "medical-core-stg";
  const region = options.region || process.env.GOOGLE_CLOUD_REGION || "asia-northeast1";
  const store = options.store || new MemoryPlatformStore();

  return http.createServer(async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const response = await handlePlatformApiRequest({
        method: req.method,
        path: req.url,
        body,
        env,
        projectId,
        region,
        startedAt,
        store
      });

      sendJson(res, response.statusCode, response.body);
    } catch (error) {
      const response = errorResponse(error);
      sendJson(res, response.statusCode, response.body);
    }
  });
}

export function resolvePlatformApiResponse(input = {}) {
  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");

  if (method === "GET" && url.pathname === "/healthz") {
    return {
      statusCode: 200,
      body: {
        status: "ok",
        service: "platform-api"
      }
    };
  }

  if (method === "GET" && url.pathname === "/readyz") {
    return {
      statusCode: 200,
      body: {
        status: "ok",
        service: "platform-api",
        env: input.env || "local",
        projectId: input.projectId || "medical-core-stg",
        region: input.region || "asia-northeast1",
        startedAt: input.startedAt instanceof Date
          ? input.startedAt.toISOString()
          : new Date().toISOString()
      }
    };
  }

  return {
    statusCode: 404,
    body: {
      error: "not_found",
      message: "Route not found"
    }
  };
}

export async function handlePlatformApiRequest(input = {}) {
  try {
    return routePlatformApiRequest(input);
  } catch (error) {
    return errorResponse(error);
  }
}

function routePlatformApiRequest(input = {}) {
  const healthResponse = resolvePlatformApiResponse(input);
  if (healthResponse.statusCode !== 404 || !String(input.path || "").startsWith("/v1/")) {
    return healthResponse;
  }

  const method = input.method || "GET";
  const url = new URL(input.path || "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const store = input.store || new MemoryPlatformStore();

  if (method === "GET" && matches(parts, ["v1", "organizations"])) {
    return ok({ organizations: store.listOrganizations() });
  }

  if (method === "POST" && matches(parts, ["v1", "organizations"])) {
    return created({ organization: store.createOrganization(input.body || {}) });
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "organizations") {
    const organization = store.getOrganization(parts[2]);
    if (!organization) {
      return notFound("organization not found");
    }
    return ok({ organization });
  }

  if (method === "GET" && isOrgChildCollection(parts, "members")) {
    return ok({ members: store.listMembers(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "members")) {
    return created({ member: store.createMember(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "members")) {
    const member = store.getMember(parts[2], parts[4]);
    if (!member) {
      return notFound("member not found");
    }
    return ok({ member });
  }

  if (method === "GET" && isOrgChildCollection(parts, "patients")) {
    return ok({ patients: store.listPatients(parts[2]) });
  }

  if (method === "POST" && isOrgChildCollection(parts, "patients")) {
    return created({ patient: store.createPatient(parts[2], input.body || {}) });
  }

  if (method === "GET" && isOrgChildDocument(parts, "patients")) {
    const patient = store.getPatient(parts[2], parts[4]);
    if (!patient) {
      return notFound("patient not found");
    }
    return ok({ patient });
  }

  return notFound("Route not found");
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
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
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.name = "BadRequestError";
    error.statusCode = 400;
    throw error;
  }
}

function ok(body) {
  return {
    statusCode: 200,
    body
  };
}

function created(body) {
  return {
    statusCode: 201,
    body
  };
}

function notFound(message) {
  return {
    statusCode: 404,
    body: {
      error: "not_found",
      message
    }
  };
}

function errorResponse(error) {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const errorCode = statusCode === 500 ? "internal_error" : toErrorCode(error.name);

  return {
    statusCode,
    body: {
      error: errorCode,
      message: statusCode === 500 ? "Internal server error" : error.message,
      field: error.field
    }
  };
}

function toErrorCode(name) {
  return String(name || "error")
    .replace(/Error$/, "")
    .replace(/[A-Z]/g, (letter, index) => `${index === 0 ? "" : "_"}${letter.toLowerCase()}`) || "error";
}

function matches(parts, expected) {
  return parts.length === expected.length && expected.every((part, index) => parts[index] === part);
}

function isOrgChildCollection(parts, collectionName) {
  return parts.length === 4
    && parts[0] === "v1"
    && parts[1] === "organizations"
    && parts[3] === collectionName;
}

function isOrgChildDocument(parts, collectionName) {
  return parts.length === 5
    && parts[0] === "v1"
    && parts[1] === "organizations"
    && parts[3] === collectionName;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PLATFORM_API_PORT || "8080", 10);
  const server = createPlatformApiServer();

  server.listen(port, () => {
    console.log(`platform-api listening on :${port}`);
  });
}
