import { Suspense } from "react";

import { ContactSignupVerifyPanel } from "../../../components/contact-signup-verify-panel";

export default function ContactSignupVerifyPage() {
  return (
    <Suspense fallback={null}>
      <ContactSignupVerifyPanel />
    </Suspense>
  );
}
