import { ReferralWorkspace } from "../../../components/referral-workspace";

export default async function ReferralDetailPage({ params }) {
  const resolvedParams = await params;
  return <ReferralWorkspace mode="detail" referralId={resolvedParams.id} />;
}
