"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEyeApi } from "./eye-api";
import { byNewest, FILE_KIND_LABELS, FilePreview, isImageFile, shortDate, ThumbImage, UploadDialog, useFileUrls } from "./files-panel";
import { PatientBanner } from "./patient-banner";
import { EYE_LABELS, formatDate } from "../lib/format";
import { filesOnDate, followupColumns, followupDates, prefersFollowup, resolveFollowupDates } from "../lib/image-followup";

const COMPARE_KINDS = Object.keys(FILE_KIND_LABELS).filter((kind) => kind !== "paper_chart" && kind !== "face_photo");
const EYE_FILTERS = [["", "すべて"], ["od", "右眼"], ["os", "左眼"]];
const PANES = [
  { key: "left", mark: "1", label: "左の面" },
  { key: "right", mark: "2", label: "右の面" }
];
const THUMB_LIMIT = 24;
const SERIES_LIMIT = 6;
// 表示モード（IMAGEnet の経過・比較・OU・トレンドの表示に倣う）
const FOLLOWUP_ROWS = [
  { key: "followup", label: "経過", note: "今回" },
  { key: "baseline", label: "基準", note: "ベースライン" }
];
const MODES = [
  { key: "followup", label: "経過", title: "今回（上段）と基準の日（下段）を上下に並べ、その日の画像を種類ごとに横に並べる" },
  { key: "compare", label: "比較", title: "同じ眼の 2 つの日付を左右に並べる" },
  { key: "ou", label: "OU", title: "同じ日の右眼と左眼を並べる" },
  { key: "series", label: "時系列", title: "同じ眼・同じ種類を古い順に横に並べる" }
];

