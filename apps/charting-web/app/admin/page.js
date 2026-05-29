import { AdminConsole } from "../../components/admin-console";
import { BRAND_NAME } from "../../lib/brand";

export const metadata = {
  title: `設定 | ${BRAND_NAME}`
};

export default function AdminPage() {
  return <AdminConsole />;
}
