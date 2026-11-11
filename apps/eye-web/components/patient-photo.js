"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useEyeApi } from "./eye-api";
import { byNewest, useFileUrls } from "./files-panel";
import { formatDate } from "../lib/format";

// 顔写真の確認（トプコンの「顔写真確認」に倣う）。ファイルの種類「顔写真」(face_photo) の最新 1 枚を、
// 患者の帯・カルテ概要に小さく出し、押すと大きく見せる。写真が無ければ何も出さない（取り込みはファイルの取り込みから）。
// 同じ患者は 1 分間覚えておく。取り込み・削除の後は notifyPatientPhotoChanged(patientId) で読み直す。
const cache = new Map();
const CACHE_MS = 60000;
const EVENT = "halunasu:patient-photo-changed";

export function notifyPatientPhotoChanged(patientId) {
  cache.delete(patientId);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: { patientId } }));
}

function usePatientPhoto(patientId) {
  const api = useEyeApi();
  const [state, setState] = useState(() => cache.get(patientId)?.file ?? null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const onChange = (event) => { if (event.detail?.patientId === patientId) setVersion((value) => value + 1); };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [patientId]);
  useEffect(() => {
    if (!patientId) return undefined;
    const hit = cache.get(patientId);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      setState(hit.file);
      return undefined;
    }
    let active = true;
    api(`/v1/eye/patients/${patientId}/files?kind=face_photo`)
      .then((payload) => {
        const file = (payload.files || []).filter((item) => /^image\//u.test(item.contentType || "")).sort(byNewest)[0] || null;
        cache.set(patientId, { at: Date.now(), file });
        if (active) setState(file);
      })
      // 読めないときは出さない（本人確認は氏名・生年月日でもできる）
      .catch(() => { if (active) setState(null); });
    return () => { active = false; };
  }, [api, patientId, version]);
  return state;
}

// size: "sm"（帯の 1 行）/ "lg"（カルテ概要）
export function PatientPhoto({ patientId, name = "", size = "sm" }) {
  const file = usePatientPhoto(patientId);
  const { urls, failed } = useFileUrls(file ? [file.fileId] : []);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!file || failed[file.fileId]) return null;
  const url = urls[file.fileId];
  return (
    <>
      <button
        aria-label={`${name ? `${name}の` : ""}顔写真を大きく見る`}
        className={`pt-photo is-${size}`}
        onClick={() => setOpen(true)}
        title={`顔写真（${formatDate(file.takenOn)}）`}
        type="button"
      >
        {url ? <img alt="" src={url} /> : <span aria-hidden="true" className="pt-photo-wait" />}
      </button>
      {open ? createPortal(
        <div className="dialog-backdrop" onClick={() => setOpen(false)} role="presentation">
          <div aria-label="顔写真" aria-modal="true" className="dialog pt-photo-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="dialog-head">
              <h2>顔写真{name ? ` ${name}` : ""}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} type="button">閉じる</button>
            </div>
            {url ? <img alt={`${name}の顔写真`} className="pt-photo-large" src={url} /> : <p className="loading">読み込み中…</p>}
            <p className="muted small">撮影日 {formatDate(file.takenOn)}{file.title ? ` ・ ${file.title}` : ""}</p>
          </div>
        </div>,
        document.body
      ) : null}
    </>
  );
}
