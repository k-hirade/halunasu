"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { adherenceLabel, counsellingLabel, diagnosisName, groupRps, pupilLabel } from "@halunasu/eye-core";
import { ALIGNMENT_LABELS, MOTILITY_LABELS, PLAN_ITEM_EYE_LABELS, RAPD_LABELS } from "@halunasu/eye-contracts";
import { COPY_DRAG_TYPE, dateWithWeekday, ORDER_BADGES, RX_BADGES } from "./chart-shared";
import { DocumentsPanel } from "./documents-panel";
import { useEyeApi } from "./eye-api";
import { FilesPanel } from "./files-panel";
import { AllergyBadge } from "./patient-banner";
import { SketchThumb } from "./sketch-pad";
import { EYE_LABELS, formatDate, formatDateTime, formatShortDate, formatVisualAcuityLine, VISIT_TYPE_LABELS } from "../lib/format";
import { copyDragProps, findingDragText } from "../lib/chart-dnd";

// 左のペイン「患者の情報」のタブ（デジカルの並び。code は Shift+数字のキー）。既定は診療履歴。
export const LEFT_TABS = [
  { id: "info", label: "患者情報", codes: ["Digit1", "Digit3", "Digit4", "Digit5"], keyLabel: "Shift+1" },
  { id: "exam", label: "検査", codes: ["Digit6"], keyLabel: "Shift+6" },
  { id: "history", label: "診療履歴", codes: ["Digit7"], keyLabel: "Shift+7" },
  { id: "drugs", label: "薬歴", codes: ["Digit8"], keyLabel: "Shift+8" },
  { id: "files", label: "ファイル", codes: ["Digit9", "Digit0"], keyLabel: "Shift+9" },
  { id: "diagnoses", label: "病名", codes: ["Minus"], keyLabel: "Shift+-" }
];

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

// 確定の版の一覧（確定済みカルテを直したときは新しい版になり、前の版も残る）。
export function VersionsPanel({ encounterId, versions }) {
  if (!versions.length) return <p className="empty">まだ確定していません。</p>;
  return (
    <ol className="versions">
      {[...versions].reverse().map((version) => (
        <li key={version.versionId}>
          <a className="version-link" href={`/encounters/${encounterId}/print?version=${version.version}`} rel="noreferrer" target="_blank">v{version.version}</a>
          <span className="muted small"> {formatDateTime(version.finalizedAt)} {version.finalizedBy?.displayName}</span>
          {version.amendmentReason ? <div className="small">修正理由: {version.amendmentReason}</div> : null}
          {version.warningCodes?.length ? <div className="muted small">確認事項 {version.warningCodes.length}件のまま確定</div> : null}
        </li>
      ))}
    </ol>
  );
}

const FINDING_PARTS = [["anterior", "前眼部"], ["angle", "隅角"], ["lens", "中間透光体"], ["fundus", "眼底"], ["cdRatio", "C/D"], ["other", "その他"]];
const findingText = (key, values = {}) => {
  if (key === "cdRatio") return Number.isFinite(values.cdRatio) ? String(values.cdRatio) : "";
  if (key === "angle") return [values.angle, values.angleNote].filter(Boolean).join(" ");
  return values[key] || "";
};

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

function searchableText(encounter) {
  const content = encounter.content || {};
  return [
    content.chiefComplaint, content.findingsText, content.history, content.assessment, content.plan, content.staffNote,
    ...["od", "os"].flatMap((side) => Object.values(content.findings?.[side] || {}).map(String)),
    content.findings?.general,
    ...(content.prescriptions || []).map((row) => row.name || row.text),
    ...(content.orders || []).map((row) => row.name || row.text),
    ...(content.diagnoses || []).map((row) => row.name)
  ].filter(Boolean).join("\n");
}

function startDrag(event, payload, text = "") {
  event.dataTransfer.setData(COPY_DRAG_TYPE, JSON.stringify(payload));
  if (text) event.dataTransfer.setData("text/plain", text);
  event.dataTransfer.effectAllowed = "copy";
}