// 画像の比較。時系列のサムネイル列から選び、左右に日付の違う検査を並べる（判定はしない）。
// 既定は ②=最新、①=その 1 つ前。選択中の面だけを ‹ › で前後に送る。
export function ImageCompare({ patientId }) {
  const api = useEyeApi();
  const [patient, setPatient] = useState(null);
  const [profile, setProfile] = useState(null);
  const [context, setContext] = useState(null);
  const [files, setFiles] = useState(null);
  const [kind, setKind] = useState("");
  const [eye, setEye] = useState("");
  const [selection, setSelection] = useState({ left: "", right: "" });
  const [activePane, setActivePane] = useState("right");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("compare");
  const [ouDate, setOuDate] = useState("");
  // 経過: 選んだ日付（"" は既定）と、基準の既定（前回 / 初回）
  const [followPick, setFollowPick] = useState({ followup: "", baseline: "" });
  const [baselineRule, setBaselineRule] = useState("previous");
  const modeChosen = useRef(false);

  const loadFiles = useCallback(async () => {
    const payload = await api(`/v1/eye/patients/${patientId}/files`);
    setFiles(payload.files);
    return payload.files;
  }, [api, patientId]);

  useEffect(() => {
    Promise.all([
      api(`/v1/eye/patients/${patientId}`),
      api(`/v1/eye/patients/${patientId}/profile`).catch(() => ({ profile: null })),
      api("/v1/eye/context").catch(() => ({ context: null })),
      loadFiles()
    ])
      .then(([patientPayload, profilePayload, contextPayload]) => {
        setPatient(patientPayload.patient);
        setProfile(profilePayload.profile);
        setContext(contextPayload.context);
      })
      .catch((nextError) => setError(nextError.message));
  }, [api, patientId, loadFiles]);

  const comparable = useMemo(() => (files || []).filter((item) => COMPARE_KINDS.includes(item.kind)), [files]);
  const kindCounts = useMemo(() => {
    const counts = new Map();
    for (const item of comparable) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
    return COMPARE_KINDS.filter((value) => counts.get(value)).map((value) => [value, counts.get(value)]);
  }, [comparable]);

  // 種類が未選択（または 0 件になった）なら、最新ファイルの種類と眼を初期値にする
  useEffect(() => {
    if (kindCounts.length === 0) return;
    if (kind && kindCounts.some(([value]) => value === kind)) return;
    const sorted = [...comparable].sort(byNewest);
    // 比べられる（2 件以上ある）種類を優先する
    const newest = sorted.find((item) => (kindCounts.find(([value]) => value === item.kind)?.[1] || 0) >= 2) || sorted[0];
    setKind(newest.kind);
    setEye(newest.eye === "od" || newest.eye === "os" ? newest.eye : "");
  }, [comparable, kind, kindCounts]);

  // 画像のある受診日が 2 日以上あれば、最初は「経過」で開く（モードを選んだ後は変えない）
  useEffect(() => {
    if (files === null || modeChosen.current) return;
    modeChosen.current = true;
    if (!prefersFollowup(comparable)) return;
    setMode("followup");
    // 経過の既定の眼は、いちばん新しい画像の眼
    const newest = [...comparable].sort(byNewest)[0];
    setEye(newest && (newest.eye === "od" || newest.eye === "os") ? newest.eye : "");
  }, [comparable, files]);

  function chooseMode(value) {
    modeChosen.current = true;
    setMode(value);
  }

  function chooseKind(value) {
    setKind(value);
    const newest = comparable.filter((item) => item.kind === value).sort(byNewest)[0];
    setEye(newest && (newest.eye === "od" || newest.eye === "os") ? newest.eye : "");
  }

  // 古い → 新しい の順
  const candidates = useMemo(() => comparable
    .filter((item) => item.kind === kind && (!eye || item.eye === eye || item.eye === "ou"))
    .sort((left, right) => byNewest(right, left)), [comparable, kind, eye]);
  const candidateKey = candidates.map((item) => item.fileId).join(",");

  useEffect(() => {
    setSelection({ left: candidates.at(-2)?.fileId || "", right: candidates.at(-1)?.fileId || "" });
    setActivePane("right");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  const stripFiles = candidates.slice(-THUMB_LIMIT);
  // OU: この種類で右眼・左眼のそろう日付（古い → 新しい）。片眼だけの日も選べる。
  const ouDates = useMemo(() => {
    const byDate = new Map();
    for (const item of comparable.filter((file) => file.kind === kind)) {
      const entry = byDate.get(item.takenOn) || {};
      for (const side of item.eye === "ou" ? ["od", "os"] : [item.eye]) {
        if ((side === "od" || side === "os") && (!entry[side] || byNewest(item, entry[side]) < 0)) entry[side] = item;
      }
      byDate.set(item.takenOn, entry);
    }
    return [...byDate.entries()].filter(([, entry]) => entry.od || entry.os).sort(([left], [right]) => String(left).localeCompare(String(right)));
  }, [comparable, kind]);
  const ouIndex = (() => {
    const index = ouDates.findIndex(([value]) => value === ouDate);
    if (index >= 0) return index;
    const both = ouDates.map(([, entry], position) => (entry.od && entry.os ? position : -1)).filter((position) => position >= 0);
    return both.length ? both.at(-1) : ouDates.length - 1;
  })();
  const ouEntry = ouIndex >= 0 ? ouDates[ouIndex][1] : null;
  const seriesFiles = candidates.slice(-SERIES_LIMIT);
  // 経過: 眼の絞り込みに合う画像のある受診日。上段＝経過（既定は最新）、下段＝基準（既定は前回 / 初回）。
  const visitDates = useMemo(() => followupDates(comparable, eye), [comparable, eye]);
  const followDates = resolveFollowupDates(visitDates, { ...followPick, rule: baselineRule });
  const followRows = {
    followup: filesOnDate(comparable, followDates.followup, eye),
    baseline: filesOnDate(comparable, followDates.baseline, eye)
  };
  const followColumns = followupColumns(followRows.followup, followRows.baseline);
  const shownIds = mode === "followup" ? [...followRows.followup, ...followRows.baseline].map((item) => item.fileId)
    : mode === "ou" ? [ouEntry?.od?.fileId, ouEntry?.os?.fileId] : mode === "series" ? seriesFiles.map((item) => item.fileId) : [selection.left, selection.right];
  const { urls, failed } = useFileUrls([
    ...(mode === "compare" ? stripFiles.filter(isImageFile).map((item) => item.fileId) : []),
    ...shownIds
  ]);

  const indexOf = (fileId) => candidates.findIndex((item) => item.fileId === fileId);
  const step = useCallback((pane, delta) => {
    setSelection((current) => {
      const index = candidates.findIndex((item) => item.fileId === current[pane]);
      const nextIndex = index < 0 ? (delta < 0 ? candidates.length - 1 : 0) : index + delta;
      if (nextIndex < 0 || nextIndex >= candidates.length) return current;
      return { ...current, [pane]: candidates[nextIndex].fileId };
    });
  }, [candidates]);

  // ← → で選択中の面を送る（入力欄にいるときと変換中は無視）
  useEffect(() => {
    const onKey = (event) => {
      if (event.isComposing || uploading || event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, select, textarea, [contenteditable='true']")) return;
      if (mode !== "compare") return;
      if (event.key === "ArrowLeft") { event.preventDefault(); step(activePane, -1); }
      if (event.key === "ArrowRight") { event.preventDefault(); step(activePane, 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePane, mode, step, uploading]);

  // 比較・OU の面の画像の高さに使うため、画像の上端（ページの先頭から）を --cmp-preview-top に入れる。
  // 一番上までスクロールした状態で、面の下端が画面に収まる高さにする（patient.css の .cmp-pane .file-preview）。
  const pageRef = useRef(null);
  useEffect(() => {
    const page = pageRef.current;
    if (!page || typeof ResizeObserver === "undefined") return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 面ごとに見出しの段数が違う（題名の行がない面もある）ので、一番下にある画像の上端を使う
        const previews = [...page.querySelectorAll(".cmp-grid .file-preview")];
        if (!previews.length) return;
        const top = Math.round(Math.max(...previews.map((preview) => preview.getBoundingClientRect().top)) + window.scrollY);
        if (page.style.getPropertyValue("--cmp-preview-top") !== `${top}px`) page.style.setProperty("--cmp-preview-top", `${top}px`);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const byId = new Map(candidates.map((item) => [item.fileId, item]));
  const canUpload = Boolean(context?.canWriteDocuments);
  const uploadButton = canUpload ? <button className="btn btn-ghost" onClick={() => setUploading(true)} type="button">＋取り込む</button> : null;

  return (
    <main className="eye-page cmp-page" ref={pageRef}>
      {patient ? (
        <div className="encounter-bar is-static">
          <PatientBanner
            actions={uploadButton}
            compact
            context={context}
            leading={<Link className="back-link" href={`/patients/${patientId}`}>← 患者ページ</Link>}
            onProfileSaved={setProfile}
            patient={patient}
            profile={profile}
          />
        </div>
      ) : (
        <Link className="back-link" href={`/patients/${patientId}`}>← 患者ページ</Link>
      )}
      <div className="cmp-head">
        <h2>画像の比較</h2>
        {kindCounts.length ? (
          <div aria-label="表示モード" className="segmented cmp-modes" role="group">
            {MODES.map((item) => (
              <button aria-pressed={mode === item.key} key={item.key} onClick={() => chooseMode(item.key)} title={item.title} type="button">{item.label}</button>
            ))}
          </div>
        ) : null}
        {kindCounts.length && mode !== "followup" ? (
          <div aria-label="種類" className="cmp-chips" role="group">
            {kindCounts.map(([value, count]) => (
              <button aria-pressed={kind === value} className="flow-chip cmp-chip" key={value} onClick={() => chooseKind(value)} type="button">
                {FILE_KIND_LABELS[value]}<strong>{count}</strong>
              </button>
            ))}
          </div>
        ) : null}
        {kindCounts.length && mode !== "ou" ? (
          <div aria-label="眼" className="cmp-eyes" role="group">
            {EYE_FILTERS.map(([value, label]) => (
              <button aria-pressed={eye === value} className="btn btn-chip btn-sm" key={value || "all"} onClick={() => setEye(value)} type="button">{label}</button>
            ))}
          </div>
        ) : null}
      </div>
      {error ? <p className="alert alert-danger" role="alert">{error}</p> : null}
      {files === null && !error ? <p className="loading">読み込み中…</p> : null}
      {files !== null && kindCounts.length === 0 ? (
        <div className="cmp-empty">
          <p className="empty">この患者の画像はまだありません。</p>
          {uploadButton}
        </div>
      ) : null}
      {mode === "followup" && kindCounts.length ? (
        visitDates.length ? (
          <div className="cmp-followup" style={{ "--fu-cols": Math.max(1, followColumns.length) }}>
            {FOLLOWUP_ROWS.map((row) => {
              const date = followDates[row.key];
              const index = visitDates.indexOf(date);
              const rowFiles = followRows[row.key];
              const pick = (value) => setFollowPick((current) => ({ ...current, [row.key]: value }));
              return (
                <section aria-label={`${row.label}（${row.note}）`} className="cmp-followup-row" data-role={row.key} key={row.key}>
                  <div className="cmp-fu-head">
                    <span className={`cmp-fu-label is-${row.key}`}>{row.label}</span>
                    <span className="cmp-fu-dates">
                      <button aria-label={`${row.label}の日付を前へ`} className="btn btn-chip btn-sm" disabled={index <= 0} onClick={() => pick(visitDates[index - 1])} type="button">‹</button>
                      <select aria-label={`${row.label}の日付`} className="input input-compact cmp-fu-select" onChange={(event) => pick(event.target.value)} value={date}>
                        {!date ? <option value="">—</option> : null}
                        {[...visitDates].reverse().map((value) => <option key={value} value={value}>{formatDate(value)}</option>)}
                      </select>
                      <button aria-label={`${row.label}の日付を次へ`} className="btn btn-chip btn-sm" disabled={index < 0 || index >= visitDates.length - 1} onClick={() => pick(visitDates[index + 1])} type="button">›</button>
                    </span>
                    <span className="cmp-fu-meta muted small">{row.note}{rowFiles.length ? ` ・ ${rowFiles.length}件` : ""}</span>
                    {row.key === "baseline" ? (
                      <span aria-label="基準の日の既定" className="segmented cmp-fu-rule" role="group">
                        {[["previous", "前回"], ["first", "初回"]].map(([value, label]) => (
                          <button aria-pressed={baselineRule === value && !followPick.baseline} key={value} onClick={() => { setBaselineRule(value); pick(""); }} type="button">{label}</button>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  {date ? (
                    <div className="cmp-fu-cells">
                      {followColumns.map((kind) => {
                        const cellFiles = rowFiles.filter((item) => item.kind === kind);
                        return (
                          <div className="cmp-fu-cell" key={kind}>
                            <div className="cmp-fu-cell-head">{FILE_KIND_LABELS[kind]}</div>
                            {cellFiles.length ? (
                              <div className="cmp-fu-files">
                                {cellFiles.map((item) => (
                                  <figure className="cmp-fu-file" key={item.fileId}>
                                    <FilePreview failed={Boolean(failed[item.fileId])} file={item} url={urls[item.fileId]} />
                                    <figcaption title={item.title}>
                                      {item.eye ? <span className={`cmp-fu-eye eye-${item.eye}`}>{EYE_LABELS[item.eye]}</span> : null}
                                      {item.title !== FILE_KIND_LABELS[item.kind] ? <span>{item.title}</span> : null}
                                    </figcaption>
                                  </figure>
                                ))}
                              </div>
                            ) : <div className="file-preview is-empty">その日はありません</div>}
                          </div>
                        );
                      })}
                    </div>
                  ) : <p className="empty">画像のある日がもう 1 日ありません。上段と同じ日を選ぶか、画像を取り込んでください。</p>}
                </section>
              );
            })}
          </div>
        ) : <p className="empty">この眼の画像はありません。眼を「すべて」にすると表示されます。</p>
      ) : null}
      {(mode === "compare" || mode === "series") && kindCounts.length > 0 && candidates.length === 0 ? <p className="empty">この条件の画像はありません。眼を「すべて」にすると表示されます。</p> : null}
      {mode === "ou" && kindCounts.length ? (
        ouEntry ? (
          <>
            <div className="cmp-ou-head">
              <button aria-label="前の日付へ" className="btn btn-chip btn-sm" disabled={ouIndex <= 0} onClick={() => setOuDate(ouDates[ouIndex - 1][0])} type="button">‹</button>
              <strong className="cmp-ou-date">{formatDate(ouDates[ouIndex][0])}</strong>
              <button aria-label="次の日付へ" className="btn btn-chip btn-sm" disabled={ouIndex >= ouDates.length - 1} onClick={() => setOuDate(ouDates[ouIndex + 1][0])} type="button">›</button>
              <span className="muted small">{ouIndex + 1}/{ouDates.length} 日</span>
            </div>
            <div className="compare-grid cmp-grid">
              {[["od", "右眼"], ["os", "左眼"]].map(([side, label]) => {
                const file = ouEntry[side];
                return (
                  <section aria-label={label} className="cmp-pane" key={side}>
                    <div className="cmp-pane-head">
                      <span className="cmp-pane-select is-static">
                        <span className={`cmp-pane-mark eye-${side}`}>{side === "od" ? "R" : "L"}</span>
                        <span className="cmp-pane-rel">{label}</span>
                        {file ? <span className="cmp-pane-meta">{FILE_KIND_LABELS[file.kind]}</span> : null}
                      </span>
                    </div>
                    {file ? <FilePreview failed={Boolean(failed[file.fileId])} file={file} url={urls[file.fileId]} /> : <div className="file-preview is-empty">この日の{label}の画像はありません</div>}
                  </section>
                );
              })}
            </div>
          </>
        ) : <p className="empty">この種類の画像はありません。</p>
      ) : null}
      {mode === "series" && candidates.length > 0 ? (
        <>
          <ol aria-label="時系列（古い順）" className="cmp-series">
            {seriesFiles.map((item, index) => (
              <li className="cmp-series-item" key={item.fileId}>
                <div className="cmp-series-head">
                  <strong>{formatDate(item.takenOn)}</strong>
                  <span className="muted small">{item.eye ? EYE_LABELS[item.eye] : ""}{index === seriesFiles.length - 1 ? " ・ 最新" : ""}</span>
                </div>
                <FilePreview failed={Boolean(failed[item.fileId])} file={item} url={urls[item.fileId]} />
              </li>
            ))}
          </ol>
          {candidates.length > SERIES_LIMIT ? <p className="muted small">新しい {SERIES_LIMIT} 件を表示しています。</p> : null}
        </>
      ) : null}
      {mode === "compare" && candidates.length > 0 ? (
        <>
          <ol aria-label="時系列（古い順）" className="cmp-strip">
            {stripFiles.map((item) => {
              const inPane = PANES.filter((pane) => selection[pane.key] === item.fileId);
              return (
                <li key={item.fileId}>
                  <button
                    aria-label={`${formatDate(item.takenOn)} ${item.eye ? EYE_LABELS[item.eye] : ""} ${item.title}`}
                    aria-pressed={inPane.length > 0}
                    className={`thumb cmp-thumb${inPane.length ? " is-shown" : ""}`}
                    onClick={() => setSelection((current) => ({ ...current, [activePane]: item.fileId }))}
                    title={item.title}
                    type="button"
                  >
                    <ThumbImage failed={failed[item.fileId]} file={item} url={urls[item.fileId]} />
                    <span className="thumb-caption">
                      <strong>{shortDate(item.takenOn)}</strong>
                      <span>{item.eye ? EYE_LABELS[item.eye] : ""}</span>
                    </span>
                    {inPane.length ? <span className="cmp-thumb-mark">{inPane.map((pane) => pane.mark).join("・")}</span> : null}
                  </button>
                </li>
              );
            })}
          </ol>
          {candidates.length > THUMB_LIMIT ? <p className="muted small">新しい {THUMB_LIMIT} 件を表示しています。古いものは面の ‹ で送れます。</p> : null}
          <div className="compare-grid cmp-grid">
            {PANES.map((pane) => {
              const file = byId.get(selection[pane.key]);
              const index = file ? indexOf(file.fileId) : -1;
              const fromNewest = index < 0 ? null : candidates.length - 1 - index;
              const active = activePane === pane.key;
              return (
                <section
                  aria-label={pane.label}
                  className={`cmp-pane${active ? " is-active" : ""}`}
                  key={pane.key}
                  onClick={() => setActivePane(pane.key)}
                >
                  <div className="cmp-pane-head">
                    <button aria-pressed={active} className="cmp-pane-select" onClick={() => setActivePane(pane.key)} title="サムネイルを押すとこの面に入ります" type="button">
                      <span className="cmp-pane-mark">{pane.mark}</span>
                      <span className="cmp-pane-rel">{fromNewest === null ? "未選択" : fromNewest === 0 ? "最新" : fromNewest === 1 ? "前回" : `${fromNewest}回前`}</span>
                      {file ? <span className="cmp-pane-date">{formatDate(file.takenOn)}</span> : null}
                      {file ? <span className="cmp-pane-meta">{file.eye ? EYE_LABELS[file.eye] : ""} {FILE_KIND_LABELS[file.kind]}</span> : null}
                    </button>
                    <span className="cmp-pane-step">
                      <button aria-label={`${pane.label}を前の日付へ`} className="btn btn-chip btn-sm" disabled={index <= 0 && index !== -1} onClick={(event) => { event.stopPropagation(); setActivePane(pane.key); step(pane.key, -1); }} type="button">‹</button>
                      <button aria-label={`${pane.label}を次の日付へ`} className="btn btn-chip btn-sm" disabled={index === -1 || index >= candidates.length - 1} onClick={(event) => { event.stopPropagation(); setActivePane(pane.key); step(pane.key, 1); }} type="button">›</button>
                    </span>
                  </div>
                  {file && file.title !== FILE_KIND_LABELS[file.kind] ? <p className="cmp-pane-title" title={file.title}>{file.title}</p> : null}
                  {file ? <FilePreview failed={Boolean(failed[file.fileId])} file={file} url={urls[file.fileId]} /> : (
                    <div className="file-preview is-empty">{candidates.length === 1 ? "比べる画像がもう 1 件ありません" : "サムネイルを選んでください"}</div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      ) : null}
      <p className="cmp-footnote">比較表示は記録の確認用です。変化の判定は医師が行います。</p>
      {uploading ? (
        <UploadDialog
          defaultKind={kind || "oct"}
          onClose={() => setUploading(false)}
          onUploaded={() => { loadFiles().catch((nextError) => setError(nextError.message)); }}
          patientId={patientId}
        />
      ) : null}
    </main>
  );
}
