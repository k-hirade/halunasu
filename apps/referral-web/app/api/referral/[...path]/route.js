import { proxyApiRequest } from "../../proxy-utils";

const targetBaseUrl =
  process.env.REFERRAL_PROXY_TARGET ||
  process.env.REFERRAL_BASE_URL ||
  process.env.NEXT_PUBLIC_REFERRAL_BASE_URL;

export async function GET(request, { params }) {
  const resolvedParams = await params;
  return proxyApiRequest(request, resolvedParams.path || [], targetBaseUrl);
}

export async function POST(request, { params }) {
  const resolvedParams = await params;
  return proxyApiRequest(request, resolvedParams.path || [], targetBaseUrl);
}

export async function PATCH(request, { params }) {
  const resolvedParams = await params;
  return proxyApiRequest(request, resolvedParams.path || [], targetBaseUrl);
}

export async function DELETE(request, { params }) {
  const resolvedParams = await params;
  return proxyApiRequest(request, resolvedParams.path || [], targetBaseUrl);
}
