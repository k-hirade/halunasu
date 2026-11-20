import { Suspense } from "react";
import { PrintView } from "../../../../components/print-view";

export const metadata = { title: "カルテ印刷" };

export default async function EncounterPrintPage({ params }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <PrintView encounterId={id} />
    </Suspense>
  );
}
