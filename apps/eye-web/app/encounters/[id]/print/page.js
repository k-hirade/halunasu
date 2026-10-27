import { Suspense } from "react";
import { PrintView } from "../../../../components/print-view";

export default async function EncounterPrintPage({ params }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <PrintView encounterId={id} />
    </Suspense>
  );
}
