"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEyeApi } from "./eye-api";
import { byNewest, FILE_KIND_LABELS, FilePreview, isImageFile, shortDate, ThumbImage, UploadDialog, useFileUrls } from "./files-panel";
import { PatientBanner } from "./patient-banner";
import { EYE_LABELS, formatDate } from "../lib/format";

const COMPARE_KINDS = Object.keys(FILE_KIND_LABELS).filter((kind) => kind !== "paper_chart");
const EYE_FILTERS = [["", "すべて"], ["od", "右眼"], ["os", "左眼"]];
const PANES = [
  { key: "left", mark: "1", label: "左の面" },
  { key: "right", mark: "2", label: "右の面" }
];
const THUMB_LIMIT = 24;

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
  const { urls, failed } = useFileUrls([
    ...stripFiles.filter(isImageFile).map((item) => item.fileId),
    selection.left,
    selection.right
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
      if (event.key === "ArrowLeft") { event.preventDefault(); step(activePane, -1); }
      if (event.key === "ArrowRight") { event.preventDefault(); step(activePane, 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePane, step, uploading]);

  const byId = new Map(candidates.map((item) => [item.fileId, item]));
  const canUpload = Boolean(context?.canWriteDocuments);
  const uploadButton = canUpload ? <button className="btn btn-ghost" onClick={() => setUploading(true)} type="button">＋取り込む</button> : null;

  return (
    <main className="eye-page cmp-page">
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
          <div aria-label="種類" className="cmp-chips" role="group">
            {kindCounts.map(([value, count]) => (
              <button aria-pressed={kind === value} className="flow-chip cmp-chip" key={value} onClick={() => chooseKind(value)} type="button">
                {FILE_KIND_LABELS[value]}<strong>{count}</strong>
              </button>
            ))}
          </div>
        ) : null}
        {kindCounts.length ? (
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
      {kindCounts.length > 0 && candidates.length === 0 ? <p className="empty">この条件の画像はありません。眼を「すべて」にすると表示されます。</p> : null}
      {candidates.length > 0 ? (
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
                  {file ? <FilePreview file={file} url={urls[file.fileId]} /> : (
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
