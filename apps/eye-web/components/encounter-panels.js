"use client";

import Link from "next/link";
import { useState } from "react";
import { adherenceLabel, COPYABLE_FINDING_KEYS, counsellingLabel, pupilLabel } from "@halunasu/eye-core";
import { ALIGNMENT_LABELS, MOTILITY_LABELS, PER_EYE_PHRASE_TARGETS, RAPD_LABELS } from "@halunasu/eye-contracts";
import { SoapMark } from "./encounter-extras";
import { diagnosisText, formatDate, formatDateTime, formatShortDate, PHRASE_TARGET_LABELS, PHRASE_TARGET_SOAP, prescriptionText, VISIT_TYPE_LABELS } from "../lib/format";

// 左列「変更点」: 前回の確定カルテから今回変わった所。
export function ChangesPanel({ changes, previous }) {
  if (!previous) return <p className="empty">確定済みの前回カルテはありません。</p>;
  return (
    <div className="changes-panel">
      <p className="muted small">
        前回 {formatDate(previous.encounterDate)}（v{previous.versionCount}）との違い ・ <Link href={`/encounters/${previous.encounterId}`}>前回を開く</Link>
      </p>
      {changes.length === 0 ? <p className="muted small">変更はまだありません。</p> : (
        <ul className="changes">
          {changes.map((change) => (
            <li key={change.path}>
              <span className="change-label">{change.label}</span>
              <span className="change-values"><del>{change.before || "（空）"}</del> → <ins>{change.after || "（空）"}</ins></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VersionsPanel({ encounterId, versions }) {
  if (!versions.length) return null;
  return (
    <section className="panel">
      <h2>確定履歴</h2>
      <ol className="versions">
        {[...versions].reverse().map((version) => (
          <li key={version.versionId}>
            <a href={`/encounters/${encounterId}/print?version=${version.version}`} target="_blank" rel="noreferrer">v{version.version}</a>
            <span className="muted small"> {formatDateTime(version.finalizedAt)} {version.finalizedBy?.displayName}</span>
            {version.amendmentReason ? <div className="small">修正理由: {version.amendmentReason}</div> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}


const FINDING_PARTS = [["anterior", "前眼部"], ["angle", "隅角"], ["lens", "中間透光体"], ["fundus", "眼底"], ["cdRatio", "C/D"], ["other", "その他"]];
const findingText = (key, values = {}) => {
  if (key === "cdRatio") return Number.isFinite(values.cdRatio) ? String(values.cdRatio) : "";
  if (key === "angle") return [values.angle, values.angleNote].filter(Boolean).join(" ");
  return values[key] || "";
};

// 過去カードの「検査」の追加行（瞳孔・RAPD・眼位・眼球運動）。値があるものだけを 1 行に。
function examExtrasLine(exam = {}) {
  const binocular = exam.binocular || {};
  const pupil = ["od", "os"].map((side) => {
    const text = pupilLabel(exam[side]?.pupil);
    return text ? `${side === "od" ? "R" : "L"} ${text}` : "";
  }).filter(Boolean).join(" ");
  return [
    pupil ? `瞳孔 ${pupil}` : "",
    binocular.rapd ? `RAPD ${RAPD_LABELS[binocular.rapd]}` : "",
    binocular.alignment || binocular.alignmentNote ? `眼位 ${[ALIGNMENT_LABELS[binocular.alignment], binocular.alignmentNote].filter(Boolean).join(" ")}` : "",
    binocular.motility || binocular.motilityNote ? `眼球運動 ${[MOTILITY_LABELS[binocular.motility], binocular.motilityNote].filter(Boolean).join(" ")}` : ""
  ].filter(Boolean).join("　");
}

const examLine = (values = {}) => `${values.vaCorrected || values.vaUncorrected || "—"} / ${values.iop ?? "—"}`;

// 左列「過去」: 過去の確定カルテ。最新の 1 回だけ開き、他は 1 行に畳む（日付を押して開閉）。
// 複写は、カードの見出しの「Do」（すべて）と、各グループの「→」の 2 種類。複写の処理そのものは onCopy（今回の入力は上書きしない）。
export function HistoryPane({ history, editable, onCopy }) {
  const [openIds, setOpenIds] = useState(() => new Set(history[0] ? [history[0].encounterId] : []));
  if (!history.length) {
    return <p className="empty">確定済みの過去カルテはありません。</p>;
  }
  const toggle = (id) => {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  };
  return (
    <ol className="history-pane">
      {history.map((encounter) => {
        const { content } = encounter;
        const open = openIds.has(encounter.encounterId);
        const primary = (content.diagnoses || []).find((item) => item.primary) || content.diagnoses?.[0];
        const copyButton = (kind, label) => (editable && hasContent(content, kind) ? (
          <button aria-label={`${label}を今回へ複写`} className="history-copy-arrow" onClick={() => onCopy(kind, encounter)} title={`${label}を今回へ複写（入力済みの欄はそのまま）`} type="button">→</button>
        ) : null);
        const group = (kind, label, body) => (
          <div className="history-group">
            <div className="history-group-head">
              <span className="history-label">{label}</span>
              {copyButton(kind, label)}
            </div>
            {body}
          </div>
        );
        const findings = FINDING_PARTS.map(([key, label]) => {
          const right = findingText(key, content.findings?.od);
          const left = findingText(key, content.findings?.os);
          if (!right && !left) return null;
          return (
            <div className="history-finding" key={key}>
              <span className="history-part">{label}</span>
              <span>
                {right ? <span className="history-eye-line"><span className="eye-od">R</span> {right}</span> : null}
                {left ? <span className="history-eye-line"><span className="eye-os">L</span> {left}</span> : null}
              </span>
            </div>
          );
        }).filter(Boolean);
        if (content.findings?.general) {
          findings.push(
            <div className="history-finding" key="general">
              <span className="history-part">両眼・全体</span>
              <span>{content.findings.general}</span>
            </div>
          );
        }
        const extras = examExtrasLine(content.exam);
        const counselling = counsellingLabel(content.counselling);
        const adherence = adherenceLabel(content.adherence);
        return (
          <li className={`history-card${open ? " is-open" : ""}`} key={encounter.encounterId}>
            <div className="history-card-head">
              <button aria-expanded={open} className="history-toggle" onClick={() => toggle(encounter.encounterId)} type="button">
                <span className="history-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                <strong>{formatShortDate(encounter.encounterDate)}</strong>
                <span className="muted small">{VISIT_TYPE_LABELS[encounter.visitType] || ""}</span>
                {open ? <span className="muted small">{encounter.finalizedBy?.displayName || ""}</span> : (
                  <span className="history-summary">
                    <span className="eye-od">R</span> {examLine(content.exam?.od)} <span className="eye-os">L</span> {examLine(content.exam?.os)}
                    {primary ? <span className="history-dx"> {primary.name}</span> : null}
                  </span>
                )}
              </button>
              {editable ? (
                <button aria-label={`${formatDate(encounter.encounterDate)} の所見・処方・方針・シェーマを今回へ複写`} className="btn btn-chip history-do" onClick={() => onCopy("all", encounter)} title="所見・処方・方針・シェーマをまとめて複写（入力済みの欄はそのまま）" type="button">Do</button>
              ) : null}
            </div>
            {open ? (
              <div className="history-body">
                <p className="history-line">
                  <span className="eye-od">R</span> {examLine(content.exam?.od)}
                  {"　"}
                  <span className="eye-os">L</span> {examLine(content.exam?.os)}
                  <span className="muted small">（視力 / 眼圧）</span>
                </p>
                {extras ? <p className="history-line muted small">{extras}</p> : null}
                {content.chiefComplaint ? <p className="history-line"><span className="history-label">主訴</span>{content.chiefComplaint}</p> : null}
                {findings.length ? group("findings", "所見", <div className="history-findings">{findings}</div>) : null}
                {content.diagnoses?.length ? <p className="history-line"><span className="history-label">病名</span>{content.diagnoses.map(diagnosisText).join("、")}</p> : null}
                {content.prescriptions?.length ? group("prescriptions", "処方", (
                  <ul className="history-rx">{content.prescriptions.map((item, index) => <li key={index}>{prescriptionText(item)}</li>)}</ul>
                )) : null}
                {content.plan || content.assessment ? group("plan", "方針", <p className="history-text pre">{[content.assessment, content.plan].filter(Boolean).join("\n")}</p>) : null}
                {adherence ? <p className="history-line"><span className="history-label">点眼</span>{adherence}</p> : null}
                {counselling ? <p className="history-line"><span className="history-label">説明</span>{counselling}</p> : null}
                {content.sketches?.length ? group("sketches", "シェーマ", <p className="history-text muted small">{content.sketches.length}枚</p>) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function hasContent(content, kind) {
  if (kind === "findings") {
    return Boolean(content.findings?.general) || ["od", "os"].some((side) => COPYABLE_FINDING_KEYS.some((key) => Boolean(content.findings?.[side]?.[key])));
  }
  if (kind === "prescriptions") return (content.prescriptions || []).length > 0;
  if (kind === "plan") return Boolean(content.plan || content.assessment);
  if (kind === "sketches") return (content.sketches || []).length > 0;
  return false;
}

// 右列の「候補」: よく使う薬剤を1クリックで処方に追加する。
export function CandidatesPanel({ drugPresets, editable, onAddPrescription }) {
  if (!drugPresets.length) return <p className="empty">設定画面で「よく使う薬剤」を登録すると、ここから追加できます。</p>;
  return (
    <ul className="candidate-buttons">
      {drugPresets.map((preset) => (
        <li key={preset.presetId}>
          <button className="candidate-button" disabled={!editable} onClick={() => onAddPrescription(preset)} type="button">
            <span>{preset.name}</span>
            <span className="muted small">{preset.defaultTimesPerDay ? `1日${preset.defaultTimesPerDay}回` : ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// 右列の「候補」: セット（処方・オーダー・方針の組み合わせ）と定型文。
export function SetsAndPhrasesPanel({ orderSets, phrases, editable, onApplySet, onInsertPhrase }) {
  const activeSets = orderSets.filter((item) => item.active !== false);
  const activePhrases = phrases.filter((item) => item.active !== false);
  const groups = Object.entries(PHRASE_TARGET_LABELS)
    .map(([target, label]) => [target, label, activePhrases.filter((item) => item.target === target)])
    .filter(([, , items]) => items.length);
  return (
    <>
      <section className="panel">
        <h2>セット</h2>
        {activeSets.length === 0 ? <p className="empty">設定画面でセットを登録すると、ここから一括で追加できます。</p> : (
          <ul className="candidate-buttons">
            {activeSets.map((item) => (
              <li key={item.setId}>
                <button className="candidate-button" disabled={!editable} onClick={() => onApplySet(item)} type="button">
                  <span>{item.name}</span>
                  <span className="muted small">処方{item.prescriptions.length}・検査{item.orders.length}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>定型文</h2>
        {groups.length === 0 ? <p className="empty">設定画面で定型文を登録できます。</p> : groups.map(([target, label, items]) => (
          <div className="phrase-group" key={target}>
            <h3>{label}{PHRASE_TARGET_SOAP[target] ? <SoapMark letters={PHRASE_TARGET_SOAP[target]} /> : null}</h3>
            {items.map((item) => (
              <div className="phrase-row" key={item.phraseId}>
                <span className="phrase-text" title={item.text}>{item.label || item.text}</span>
                {PER_EYE_PHRASE_TARGETS.includes(target) ? (
                  <span className="phrase-actions">
                    <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "od")} type="button">右</button>
                    <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "os")} type="button">左</button>
                    <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item, "both")} type="button">両</button>
                  </span>
                ) : (
                  <button className="btn btn-chip" disabled={!editable} onClick={() => onInsertPhrase(item)} type="button">挿入</button>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>
    </>
  );
}