// 左「診療履歴」: 過去の確定カルテを新しい順に、すべて開いた状態で並べる（デジカルの診療履歴タブ）。
// 複写: 列見出しの［複写］（主訴・所見／処置・行為）、束を押す、ドラッグ＆ドロップ（トプコン）。Do は処置・行為の複写と同じ。
export function HistoryTab({ history, editable, onCopy, changes, previous, highlightId = "" }) {
  const [keyword, setKeyword] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [showIndex, setShowIndex] = useState(false);
  const shown = useMemo(() => {
    const word = keyword.trim();
    return word ? history.filter((item) => searchableText(item).includes(word)) : history;
  }, [history, keyword]);
  const jump = (id) => document.getElementById(`hist-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="history-tab">
      <div className="pane-tools">
        <input aria-label="診療履歴の全文検索" className="input pane-search" onChange={(event) => setKeyword(event.target.value)} placeholder="キーワード（全文検索）" type="search" value={keyword} />
        <button aria-pressed={showDiff} className="btn btn-chip" onClick={() => setShowDiff(!showDiff)} type="button">前回との差分{changes.length ? ` ${changes.length}` : ""}</button>
        <button aria-expanded={showIndex} className="btn btn-chip" onClick={() => setShowIndex(!showIndex)} type="button">一覧</button>
      </div>
      {showDiff ? <div className="history-diff"><ChangesPanel changes={changes} previous={previous} /></div> : null}
      {showIndex && history.length ? (
        <ul className="history-index">
          {history.map((item) => (
            <li key={item.encounterId}>
              <button className="link-button" onClick={() => jump(item.encounterId)} type="button">
                {formatShortDate(item.encounterDate)} {VISIT_TYPE_LABELS[item.visitType] || ""}
                <span className="muted small"> {(item.content?.diagnoses || []).find((dx) => dx.primary)?.name || ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!history.length ? <p className="empty">確定済みの過去カルテはありません。</p> : null}
      {history.length && !shown.length ? <p className="empty">「{keyword}」を含むカルテはありません。</p> : null}
      <ol className="history-pane">
        {shown.map((encounter) => (
          <HistoryCard editable={editable} encounter={encounter} highlighted={highlightId === encounter.encounterId} key={encounter.encounterId} onCopy={onCopy} />
        ))}
      </ol>
    </div>
  );
}

function HistoryCard({ encounter, editable, onCopy, highlighted }) {
  const content = encounter.content || {};
  const rxGroups = groupRps(content.prescriptions || []);
  const orderGroups = groupRps(content.orders || []);
  const findings = FINDING_PARTS.map(([key, label]) => {
    const right = findingText(key, content.findings?.od);
    const left = findingText(key, content.findings?.os);
    if (!right && !left) return null;
    return (
      <div className="history-finding" key={key} {...copyDragProps(editable, { kind: "finding", encounterId: encounter.encounterId, part: key }, { text: findingDragText(label, right, left), title: `ドラッグして今日の${label}へ（空の欄にだけ入ります）` })}>
        <span className="history-part">{label}</span>
        <span>
          {right ? <span className="history-eye-line"><span className="eye-od">R</span> {right}</span> : null}
          {left ? <span className="history-eye-line"><span className="eye-os">L</span> {left}</span> : null}
        </span>
      </div>
    );
  }).filter(Boolean);
  const extras = examExtrasLine(content.exam);
  const counselling = counsellingLabel(content.counselling);
  const adherence = adherenceLabel(content.adherence);
  const exam = content.exam || {};
  const hasExam = ["od", "os"].some((side) => formatVisualAcuityLine(exam[side] || {}) || Number.isFinite(exam[side]?.iop));
  const leftHas = Boolean(content.findingsText || findings.length || content.findings?.general || content.plan || content.assessment || content.sketches?.length);
  const rightHas = rxGroups.length > 0 || orderGroups.some((group) => group.items.some(({ row }) => row.status !== "cancelled"));
  const copyButton = (kind, label, has) => (editable && has ? (
    <button aria-label={`${formatDate(encounter.encounterDate)} の${label}を複写`} className="btn btn-chip history-col-copy" onClick={() => onCopy(kind, encounter)} title={`${label}を今日のカルテへ複写（入力済みの欄はそのまま）`} type="button">複写</button>
  ) : null);
  const primary = (content.diagnoses || []).find((item) => item.primary) || content.diagnoses?.[0];

  return (
    <li className={`history-card${highlighted ? " is-highlighted" : ""}`} id={`hist-${encounter.encounterId}`}>
      <div className="history-card-head">
        <div className="history-card-title">
          <strong>{dateWithWeekday(encounter.encounterDate)}</strong>
          <span className="tag">{VISIT_TYPE_LABELS[encounter.visitType] || "受診"}</span>
          <span className="muted small">眼科 {encounter.finalizedBy?.displayName || ""} 確定 v{encounter.versionCount}</span>
        </div>
        <span className="history-card-actions">
          {editable && rightHas ? (
            <button aria-label={`${formatDate(encounter.encounterDate)} の処置・行為を Do`} className="btn btn-chip history-do" onClick={() => onCopy("right", encounter)} title="処置・行為（処方・検査処置）をまとめて複写" type="button">Do</button>
          ) : null}
          <Link aria-label={`${formatDate(encounter.encounterDate)} のカルテを開いて編集`} className="btn btn-chip" href={`/encounters/${encounter.encounterId}`} title="このカルテを開く（直すと新しい版になります）">✎</Link>
        </span>
      </div>
      {primary ? <p className="history-dx-line"><span className="history-label">病名</span>{(content.diagnoses || []).map((item) => diagnosisName(item)).join("、")}</p> : null}
      <div className="history-cols">
        <div className="history-col">
          <div className="history-col-head"><span>主訴・所見</span>{copyButton("left", "主訴・所見", leftHas)}</div>
          {hasExam ? (
            <p className="history-line history-exam">
              <span className="history-label">検査</span>
              <span className="eye-od">RV=</span>{formatVisualAcuityLine(exam.od || {}) || "—"}{Number.isFinite(exam.od?.iop) ? ` T ${exam.od.iop}` : ""}
              {"　"}
              <span className="eye-os">LV=</span>{formatVisualAcuityLine(exam.os || {}) || "—"}{Number.isFinite(exam.os?.iop) ? ` T ${exam.os.iop}` : ""}
            </p>
          ) : null}
          {extras ? <p className="history-line muted small">{extras}</p> : null}
          {content.chiefComplaint ? <p className="history-line"><span className="history-label">主訴</span>{content.chiefComplaint}</p> : null}
          {content.findingsText ? (
            <div
              className="history-text pre history-free"
              draggable={editable}
              onDragStart={(event) => {
                // 選択した範囲だけをドラッグしたときは、ブラウザの標準の文字のドラッグに任せる
                if (window.getSelection()?.toString()) return;
                startDrag(event, { kind: "text", encounterId: encounter.encounterId }, content.findingsText);
              }}
              title={editable ? "ドラッグして今日の主訴・所見へ（範囲を選んでドラッグするとその部分だけ）" : undefined}
            >
              {content.findingsText}
            </div>
          ) : null}
          {findings.length ? <div className="history-findings">{findings}</div> : null}
          {content.findings?.general ? <p className="history-line"><span className="history-label">両眼</span>{content.findings.general}</p> : null}
          {content.assessment || content.plan ? <p className="history-line pre" {...copyDragProps(editable, { kind: "plan", encounterId: encounter.encounterId }, { text: [content.assessment, content.plan].filter(Boolean).join("\n"), title: "ドラッグして今日の方針へ" })}><span className="history-label">方針</span>{[content.assessment, content.plan].filter(Boolean).join("\n")}</p> : null}
          {adherence ? <p className="history-line"><span className="history-label">点眼</span>{adherence}</p> : null}
          {counselling ? <p className="history-line"><span className="history-label">説明</span>{counselling}</p> : null}
          {content.sketches?.length ? (
            <div className="history-sketches">
              {content.sketches.map((sketch) => (
                <div
                  className="history-sketch"
                  draggable={editable}
                  key={sketch.sketchId}
                  onDragStart={(event) => startDrag(event, { kind: "sketch", encounterId: encounter.encounterId, sketchId: sketch.sketchId, strokes: true })}
                >
                  <SketchThumb sketch={sketch} />
                  {editable ? (
                    <span className="history-sketch-actions">
                      <button className="btn btn-chip" onClick={() => onCopy("sketch", encounter, { sketch, strokes: false })} title="下絵だけを写す" type="button">図だけ</button>
                      <button className="btn btn-chip" onClick={() => onCopy("sketch", encounter, { sketch, strokes: true })} title="書き込みも写す" type="button">複写</button>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="history-col">
          <div className="history-col-head"><span>処置・行為</span>{copyButton("right", "処置・行為", rightHas)}</div>
          {rxGroups.map((group) => {
            const rows = group.rows.map(({ row }) => row);
            const head = group.head || {};
            return (
              <button
                aria-label={`${formatDate(encounter.encounterDate)} の処方 ${group.items.map(({ row }) => row.name).join("・")} を複写`}
                className="history-group"
                disabled={!editable}
                draggable={editable}
                key={group.rpId}
                onClick={() => onCopy("rx", encounter, { rows })}
                onDragStart={(event) => startDrag(event, { kind: "rx", encounterId: encounter.encounterId, rpId: group.rpId })}
                title={editable ? "押す・ドラッグすると、この Rp を今日の処置・行為へ複写" : undefined}
                type="button"
              >
                {group.rows.map(({ row }, index) => (row.kind === "comment" ? (
                  <span className="history-group-row is-comment" key={index}>※{row.text}</span>
                ) : (
                  <span className="history-group-row" key={index}>
                    <span className="rp-badge">{RX_BADGES[row.kind] || "薬"}</span>
                    {row.name}{row.issued !== false && row.quantity ? ` ${row.quantity}${row.unit || ""}` : ""}{row.issued === false ? "（今回なし）" : ""}
                  </span>
                )))}
                <span className="history-group-foot">
                  {[head.route === "inside" ? "院内" : "院外", head.eye ? EYE_LABELS[head.eye] : "", head.timesPerDay ? `1日${head.timesPerDay}回` : "", head.usage || "", head.days ? `${head.days}日` : ""].filter(Boolean).join(" ")}
                </span>
              </button>
            );
          })}
          {orderGroups.map((group) => {
            const rows = group.rows.map(({ row }) => row);
            const items = group.items.filter(({ row }) => row.status !== "cancelled");
            if (!items.length) return null;
            return (
              <button
                aria-label={`${formatDate(encounter.encounterDate)} の検査・処置 ${items.map(({ row }) => row.name).join("・")} を複写`}
                className="history-group is-order"
                disabled={!editable}
                draggable={editable}
                key={group.rpId}
                onClick={() => onCopy("orders", encounter, { rows })}
                onDragStart={(event) => startDrag(event, { kind: "orders", encounterId: encounter.encounterId, rpId: group.rpId })}
                type="button"
              >
                {group.rows.map(({ row }, index) => (row.kind === "comment" ? (
                  <span className="history-group-row is-comment" key={index}>※{row.text}</span>
                ) : row.status === "cancelled" ? null : (
                  <span className="history-group-row" key={index}>
                    <span className="rp-badge is-order">{ORDER_BADGES[row.kind] || "検査"}</span>{row.name}{row.eye ? `（${EYE_LABELS[row.eye]}）` : ""}
                  </span>
                )))}
              </button>
            );
          })}
          {content.optical?.type ? <p className="history-line"><span className="rp-badge is-optical">{content.optical.type === "contact" ? "CL" : "眼鏡"}</span>{content.optical.issue ? "発行" : "記録のみ"}</p> : null}
          {content.nextVisit?.intervalWeeks || content.nextVisit?.planItems?.length ? (
            <p className="history-line">
              <span className="rp-badge is-plan">予定</span>
              {content.nextVisit.intervalWeeks ? `${content.nextVisit.intervalWeeks}週後 ` : ""}
              {(content.nextVisit.planItems || []).map((item) => `${item.name || item.code}${item.eye && item.eye !== "none" ? `(${PLAN_ITEM_EYE_LABELS[item.eye]})` : ""}`).join("、")}
            </p>
          ) : null}
          {!rightHas && !content.optical?.type ? <p className="muted small">なし</p> : null}
        </div>
      </div>
    </li>
  );
}

// 左「薬歴」: 薬剤 × 年月の表に ✓（デジカルの投薬履歴）。✓ を押すと診療履歴のそのカルテへ。
export function DrugHistoryTab({ history, onJump }) {
  // 月は古い順に右へ並ぶ。狭いペインでも最新の月が見えるよう、開いたときは右端までスクロールしておく（薬剤名の列は左に固定）
  const scrollRef = useRef(null);
  const { months, rows } = useMemo(() => {
    const visits = [...history].sort((left, right) => String(left.encounterDate).localeCompare(String(right.encounterDate)));
    const monthKeys = [...new Set(visits.map((item) => item.encounterDate.slice(0, 7)))];
    const byName = new Map();
    for (const visit of visits) {
      for (const row of visit.content?.prescriptions || []) {
        if (row.kind === "comment" || !row.name) continue;
        const entry = byName.get(row.name) || { name: row.name, kind: row.kind, cells: new Map() };
        entry.cells.set(visit.encounterDate.slice(0, 7), visit.encounterId);
        byName.set(row.name, entry);
      }
    }
    return { months: monthKeys, rows: [...byName.values()] };
  }, [history]);
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [months.length]);
  if (!rows.length) return <p className="empty">処方の記録はありません。</p>;
  const years = [];
  for (const month of months) {
    const year = month.slice(0, 4);
    if (years.at(-1)?.year === year) years.at(-1).span += 1;
    else years.push({ year, span: 1 });
  }
  return (
    <div className="table-scroll drug-history" ref={scrollRef}>
      <table className="data-table drug-matrix">
        <thead>
          <tr>
            <th rowSpan={2} scope="col">医薬品</th>
            {years.map((item) => <th colSpan={item.span} key={item.year} scope="colgroup">{item.year}</th>)}
          </tr>
          <tr>
            {months.map((month) => <th key={month} scope="col">{Number(month.slice(5))}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th scope="row" title={row.name}><span className="rp-badge">{RX_BADGES[row.kind] || "薬"}</span>{row.name}</th>
              {months.map((month) => (
                <td key={month}>
                  {row.cells.has(month) ? (
                    <button aria-label={`${month.replace("-", "年")}月の${row.name}`} className="drug-check" onClick={() => onJump(row.cells.get(month))} type="button">✓</button>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 左「患者情報」: アレルギー・既往・CL・患者メモ（患者メモはここで直せる）。
export function PatientInfoTab({ patient, profile, context, onEditProfile, onProfileSaved }) {
  const api = useEyeApi();
  const [memo, setMemo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = profile?.patientMemo || "";
  async function saveMemo() {
    setBusy(true);
    setError("");
    try {
      const payload = await api(`/v1/eye/patients/${patient.patientId}/memo`, { method: "PUT", body: { expectedRevision: profile?.revision || 0, patientMemo: memo } });
      onProfileSaved(payload.profile);
      setMemo(null);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="info-tab">
      <dl className="info-list">
        <dt>アレルギー</dt>
        <dd><AllergyBadge profile={profile} /></dd>
        <dt>全身既往・内服</dt>
        <dd className="pre">{profile?.medicalHistory || <span className="muted">未記入</span>}</dd>
        <dt>眼科既往</dt>
        <dd className="pre">{profile?.ophthalmicHistory || <span className="muted">未記入</span>}</dd>
        <dt>CL</dt>
        <dd>{profile?.contactLensUser ? "装用" : "—"}</dd>
        <dt>生年月日</dt>
        <dd>{patient.birthDate ? formatDate(patient.birthDate) : "—"}</dd>
      </dl>
      {context?.canEditProfile ? <button className="btn btn-chip" onClick={onEditProfile} type="button">アレルギー・既往を編集</button> : null}
      <section className="info-memo">
        <h3>患者メモ</h3>
        {memo === null ? (
          <>
            <p className="pre">{current || <span className="muted">メモはありません。</span>}</p>
            {context?.canReceive ? <button className="btn btn-chip" onClick={() => setMemo(current)} type="button">患者メモを編集</button> : null}
          </>
        ) : (
          <>
            <textarea aria-label="患者メモ" autoFocus className="input" maxLength={2000} onChange={(event) => setMemo(event.target.value)} rows={3} value={memo} />
            {error ? <p className="alert alert-danger small">{error}</p> : null}
            <span className="row-line">
              <button className="btn btn-ghost" onClick={() => setMemo(null)} type="button">キャンセル</button>
              <button className="btn btn-primary" disabled={busy} onClick={saveMemo} type="button">保存</button>
            </span>
          </>
        )}
      </section>
    </div>
  );
}

// 左「ファイル」: 文書（紹介状など）と画像・取り込みファイル。
export function FilesTab({ patientId, encounterId, context, onUpload, reloadKey }) {
  return (
    <div className="files-tab">
      <DocumentsPanel canWrite={Boolean(context?.canWriteDocuments)} encounterId={encounterId} patientId={patientId} />
      <FilesPanel context={context} onUpload={context?.canWriteDocuments ? onUpload : null} patientId={patientId} reloadKey={reloadKey} />
    </div>
  );
}

