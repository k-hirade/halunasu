import { PasswordSetupPanel } from "../../../components/password-setup-panel";

export default async function SetupPasswordPage({ params }) {
  const awaitedParams = await params;

  return <PasswordSetupPanel tokenId={awaitedParams.tokenId} />;
}
