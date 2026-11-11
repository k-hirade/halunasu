import { Suspense } from "react";
import { ReceptionPrint } from "../../../../components/reception-print";

// 予約票（デジカルの予約票）・受付票（トプコンの受診票）の印刷。?kind=booking|visit、?memo=1 で受付メモを備考に印字する。
export default async function ReceptionPrintPage({ params }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <ReceptionPrint appointmentId={id} />
    </Suspense>
  );
}
