import { Suspense } from "react";
import { ReceptionDisplay } from "../../../components/reception-display";

export const metadata = { title: "院内掲示" };

// 受付番号の院内掲示（デジカルの受付番号院内掲示）。待合室の画面に全画面で出す。?department= で診療科ごと。
export default function ReceptionDisplayPage() {
  return (
    <Suspense fallback={null}>
      <ReceptionDisplay />
    </Suspense>
  );
}
