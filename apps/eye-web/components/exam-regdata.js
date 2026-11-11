"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  averageOf,
  COVER_DIRECTION_LABELS,
  COVER_DIRECTIONS,
  COVER_KIND_LABELS,
  COVER_KINDS,
  IOL_CL_LABELS,
  IOL_CL_VALUES,
  NINE_GAZE_DIRECTION_LABELS,
  NINE_GAZE_DIRECTIONS,
  NINE_GAZE_VALUES,
  REFRACTION_SOURCE_LABELS,
  REFRACTION_SOURCES,
  TEST_DISTANCE_LABELS,
  TEST_DISTANCES,
  WORTH_PATTERN_LABELS,
  WORTH_PATTERNS
} from "@halunasu/eye-contracts";
import { AxisField, DiopterField, moveToNextOnEnter, NumberField, VaField } from "./exam-inputs";
import {
  ALIGNMENT_OPTIONS,
  copyDeviceValues,
  getPath,
  hasAnyValue,
  MOTILITY_OPTIONS,
  RAPD_OPTIONS,
  writeValue
} from "../lib/exam-record";

export { copyDeviceValues, writeValue };
import { DEVICE_IMPORT_KINDS, DEVICE_IMPORT_LABELS, parseDeviceText, previewLines } from "../lib/device-import";
import { formatDiopter, IOP_METHOD_LABELS, VA_CORRECTION_TYPE_LABELS } from "../lib/format";

// 検査入力（トプコンの RegData に当たる）の大タブと、その中のフォーム。
// 値はすべて 1 件の検査記録（values）に書く。保存（登録）は呼び出し側（exam-workbench.js）が行う。

const SIDES = [["od", "R", "右眼"], ["os", "L", "左眼"]];
const GRID_ROWS = [
  { distance: "far", side: "od", label: "R" },
  { distance: "far", side: "os", label: "L" },
  { distance: "far", side: "ou", label: "B" },
  { distance: "near", side: "od", label: "R" },
  { distance: "near", side: "os", label: "L" },
  { distance: "near", side: "ou", label: "B" }
];
const DISTANCE_LABELS = { far: "遠見", near: "近見" };
const SIDE_ARIA = { od: "右眼", os: "左眼", ou: "両眼" };
const RG_VALUES = ["R>G", "R=G", "G>R"];
const CONDITION_OPTIONS = ["5m", "3m", "1m", "30cm", "字ひとつ", "字づまり", "ETDRS"];
const COLOR_TESTS = ["石原式", "パネルD-15", "標準色覚検査表", "アノマロスコープ", "その他"];
const STEREO_TESTS = ["Titmus", "TNO", "Lang", "その他"];
const NINE_LABELS = { normal: "正常" };

// 大タブ。トプコンの 11 タブを Halunasu の名前にしたもの（docs/eye-ux/spec-topcon-eye §10.3 E1）。
// provisional: 公開資料で中身が分からず、仮の入力欄にしているもの。
export const EXAM_TABS = [
  { key: "vision", label: "視力", subtabs: [["subjective", "自覚検査"]] },
  { key: "iop", label: "眼圧" },
  { key: "refraction", label: "屈折" },
  { key: "kerato", label: "角膜曲率" },
  { key: "gaze", label: "眼位", subtabs: [["nine", "9方向眼位"], ["summary", "眼位・眼球運動・瞳孔"]] },
  { key: "binocular", label: "両眼視", subtabs: [["worth", "Worth 4灯"]] },
  { key: "color", label: "色覚", provisional: true },
  { key: "stereo", label: "立体視", provisional: true },
  { key: "accommodation", label: "調節", provisional: true },
  { key: "anterior", label: "前眼部", provisional: true },
  { key: "other", label: "その他", provisional: true }
];

// タブに値が入っているか（タブの印に使う）
export function tabHasValues(key, values = {}) {
  switch (key) {
    case "vision": return hasAnyValue(values.vision);
    case "iop": return hasAnyValue(values.iop?.od?.readings) || hasAnyValue(values.iop?.os?.readings);
    case "refraction": return hasAnyValue(values.refraction) || hasAnyValue(values.pd);
    case "kerato": return hasAnyValue(values.keratometry);
    case "gaze": return hasAnyValue(values.tests?.nineGaze) || hasAnyValue(values.binocular) || hasAnyValue(values.pupil);
    case "binocular": return hasAnyValue(values.tests?.worth) || hasAnyValue(values.tests?.cover);
    default: return hasAnyValue(values.tests?.[key]);
  }
}

export function ExamTabBody({ tab, subtab, values, set, touch, previous, devicePanels }) {
  const props = { values, set, touch, previous };
  if (tab === "vision") return <VisionTab {...props} devicePanels={devicePanels} />;
  if (tab === "iop") return <IopTab {...props} />;
  if (tab === "refraction") return <RefractionTab {...props} />;
  if (tab === "kerato") return <KeratoTab {...props} />;
  if (tab === "gaze") return subtab === "summary" ? <GazeSummaryTab {...props} /> : <NineGazeTab {...props} />;
  if (tab === "binocular") return <WorthTab {...props} />;
  return <TextTestTab {...props} tab={tab} />;
}

// ---- 視力 > 自覚検査 ----

