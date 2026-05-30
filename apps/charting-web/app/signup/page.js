import { redirect } from "next/navigation";
import { lpSignupUrl } from "../../lib/lp-signup-url";

export default function SignupPage() {
  redirect(lpSignupUrl());
}
