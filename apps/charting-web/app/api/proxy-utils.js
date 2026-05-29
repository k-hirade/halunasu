const hopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "transfer-encoding",
  "upgrade"
]);

export async function proxyApiRequest(request, segments, targetBaseUrl, prefix = "/api/v1") {
  if (!targetBaseUrl) {
    return Response.json({ error: "API proxy target is not configured." }, { status: 503 });
  }

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(
    `${prefix}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}${sourceUrl.search}`,
    targetBaseUrl
  );
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
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}
