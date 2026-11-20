import { Suspense } from "react";
import { OpticalPrint } from "../../../../components/optical-print";

export const metadata = { title: "眼鏡・CL処方" };

export default async function OpticalPrintPage({ params }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <OpticalPrint encounterId={id} />
    </Suspense>
  );
}
