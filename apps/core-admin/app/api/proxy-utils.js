const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade"
]);

export async function proxyApiRequest(request, segments, targetBaseUrl, prefix = "") {
  if (!targetBaseUrl) {
    return Response.json({ error: "API proxy target is not configured." }, { status: 503 });
  }

  const sourceUrl = new URL(request.url);
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const targetUrl = new URL(`${prefix}/${encodedPath}${sourceUrl.search}`, targetBaseUrl);
  const headers = new Headers();

  for (const [name, value] of request.headers.entries()) {
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  headers.set("x-forwarded-host", sourceUrl.host);
  headers.set("x-forwarded-proto", sourceUrl.protocol.replace(":", ""));

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.arrayBuffer();
  }

  const response = await fetch(targetUrl, init);
  const responseHeaders = new Headers();
  for (const [name, value] of response.headers.entries()) {
    const lowerName = name.toLowerCase();
    if (hopByHopHeaders.has(lowerName)) {
      continue;
    }
    if (lowerName === "set-cookie") {
      for (const cookie of splitSetCookieHeader(value)) {
        responseHeaders.append(name, cookie);
      }
      continue;
    }
    responseHeaders.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

function splitSetCookieHeader(value) {
  if (typeof value !== "string" || !value) {
    return [];
  }

  const cookies = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === ",") {
      if (!inExpires) {
        cookies.push(value.slice(start, index).trim());
        start = index + 1;
      }
      continue;
    }

    const lowerTail = value.slice(index).toLowerCase();
    if (lowerTail.startsWith("expires=")) {
      inExpires = true;
      index += "expires=".length - 1;
      continue;
    }
    if (inExpires && char === ";") {
      inExpires = false;
    }
  }

  cookies.push(value.slice(start).trim());
  return cookies.filter(Boolean);
}

