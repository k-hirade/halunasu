"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  calculateEyeDropBottles,
  daysUntilNextVisit,
  diffEncounterContent
} from "@halunasu/eye-core";
import { AppointmentDialog } from "./appointment-dialog";
import { useEyeApi } from "./eye-api";
import { StatusTag } from "./home-workspace";
import { SKETCH_TEMPLATE_LABELS, SketchPad } from "./sketch-pad";
import {
  addDays,
  diagnosisText,
  EYE_LABELS,
  formatDate,
  formatDateTime,
  formatRefraction,
  IOP_METHOD_LABELS,
  patientLine,
  PRESCRIPTION_KIND_LABELS,
  prescriptionText,
  VISIT_TYPE_LABELS
} from "../lib/format";

const SIDES = ["od", "os"];
const AUTOSAVE_MS = 1500;
const COMMON_DIAGNOSES = [
  "原発開放隅角緑内障", "正常眼圧緑内障", "高眼圧症", "白内障", "加齢性白内障", "糖尿病網膜症", "糖尿病黄斑浮腫",
  "加齢黄斑変性", "網膜静脈分枝閉塞症", "網膜剥離", "アレルギー性結膜炎", "細菌性結膜炎", "ドライアイ",
  "眼精疲労", "近視", "乱視", "老視", "麦粒腫", "霰粒腫", "飛蚊症", "後発白内障"
];

