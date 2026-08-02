import { proxyApiRequest } from "../../proxy-utils";

const targetBaseUrl =
  process.env.CARE_FEE_PROXY_TARGET
  || process.env.CARE_FEE_BASE_URL
  || process.env.NEXT_PUBLIC_CARE_FEE_BASE_URL;

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
