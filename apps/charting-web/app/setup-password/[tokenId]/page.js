import { redirect } from "next/navigation";
import { lpSignupUrl } from "../../../lib/lp-signup-url";

export default async function SetupPasswordPage({ params }) {
  const awaitedParams = await params;

  redirect(lpSignupUrl({ setup: awaitedParams.tokenId }));
}
