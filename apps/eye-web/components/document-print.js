"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useEyeApi } from "./eye-api";
import { LetterSheet } from "./letter-sheet";
import { usePrintNames } from "./use-print-names";
import { PrintMessage, PrintShell } from "./print-shell";
import { formatDateTime } from "../lib/format";

// 文書の印刷。保存済みの内容を出す（編集画面は保存してからこのページへ移る）。
export function DocumentPrint({ documentId }) {
  const api = useEyeApi();
  const printNames = usePrintNames();
  const [document, setDocument] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/v1/eye/documents/${documentId}`).then((payload) => setDocument(payload.document)).catch((nextError) => setError(nextError.message));
  }, [api, documentId]);

  const back = { backHref: `/documents/${documentId}`, backLabel: "文書に戻る" };
  if (error) return <PrintMessage {...back}><p className="alert alert-danger" role="alert">{error}</p></PrintMessage>;
  if (!document) return <PrintMessage {...back}><p className="loading">読み込み中…</p></PrintMessage>;

  const finalized = document.status === "finalized";
  const discarded = document.status === "discarded";
  const patient = document.patientSnapshot || {};
  const senderMissing = !document.sender?.facilityName || !document.sender?.address || !document.sender?.phone;
  const alerts = [];
  if (discarded) alerts.push(<p className="print-alert is-danger" key="discarded">この下書きは破棄されています。</p>);
  else if (!finalized) {
    alerts.push(
      <p className="print-alert is-draft" key="draft">
        <strong>下書き（未確定）</strong>です。紙には「下書き・未確定」の透かしが入ります。最終保存 {formatDateTime(document.updatedAt)}。
        <Link href={`/documents/${documentId}`}>文書に戻って確定する →</Link>
      </p>
    );
  }
  if (senderMissing) alerts.push(<p className="print-alert is-warn" key="sender">差出人の医療機関名・住所・電話のいずれかが未登録です。</p>);

  return (
    <PrintShell
      {...back}
      alerts={alerts.length ? alerts : null}
      draft={!finalized}
      footerText={`${patient.displayName || ""} 様 ・ ${document.title}`}
      margin="15mm 18mm 16mm"
      sheetClassName="sheet-letter"
      statusLabel={finalized ? `確定 ${formatDateTime(document.finalizedAt)}` : discarded ? "破棄済み" : "下書き（未確定）"}
      subject={`${patient.displayName || ""} 様`}
      title={document.title}
      watermark={discarded ? "破棄済み" : "下書き・未確定"}
    >
      <LetterSheet document={document} printNames={printNames} />
    </PrintShell>
  );
}
