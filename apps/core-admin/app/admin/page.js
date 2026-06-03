import { Suspense } from "react";
import { CoreAdminConsole } from "../../components/core-admin-console";

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <CoreAdminConsole />
    </Suspense>
  );
}

