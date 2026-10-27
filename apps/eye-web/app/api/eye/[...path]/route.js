import { proxyApiRequest } from "../../proxy-utils";

const targetBaseUrl =
  process.env.EYE_PROXY_TARGET
  || process.env.EYE_BASE_URL
  || process.env.NEXT_PUBLIC_EYE_BASE_URL;

async function proxy(request, params) {
  const resolvedParams = await params;
  return proxyApiRequest(request, resolvedParams.path || [], targetBaseUrl);
}

export function GET(request, { params }) {
  return proxy(request, params);
}

export function POST(request, { params }) {
  return proxy(request, params);
}

export function PATCH(request, { params }) {
  return proxy(request, params);
}
