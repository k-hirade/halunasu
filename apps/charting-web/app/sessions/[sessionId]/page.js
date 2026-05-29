import { EncounterWorkspace } from "../../../components/encounter-workspace";

export default async function SessionPage({ params }) {
  const awaitedParams = await params;

  return (
    <EncounterWorkspace
      sessionId={awaitedParams.sessionId}
      initialPairingId={null}
      initialPairingToken={null}
    />
  );
}
