import { Suspense } from "react";
import { FeeAdminConsole } from "../../components/fee-admin-console";

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <FeeAdminConsole />
    </Suspense>
  );
}

