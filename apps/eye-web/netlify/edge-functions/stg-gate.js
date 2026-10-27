export default async function stgGate(request, context) {
  if (!shouldProtect(request)) {
    return context.next();
  }

  const allowlist = parseAllowlist(Deno.env.get("STG_GATE_ALLOWED_IPS") || "");
  if (allowlist.length === 0) {
    return new Response("STG gate IP allowlist is not configured.", {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }

  if (isAllowedIp(context.ip || "", allowlist)) {
    return context.next();
  }

  return new Response("Forbidden.", {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8"
    }
  });
}

function shouldProtect(request) {
  if (Deno.env.get("STG_GATE_DISABLED") === "true") {
    return false;
  }
  const gateEnabled = Deno.env.get("STG_GATE_ENABLED");
  if (gateEnabled === "false") {
    return false;
  }
  if (gateEnabled === "true") {
    return true;
  }
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const env = (Deno.env.get("HALUNASU_ENV") || Deno.env.get("NEXT_PUBLIC_HALUNASU_ENV") || "").toLowerCase();
  return env === "stg"
    || host === "stg.halunasu.com"
    || host.includes(".stg.halunasu.com")
    || host.includes("-stg.halunasu.com")
    || host.endsWith("-stg.netlify.app");
}

function parseAllowlist(value) {
  return value.split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isAllowedIp(ip, allowlist) {
  const clientBytes = ipToBytes(ip);
  if (!clientBytes) {
    return false;
  }
  for (const entry of allowlist) {
    const [range, prefixText] = entry.split("/", 2);
    const rangeBytes = ipToBytes(range);
    if (!rangeBytes || rangeBytes.length !== clientBytes.length) {
      continue;
    }
    if (prefixText === undefined) {
      if (bytesEqual(clientBytes, rangeBytes)) {
        return true;
      }
      continue;
    }
    const prefix = Number(prefixText);
    if (Number.isInteger(prefix) && cidrContains(clientBytes, rangeBytes, prefix)) {
      return true;
    }
  }
  return false;
}

function cidrContains(clientBytes, rangeBytes, prefix) {
  const totalBits = rangeBytes.length * 8;
  if (prefix < 0 || prefix > totalBits) {
    return false;
  }
  const fullBytes = Math.floor(prefix / 8);
  const partialBits = prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (clientBytes[index] !== rangeBytes[index]) {
      return false;
    }
  }
  if (partialBits === 0) {
    return true;
  }
  const mask = 0xff << (8 - partialBits) & 0xff;
  return (clientBytes[fullBytes] & mask) === (rangeBytes[fullBytes] & mask);
}

function ipToBytes(value) {
  const ip = String(value || "").trim().replace(/^\[|\]$/gu, "").replace(/%.+$/u, "");
  if (!ip) {
    return null;
  }
  if (ip.includes(":")) {
    return ipv6ToBytes(ip);
  }
  return ipv4ToBytes(ip);
}

function ipv4ToBytes(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value < 0 || value > 255) {
      return null;
    }
    bytes.push(value);
  }
  return bytes;
}

function ipv6ToBytes(ip) {
  let normalized = ip.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon >= 0 && normalized.slice(lastColon + 1).includes(".")) {
    const ipv4 = ipv4ToBytes(normalized.slice(lastColon + 1));
    if (!ipv4) {
      return null;
    }
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const compactParts = normalized.split("::");
  if (compactParts.length > 2) {
    return null;
  }
  const left = compactParts[0] ? compactParts[0].split(":") : [];
  const right = compactParts.length === 2 && compactParts[1] ? compactParts[1].split(":") : [];
  const fillLength = 8 - left.length - right.length;
  if (fillLength < 0 || (compactParts.length === 1 && fillLength !== 0)) {
    return null;
  }
  const parts = [...left, ...Array(fillLength).fill("0"), ...right];
  if (parts.length !== 8) {
    return null;
  }
  const bytes = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/u.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function bytesEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
