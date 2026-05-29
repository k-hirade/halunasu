import { MobileJoinClient } from "../../../components/mobile-join-client";

export default async function MobileJoinPage({ searchParams }) {
  const awaitedSearchParams = await searchParams;

  return (
    <MobileJoinClient
      initialPairingId={awaitedSearchParams?.pairingId || null}
      initialToken={awaitedSearchParams?.token || null}
    />
  );
}
