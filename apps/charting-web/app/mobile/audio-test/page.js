import { MobileAudioTestClient } from "../../../components/mobile-audio-test-client";

export default async function MobileAudioTestPage({ searchParams }) {
  const awaitedSearchParams = await searchParams;

  return (
    <MobileAudioTestClient
      initialTestId={awaitedSearchParams?.testId || null}
      initialToken={awaitedSearchParams?.token || null}
    />
  );
}
