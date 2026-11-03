"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { adherenceLabel, counsellingLabel, printableStaffName, pupilLabel } from "@halunasu/eye-core";
import { ALIGNMENT_LABELS, MOTILITY_LABELS, RAPD_LABELS } from "@halunasu/eye-contracts";
import { useEyeApi } from "./eye-api";
import { facilityInfo, pickFacility, PrintMessage, PrintShell, VersionSelect } from "./print-shell";
import { SKETCH_TEMPLATE_LABELS, SketchPad } from "./sketch-pad";
import {
  ageOn,
  diagnosisText,
  EYE_LABELS,
  formatDate,
  formatDateTime,
  formatRefraction,
  formatVisualAcuityLine,
  IOP_METHOD_LABELS,
  prescriptionText,
  SEX_LABELS,
  VISIT_TYPE_LABELS
} from "../lib/format";

const FINDINGS = [["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]];
// 追加の所見（入力があるときだけ行を出す）
const EXTRA_FINDINGS = [
  ["cdRatio", "C/D 比", (values) => (Number.isFinite(values?.cdRatio) ? String(values.cdRatio) : "")],
  ["angle", "隅角", (values) => [values?.angle ? (/^[0-4]$/u.test(values.angle) ? `Shaffer ${values.angle}` : values.angle) : "", values?.angleNote || ""].filter(Boolean).join(" ")],
  ["other", "その他", (values) => values?.other || ""]
];

// カルテの印刷（診療録の写し）。版番号の指定があれば確定済みの版をそのまま出す。
// 指定がなければ、いま保存されている内容（下書きなら透かし入り）を出す。
export function PrintView({ encounterId }) {
  const api = useEyeApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const versionNumber = searchParams.get("version") || "";
  const [record, setRecord] = useState(null);
  const [error, setError] = useState("");
  const [printedAt, setPrintedAt] = useState("");

  useEffect(() => {
    let active = true;
    setRecord(null);
    setError("");
    (async () => {
      const [detail, bootstrap] = await Promise.all([
        api(`/v1/eye/encounters/${encounterId}`),
        api("/v1/eye/bootstrap").catch(() => ({ facilities: [] }))
      ]);
      const facility = pickFacility(bootstrap.facilities);
      const base = { encounter: detail.encounter, versions: detail.versions || [], facility, printNames: bootstrap.printNames || {} };
      if (versionNumber) {
        const { version } = await api(`/v1/eye/encounters/${encounterId}/versions/${Number(versionNumber)}`);
        return { ...base, content: version.content, encounterDate: version.encounterDate, visitType: version.visitType, version };
      }
      return { ...base, content: detail.encounter.content, encounterDate: detail.encounter.encounterDate, visitType: detail.encounter.visitType, version: null };
    })()
      .then((next) => { if (active) { setRecord(next); setPrintedAt(new Date().toISOString()); } })
      .catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [api, encounterId, versionNumber]);

  const back = { backHref: `/encounters/${encounterId}`, backLabel: "カルテに戻る" };
  if (error) return <PrintMessage {...back}><p className="alert alert-danger" role="alert">{error}</p></PrintMessage>;
  if (!record) return <PrintMessage {...back}><p className="loading">読み込み中…</p></PrintMessage>;

  const { encounter, content, version, facility } = record;
  const patient = encounter.patientSnapshot || {};
  const finalizedInfo = version || (encounter.status === "finalized" ? { version: encounter.versionCount, finalizedAt: encounter.finalizedAt, finalizedBy: encounter.finalizedBy } : null);
  const draft = !finalizedInfo;
  // 記載医は紙に載せる氏名（設定の「印刷用の氏名」、なければ表示名から役割の括弧を除いたもの）
  const finalizer = finalizedInfo?.finalizedBy || null;
  const doctorName = finalizer ? record.printNames[finalizer.memberId] || printableStaffName(finalizer.displayName) : "";
  const statusLabel = finalizedInfo
    ? `確定 v${finalizedInfo.version}（${formatDateTime(finalizedInfo.finalizedAt)} ${doctorName}）`
    : "下書き（未確定）";
  const age = ageOn(patient.birthDate, record.encounterDate);
  const info = facilityInfo(facility);
  const exam = content.exam || {};
  const findings = content.findings || {};
  const examRows = [
    ["視力", (side) => formatVisualAcuityLine(exam[side])],
    ["他覚屈折", (side) => formatRefraction(exam[side]?.refraction)],
    ["眼圧", (side) => iopText(exam[side])],
    ["近見視力", (side) => exam[side]?.vaNear || ""],
    ["瞳孔", (side) => pupilLabel(exam[side]?.pupil)],
    ["角膜曲率", (side) => keratometryText(exam[side]?.keratometry)]
  ].filter(([, read]) => ["od", "os"].some((side) => read(side)));
  // 両眼で 1 つの値（RAPD・眼位・眼球運動）と所見の「両眼・全体」は 2 列をまたいで出す
  const binocular = exam.binocular || {};
  const bothRows = [
    ["RAPD", RAPD_LABELS[binocular.rapd] || ""],
    ["眼位", [ALIGNMENT_LABELS[binocular.alignment], binocular.alignmentNote].filter(Boolean).join(" ")],
    ["眼球運動", [MOTILITY_LABELS[binocular.motility], binocular.motilityNote].filter(Boolean).join(" ")]
  ].filter(([, text]) => text);
  const findingRows = [
    ...FINDINGS.map(([key, label]) => [key, label, (values) => values?.[key] || ""]),
    ...EXTRA_FINDINGS
  ].filter(([, , read]) => ["od", "os"].some((side) => read(findings[side])));
  const counselling = counsellingLabel(content.counselling);
  const adherence = adherenceLabel(content.adherence);
  const performedOrders = (content.orders || []).filter((item) => item.status === "performed" && item.name);
  const nextVisit = nextVisitText(content.nextVisit);

  function selectVersion(value) {
    router.replace(value ? `${pathname}?version=${value}` : pathname);
  }

  const alerts = draft ? (
    <p className="print-alert is-draft">
      <strong>下書き（未確定）</strong>です。紙には「下書き・未確定」の透かしが入ります。最終保存 {formatDateTime(encounter.updatedAt)} の内容で、カルテで保存されていない入力は含まれません。
      <Link href={`/encounters/${encounterId}`}>カルテで確定する →</Link>
    </p>
  ) : null;

  return (
    <PrintShell
      {...back}
      alerts={alerts}
      controls={<VersionSelect latestLabel={encounter.status === "finalized" ? `最新（確定 v${encounter.versionCount}）` : "最新（下書き）"} onChange={selectVersion} value={versionNumber} versions={record.versions} />}
      draft={draft}
      footerText={`${patient.displayName || ""}${patient.primaryPatientNumber ? ` No.${patient.primaryPatientNumber}` : ""} ・ ${formatDate(record.encounterDate)} 受診 ・ 印刷 ${formatDateTime(printedAt)}`}
      statusLabel={statusLabel}
      subject={`${patient.displayName || ""} 様 ・ ${formatDate(record.encounterDate)}`}
      title="カルテの印刷"
    >
      <div className="chart-sheet">
        <header className="cs-facility">
          <span>{[info.name, info.postalCode ? `〒${info.postalCode}` : "", info.address, info.phone ? `TEL ${info.phone}` : ""].filter(Boolean).join("　")}</span>
          <span className="cs-kind">診療録（写し）</span>
        </header>
        <div className="cs-patient">
          <h1>{patient.displayName}{patient.displayNameKana ? <span className="cs-kana">（{patient.displayNameKana}）</span> : null}</h1>
          <p>
            {[SEX_LABELS[patient.sex], patient.birthDate ? `${formatDate(patient.birthDate)}生` : "", age === null ? "" : `${age}歳`, patient.primaryPatientNumber ? `No.${patient.primaryPatientNumber}` : ""].filter(Boolean).join("　")}
          </p>
        </div>
        <p className="cs-visit">
          <span>受診日 {formatDate(record.encounterDate)}（{VISIT_TYPE_LABELS[record.visitType] || ""}）</span>
          <span>記載医 {doctorName || "—"}</span>
          <span>{statusLabel}</span>
        </p>

        <table className="cs-table">
          <colgroup><col className="cs-col-label" /><col /><col /></colgroup>
          {content.chiefComplaint || content.history ? (
            <tbody>
              {content.chiefComplaint ? <tr><th scope="row">主訴</th><td className="pre" colSpan={2}>{content.chiefComplaint}</td></tr> : null}
              {content.history ? <tr><th scope="row">経過</th><td className="pre" colSpan={2}>{content.history}</td></tr> : null}
            </tbody>
          ) : null}
          {examRows.length || findingRows.length || bothRows.length || findings.general ? (
            <tbody>
              <tr className="cs-eye-head"><th scope="col" /><th scope="col">右眼（R）</th><th scope="col">左眼（L）</th></tr>
              {examRows.map(([label, read]) => (
                <tr key={label}><th scope="row">{label}</th>{["od", "os"].map((side) => <td key={side}>{read(side)}</td>)}</tr>
              ))}
              {bothRows.map(([label, text]) => (
                <tr key={label}><th scope="row">{label}</th><td colSpan={2}>{text}</td></tr>
              ))}
              {findingRows.map(([key, label, read]) => (
                <tr key={key}><th scope="row">{label}</th>{["od", "os"].map((side) => <td className="pre" key={side}>{read(findings[side])}</td>)}</tr>
              ))}
              {findings.general ? <tr><th scope="row">両眼・全体</th><td className="pre" colSpan={2}>{findings.general}</td></tr> : null}
            </tbody>
          ) : null}
        </table>

        {content.sketches?.length ? (
          <section className="cs-section">
            <h2>シェーマ</h2>
            <div className="print-sketches">
              {content.sketches.map((sketch) => (
                <figure key={sketch.sketchId}>
                  <SketchPad onChange={() => {}} readOnly sketch={sketch} />
                  <figcaption>{EYE_LABELS[sketch.eye]} {SKETCH_TEMPLATE_LABELS[sketch.template]}{sketch.caption ? `：${sketch.caption}` : ""}</figcaption>
                </figure>
              ))}
            </div>
          </section>
        ) : null}

        <dl className="cs-list">
          {/* 病名は確定時に患者の病名から写すため、下書きで空なら行を出さない（「なし」と誤読させない） */}
          {content.diagnoses?.length || !draft ? <div><dt>病名</dt><dd>{(content.diagnoses || []).map(diagnosisText).join("、") || "なし"}</dd></div> : null}
          {content.assessment ? <div><dt>評価</dt><dd className="pre">{content.assessment}</dd></div> : null}
          {content.plan ? <div><dt>方針</dt><dd className="pre">{content.plan}</dd></div> : null}
          {counselling ? <div><dt>説明・同意</dt><dd className="pre">{counselling}</dd></div> : null}
          <div>
            <dt>処方</dt>
            <dd>{content.prescriptions?.length ? <ul>{content.prescriptions.map((item, index) => <li key={index}>{prescriptionText(item)}</li>)}</ul> : "なし"}</dd>
          </div>
          {adherence ? <div><dt>点眼状況</dt><dd>{adherence}</dd></div> : null}
          {performedOrders.length ? (
            <div><dt>検査・処置</dt><dd><ul>{performedOrders.map((item) => <li key={item.orderId}>{item.name}{item.eye ? `（${EYE_LABELS[item.eye]}）` : ""}{item.note ? ` ${item.note}` : ""}</li>)}</ul></dd></div>
          ) : null}
          {nextVisit ? <div><dt>次回</dt><dd>{nextVisit}</dd></div> : null}
        </dl>

        {version?.amendmentReason ? <p className="cs-small">修正理由: {version.amendmentReason}</p> : null}
        {version?.contentHash ? <p className="cs-small cs-hash">内容ハッシュ（改ざん検知用） {version.contentHash.slice(0, 16)}…</p> : null}
      </div>
    </PrintShell>
  );
}

function iopText(value = {}) {
  if (!Number.isFinite(value?.iop)) return "";
  // 眼圧は測定法と測定時刻を添える（例: 15 mmHg NCT 10:30測定）
  return [`${value.iop} mmHg`, IOP_METHOD_LABELS[value.iopMethod] || "", value.measuredAt ? `${value.measuredAt}測定` : ""].filter(Boolean).join(" ");
}

// 角膜曲率（K1・K2 は D、軸は K1 の軸）: 「K1 43.25D K2 44.00D Ax175°」
function keratometryText(value) {
  if (!value) return "";
  const diopter = (number) => (Number.isFinite(number) ? `${number.toFixed(2)}D` : "");
  return [
    Number.isFinite(value.k1) ? `K1 ${diopter(value.k1)}` : "",
    Number.isFinite(value.k2) ? `K2 ${diopter(value.k2)}` : "",
    Number.isFinite(value.axis) ? `Ax${value.axis}°` : ""
  ].filter(Boolean).join(" ");
}

function nextVisitText(nextVisit = {}) {
  const parts = [
    nextVisit?.intervalWeeks ? `${nextVisit.intervalWeeks}週後` : "",
    nextVisit?.date ? `（${formatDate(nextVisit.date)}）` : ""
  ].join("");
  return [parts, nextVisit?.note || ""].filter(Boolean).join("　");
}
