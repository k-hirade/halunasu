import { FeeWorkspace } from "../../../components/fee-workspace";

export default async function SessionDetailPage({ params }) {
  const resolvedParams = await params;
  return <FeeWorkspace mode="detail" sessionId={resolvedParams.sessionId} />;
}
