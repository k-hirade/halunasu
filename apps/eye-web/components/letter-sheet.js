"use client";

import { printableStaffName } from "@halunasu/eye-core";
import { parseLetter } from "../lib/letter";
import { recipientLines } from "../lib/paper";
import { ageOn, formatDate, SEX_LABELS } from "../lib/format";

// 文書の紙面。印刷ページと編集画面の右のプレビューで同じ部品を使う。
// 本文の【見出し】ごとに表の行として描く（表示だけの処理。保存する本文は変えない）。
// 【】の見出しがない本文は、1つの段落としてそのまま出す。
// printNames（memberId → 印刷用の氏名）があれば署名にそれを使う。なければ表示名から役割の括弧を除いて出す。
export function LetterSheet({ document, showEmpty = false, printNames = {} }) {
  const patient = document.patientSnapshot || {};
  const recipient = document.recipient || {};
  const sender = document.sender || {};
  const age = ageOn(patient.birthDate, document.issueDate || undefined);
  const { preamble, sections } = parseLetter(document.body);
  // 医師名は確定した医師だけを印字する。下書きは署名欄を空けておく（作成者が医師とは限らないため）。
  const finalizer = document.finalizedBy || null;
  const doctorName = document.status === "finalized"
    ? (finalizer?.memberId && printNames[finalizer.memberId]) || printableStaffName(finalizer?.displayName || sender.doctorName || "")
    : "";
  const address = recipientLines(recipient);
  const to = address.to;
  return (
    <div className="letter-sheet">
      {/* 編集画面ではページの見出しと重なるので、紙面の表題は見出し要素にしない */}
      <p className="ls-title">{document.title}</p>
      <div className="ls-top">
        <div className="ls-to">
          <p className={`ls-to-inst${to ? "" : " is-blank"}`}>{to || "　"}{to && address.toSuffix ? ` ${address.toSuffix}` : ""}</p>
          {address.person === null ? null : (
            <p className="ls-to-doctor">
              {address.person ? address.person : <span className="ls-blank-line">　</span>}{address.suffix ? ` ${address.suffix}` : ""}
            </p>
          )}
        </div>
        <p className="ls-date">{formatJapaneseDate(document.issueDate)}</p>
      </div>
      <div className="ls-from">
        {sender.address ? <p>{sender.address}</p> : null}
        <p className="ls-facility">{sender.facilityName || (showEmpty ? <span className="ls-missing">医療機関名 未登録</span> : "")}</p>
        {sender.phone ? <p>TEL {sender.phone}</p> : null}
        <p className="ls-sign">
          <span>医師</span>
          <span className="ls-sign-name">{doctorName}</span>
          <span aria-label="押印欄" className="ls-seal">印</span>
        </p>
      </div>
      {preamble ? <p className="ls-preamble">{preamble}</p> : null}
      <table className="ls-grid">
        <colgroup><col className="ls-col-head" /><col /></colgroup>
        <tbody>
          <tr>
            <th scope="row">患者氏名</th>
            <td>
              <strong>{patient.displayName}</strong>
              {patient.displayNameKana ? <span className="ls-kana">（{patient.displayNameKana}）</span> : null}
              <span className="ls-patient-meta">
                {SEX_LABELS[patient.sex] ? <span>{SEX_LABELS[patient.sex]}</span> : null}
                {patient.birthDate ? <span>{formatDate(patient.birthDate)}生{age === null ? "" : `（${age}歳）`}</span> : null}
              </span>
            </td>
          </tr>
          {sections.map((section) => {
            const empty = !section.text.trim();
            if (empty && !showEmpty) return null;
            return (
              <tr className={empty ? "is-empty" : ""} key={`${section.line}-${section.heading}`}>
                <th scope="row">{section.heading}{section.note ? <span className="ls-note">{section.note}</span> : null}</th>
                <td>{empty ? <span className="ls-missing">未入力</span> : section.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {document.contentHash ? (
        <p className="ls-meta">文書ID {document.documentId} ・ 内容ハッシュ（改ざん検知用） {document.contentHash.slice(0, 16)}</p>
      ) : null}
    </div>
  );
}

export function formatJapaneseDate(iso) {
  if (!iso) return "";
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return `${year}年${month}月${day}日`;
}
