"use client";

import { useMemo } from "react";
import { parseVisualAcuity, sortExamRecords } from "@halunasu/eye-core";
import { ResultMatrix } from "./chart-left-matrix";
import { formatTime } from "./encounter-sections";
import { formatDiopter, formatShortDate, IOP_METHOD_LABELS } from "../lib/format";

const SIDES = [["od", "R"], ["os", "L"]];
// 眼圧の基準値（正常眼圧の目安）。ほかの項目は眼科では「基準値」を持たないので空欄にする。
export const IOP_REFERENCE = Object.freeze({ low: 10, high: 21 });

const num = (value) => (Number.isFinite(value) ? value : null);

// 1 回分の検査値から、表の項目ごとの値を作る。
export function examCells(exam = {}, findings = {}) {
  const cells = {};
  for (const [side, eye] of SIDES) {
    const values = exam[side] || {};
    const unc = parseVisualAcuity(values.vaUncorrected);
    const cor = parseVisualAcuity(values.vaCorrected);
    const near = parseVisualAcuity(values.vaNear);
    if (values.vaUncorrected) cells[`${side}-vau`] = { value: unc.decimal, text: String(values.vaUncorrected) };
    if (values.vaCorrected) cells[`${side}-vac`] = { value: cor.decimal, text: `(${values.vaCorrected})` };
    if (values.vaNear) cells[`${side}-near`] = { value: near.decimal, text: String(values.vaNear) };
    if (Number.isFinite(values.iop)) {
      const method = IOP_METHOD_LABELS[values.iopMethod] || "";
      cells[`${side}-iop`] = { value: values.iop, text: String(values.iop), note: method };
    }
    const refraction = values.refraction || {};
    if (Number.isFinite(refraction.sphere)) cells[`${side}-s`] = { value: refraction.sphere, text: formatDiopter(refraction.sphere) };
    if (Number.isFinite(refraction.cylinder)) cells[`${side}-c`] = { value: refraction.cylinder, text: formatDiopter(refraction.cylinder) };
    const kerato = values.keratometry || {};
    if (Number.isFinite(kerato.k1)) cells[`${side}-k1`] = { value: kerato.k1, text: String(kerato.k1) };
    if (Number.isFinite(kerato.k2)) cells[`${side}-k2`] = { value: kerato.k2, text: String(kerato.k2) };
    if (Number.isFinite(values.pupil?.sizeMm)) cells[`${side}-pupil`] = { value: values.pupil.sizeMm, text: String(values.pupil.sizeMm) };
    const cd = num(findings?.[side]?.cdRatio);
    if (cd !== null) cells[`${side}-cd`] = { value: cd, text: String(cd) };
  }
  return cells;
}

export const EXAM_ROWS = SIDES.flatMap(([side, eye]) => [
  { key: `${side}-vau`, label: `${eye} 裸眼視力`, graphUnit: "視力", side },
  { key: `${side}-vac`, label: `${eye} 矯正視力`, graphUnit: "視力", side },
  { key: `${side}-near`, label: `${eye} 近見視力`, graphUnit: "視力", side },
  { key: `${side}-iop`, label: `${eye} 眼圧`, unit: "mmHg", ref: IOP_REFERENCE, refLabel: `${eye} 眼圧`, side },
  { key: `${side}-s`, label: `${eye} 屈折 S`, unit: "D", side },
  { key: `${side}-c`, label: `${eye} 屈折 C`, unit: "D", side },
  { key: `${side}-k1`, label: `${eye} 角膜曲率 K1`, unit: "D", graphUnit: "角膜曲率 D", side },
  { key: `${side}-k2`, label: `${eye} 角膜曲率 K2`, unit: "D", graphUnit: "角膜曲率 D", side },
  { key: `${side}-pupil`, label: `${eye} 瞳孔径`, unit: "mm", side },
  { key: `${side}-cd`, label: `${eye} C/D`, unit: "", graphUnit: "C/D", side }
]);

// 並びは 視力 → 眼圧 → 屈折 → 角膜曲率 → 瞳孔 → C/D、それぞれ R・L の順。
const ORDER = ["vau", "vac", "near", "iop", "s", "c", "k1", "k2", "pupil", "cd"];
const SORTED_ROWS = ORDER.flatMap((kind) => EXAM_ROWS.filter((row) => row.key.endsWith(`-${kind}`)));

// 左「検査」（デジカルの検査結果タブ）。検査項目 × 日付の表と、選んだ項目のグラフ（眼圧は基準値の線つき）。
// 今日の列は保存前の入力も含む。値を押すと主訴・所見へ日付つきで書き込む。
export function ExamResultsTab({ history, current, currentDate, onInsert = null }) {
  const { columns, rows } = useMemo(() => {
    const visits = [
      ...[...history].sort((left, right) => String(left.encounterDate).localeCompare(String(right.encounterDate))),
      ...(current ? [{ encounterId: "current", encounterDate: currentDate, content: current, today: true }] : [])
    ];
    const withCells = visits.map((visit) => ({ visit, cells: examCells(visit.content?.exam, visit.content?.findings) })).filter(({ cells }) => Object.keys(cells).length);
    const columnList = withCells.map(({ visit }) => ({
      key: visit.encounterId,
      date: visit.encounterDate,
      label: formatShortDate(visit.encounterDate).replace(/\(.\)$/u, ""),
      axisLabel: `${Number(visit.encounterDate.slice(5, 7))}/${Number(visit.encounterDate.slice(8, 10))}`,
      today: Boolean(visit.today),
      cells: visit
    }));
    const rowList = SORTED_ROWS.map((row) => ({
      ...row,
      values: Object.fromEntries(withCells.map(({ visit, cells }) => [visit.encounterId, cells[row.key]]).filter(([, cell]) => cell))
    }));
    return { columns: columnList, rows: rowList };
  }, [history, current, currentDate]);

  return (
    <div className="cl-exam">
      <ResultMatrix
        cellTitle={onInsert ? "主訴・所見へ日付つきで書き込む" : ""}
        columns={columns}
        defaultSelected={["od-iop", "os-iop"]}
        emptyText="視力・眼圧などの検査の記録はありません。"
        label="検査結果"
        onCellClick={onInsert ? (row, column, cell) => onInsert(`${formatShortDate(column.date)} ${row.label} ${cell.text}${row.unit && row.unit !== "D" ? ` ${row.unit}` : ""}`) : null}
        rows={rows}
      />
      {current?.examRecords?.length ? (
        <section className="exam-records-today cl-records">
          <h3>本日の検査記録</h3>
          <ol className="plain">
            {sortExamRecords(current.examRecords).map((record) => (
              <li key={record.recordId}>
                <strong>{formatTime(record.at)}</strong> {record.examinerName || record.recordedBy?.displayName || ""}
                <span className="muted small"> {recordSummary(record.values)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function recordSummary(values = {}) {
  return [
    values.vision ? "視力" : "", values.iop ? "眼圧" : "", values.refraction ? "屈折" : "", values.keratometry ? "角膜曲率" : "",
    values.pupil ? "瞳孔" : "", values.binocular ? "眼位など" : "", values.devices ? "機器" : ""
  ].filter(Boolean).join("・");
}
