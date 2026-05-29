import { Suspense } from "react";

import { ContactSignupSubmittedPanel } from "../../../components/contact-signup-submitted-panel";

export default function ContactSignupSubmittedPage() {
  return (
    <Suspense fallback={null}>
      <ContactSignupSubmittedPanel />
    </Suspense>
  );
}
