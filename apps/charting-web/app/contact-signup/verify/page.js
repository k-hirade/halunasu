import { redirect } from "next/navigation";
import { lpSignupUrl } from "../../../lib/lp-signup-url";

export default async function ContactSignupVerifyPage({ searchParams }) {
  const params = await searchParams;
  redirect(lpSignupUrl({ token: params?.token }));
}
