import { proxyApiRequest } from "../../../../api/proxy-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const target = process.env.BILLING_PROXY_TARGET || process.env.NEXT_PUBLIC_BILLING_BASE_URL || "";

export async function GET(request, context) {
  return proxy(request, context);
}

export async function POST(request, context) {
  return proxy(request, context);
}

export async function PATCH(request, context) {
  return proxy(request, context);
}

export async function DELETE(request, context) {
  return proxy(request, context);
}

export async function OPTIONS(request, context) {
  return proxy(request, context);
}

async function proxy(request, { params }) {
  const { path = [] } = await params;
  return proxyApiRequest(request, path, target, "/v1");
}
