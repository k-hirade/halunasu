"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { openPatientSearch } from "./patient-search";

// 画面を開けなかったとき（カルテ・患者・文書が見つからない、権限が無いなど）の共通の表示。
// 文言だけで行き止まりにせず、戻り先（前の画面・受付・患者検索）を出す。
export function LoadErrorPage({ message }) {
  const router = useRouter();
  const canGoBack = typeof window !== "undefined" && window.history.length > 1;
  return (
    <main className="eye-page">
      <div className="load-error" role="alert">
        <p className="alert alert-danger">{message || "画面を開けませんでした。"}</p>
        <div className="load-error-actions">
          {canGoBack ? <button className="btn btn-ghost" onClick={() => router.back()} type="button">前の画面へ</button> : null}
          <Link className="btn btn-primary" href="/reception">受付へ</Link>
          <button className="btn btn-ghost" onClick={() => openPatientSearch()} type="button">患者検索</button>
        </div>
      </div>
    </main>
  );
}
