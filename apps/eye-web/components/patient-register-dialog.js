"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeKanaName } from "@halunasu/eye-contracts";
import { AppointmentDialog } from "./appointment-dialog";
import { useEyeApi } from "./eye-api";
import { Modal, useChangedSince } from "./modal";
import { ageOn, patientBirthLine, todayIso } from "../lib/format";
import { birthDateLabel, birthDateShort, parseBirthDateInput } from "../lib/birth-date";
import { autoKana, createKanaCapture, kanaCaptureStep, readingOf } from "../lib/kana-capture";

const SEX_OPTIONS = [["male", "男性"], ["female", "女性"], ["other", "その他"]];
export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"
];
// 住所・電話は platform の contact（形は自由）に次の名前で入れる
const CONTACT_KEYS = ["postalCode", "prefecture", "address1", "address2", "address3", "phone1", "phone2"];
// 受付一覧に「受付が増えた」ことを知らせる（ヘッダーから登録して受付したとき）
export const RECEPTION_CHANGED_EVENT = "halunasu-eye-reception-changed";

// 患者情報の登録・編集（デジカルの患者情報登録ダイアログ）。項目は 患者番号 → 氏名 → カナ → 性別 → 生年月日 → 住所 → 電話 の順。
// - 新規: ［キャンセル］［登録］［登録して受付］。［登録して受付］は登録のあと受付登録（当日受付）へ続ける。
// - 編集（patient を渡す）: ［キャンセル］［更新］。
// - 受付に紐づける用途（submitLabel を渡す）: ［キャンセル］［submitLabel］。
// onCreated(patient) は登録後の処理（患者のページを開く、受付に紐づける など）。
// 失敗したときは作った患者を覚えておき、もう一度押すと onCreated だけをやり直す（患者を二重に作らない）。
// onPickExisting(patient) を渡すと、似た患者の行に「この患者で…」のボタンを出す。
export function PatientRegisterDialog({
  title,
  initial = {},
  patient: editing = null,
  submitLabel = "",
  onCancel,
  onCreated,
  onUpdated,
  onReceived,
  onPickExisting,
  pickExistingLabel = "この患者を開く"
}) {
  const api = useEyeApi();
  const router = useRouter();
  const source = editing || initial;
  const [draft, setDraft] = useState({
    primaryPatientNumber: source.primaryPatientNumber || "",
    displayName: source.displayName || "",
    displayNameKana: source.displayNameKana ? normalizeKanaName(source.displayNameKana) : "",
    sex: source.sex || "unknown",
    birthDate: source.birthDate || "",
    ...Object.fromEntries(CONTACT_KEYS.map((key) => [key, String(editing?.contact?.[key] || "")]))
  });
  const [created, setCreated] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [numberError, setNumberError] = useState("");
  // 性別の「未入力」は、性別を触ったか登録を押したあとだけ出す（開いた直後から警告を出さない）
  const [sexTouched, setSexTouched] = useState(false);
  const firstFieldRef = useRef(null);
  const intentRef = useRef("register");
  // 生年月日は和暦でも西暦でも打てる欄（S50.1.1・昭和50年1月1日・19750101 など）。カレンダーでも選べる。
  const [birthText, setBirthText] = useState(() => birthDateShort(source.birthDate));
  const [birthTouched, setBirthTouched] = useState(false);
  const [birthCalendar, setBirthCalendar] = useState(false);
  const birthCalendarRef = useRef(null);
  // 氏名を日本語入力で打ったときの読み（変換前のひらがな）をフリガナに入れる。フリガナを手で直したら止める。
  const kanaCapture = useRef(createKanaCapture());
  const autoKanaRef = useRef("");
  const kanaRef = useRef(draft.displayNameKana);
  kanaRef.current = draft.displayNameKana;
  const linking = Boolean(submitLabel);
  const heading = title || (editing ? "患者情報の編集" : "新規患者を登録");

  // 開いたら最初の欄へ・閉じたら元の場所へ・Esc と背景で閉じる、は Modal が受け持つ。
  // 入力を変えていれば（登録前なら）閉じる前に確かめる。
  const changed = useChangedSince({ draft, birthText });
  const dirty = changed && !created;

  // 似た患者（同じフリガナ・氏名・患者番号）を既存の検索で探す。登録は止めず、押す前に目に入るようにする。
  const nameQuery = (draft.displayNameKana || draft.displayName).trim();
  const numberQuery = draft.primaryPatientNumber.trim();
  useEffect(() => {
    if (editing || created || (nameQuery.length < 2 && !numberQuery)) {
      setSimilar([]);
      return undefined;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const queries = [nameQuery.length >= 2 ? nameQuery : "", numberQuery].filter(Boolean);
        const results = await Promise.all(queries.map((q) => api("/v1/eye/patients/search", { method: "POST", body: { q } })));
        if (cancelled) return;
        const byId = new Map();
        for (const patient of results.flatMap((payload) => payload.patients)) byId.set(patient.patientId, patient);
        setSimilar([...byId.values()].slice(0, 4));
      } catch {
        if (!cancelled) setSimilar([]);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [api, created, editing, nameQuery, numberQuery]);

  const sameBirth = similar.some((patient) => draft.birthDate && patient.birthDate === draft.birthDate);
  const age = draft.birthDate ? ageOn(draft.birthDate) : null;
  const birthError = parseBirthDateInput(birthText, { today: todayIso() }).error;

  function changeBirthText(value) {
    setBirthText(value);
    const { iso } = parseBirthDateInput(value, { today: todayIso() });
    setDraft((current) => ({ ...current, birthDate: iso }));
  }

  function pickBirthDate(value) {
    setBirthText(birthDateShort(value));
    setBirthTouched(true);
    setDraft((current) => ({ ...current, birthDate: value }));
  }

  useEffect(() => {
    if (birthCalendar) birthCalendarRef.current?.focus();
  }, [birthCalendar]);

  // 氏名の値から読みを出し直し、フリガナが空か前に自動で入れた値のままなら入れ替える
  function syncKana(name) {
    const result = autoKana({ kana: kanaRef.current, auto: autoKanaRef.current, reading: readingOf(kanaCapture.current, name) });
    if (!result) return;
    autoKanaRef.current = result.auto;
    kanaRef.current = result.kana;
    setDraft((current) => ({ ...current, displayNameKana: result.kana }));
  }
  const nameEvents = {
    onCompositionStart: () => { kanaCapture.current = kanaCaptureStep(kanaCapture.current, { type: "start" }); },
    onCompositionUpdate: (event) => { kanaCapture.current = kanaCaptureStep(kanaCapture.current, { type: "update", data: event.data }); },
    onCompositionEnd: (event) => {
      kanaCapture.current = kanaCaptureStep(kanaCapture.current, { type: "end", data: event.data });
      syncKana(event.currentTarget.value);
    },
    onChange: (event) => {
      const value = event.target.value;
      setDraft((current) => ({ ...current, displayName: value }));
      // 変換中は確定（compositionend）を待つ
      if (!event.nativeEvent?.isComposing && !kanaCapture.current.composing) syncKana(value);
    }
  };

  function body() {
    const contact = { ...(editing?.contact || {}) };
    for (const key of CONTACT_KEYS) {
      const value = draft[key].trim();
      if (value) contact[key] = key === "postalCode" ? value.replace(/[^0-9]/gu, "") : value;
      else delete contact[key];
    }
    return {
      displayName: draft.displayName.trim(),
      displayNameKana: normalizeKanaName(draft.displayNameKana),
      birthDate: draft.birthDate,
      sex: draft.sex,
      primaryPatientNumber: draft.primaryPatientNumber.trim(),
      contact
    };
  }

  async function submit(event) {
    event.preventDefault();
    const intent = event.nativeEvent?.submitter?.dataset?.intent || intentRef.current;
    setSexTouched(true);
    setBusy(true);
    setError("");
    setNumberError("");
    if (editing) {
      try {
        const payload = await api(`/v1/eye/patients/${editing.patientId}`, { method: "PATCH", body: body() });
        await onUpdated?.(payload.patient);
      } catch (nextError) {
        if (nextError.status === 409 && /identifier|patientNumber|primaryPatientNumber/u.test(`${nextError.field}`)) setNumberError("この患者番号はすでに使われています。");
        else setError(nextError.message);
        setBusy(false);
      }
      return;
    }
    let patient = created;
    try {
      if (!patient) {
        patient = (await api("/v1/eye/patients", { method: "POST", body: body() })).patient;
        setCreated(patient);
      }
      if (intent === "receive") {
        setReceiving(patient);
        setBusy(false);
        return;
      }
      await onCreated(patient);
    } catch (nextError) {
      if (!patient && nextError.status === 409 && /identifier|patientNumber|primaryPatientNumber/u.test(`${nextError.field}`)) {
        setNumberError("この患者番号はすでに使われています。");
      } else if (patient) {
        setError(`患者「${patient.displayName}」は登録済みです。続きの処理に失敗しました: ${nextError.message} もう一度押すと続きだけをやり直します。`);
      } else {
        setError(nextError.message);
      }
      setBusy(false);
    }
  }

  async function received(appointment) {
    const patient = receiving;
    setReceiving(null);
    if (onReceived) {
      await onReceived(patient, appointment);
      return;
    }
    window.dispatchEvent(new CustomEvent(RECEPTION_CHANGED_EVENT));
    onCancel();
    router.push("/reception");
  }

  async function pick(patient) {
    setBusy(true);
    setError("");
    try {
      await onPickExisting(patient);
    } catch (nextError) {
      setError(nextError.message);
      setBusy(false);
    }
  }

  if (receiving) {
    return (
      <AppointmentDialog
        fixedPatient={receiving}
        initial={{ date: todayIso(), walkIn: true, purpose: "initial", time: "" }}
        onCancel={() => { setReceiving(null); onCancel(); }}
        onSaved={received}
        title="受付登録"
      />
    );
  }

  const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value });
  const locked = Boolean(created);
  const kanaMissing = !draft.displayNameKana.trim();
  const blocked = busy || !draft.displayName.trim() || kanaMissing || Boolean(birthError);
  const primaryLabel = busy ? "登録中…" : editing ? "更新" : created ? "続きをやり直す" : linking ? submitLabel : sameBirth ? "別人として登録" : "登録";
  return (
    <Modal as="form" busy={busy} className={`dialog register-dialog${similar.length && !created ? " has-side" : ""}`} dirty={dirty} initialFocus={firstFieldRef} labelledBy="register-heading" onClose={onCancel} onSubmit={submit}>
      <h2 id="register-heading">{heading}</h2>
      <div className="register-body">
        <div className="register-form">
          <div className="register-row">
            <label htmlFor="reg-number">患者番号</label>
            <div>
              <input
                autoCapitalize="characters"
                autoComplete="off"
                className="input"
                disabled={locked}
                id="reg-number"
                onChange={(event) => { setDraft({ ...draft, primaryPatientNumber: event.target.value }); setNumberError(""); }}
                placeholder="レセコンの患者番号"
                ref={firstFieldRef}
                value={draft.primaryPatientNumber}
              />
              {numberError ? <small className="register-error" role="alert">{numberError}</small> : <small className="muted">レセコンの番号と同じにします。空欄なら後で入力できます。</small>}
            </div>
          </div>
          <div className="register-row">
            <label htmlFor="reg-name">氏名 <em>必須</em></label>
            <div>
              <input autoComplete="off" className="input" disabled={locked} id="reg-name" required value={draft.displayName} {...nameEvents} />
              <small className="muted">日本語入力で打つと、フリガナに読みが入ります。</small>
            </div>
          </div>
          <div className="register-row">
            <label htmlFor="reg-kana">フリガナ <em>必須</em></label>
            <div>
              <input
                autoComplete="off"
                className="input"
                disabled={locked}
                id="reg-kana"
                onBlur={() => setDraft((current) => ({ ...current, displayNameKana: normalizeKanaName(current.displayNameKana) }))}
                onChange={set("displayNameKana")}
                placeholder="ミホン ハナコ"
                required
                value={draft.displayNameKana}
              />
              <small className="muted">ひらがなで入れてもカタカナにそろえます。違うときは直してください。</small>
            </div>
          </div>
          <div className="register-row">
            <span id="reg-sex-label">性別</span>
            <div>
              <div className="segmented" role="radiogroup" aria-labelledby="reg-sex-label">
                {SEX_OPTIONS.map(([value, label]) => (
                  <button aria-checked={draft.sex === value} className="segmented-option" disabled={locked} key={value} onClick={() => { setSexTouched(true); setDraft({ ...draft, sex: draft.sex === value ? "unknown" : value }); }} role="radio" type="button">{label}</button>
                ))}
              </div>
              {draft.sex === "unknown" && sexTouched ? <small className="register-warn">未入力です（レセコン連携で必要です）</small> : null}
            </div>
          </div>
          <div className="register-row">
            <label htmlFor="reg-birth">生年月日</label>
            <div>
              <div className="register-birth">
                <input
                  aria-describedby="reg-birth-check"
                  aria-invalid={birthTouched && birthError ? true : undefined}
                  autoComplete="off"
                  className="input"
                  disabled={locked}
                  id="reg-birth"
                  onBlur={() => setBirthTouched(true)}
                  onChange={(event) => changeBirthText(event.target.value)}
                  placeholder="S50.1.1 / 19750101"
                  value={birthText}
                />
                <button aria-controls="reg-birth-calendar" aria-expanded={birthCalendar} className="btn btn-ghost btn-sm" disabled={locked} onClick={() => setBirthCalendar(!birthCalendar)} type="button">カレンダー</button>
                {birthCalendar ? (
                  <input
                    aria-label="カレンダーで生年月日を選ぶ"
                    className="input"
                    disabled={locked}
                    id="reg-birth-calendar"
                    max={todayIso()}
                    min="1868-01-25"
                    onChange={(event) => pickBirthDate(event.target.value)}
                    ref={birthCalendarRef}
                    type="date"
                    value={draft.birthDate}
                  />
                ) : null}
              </div>
              {birthTouched && birthError ? (
                <small className="register-error" id="reg-birth-check" role="alert">{birthError}</small>
              ) : (
                <small className="muted register-birth-check" id="reg-birth-check" aria-live="polite">
                  {draft.birthDate ? `${birthDateLabel(draft.birthDate)}${age !== null && age >= 0 ? ` ・ ${age}歳` : ""}` : "和暦（S50.1.1・昭和50年1月1日）でも西暦（19750101）でも入れられます。"}
                </small>
              )}
            </div>
          </div>
          {/* 住所・電話は患者のもの。ブラウザが端末の持ち主（職員）の住所・電話を自動入力しないよう、autocomplete は off にし、住所らしい name も付けない */}
          <fieldset className="register-row register-address" disabled={locked}>
            <legend>住所</legend>
            <div className="register-address-fields">
              <input aria-label="郵便番号" autoComplete="off" className="input" name="reg-patient-c1" inputMode="numeric" maxLength={8} onChange={set("postalCode")} placeholder="郵便番号" title="郵便番号（ハイフンなしでも入力できます）" value={draft.postalCode} />
              <select aria-label="都道府県" autoComplete="off" className="input" name="reg-patient-c2" onChange={set("prefecture")} value={draft.prefecture}>
                <option value="">都道府県</option>
                {PREFECTURES.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <input aria-label="市区町村" autoComplete="off" className="input" name="reg-patient-c3" onChange={set("address1")} placeholder="市区町村" value={draft.address1} />
              <input aria-label="番地" autoComplete="off" className="input" name="reg-patient-c4" onChange={set("address2")} placeholder="番地" value={draft.address2} />
              <input aria-label="建物" autoComplete="off" className="input" name="reg-patient-c5" onChange={set("address3")} placeholder="建物名・部屋番号" value={draft.address3} />
            </div>
          </fieldset>
          <div className="register-row">
            <label htmlFor="reg-phone1">電話番号1</label>
            <input autoComplete="off" className="input" disabled={locked} id="reg-phone1" name="reg-patient-c6" inputMode="tel" onChange={set("phone1")} value={draft.phone1} />
          </div>
          <div className="register-row">
            <label htmlFor="reg-phone2">電話番号2</label>
            <input autoComplete="off" className="input" disabled={locked} id="reg-phone2" name="reg-patient-c7" inputMode="tel" onChange={set("phone2")} value={draft.phone2} />
          </div>
          <p className="muted small register-note">保険証・資格確認はレセコンで登録します。</p>
        </div>

        {similar.length && !created ? (
          <aside className={`register-similar${sameBirth ? " is-strong" : ""}`} role="status">
            <p><strong>{sameBirth ? "同じ生年月日の似た患者がいます" : "似た患者がいます"}</strong>　同じ人なら新しく登録しないでください。</p>
            <ul>
              {similar.map((patient) => (
                <li key={patient.patientId}>
                  <span className="mono">{patient.primaryPatientNumber || "番号なし"}</span>
                  <strong>{patient.displayName}</strong>
                  <span className="muted">{patient.displayNameKana}</span>
                  <span className={draft.birthDate && patient.birthDate === draft.birthDate ? "register-same" : "muted"}>{patientBirthLine(patient)}</span>
                  {onPickExisting ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => pick(patient)} type="button">{pickExistingLabel}</button> : null}
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
      </div>

      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel} type="button">キャンセル</button>
        <button className={`btn ${editing || linking ? "btn-primary" : "btn-outline"}`} data-intent="register" disabled={blocked} onClick={() => { intentRef.current = "register"; }} type="submit">
          {primaryLabel}
        </button>
        {editing || linking ? null : (
          <button className="btn btn-primary" data-intent="receive" disabled={blocked} onClick={() => { intentRef.current = "receive"; }} type="submit">
            {created ? "受付へ進む" : "登録して受付"}
          </button>
        )}
      </div>
    </Modal>
  );
}

// 受付の予約・当日受付に患者を紐づける。最新の版で更新し、すでに同じ患者なら何もしない。
export async function linkAppointmentToPatient(api, appointment, patient) {
  if (appointment.patientId === patient.patientId) return;
  await api(`/v1/eye/appointments/${appointment.appointmentId}`, {
    method: "PATCH",
    body: { expectedRevision: appointment.revision, patientId: patient.patientId }
  });
}
