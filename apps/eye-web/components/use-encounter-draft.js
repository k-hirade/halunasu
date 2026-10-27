"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEyeApi } from "./eye-api";
import { setIn } from "./encounter-sections";

const AUTOSAVE_MS = 1500;
const REFRESH_MS = 20000;
const SECTION_LABELS = {
  chiefComplaint: "主訴", history: "現病歴", exam: "検査", findings: "所見", sketches: "シェーマ", diagnoses: "病名",
  assessment: "評価", plan: "方針", prescriptions: "処方", nextVisit: "次回受診", staffNote: "スタッフメモ",
  orders: "検査オーダー", flags: "散瞳・フラグ", meta: "診療日・区分", examConfirmations: "検査値の確認"
};

// カルテの下書きを編集・自動保存する。変更した項目だけを送り、他の人が別の項目を更新していれば取り込む。
export function useEncounterDraft(encounterId) {
  const api = useEyeApi();
  const [detail, setDetail] = useState(null);
  const [context, setContext] = useState(null);
  const [bootstrap, setBootstrap] = useState({ drugPresets: [], orderCatalog: [], orderSets: [], phrases: [] });
  const [content, setContent] = useState(null);
  const [meta, setMeta] = useState({ encounterDate: "", visitType: "revisit" });
  const [saveState, setSaveState] = useState("saved");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(null);
  const revisionRef = useRef(0);
  const dirtyRef = useRef(new Set());
  const savingRef = useRef(null);
  const contentRef = useRef(null);
  const metaRef = useRef(meta);
  // ログイン状態の復元で api の参照が変わっても、カルテを読み直して入力中の内容を上書きしないようにする。
  const apiRef = useRef(api);
  apiRef.current = api;
  contentRef.current = content;
  metaRef.current = meta;

  const applyServerEncounter = useCallback((encounter, { force = false } = {}) => {
    // 自分が編集中の項目は残し、それ以外をサーバーの最新に合わせる。
    setContent((current) => {
      if (!current || force) return encounter.content;
      const next = { ...encounter.content };
      for (const key of dirtyRef.current) if (key !== "meta") next[key] = current[key];
      return next;
    });
    if (force || !dirtyRef.current.has("meta")) {
      setMeta({ encounterDate: encounter.encounterDate, visitType: encounter.visitType });
    }
    revisionRef.current = encounter.revision;
    setDetail((current) => ({ ...current, encounter }));
  }, []);

  const load = useCallback(async ({ force = false } = {}) => {
    const [detailPayload, bootstrapPayload] = await Promise.all([
      apiRef.current(`/v1/eye/encounters/${encounterId}`),
      apiRef.current("/v1/eye/bootstrap")
    ]);
    if (force) dirtyRef.current.clear();
    setDetail(detailPayload);
    setContext(bootstrapPayload.context);
    setBootstrap({
      drugPresets: bootstrapPayload.drugPresets.filter((preset) => preset.active !== false),
      orderCatalog: bootstrapPayload.orderCatalog || [],
      orderSets: bootstrapPayload.orderSets || [],
      phrases: bootstrapPayload.phrases || []
    });
    applyServerEncounter(detailPayload.encounter, { force: force || !contentRef.current });
    setSaveState(dirtyRef.current.size ? "dirty" : "saved");
    setConflict(null);
  }, [applyServerEncounter, encounterId]);

  useEffect(() => {
    load().catch((nextError) => setError(nextError.message));
  }, [load]);

  const encounter = detail?.encounter;
  const editable = Boolean(encounter && encounter.status === "draft" && context?.canWrite);

  const save = useCallback(async () => {
    if (!dirtyRef.current.size || !editable) return true;
    if (savingRef.current) return savingRef.current;
    const keys = [...dirtyRef.current];
    const sections = Object.fromEntries(keys.filter((key) => key !== "meta").map((key) => [key, contentRef.current[key]]));
    const body = { expectedRevision: revisionRef.current, sections };
    if (keys.includes("meta")) Object.assign(body, metaRef.current);
    dirtyRef.current = new Set();
    setSaveState("saving");
    const promise = apiRef.current(`/v1/eye/encounters/${encounterId}`, { method: "PATCH", body })
      .then((payload) => {
        applyServerEncounter(payload.encounter);
        setSaveState(dirtyRef.current.size ? "dirty" : "saved");
        setError("");
        // 保存中に入力が続いた場合は、次の入力を待たずに続けて保存する。
        if (dirtyRef.current.size) setTimeout(() => saveRef.current(), 0);
        return true;
      })
      .catch((nextError) => {
        for (const key of keys) dirtyRef.current.add(key);
        setSaveState("error");
        if (nextError.status === 409) {
          setConflict({ sections: (nextError.details?.sections || keys).map((key) => SECTION_LABELS[key] || key) });
        }
        setError(nextError.message);
        return false;
      })
      .finally(() => {
        savingRef.current = null;
      });
    savingRef.current = promise;
    return promise;
  }, [applyServerEncounter, editable, encounterId]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (saveState !== "dirty") return undefined;
    const handle = setTimeout(() => { save(); }, AUTOSAVE_MS);
    return () => clearTimeout(handle);
  }, [save, saveState, content, meta]);

  // 他の端末の更新（検査員が入れた値など）を、編集していない項目にだけ取り込む。
  useEffect(() => {
    if (!encounter || encounter.status !== "draft") return undefined;
    const handle = setInterval(async () => {
      if (savingRef.current) return;
      try {
        const payload = await apiRef.current(`/v1/eye/encounters/${encounterId}`);
        if (payload.encounter.revision > revisionRef.current) {
          applyServerEncounter(payload.encounter);
          setDetail((current) => ({ ...payload, encounter: payload.encounter, profile: current?.profile ?? payload.profile }));
        }
      } catch {
        // 次の周期でもう一度試す
      }
    }, REFRESH_MS);
    return () => clearInterval(handle);
  }, [applyServerEncounter, encounter?.status, encounterId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        save();
      }
    }
    function onBeforeUnload(event) {
      if (dirtyRef.current.size) {
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
    dirtyRef.current.add(path[0]);
    setSaveState("dirty");
  }, []);

  const replaceContent = useCallback((next) => {
    setContent((current) => {
      for (const key of Object.keys(next)) {
        if (JSON.stringify(next[key]) !== JSON.stringify(current?.[key])) dirtyRef.current.add(key);
      }
      return next;
    });
    setSaveState("dirty");
  }, []);

  const updateMeta = useCallback((patch) => {
    setMeta((current) => ({ ...current, ...patch }));
    dirtyRef.current.add("meta");
    setSaveState("dirty");
  }, []);

  // 確定・修正などの操作。先に未保存の変更を保存してから送る。
  const runAction = useCallback(async (path, body = {}) => {
    const saved = await saveRef.current();
    if (!saved) return null;
    try {
      const payload = await apiRef.current(path, { method: "POST", body: { expectedRevision: revisionRef.current, ...body } });
      if (payload.encounter) applyServerEncounter(payload.encounter, { force: true });
      setError("");
      return payload;
    } catch (nextError) {
      setError(nextError.message);
      return null;
    }
  }, [applyServerEncounter]);

  const confirmExam = useCallback((eye, confirmed = true) => (
    runAction(`/v1/eye/encounters/${encounterId}/exam-confirm`, { eye, confirmed })
  ), [encounterId, runAction]);

  return {
    api,
    detail,
    setDetail,
    context,
    bootstrap,
    content,
    meta,
    encounter,
    editable,
    saveState,
    error,
    setError,
    conflict,
    revisionRef,
    load,
    save,
    update,
    replaceContent,
    updateMeta,
    runAction,
    confirmExam
  };
}