export function EncounterEditor({ encounterId }) {
  const api = useEyeApi();
  const router = useRouter();
  const [detail, setDetail] = useState(null);
  const [context, setContext] = useState(null);
  const [drugPresets, setDrugPresets] = useState([]);
  const [content, setContent] = useState(null);
  const [meta, setMeta] = useState({ encounterDate: "", visitType: "revisit" });
  const [saveState, setSaveState] = useState("saved");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [booking, setBooking] = useState({ open: false, saved: null });
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(null);
  // ログイン状態の復元で api の参照が変わっても、カルテを読み直して入力中の内容を上書きしないようにする。
  const apiRef = useRef(api);
  apiRef.current = api;

  const load = useCallback(async () => {
    const [detailPayload, bootstrap] = await Promise.all([
      apiRef.current(`/v1/eye/encounters/${encounterId}`),
      apiRef.current("/v1/eye/bootstrap")
    ]);
    if (dirtyRef.current) return;
    setDetail(detailPayload);
    setContext(bootstrap.context);
    setDrugPresets(bootstrap.drugPresets.filter((preset) => preset.active !== false));
    setContent(detailPayload.encounter.content);
    setMeta({ encounterDate: detailPayload.encounter.encounterDate, visitType: detailPayload.encounter.visitType });
    revisionRef.current = detailPayload.encounter.revision;
    setSaveState("saved");
  }, [encounterId]);

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
  }, [load]);

  const encounter = detail?.encounter;
  const editable = Boolean(encounter && encounter.status === "draft" && context?.canWrite);

  const save = useCallback(async () => {
    if (!dirtyRef.current || !editable) return true;
    if (savingRef.current) return savingRef.current;
    const snapshot = { content, meta };
    dirtyRef.current = false;
    setSaveState("saving");
    const promise = api(`/v1/eye/encounters/${encounterId}`, {
      method: "PATCH",
      body: { expectedRevision: revisionRef.current, content: snapshot.content, ...snapshot.meta }
    }).then((payload) => {
      revisionRef.current = payload.encounter.revision;
      setDetail((current) => ({ ...current, encounter: payload.encounter }));
      setSaveState(dirtyRef.current ? "dirty" : "saved");
      setError("");
      // 保存中に入力が続いた場合は、次の入力を待たずに続けて保存する。
      if (dirtyRef.current) setTimeout(() => saveRef.current(), 0);
      return true;
    }).catch((nextError) => {
      dirtyRef.current = true;
      setSaveState("error");
      setError(nextError.message);
      return false;
    }).finally(() => {
      savingRef.current = null;
    });
    savingRef.current = promise;
    return promise;
  }, [api, content, editable, encounterId, meta]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (saveState !== "dirty") return undefined;
    const handle = setTimeout(() => { save(); }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
  }, [save, saveState, content, meta]);

  useEffect(() => {
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        save();
      }
    }
    function onBeforeUnload(event) {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [save]);

  const update = useCallback((path, value) => {
    setContent((current) => setIn(current, path, value));
    dirtyRef.current = true;
    setSaveState("dirty");
  }, []);

  const updateMeta = (patch) => {
    setMeta((current) => ({ ...current, ...patch }));
    dirtyRef.current = true;
    setSaveState("dirty");
  };

  const previous = detail?.previous || null;
  const changes = useMemo(() => {
    if (!previous || !content) return [];
    try {
      return diffEncounterContent(previous.content, content);
    } catch {
      return [];
    }
  }, [previous, content]);

  if (error && !detail) return <main className="eye-page"><p className="alert alert-danger" role="alert">{error}</p></main>;
  if (!detail || !content) return <main className="eye-page"><p className="loading">読み込み中…</p></main>;

  async function runAction(path, body, after) {
    const saved = await save();
    if (!saved) return;
    try {
      const payload = await api(path, { method: "POST", body: { expectedRevision: revisionRef.current, ...body } });
      setDialog(null);
      if (after) after(payload);
      else await load();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  const patient = encounter.patientSnapshot;
  const nextDays = daysUntilNextVisit(meta.encounterDate, content.nextVisit);

  return (
    <main className="eye-page encounter-page">
      <header className="encounter-bar">
        <div className="encounter-bar-main">
          <a className="back-link" href={`/patients/${encounter.patientId}`}>← {patient.displayName} のカルテ一覧</a>
          <div className="encounter-title">
            <h1>{patient.displayName}</h1>
            <span className="muted">{patientLine(patient)}</span>
            <StatusTag encounter={{ ...encounter, amending: Boolean(encounter.amendment) }} />
          </div>
          <div className="encounter-meta-row">
            <label className="inline-field">
              <span>診療日</span>
              <input className="input input-date" disabled={!editable} onChange={(event) => updateMeta({ encounterDate: event.target.value })} type="date" value={meta.encounterDate} />
            </label>
            <label className="inline-field">
              <span>区分</span>
              <select className="input" disabled={!editable} onChange={(event) => updateMeta({ visitType: event.target.value })} value={meta.visitType}>
                <option value="initial">初診</option>
                <option value="revisit">再診</option>
              </select>
            </label>
            {encounter.copiedFromEncounterId ? <span className="muted small">前回カルテから方針・処方・所見を引き継ぎました（視力・眼圧は引き継いでいません）</span> : null}
          </div>
        </div>
        <div className="encounter-actions">
          {editable ? <SaveIndicator state={saveState} onRetry={save} /> : null}
          <a className="btn btn-ghost" href={`/encounters/${encounterId}/print`} target="_blank" rel="noreferrer">印刷</a>
          {encounter.status === "draft" && encounter.versionCount === 0 && context?.canWrite ? (
            <button className="btn btn-ghost danger-text" onClick={() => setDialog("discard")} type="button">下書きを破棄</button>
          ) : null}
          {encounter.status === "draft" && context?.canFinalize ? (
            <button className="btn btn-primary" onClick={() => setDialog("finalize")} type="button">確定する</button>
          ) : null}
          {encounter.status === "finalized" && context?.canFinalize ? (
            <button className="btn btn-ghost" onClick={() => setDialog("amend")} type="button">修正する</button>
          ) : null}
        </div>
      </header>

      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {encounter.amendment ? (
        <p className="alert alert-warn">確定済み v{encounter.versionCount} を修正中です。理由: {encounter.amendment.reason}（{encounter.amendment.requestedBy?.displayName}・{formatDateTime(encounter.amendment.requestedAt)}）</p>
      ) : null}
      {encounter.status === "draft" && !context?.canFinalize ? (
        <p className="alert alert-info">下書きとして保存されます。確定は医師が行います。</p>
      ) : null}

      <div className="encounter-grid">
        <fieldset className="encounter-form" disabled={!editable}>
          <Section title="主訴・経過" id="subjective">
            <label className="field">
              <span>主訴</span>
              <textarea className="input" onChange={(event) => update(["chiefComplaint"], event.target.value)} rows={2} value={content.chiefComplaint} />
            </label>
            <label className="field">
              <span>現病歴・経過</span>
              <textarea className="input" onChange={(event) => update(["history"], event.target.value)} rows={3} value={content.history} />
            </label>
          </Section>

          <Section title="検査" id="exam">
            <ExamTable content={content} previous={previous?.content} update={update} />
          </Section>

          <Section title="所見" id="findings">
            <div className="eye-columns">
              {SIDES.map((side) => (
                <div className="eye-column" key={side}>
                  <h3 className={`eye-heading eye-${side}`}>{EYE_LABELS[side]}</h3>
                  {[["anterior", "前眼部"], ["lens", "中間透光体"], ["fundus", "眼底"]].map(([key, label]) => (
                    <label className="field" key={key}>
                      <span>{label}</span>
                      <textarea className="input" onChange={(event) => update(["findings", side, key], event.target.value)} rows={2} value={content.findings[side][key]} />
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </Section>

          <Section title="シェーマ" id="sketches">
            <Sketches content={content} editable={editable} update={update} />
          </Section>

          <Section title="病名" id="diagnoses">
            <Diagnoses content={content} update={update} />
          </Section>

          <Section title="評価・方針" id="plan">
            <label className="field">
              <span>評価</span>
              <textarea className="input" onChange={(event) => update(["assessment"], event.target.value)} rows={2} value={content.assessment} />
            </label>
            <label className="field">
              <span>方針</span>
              <textarea className="input" onChange={(event) => update(["plan"], event.target.value)} rows={3} value={content.plan} />
            </label>
          </Section>

          <Section title="次回受診" id="next-visit">
            <NextVisit content={content} encounterDate={meta.encounterDate} suggestion={detail.nextVisitSuggestion} update={update} editable={editable} />
          </Section>

          <Section title="処方" id="prescriptions">
            <Prescriptions content={content} drugPresets={drugPresets} nextDays={nextDays} update={update} editable={editable} />
          </Section>

          <Section title="スタッフメモ" id="staff-note">
            <textarea aria-label="スタッフメモ" className="input" onChange={(event) => update(["staffNote"], event.target.value)} rows={2} value={content.staffNote} />
          </Section>
        </fieldset>

        <aside className="copilot" aria-label="前回との比較">
          {context?.canReceive ? (
            <section className="panel next-booking">
              <h2>次回予約</h2>
              <p className="small muted">
                {content.nextVisit.intervalWeeks
                  ? `指示: ${content.nextVisit.intervalWeeks}週後（目安 ${formatDate(addDays(meta.encounterDate, Math.round(content.nextVisit.intervalWeeks * 7)))}）`
                  : "次回受診の指示はまだありません。"}
              </p>
              {booking.saved ? <p className="alert alert-ok small">予約しました: {formatDate(booking.saved.date)}{booking.saved.time ? ` ${booking.saved.time}` : ""}</p> : null}
              <button className="btn btn-ghost" onClick={() => setBooking({ open: true, saved: null })} type="button">次回予約を取る</button>
            </section>
          ) : null}
          <ComparePanel changes={changes} previous={previous} />
          <VersionsPanel encounterId={encounterId} versions={detail.versions} />
        </aside>
      </div>

      {dialog === "finalize" ? (
        <ConfirmDialog
          confirmLabel="確定する"
          onCancel={() => setDialog(null)}
          onConfirm={() => runAction(`/v1/eye/encounters/${encounterId}/finalize`, {})}
          title="カルテを確定しますか？"
        >
          <p>確定すると v{encounter.versionCount + 1} として保存され、以後の変更は「修正する」から理由を付けて行います。</p>
          {changes.length ? <p className="muted small">前回からの変更: {changes.map((change) => change.label).join("、")}</p> : null}
        </ConfirmDialog>
      ) : null}
      {booking.open ? (
        <AppointmentDialog
          fixedPatient={patient}
          initial={{
            date: content.nextVisit.date || (content.nextVisit.intervalWeeks ? addDays(meta.encounterDate, Math.round(content.nextVisit.intervalWeeks * 7)) : meta.encounterDate),
            time: "",
            purpose: "revisit",
            note: content.nextVisit.note,
            walkIn: false,
            sourceEncounterId: encounterId
          }}
          onCancel={() => setBooking({ open: false, saved: null })}
          onSaved={(appointment) => setBooking({ open: false, saved: appointment })}
          title="次回予約"
        />
      ) : null}
      {dialog === "amend" ? (
        <AmendDialog onCancel={() => setDialog(null)} onConfirm={(reason) => runAction(`/v1/eye/encounters/${encounterId}/amend`, { reason })} />
      ) : null}
      {dialog === "discard" ? (
        <ConfirmDialog
          confirmLabel="破棄する"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => runAction(`/v1/eye/encounters/${encounterId}/discard`, {}, () => router.push(`/patients/${encounter.patientId}`))}
          title="この下書きを破棄しますか？"
        >
          <p>一度も確定していない下書きのため、記録は残りません。</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

function Section({ title, id, children }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="form-section">
      <h2 id={`${id}-heading`}>{title}</h2>
      {children}
    </section>
  );
}

function ExamTable({ content, previous, update }) {
  const numberInput = (side, path, props = {}) => {
    const value = getIn(content.exam[side], path);
    return (
      <input
        className="input input-num"
        inputMode="decimal"
        onChange={(event) => update(["exam", side, ...path], parseNumber(event.target.value))}
        type="number"
        value={value ?? ""}
        {...props}
      />
    );
  };
  const hint = (side, path, format = (value) => value) => {
    const value = previous ? getIn(previous.exam?.[side] || {}, path) : null;
    return value === null || value === undefined || value === "" ? null : <span className="prev-hint">前回 {format(value)}</span>;
  };

  return (
    <div className="table-scroll">
      <table className="exam-table">
        <thead>
          <tr>
            <th scope="col" />
            <th className="eye-od" scope="col">右眼 (R)</th>
            <th className="eye-os" scope="col">左眼 (L)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">裸眼視力</th>
            {SIDES.map((side) => (
              <td key={side}>
                <input aria-label={`${EYE_LABELS[side]} 裸眼視力`} className="input input-va" onChange={(event) => update(["exam", side, "vaUncorrected"], event.target.value)} placeholder="例 0.3" value={content.exam[side].vaUncorrected} />
                {hint(side, ["vaUncorrected"])}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">矯正視力</th>
            {SIDES.map((side) => (
              <td key={side}>
                <input aria-label={`${EYE_LABELS[side]} 矯正視力`} className="input input-va" onChange={(event) => update(["exam", side, "vaCorrected"], event.target.value)} placeholder="例 1.2" value={content.exam[side].vaCorrected} />
                {hint(side, ["vaCorrected"])}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">矯正 S / C / Ax</th>
            {SIDES.map((side) => (
              <td key={side}>
                <span className="triple">
                  {numberInput(side, ["correction", "sphere"], { "aria-label": `${EYE_LABELS[side]} 矯正 球面`, step: 0.25, placeholder: "S" })}
                  {numberInput(side, ["correction", "cylinder"], { "aria-label": `${EYE_LABELS[side]} 矯正 円柱`, step: 0.25, placeholder: "C" })}
                  {numberInput(side, ["correction", "axis"], { "aria-label": `${EYE_LABELS[side]} 矯正 軸`, step: 1, min: 0, max: 180, placeholder: "Ax" })}
                </span>
                {previous ? <span className="prev-hint">{formatRefraction(previous.exam?.[side]?.correction) ? `前回 ${formatRefraction(previous.exam[side].correction)}` : ""}</span> : null}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">他覚屈折 S / C / Ax</th>
            {SIDES.map((side) => (
              <td key={side}>
                <span className="triple">
                  {numberInput(side, ["refraction", "sphere"], { "aria-label": `${EYE_LABELS[side]} 屈折 球面`, step: 0.25, placeholder: "S" })}
                  {numberInput(side, ["refraction", "cylinder"], { "aria-label": `${EYE_LABELS[side]} 屈折 円柱`, step: 0.25, placeholder: "C" })}
                  {numberInput(side, ["refraction", "axis"], { "aria-label": `${EYE_LABELS[side]} 屈折 軸`, step: 1, min: 0, max: 180, placeholder: "Ax" })}
                </span>
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">眼圧 (mmHg)</th>
            {SIDES.map((side) => (
              <td key={side}>
                <span className="pair">
                  {numberInput(side, ["iop"], { "aria-label": `${EYE_LABELS[side]} 眼圧`, step: 1, min: 0, max: 90 })}
                  <select aria-label={`${EYE_LABELS[side]} 眼圧の測定法`} className="input" onChange={(event) => update(["exam", side, "iopMethod"], event.target.value)} value={content.exam[side].iopMethod}>
                    <option value="">測定法</option>
                    {Object.entries(IOP_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </span>
                {hint(side, ["iop"], (value) => `${value}`)}
                {Number.isFinite(content.exam[side].iop) && content.exam[side].iop > 21 ? <span className="flag">21 mmHg を超えています</span> : null}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Sketches({ content, editable, update }) {
  const [template, setTemplate] = useState("fundus");
  const [eye, setEye] = useState("od");
  const addSketch = () => {
    update(["sketches"], [...content.sketches, { sketchId: `sk_${Date.now().toString(36)}`, template, eye, caption: "", strokes: [] }]);
  };
  return (
    <div>
      {content.sketches.length === 0 ? <p className="empty">シェーマはありません。</p> : null}
      <div className="sketch-grid">
        {content.sketches.map((sketch, index) => (
          <div className="sketch-card" key={sketch.sketchId}>
            <div className="sketch-card-head">
              <strong>{EYE_LABELS[sketch.eye]} {SKETCH_TEMPLATE_LABELS[sketch.template]}</strong>
              {editable ? (
                <button className="btn btn-chip danger-text" onClick={() => update(["sketches"], content.sketches.filter((_, itemIndex) => itemIndex !== index))} type="button">削除</button>
              ) : null}
            </div>
            <SketchPad onChange={(next) => update(["sketches", index], next)} readOnly={!editable} sketch={sketch} />
            <input aria-label="シェーマの説明" className="input" onChange={(event) => update(["sketches", index, "caption"], event.target.value)} placeholder="説明（任意）" value={sketch.caption} />
          </div>
        ))}
      </div>
      {editable && content.sketches.length < 8 ? (
        <div className="add-row">
          <select aria-label="シェーマの眼" className="input" onChange={(event) => setEye(event.target.value)} value={eye}>
            {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="シェーマの種類" className="input" onChange={(event) => setTemplate(event.target.value)} value={template}>
            {Object.entries(SKETCH_TEMPLATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={addSketch} type="button">シェーマを追加</button>
        </div>
      ) : null}
    </div>
  );
}

function Diagnoses({ content, update }) {
  const rows = content.diagnoses;
  const setRow = (index, patch) => update(["diagnoses", index], { ...rows[index], ...patch });
  return (
    <div>
      <datalist id="common-diagnoses">
        {COMMON_DIAGNOSES.map((name) => <option key={name} value={name} />)}
      </datalist>
      {rows.map((row, index) => (
        <div className="row-line" key={index}>
          <input aria-label="病名" className="input grow" list="common-diagnoses" onChange={(event) => setRow(index, { name: event.target.value })} placeholder="病名" value={row.name} />
          <select aria-label="病名の眼" className="input" onChange={(event) => setRow(index, { eye: event.target.value })} value={row.eye}>
            {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="病名の状態" className="input" onChange={(event) => setRow(index, { status: event.target.value })} value={row.status}>
            <option value="active">確定</option>
            <option value="suspected">疑い</option>
            <option value="resolved">治癒</option>
          </select>
          <button aria-label="この病名を削除" className="btn btn-chip danger-text" onClick={() => update(["diagnoses"], rows.filter((_, rowIndex) => rowIndex !== index))} type="button">削除</button>
        </div>
      ))}
      <button className="btn btn-ghost" onClick={() => update(["diagnoses"], [...rows, { name: "", eye: "ou", status: "active", onsetDate: "" }])} type="button">病名を追加</button>
    </div>
  );
}

function Prescriptions({ content, drugPresets, nextDays, update, editable }) {
  const rows = content.prescriptions;
  const setRow = (index, patch) => update(["prescriptions", index], { ...rows[index], ...patch });
  const presetByName = new Map(drugPresets.map((preset) => [preset.name, preset]));

  function changeName(index, name) {
    const preset = presetByName.get(name);
    setRow(index, preset
      ? { name, presetId: preset.presetId, kind: preset.kind, timesPerDay: rows[index].timesPerDay ?? preset.defaultTimesPerDay ?? null }
      : { name, presetId: "" });
  }

  return (
    <div>
      <datalist id="drug-presets">
        {drugPresets.map((preset) => <option key={preset.presetId} value={preset.name} />)}
      </datalist>
      {rows.length === 0 ? <p className="empty">処方はありません。</p> : null}
      {rows.map((row, index) => {
        const preset = row.presetId ? drugPresets.find((item) => item.presetId === row.presetId) : null;
        const days = row.days || nextDays;
        const bottles = row.kind === "eye_drop"
          ? calculateEyeDropBottles({ timesPerDay: row.timesPerDay, eye: row.eye, days, dropsPerBottle: preset?.dropsPerBottle })
          : null;
        return (
          <div className="rx-row" key={index}>
            <div className="row-line">
              <select aria-label="処方の種類" className="input" onChange={(event) => setRow(index, { kind: event.target.value })} value={row.kind}>
                {Object.entries(PRESCRIPTION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input aria-label="薬剤名" className="input grow" list="drug-presets" onChange={(event) => changeName(index, event.target.value)} placeholder="薬剤名" value={row.name} />
              <select aria-label="処方の眼" className="input" onChange={(event) => setRow(index, { eye: event.target.value })} value={row.eye}>
                <option value="">眼</option>
                {Object.entries(EYE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <label className="inline-field">
                <span>1日</span>
                <input aria-label="1日の回数" className="input input-num" min="0" onChange={(event) => setRow(index, { timesPerDay: parseNumber(event.target.value) })} type="number" value={row.timesPerDay ?? ""} />
                <span>回</span>
              </label>
              <label className="inline-field">
                <input aria-label="数量" className="input input-num" min="0" onChange={(event) => setRow(index, { quantity: parseNumber(event.target.value) })} step="any" type="number" value={row.quantity ?? ""} />
                <input aria-label="単位" className="input input-unit" onChange={(event) => setRow(index, { unit: event.target.value })} placeholder="本" value={row.unit} />
              </label>
              <label className="inline-field">
                <input aria-label="日数" className="input input-num" min="0" onChange={(event) => setRow(index, { days: parseNumber(event.target.value) })} type="number" value={row.days ?? ""} />
                <span>日分</span>
              </label>
              <button aria-label="この処方を削除" className="btn btn-chip danger-text" onClick={() => update(["prescriptions"], rows.filter((_, rowIndex) => rowIndex !== index))} type="button">削除</button>
            </div>
            {bottles ? (
              <div className="rx-hint">
                {bottles.bottles ? (
                  <>
                    <span>
                      本数の目安 <strong>{bottles.bottles}本</strong>
                      <span className="muted small">（{days}日 × 1日{row.timesPerDay}回 × {row.eye === "ou" ? 2 : 1}眼 = {bottles.dropsNeeded}滴 ÷ 1本{bottles.dropsPerBottle}滴{row.days ? "" : "・日数は次回受診まで"}）</span>
                    </span>
                    {editable && !(row.quantity === bottles.bottles && row.unit === "本") ? (
                      <button className="btn btn-chip" onClick={() => setRow(index, { quantity: bottles.bottles, unit: "本" })} type="button">{bottles.bottles}本を反映</button>
                    ) : null}
                  </>
                ) : (
                  <span className="muted small">眼・1日の回数・次回受診（または日数）を入れると本数の目安を計算します。</span>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      <button className="btn btn-ghost" onClick={() => update(["prescriptions"], [...rows, { kind: "eye_drop", name: "", presetId: "", eye: "ou", timesPerDay: null, quantity: null, unit: "", days: null, note: "" }])} type="button">処方を追加</button>
    </div>
  );
}

function NextVisit({ content, encounterDate, suggestion, update, editable }) {
  const weeks = content.nextVisit.intervalWeeks;
  const nextDate = weeks ? addDays(encounterDate, Math.round(weeks * 7)) : "";
  return (
    <div>
      <div className="row-line">
        <label className="inline-field">
          <input aria-label="次回まで（週）" className="input input-num" min="0" onChange={(event) => update(["nextVisit", "intervalWeeks"], parseNumber(event.target.value))} type="number" value={weeks ?? ""} />
          <span>週後</span>
        </label>
        {nextDate ? <span className="muted">目安 {formatDate(nextDate)}</span> : null}
        <input aria-label="次回のメモ" className="input grow" onChange={(event) => update(["nextVisit", "note"], event.target.value)} placeholder="メモ（例: 視野検査予定）" value={content.nextVisit.note} />
      </div>
      {editable && suggestion && suggestion.intervalWeeks !== weeks && !(suggestion.basis === "default" && weeks) ? (
        <div className="suggestion">
          <span>候補 <strong>{suggestion.intervalWeeks}週後</strong> <span className="muted small">{suggestion.explanation}</span></span>
          <button className="btn btn-chip" onClick={() => update(["nextVisit", "intervalWeeks"], suggestion.intervalWeeks)} type="button">採用</button>
        </div>
      ) : null}
    </div>
  );
}

function ComparePanel({ changes, previous }) {
  if (!previous) {
    return (
      <section className="panel">
        <h2>前回との比較</h2>
        <p className="empty">確定済みの前回カルテはありません。</p>
      </section>
    );
  }
  const exam = previous.content.exam;
  return (
    <section className="panel">
      <h2>前回との比較</h2>
      <p className="muted small">前回 {formatDate(previous.encounterDate)}（v{previous.versionCount}）</p>
      <h3>今回変わった所</h3>
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
      <h3>前回の記録</h3>
      <dl className="prev-list">
        <dt>視力</dt>
        <dd>R {exam.od.vaCorrected || exam.od.vaUncorrected || "—"} / L {exam.os.vaCorrected || exam.os.vaUncorrected || "—"}</dd>
        <dt>眼圧</dt>
        <dd>R {exam.od.iop ?? "—"} / L {exam.os.iop ?? "—"}</dd>
        <dt>病名</dt>
        <dd>{previous.content.diagnoses.map(diagnosisText).join("、") || "—"}</dd>
        <dt>処方</dt>
        <dd>{previous.content.prescriptions.map(prescriptionText).join("、") || "—"}</dd>
        <dt>方針</dt>
        <dd>{previous.content.plan || "—"}</dd>
      </dl>
      <a className="small" href={`/encounters/${previous.encounterId}`}>前回カルテを開く</a>
    </section>
  );
}

function VersionsPanel({ encounterId, versions }) {
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

function SaveIndicator({ state, onRetry }) {
  if (state === "saving") return <span className="save-state">保存中…</span>;
  if (state === "dirty") return <span className="save-state">未保存の変更</span>;
  if (state === "error") return <button className="btn btn-chip danger-text" onClick={onRetry} type="button">保存に失敗・再試行</button>;
  return <span className="save-state is-saved">保存済み</span>;
}

function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, danger = false }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" role="presentation">
      <div aria-labelledby="confirm-heading" className="dialog" role="dialog">
        <h2 id="confirm-heading">{title}</h2>
        {children}
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">キャンセル</button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }} type="button">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function AmendDialog({ onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog confirmLabel="修正を始める" onCancel={onCancel} onConfirm={() => (reason.trim() ? onConfirm(reason.trim()) : null)} title="確定済みのカルテを修正">
      <p>修正内容は新しい版として保存され、元の版も残ります。</p>
      <label className="field">
        <span>修正理由 <em>必須</em></span>
        <textarea autoFocus className="input" onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
      </label>
    </ConfirmDialog>
  );
}

function parseNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getIn(object, path) {
  return path.reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

function setIn(object, path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (Array.isArray(object)) {
    const copy = [...object];
    copy[head] = setIn(object[head], rest, value);
    return copy;
  }
  return { ...object, [head]: setIn(object?.[head], rest, value) };
}