// 横にスクロールする枠の右側に続きがあるとき data-more-right を付ける（CSS で右端に影を出して知らせる）。
// 視力の表と、スマホの大タブ（exam-workbench.js）で使う。
export function useScrollEdge() {
  // 描かれるのが読み込みの後になる要素にも付けられるよう、コールバックの ref にする
  const cleanupRef = useRef(null);
  return useCallback((node) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!node) return;
    const update = () => node.toggleAttribute("data-more-right", node.scrollLeft + node.clientWidth < node.scrollWidth - 2);
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    cleanupRef.current = () => { node.removeEventListener("scroll", update); observer?.disconnect(); };
  }, []);
}

function VisionTab({ values, set, touch, previous, devicePanels }) {
  const gridScrollRef = useScrollEdge();
  const [showPd, setShowPd] = useState(() => hasAnyValue(values.pd));
  const [forcePad, setForcePad] = useState(false);
  const usePad = touch || forcePad;
  const vision = values.vision || {};
  const correctionType = vision.far?.od?.correctionType || vision.far?.os?.correctionType || "";
  const setCorrectionType = (value) => {
    let next = values;
    for (const distance of ["far", "near"]) {
      for (const side of ["od", "os"]) next = writeValue(next, ["vision", distance, side, "correctionType"], value);
    }
    set([], next);
  };
  const resetGrid = () => {
    if (!hasAnyValue(values.vision)) return;
    if (!window.confirm("視力の表の値をすべて消します。よろしいですか？")) return;
    set(["vision"], undefined);
  };
  return (
    <div className="rd-vision">
      {devicePanels}
      <div className="rd-tools">
        <label className="rd-tool-field">
          <span>補正</span>
          <select aria-label="補正の種類" className="input input-compact" onChange={(event) => setCorrectionType(event.target.value)} value={correctionType}>
            <option value="">矯正</option>
            {Object.entries(VA_CORRECTION_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="rd-tool-field">
          <span>条件</span>
          <select aria-label="視標・条件" className="input input-compact" onChange={(event) => set(["vision", "condition"], event.target.value)} value={vision.condition || ""}>
            <option value="">—</option>
            {[...new Set([...CONDITION_OPTIONS, ...(vision.condition ? [vision.condition] : [])])].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <span className="rd-tools-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={resetGrid} type="button">リセット</button>
        <button aria-pressed={showPd} className="btn btn-chip btn-sm" onClick={() => setShowPd(!showPd)} type="button">PD入力</button>
        <button aria-pressed={usePad} className="btn btn-chip btn-sm" disabled={touch} onClick={() => setForcePad(!forcePad)} title="数値をテンキー・候補のタイルで入力します" type="button">テンキー</button>
      </div>
      {showPd ? <PdRow set={set} touch={usePad} values={values} /> : null}
      <div className="rd-grid-area">
        <div className="rd-grid-frame">
          <div className="rd-grid-scroll" data-enter-root="" onKeyDown={moveToNextOnEnter} ref={gridScrollRef}>
            <table className="rd-grid">
              <thead>
                <tr>
                  <th scope="col" colSpan={2}><span className="sr-only">区分</span></th>
                  <th scope="col">裸眼VA</th>
                  <th scope="col">IOL/CL</th>
                  <th scope="col">矯正VA</th>
                  <th scope="col">S</th>
                  <th scope="col">C</th>
                  <th scope="col">A</th>
                  <th scope="col">RG</th>
                </tr>
              </thead>
              {["far", "near"].map((distance) => (
                <tbody className={`rd-grid-${distance}`} key={distance}>
                  {GRID_ROWS.filter((row) => row.distance === distance).map((row, index) => (
                    <VisionRow
                      distance={distance}
                      first={index === 0}
                      key={row.side}
                      label={row.label}
                      previous={distance === "far" ? previous?.[row.side] : null}
                      set={set}
                      side={row.side}
                      touch={usePad}
                      values={values}
                    />
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </div>
        <label className="rd-comment">
          <span>コメント</span>
          <textarea aria-label="視力のコメント" className="input" onChange={(event) => set(["vision", "comment"], event.target.value)} rows={5} value={vision.comment || ""} />
        </label>
      </div>
      <datalist id="rg-values">{RG_VALUES.map((value) => <option key={value} value={value} />)}</datalist>
    </div>
  );
}

function VisionRow({ distance, side, label, first, values, set, touch, previous }) {
  const base = ["vision", distance, side];
  const row = getPath(values, base) || {};
  const aria = `${DISTANCE_LABELS[distance]} ${SIDE_ARIA[side]}`;
  const binocular = side === "ou";
  return (
    <tr className={`rd-row is-${side}`}>
      {first ? <th className="rd-distance" rowSpan={3} scope="rowgroup">{DISTANCE_LABELS[distance]}</th> : null}
      <th className={`rd-eye eye-${side}`} scope="row">{label}</th>
      <td>
        <VaField aria-label={`${aria} 裸眼視力`} onChange={(value) => set([...base, "uncorrected"], value)} previous={previous?.vaUncorrected || ""} touch={touch} value={row.uncorrected || ""} />
      </td>
      <td>
        {binocular ? null : (
          <select aria-label={`${aria} IOL/CL`} className="input input-compact rd-iolcl" onChange={(event) => set([...base, "iolCl"], event.target.value)} value={row.iolCl || ""}>
            <option value="">—</option>
            {IOL_CL_VALUES.map((value) => <option key={value} value={value}>{IOL_CL_LABELS[value]}</option>)}
          </select>
        )}
      </td>
      <td>
        <VaField aria-label={`${aria} 矯正視力`} onChange={(value) => set([...base, "corrected"], value)} previous={previous?.vaCorrected || ""} touch={touch} value={row.corrected || ""} />
      </td>
      {binocular ? <td className="rd-blank" colSpan={4} /> : (
        <>
          <td><DiopterField aria-label={`${aria} 球面`} onCommit={(value) => set([...base, "sphere"], value)} previous={previous?.correction?.sphere ?? null} touch={touch} value={row.sphere ?? null} /></td>
          <td><DiopterField aria-label={`${aria} 円柱`} limit={20} onCommit={(value) => set([...base, "cylinder"], value)} previous={previous?.correction?.cylinder ?? null} touch={touch} value={row.cylinder ?? null} /></td>
          <td><AxisField aria-label={`${aria} 軸`} onCommit={(value) => set([...base, "axis"], value)} previous={previous?.correction?.axis ?? null} touch={touch} value={row.axis ?? null} /></td>
          <td><input aria-label={`${aria} RG`} autoComplete="off" className="input rd-rg" list="rg-values" onChange={(event) => set([...base, "rg"], event.target.value)} value={row.rg || ""} /></td>
        </>
      )}
    </tr>
  );
}

function PdRow({ values, set, touch }) {
  return (
    <div className="rd-pd" data-enter-root="" onKeyDown={moveToNextOnEnter}>
      <span className="rd-pd-label">PD（mm）</span>
      {[["far", "遠見"], ["near", "近見"]].map(([key, label]) => (
        <label className="rd-tool-field" key={key}>
          <span>{label}</span>
          <NumberField aria-label={`PD ${label}`} max={85} min={40} onCommit={(value) => set(["pd", key], value)} touch={touch} value={values.pd?.[key] ?? null} />
        </label>
      ))}
    </div>
  );
}

// ---- 眼圧 ----

function IopTab({ values, set }) {
  const iop = values.iop || {};
  const method = iop.od?.method || iop.os?.method || "";
  const time = iop.od?.at || iop.os?.at || "";
  const both = (key, value) => {
    let next = values;
    for (const side of ["od", "os"]) next = writeValue(next, ["iop", side, key], value);
    set([], next);
  };
  const setReading = (side, index, value) => {
    const current = [...(iop[side]?.readings || [])].map((item) => item?.value ?? null);
    while (current.length < 3) current.push(null);
    current[index] = value;
    const readings = current.filter((item) => Number.isFinite(item)).map((item) => ({ value: item }));
    set(["iop", side, "readings"], readings.length ? readings : undefined);
  };
  const nowClock = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 16);
  return (
    <div className="rd-iop" data-enter-root="" onKeyDown={moveToNextOnEnter}>
      <div className="rd-tools">
        <label className="rd-tool-field">
          <span>測定方法</span>
          <select aria-label="眼圧の測定方法" className="input input-compact" onChange={(event) => both("method", event.target.value)} value={method}>
            <option value="">—</option>
            {Object.entries(IOP_METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="rd-tool-field">
          <span>時刻</span>
          <input aria-label="眼圧の測定時刻" className="input input-time" onChange={(event) => both("at", event.target.value)} type="time" value={time} />
        </label>
        <button className="btn btn-ghost btn-sm" onClick={() => both("at", nowClock())} type="button">今</button>
      </div>
      <table className="rd-grid rd-iop-grid">
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">眼</span></th>
            <th scope="col">1回目</th>
            <th scope="col">2回目</th>
            <th scope="col">3回目</th>
            <th scope="col">平均</th>
          </tr>
        </thead>
        <tbody>
          {SIDES.map(([side, short, label]) => {
            const readings = (iop[side]?.readings || []).map((item) => item?.value);
            const average = averageOf(readings);
            return (
              <tr className={`rd-row is-${side}`} key={side}>
                <th className={`rd-eye eye-${side}`} scope="row">{short}</th>
                {[0, 1, 2].map((index) => (
                  <td key={index}>
                    <NumberField
                      aria-label={`${label} 眼圧 ${index + 1}回目`}
                      className="input input-num input-iop"
                      max={90}
                      min={0}
                      onCommit={(value) => setReading(side, index, value)}
                      value={readings[index] ?? null}
                    />
                  </td>
                ))}
                <td className="rd-average" aria-label={`${label} 眼圧の平均`}>{average === null ? "—" : average}<span className="rd-unit">mmHg</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label className="rd-wide-field">
        <span>コメント</span>
        <input aria-label="眼圧のコメント" className="input" onChange={(event) => set(["iop", "comment"], event.target.value)} value={iop.comment || ""} />
      </label>
      <p className="rd-hint">入力した回の平均を自動で計算します（1回だけならその値）。</p>
    </div>
  );
}

// ---- 屈折（他覚） ----

function RefractionTab({ values, set, touch, previous }) {
  const refraction = values.refraction || {};
  return (
    <div className="rd-refraction" data-enter-root="" onKeyDown={moveToNextOnEnter}>
      <div className="rd-tools">
        <label className="rd-tool-field">
          <span>測定方法</span>
          <select aria-label="屈折の測定方法" className="input input-compact" onChange={(event) => set(["refraction", "source"], event.target.value)} value={refraction.source || ""}>
            <option value="">—</option>
            {REFRACTION_SOURCES.map((value) => <option key={value} value={value}>{REFRACTION_SOURCE_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="rd-tool-field">
          <span>機器</span>
          <input aria-label="屈折の機器" className="input input-compact" onChange={(event) => set(["refraction", "device"], event.target.value)} value={refraction.device || ""} />
        </label>
      </div>
      <ScaTable
        ariaPrefix="他覚屈折"
        previous={previous}
        previousKey="refraction"
        read={(side) => refraction[side] || {}}
        set={(side, key, value) => set(["refraction", side, key], value)}
        touch={touch}
      />
      <PdRow set={set} touch={touch} values={values} />
    </div>
  );
}

function ScaTable({ read, set, touch, previous, previousKey, ariaPrefix }) {
  return (
    <table className="rd-grid rd-sca-grid">
      <thead>
        <tr>
          <th scope="col"><span className="sr-only">眼</span></th>
          <th scope="col">S</th>
          <th scope="col">C</th>
          <th scope="col">A</th>
        </tr>
      </thead>
      <tbody>
        {SIDES.map(([side, short, label]) => {
          const row = read(side);
          const before = previous?.[side]?.[previousKey] || {};
          return (
            <tr className={`rd-row is-${side}`} key={side}>
              <th className={`rd-eye eye-${side}`} scope="row">{short}</th>
              <td><DiopterField aria-label={`${label} ${ariaPrefix} 球面`} onCommit={(value) => set(side, "sphere", value)} previous={before.sphere ?? null} touch={touch} value={row.sphere ?? null} /></td>
              <td><DiopterField aria-label={`${label} ${ariaPrefix} 円柱`} limit={20} onCommit={(value) => set(side, "cylinder", value)} previous={before.cylinder ?? null} touch={touch} value={row.cylinder ?? null} /></td>
              <td><AxisField aria-label={`${label} ${ariaPrefix} 軸`} onCommit={(value) => set(side, "axis", value)} previous={before.axis ?? null} touch={touch} value={row.axis ?? null} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- 角膜曲率 ----

function KeratoTab({ values, set, touch }) {
  const kerato = values.keratometry || {};
  return (
    <div className="rd-kerato" data-enter-root="" onKeyDown={moveToNextOnEnter}>
      <table className="rd-grid rd-sca-grid">
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">眼</span></th>
            <th scope="col">K1（D）</th>
            <th scope="col">K2（D）</th>
            <th scope="col">K1 軸</th>
          </tr>
        </thead>
        <tbody>
          {SIDES.map(([side, short, label]) => (
            <tr className={`rd-row is-${side}`} key={side}>
              <th className={`rd-eye eye-${side}`} scope="row">{short}</th>
              {["k1", "k2"].map((key) => (
                <td key={key}>
                  <NumberField aria-label={`${label} ${key.toUpperCase()}`} format={(number) => number.toFixed(2)} max={70} min={30} onCommit={(value) => set(["keratometry", side, key], value)} value={kerato[side]?.[key] ?? null} />
                </td>
              ))}
              <td><AxisField aria-label={`${label} 角膜曲率の軸`} onCommit={(value) => set(["keratometry", side, "axis"], value)} touch={touch} value={kerato[side]?.axis ?? null} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- 眼位 > 9 方向眼位 ----

const GAZE_OFFSET = {
  up_right: [-1, -1], up: [0, -1], up_left: [1, -1], right: [-1, 0], center: [0, 0], left: [1, 0], down_right: [-1, 1], down: [0, 1], down_left: [1, 1]
};

function NineGazeTab({ values, set }) {
  const nine = values.tests?.nineGaze || {};
  const cells = nine.cells || {};
  const setCell = (direction, side, value) => set(["tests", "nineGaze", "cells", direction, side], value);
  const setBoth = (direction, value) => set(["tests", "nineGaze", "cells", direction], value ? { od: value, os: value } : undefined);
  const allNormal = () => set(["tests", "nineGaze", "cells"], Object.fromEntries(NINE_GAZE_DIRECTIONS.map((direction) => [direction, { od: "normal", os: "normal" }])));
  return (
    <div className="rd-nine">
      <div className="rd-tools">
        <label className="rd-tool-field">
          <span>条件</span>
          <input aria-label="9方向眼位の条件" className="input input-compact" onChange={(event) => set(["tests", "nineGaze", "condition"], event.target.value)} placeholder="例: 裸眼" value={nine.condition || ""} />
        </label>
        <span className="rd-tools-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={allNormal} type="button">全て正常</button>
        <button className="btn btn-ghost btn-sm" onClick={() => set(["tests", "nineGaze", "cells"], undefined)} type="button">リセット</button>
      </div>
      <div className="rd-nine-grid" role="group" aria-label="9方向眼位（患者から見た向き）">
        {NINE_GAZE_DIRECTIONS.map((direction) => {
          const cell = cells[direction] || {};
          const label = NINE_GAZE_DIRECTION_LABELS[direction];
          const state = cell.od === "normal" && cell.os === "normal" ? "normal" : hasAnyValue(cell) ? "abnormal" : "empty";
          return (
            <div className={`rd-nine-cell is-${state}`} key={direction}>
              <div className="rd-nine-head">
                <GazePicture direction={direction} />
                <span className="rd-nine-label">{label}</span>
              </div>
              <div className="rd-nine-eyes">
                {SIDES.map(([side, short, sideLabel]) => (
                  <label className={`rd-nine-eye eye-${side}`} key={side}>
                    <span>{short}</span>
                    <select aria-label={`${label} ${sideLabel}`} className="input input-compact" onChange={(event) => setCell(direction, side, event.target.value)} value={cell[side] || ""}>
                      <option value="">—</option>
                      {NINE_GAZE_VALUES.map((value) => <option key={value} value={value}>{NINE_LABELS[value] || value}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div className="rd-nine-actions">
                <button aria-label={`${label} 正常`} aria-pressed={state === "normal"} className="btn btn-chip btn-sm" onClick={() => setBoth(direction, "normal")} type="button">正常</button>
                <button aria-label={`${label} クリア`} className="btn btn-ghost btn-sm" disabled={state === "empty"} onClick={() => setBoth(direction, "")} type="button">クリア</button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="rd-hint">異常のときは、その方向の右眼・左眼に制限（−1〜−4）か過動（+1〜+4）の程度を選びます。</p>
    </div>
  );
}

// 両眼の簡単な図。瞳を視線の向きにずらす（患者から見た向きなので、画面上は左右が逆になる）。
function GazePicture({ direction }) {
  const [dx, dy] = GAZE_OFFSET[direction];
  return (
    <svg aria-hidden="true" className="rd-gaze-pic" viewBox="0 0 64 24">
      {[16, 48].map((cx) => (
        <g key={cx}>
          <ellipse className="rd-gaze-eye" cx={cx} cy={12} rx={13} ry={8} />
          <circle className="rd-gaze-pupil" cx={cx + dx * 6} cy={12 + dy * 3.5} r={3.6} />
        </g>
      ))}
    </svg>
  );
}

// ---- 眼位 > 眼位・眼球運動・瞳孔（概要） ----

function GazeSummaryTab({ values, set, touch }) {
  const binocular = values.binocular || {};
  return (
    <div className="rd-summary" data-enter-root="" onKeyDown={moveToNextOnEnter}>
      <div className="rd-form-grid">
        <label className="rd-tool-field">
          <span>眼位</span>
          <select aria-label="眼位" className="input input-compact" onChange={(event) => set(["binocular", "alignment"], event.target.value)} value={binocular.alignment || ""}>
            <option value="">—</option>
            {ALIGNMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="rd-tool-field is-wide">
          <span>眼位のメモ</span>
          <input aria-label="眼位のメモ" className="input" onChange={(event) => set(["binocular", "alignmentNote"], event.target.value)} value={binocular.alignmentNote || ""} />
        </label>
        <label className="rd-tool-field">
          <span>眼球運動</span>
          <select aria-label="眼球運動" className="input input-compact" onChange={(event) => set(["binocular", "motility"], event.target.value)} value={binocular.motility || ""}>
            <option value="">—</option>
            {MOTILITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="rd-tool-field is-wide">
          <span>眼球運動のメモ</span>
          <input aria-label="眼球運動のメモ" className="input" onChange={(event) => set(["binocular", "motilityNote"], event.target.value)} value={binocular.motilityNote || ""} />
        </label>
        <label className="rd-tool-field">
          <span>RAPD</span>
          <select aria-label="RAPD" className="input input-compact" onChange={(event) => set(["binocular", "rapd"], event.target.value)} value={binocular.rapd || ""}>
            <option value="">—</option>
            {RAPD_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <table className="rd-grid rd-sca-grid">
        <thead>
          <tr><th scope="col"><span className="sr-only">眼</span></th><th scope="col">瞳孔径（mm）</th><th scope="col">対光反射</th></tr>
        </thead>
        <tbody>
          {SIDES.map(([side, short, label]) => (
            <tr className={`rd-row is-${side}`} key={side}>
              <th className={`rd-eye eye-${side}`} scope="row">{short}</th>
              <td><NumberField aria-label={`${label} 瞳孔径`} max={12} min={0.5} onCommit={(value) => set(["pupil", side, "sizeMm"], value)} touch={touch} value={values.pupil?.[side]?.sizeMm ?? null} /></td>
              <td>
                <select aria-label={`${label} 対光反射`} className="input input-compact" onChange={(event) => set(["pupil", side, "reaction"], event.target.value)} value={values.pupil?.[side]?.reaction || ""}>
                  <option value="">—</option>
                  <option value="brisk">迅速</option>
                  <option value="sluggish">緩慢</option>
                  <option value="absent">消失</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- 両眼視 > Worth 4 灯（＋遮閉試験） ----

function WorthTab({ values, set }) {
  const worth = values.tests?.worth || {};
  const cover = values.tests?.cover || {};
  return (
    <div className="rd-worth">
      <div className="rd-tools">
        <fieldset className="rd-radio-group">
          <legend>固視眼</legend>
          {SIDES.map(([side, , label]) => (
            <label key={side}>
              <input checked={worth.fixingEye === side} name="worth-fixing" onChange={() => set(["tests", "worth", "fixingEye"], side)} type="radio" />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="rd-tool-field">
          <span>検査距離</span>
          <select aria-label="Worth 4灯の検査距離" className="input input-compact" onChange={(event) => set(["tests", "worth", "distance"], event.target.value)} value={worth.distance || ""}>
            <option value="">—</option>
            {TEST_DISTANCES.map((value) => <option key={value} value={value}>{TEST_DISTANCE_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="rd-tool-field">
          <span>結果</span>
          <select aria-label="Worth 4灯の結果" className="input input-compact" onChange={(event) => set(["tests", "worth", "pattern"], event.target.value)} value={worth.pattern || ""}>
            <option value="">—</option>
            {WORTH_PATTERNS.map((value) => <option key={value} value={value}>{WORTH_PATTERN_LABELS[value]}</option>)}
          </select>
        </label>
      </div>
      <div className="rd-worth-grid" role="group" aria-label="Worth 4灯の見え方">
        {WORTH_PATTERNS.map((pattern) => (
          <button
            aria-pressed={worth.pattern === pattern}
            className="rd-worth-button"
            key={pattern}
            onClick={() => set(["tests", "worth", "pattern"], worth.pattern === pattern ? "" : pattern)}
            type="button"
          >
            <WorthPicture pattern={pattern} />
            <span>{WORTH_PATTERN_LABELS[pattern]}</span>
          </button>
        ))}
      </div>
      <p className="rd-hint">赤フィルターを右眼にかけたときの見え方で選びます。</p>
      <fieldset className="rd-cover">
        <legend>遮閉試験（Cover Test）</legend>
        <table className="rd-grid rd-cover-grid">
          <thead>
            <tr><th scope="col"><span className="sr-only">距離</span></th><th scope="col">固視眼</th><th scope="col">種類</th><th scope="col">方向</th><th scope="col">量（Δ）</th></tr>
          </thead>
          <tbody>
            {TEST_DISTANCES.map((distance) => {
              const row = cover[distance] || {};
              const label = TEST_DISTANCE_LABELS[distance];
              const base = ["tests", "cover", distance];
              return (
                <tr className="rd-row" key={distance}>
                  <th scope="row">{label}</th>
                  <td>
                    <select aria-label={`遮閉試験 ${label} 固視眼`} className="input input-compact" onChange={(event) => set([...base, "fixingEye"], event.target.value)} value={row.fixingEye || ""}>
                      <option value="">—</option>
                      {SIDES.map(([side, , sideLabel]) => <option key={side} value={side}>{sideLabel}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`遮閉試験 ${label} 種類`} className="input input-compact" onChange={(event) => set([...base, "kind"], event.target.value)} value={row.kind || ""}>
                      <option value="">—</option>
                      {COVER_KINDS.map((value) => <option key={value} value={value}>{COVER_KIND_LABELS[value]}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label={`遮閉試験 ${label} 方向`} className="input input-compact" onChange={(event) => set([...base, "direction"], event.target.value)} value={row.direction || ""}>
                      <option value="">—</option>
                      {COVER_DIRECTIONS.map((value) => <option key={value} value={value}>{COVER_DIRECTION_LABELS[value]}</option>)}
                    </select>
                  </td>
                  <td><input aria-label={`遮閉試験 ${label} 量`} className="input input-short" inputMode="decimal" onChange={(event) => set([...base, "amount"], event.target.value)} value={row.amount || ""} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </fieldset>
    </div>
  );
}

// Worth 4 灯の見え方の図（上が赤、左右が緑、下が白の配置）。
const WORTH_DOTS = {
  four: [["red", 32, 8], ["green", 16, 24], ["green", 48, 24], ["white", 32, 40]],
  red2: [["red", 32, 8], ["red", 32, 40]],
  green3: [["green", 16, 24], ["green", 48, 24], ["green", 32, 40]],
  five: [["red", 22, 10], ["red", 22, 38], ["green", 38, 8], ["green", 54, 24], ["green", 38, 40]],
  alternating: [["red", 14, 12], ["red", 14, 36], ["green", 44, 12], ["green", 56, 24], ["green", 44, 36]]
};

function WorthPicture({ pattern }) {
  const dots = WORTH_DOTS[pattern];
  return (
    <svg aria-hidden="true" className="rd-worth-pic" viewBox="0 0 64 48">
      {dots ? dots.map(([color, cx, cy], index) => <circle className={`rd-worth-dot is-${color}`} cx={cx} cy={cy} key={index} r={6} />) : (
        <text className="rd-worth-unknown" textAnchor="middle" x={32} y={31}>?</text>
      )}
      {pattern === "alternating" ? <text className="rd-worth-arrow" textAnchor="middle" x={29} y={29}>⇄</text> : null}
    </svg>
  );
}

// ---- 形の決まっていない検査（仮の入力欄） ----

const TEXT_FORMS = {
  color: {
    note: "検査名と、眼ごとの結果を記録します。",
    fields: [["test", "検査", COLOR_TESTS], ["od", "右眼の結果"], ["os", "左眼の結果"], ["note", "メモ"]]
  },
  stereo: {
    note: "検査名と結果（秒など）を記録します。",
    fields: [["test", "検査", STEREO_TESTS], ["result", "結果"], ["note", "メモ"]]
  },
  accommodation: {
    note: "近点・調節力などを眼ごとに記録します。",
    fields: [["od", "右眼"], ["os", "左眼"], ["note", "メモ"]]
  },
  anterior: {
    note: "検査室で記録する前眼部の所見（医師の所見はカルテに書きます）。",
    fields: [["od", "右眼"], ["os", "左眼"], ["note", "メモ"]]
  },
  other: {
    note: "ほかの検査の名前と結果を記録します。",
    fields: [["name", "検査名"], ["text", "結果", null, true]]
  }
};

function TextTestTab({ tab, values, set }) {
  const form = TEXT_FORMS[tab];
  const label = EXAM_TABS.find((item) => item.key === tab)?.label || "";
  const current = values.tests?.[tab] || {};
  return (
    <div className="rd-text-test" data-enter-root="" onKeyDown={moveToNextOnEnter}>
      <p className="rd-provisional">仮の入力欄です（この検査の画面の中身は確認中のため、文字で記録します）。{form.note}</p>
      <div className="rd-form-grid">
        {form.fields.map(([key, fieldLabel, options, multiline]) => {
          const aria = `${label} ${fieldLabel}`;
          const onChange = (event) => set(["tests", tab, key], event.target.value);
          return (
            <label className={`rd-tool-field${multiline || key === "note" ? " is-wide" : ""}`} key={key}>
              <span>{fieldLabel}</span>
              {options ? (
                <select aria-label={aria} className="input input-compact" onChange={onChange} value={current[key] || ""}>
                  <option value="">—</option>
                  {[...new Set([...options, ...(current[key] ? [current[key]] : [])])].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              ) : multiline ? (
                <textarea aria-label={aria} className="input" maxLength={200} onChange={onChange} rows={3} value={current[key] || ""} />
              ) : (
                <input aria-label={aria} className="input" maxLength={200} onChange={onChange} value={current[key] || ""} />
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

// ---- 機器の値（参照パネル 3 枚） ----

const DEVICE_PANELS = [
  { key: "kerato", label: "ケラト値" },
  { key: "autoref", label: "レフ値" },
  { key: "tonometer", label: "眼圧値" }
];

// readings: [{ recordId, at, data }] を種類ごとに。古い → 新しい。
// onImport(kind, data): 「機器データ取込」で読んだ値を入力中の記録に入れる（無ければ取込の欄を出さない）。
export function DevicePanels({ readings, onCopy, onImport = null, disabled = false }) {
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  return (
    <div className="rd-devices-area">
      {onImport ? (
        <div className="rd-devices-bar">
          <span className="rd-devices-title">機器の値</span>
          {notice ? <span className="rd-devices-notice" role="status">{notice}</span> : null}
          <button aria-expanded={importing} className="btn btn-ghost btn-sm rd-import-open" disabled={disabled} onClick={() => { setImporting(!importing); setNotice(""); }} type="button">
            {importing ? "取込を閉じる" : "機器データ取込"}
          </button>
        </div>
      ) : null}
      {importing && onImport ? (
        <DeviceImportPanel
          onCancel={() => setImporting(false)}
          onImport={(kind, data) => {
            onImport(kind, data);
            setImporting(false);
            setNotice(`${DEVICE_IMPORT_LABELS[kind]}を取り込みました。［登録］で記録に保存します。`);
          }}
        />
      ) : null}
      <div className="rd-devices" role="group" aria-label="機器の値">
        {DEVICE_PANELS.map((panel) => (
          <DevicePanel disabled={disabled} items={readings[panel.key] || []} key={panel.key} label={panel.label} onCopy={(data) => onCopy(panel.key, data)} panelKey={panel.key} />
        ))}
      </div>
    </div>
  );
}

const IMPORT_PLACEHOLDER = "例（レフ）\nR -1.25 -0.50 180\nL -2.00 -0.75 90\n\n例（眼圧）R,14,15,14 ／ （ケラト）<R> K1 43.50 K2 44.25 A 90";

// 機器データ取込（トプコン RegData の機器データ欄）。機器とはつながず、印字・書き出しの文字を貼り付けて読む。
function DeviceImportPanel({ onImport, onCancel }) {
  const [kind, setKind] = useState("auto");
  const [text, setText] = useState("");
  const [fileError, setFileError] = useState("");
  const result = useMemo(() => (text.trim() ? parseDeviceText(text, kind) : null), [kind, text]);
  const hasData = Boolean(result && (result.data.od || result.data.os));
  const lines = hasData ? previewLines(result.kind, result.data) : [];

  function readFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    setFileError("");
    if (!file) return;
    if (file.size > 200 * 1024) {
      setFileError("200KB までのテキスト・CSV を選んでください。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.onerror = () => setFileError("ファイルを読めませんでした。");
    reader.readAsText(file);
  }

  return (
    <section aria-label="機器データ取込" className="rd-import">
      <p className="rd-import-note">機器とは接続していません。機器の印字・書き出したテキストや CSV を貼り付けるか、ファイルを選んで読み取ります（サーバーへは送りません）。</p>
      <div className="rd-import-row">
        <div aria-label="データの種類" className="segmented rd-import-kinds" role="group">
          {DEVICE_IMPORT_KINDS.map(([value, label]) => (
            <button aria-pressed={kind === value} key={value} onClick={() => setKind(value)} type="button">{label}</button>
          ))}
        </div>
        <label className="btn btn-ghost btn-sm rd-import-file">
          ファイルを選ぶ
          <input accept=".csv,.txt,text/plain,text/csv" aria-label="機器データのファイル" className="sr-only" onChange={readFile} type="file" />
        </label>
      </div>
      <div className="rd-import-body">
        <textarea
          aria-label="機器データ（貼り付け）"
          className="input rd-import-text"
          maxLength={20000}
          onChange={(event) => setText(event.target.value)}
          placeholder={IMPORT_PLACEHOLDER}
          rows={5}
          spellCheck={false}
          value={text}
        />
        <div aria-live="polite" className="rd-import-preview">
          {!result ? <p className="muted small">貼り付けると、読み取った値がここに出ます。</p> : (
            <>
              <p className="rd-import-kind"><strong>{DEVICE_IMPORT_LABELS[result.kind]}</strong>{kind === "auto" ? <span className="muted small">（自動判定）</span> : null}</p>
              {lines.length ? <pre className="rd-device-body rd-import-lines">{lines.join("\n")}</pre> : <p className="muted small">読み取れる値がありません。</p>}
              {result.errors.length ? (
                <ul className="rd-import-errors">
                  {result.errors.slice(0, 6).map((item, index) => (
                    <li key={index}>{item.line ? `${item.line}行目: ` : ""}{item.message}{item.text ? `（${item.text.slice(0, 30)}）` : ""}</li>
                  ))}
                  {result.errors.length > 6 ? <li>ほか {result.errors.length - 6} 件</li> : null}
                </ul>
              ) : null}
            </>
          )}
          {fileError ? <p className="rd-import-errors" role="alert">{fileError}</p> : null}
        </div>
      </div>
      <div className="rd-import-actions">
        <button className="btn btn-ghost btn-sm" onClick={onCancel} type="button">キャンセル</button>
        <button className="btn btn-primary btn-sm" disabled={!hasData} onClick={() => onImport(result.kind, result.data)} type="button">取り込む</button>
      </div>
    </section>
  );
}

function DevicePanel({ panelKey, label, items, onCopy, disabled }) {
  const [index, setIndex] = useState(null);
  const position = index === null || index >= items.length ? items.length - 1 : index;
  const item = items[position];
  return (
    <section aria-label={label} className="rd-device">
      <div className="rd-device-head">
        <strong>{label}</strong>
        <span className="rd-device-count">{items.length ? `${position + 1}/${items.length}` : "0/0"}</span>
        {item ? <span className="rd-device-time">{item.time}</span> : null}
        <span className="rd-device-step">
          <button aria-label={`${label}の前の測定`} className="btn btn-chip btn-sm" disabled={position <= 0} onClick={() => setIndex(position - 1)} type="button">‹</button>
          <button aria-label={`${label}の次の測定`} className="btn btn-chip btn-sm" disabled={position >= items.length - 1} onClick={() => setIndex(position + 1)} type="button">›</button>
        </span>
      </div>
      {item ? (
        <>
          <pre className="rd-device-body">{deviceText(panelKey, item.data)}</pre>
          <button className="btn btn-ghost btn-sm rd-device-copy" disabled={disabled} onClick={() => onCopy(item.data)} type="button">{DEVICE_COPY_LABELS[panelKey]}</button>
        </>
      ) : <p className="rd-device-empty">取り込んだ値はありません</p>}
    </section>
  );
}

const DEVICE_COPY_LABELS = { kerato: "角膜曲率へ写す", autoref: "表の S・C・A へ写す", tonometer: "眼圧へ写す" };

function deviceText(kind, data = {}) {
  const lines = [];
  if (data.device) lines.push(data.device);
  for (const [side, short] of [["od", "<R>"], ["os", "<L>"]]) {
    const eye = data[side] || {};
    if (kind === "kerato") {
      const parts = [Number.isFinite(eye.k1) ? `K1 ${eye.k1.toFixed(2)}` : "", Number.isFinite(eye.k2) ? `K2 ${eye.k2.toFixed(2)}` : "", Number.isFinite(eye.axis) ? `A ${eye.axis}` : "", Number.isFinite(eye.cylinder) ? `CYL ${formatDiopter(eye.cylinder)}` : ""].filter(Boolean);
      lines.push(`${short} ${parts.join(" ") || "—"}`);
    } else if (kind === "autoref") {
      const representative = eye.representative || eye.readings?.at(-1);
      lines.push(`${short} ${representative ? scaText(representative) : "—"}${eye.readings?.length ? ` (${eye.readings.length}回)` : ""}`);
    } else {
      const values = (eye.readings || []).map((reading) => reading.value);
      lines.push(`${short} ${values.join(" ") || "—"}${values.length ? `  AVG ${eye.average ?? averageOf(values)}` : ""}`);
    }
  }
  if (kind === "autoref" && Number.isFinite(data.pd)) lines.push(`PD ${data.pd}`);
  if (kind === "tonometer" && data.method) lines.push(IOP_METHOD_LABELS[data.method] || data.method);
  return lines.join("\n");
}

function scaText(value = {}) {
  return [formatDiopter(value.sphere) || "", Number.isFinite(value.cylinder) ? formatDiopter(value.cylinder) : "", Number.isFinite(value.axis) ? value.axis : ""].filter((part) => part !== "").join(" ");
}
