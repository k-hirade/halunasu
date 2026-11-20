"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { edgeMarkPath, vaFixedAxis, vaPoint } from "../lib/trend-scale.mjs";

// 検査結果・バイタルの「項目 × 日付」の表と、選んだ項目のグラフ（デジカルの検査結果タブ・バイタルタブ）。
// - 行: 項目（左に選択のチェック・項目名・基準値）。列: 日付（古い順に右へ。開いたときは最新の列が見えるよう右端へ）。
// - 基準値を外れた値は色と ↑↓ の印で示す（高い・低い。右眼の赤と見分けられるよう色だけにしない）。値を押すと onCellClick（主訴・所見へ書き込む など）。
// - 下のグラフは、チェックした項目を単位ごとに 1 枚ずつ描き、基準値の線（破線）を重ねる（線は切り替えられる）。

export function ResultMatrix({ label, columns, rows, defaultSelected = [], onCellClick = null, onHeaderClick = null, cellTitle = "", emptyText = "記録はありません。" }) {
  const scrollRef = useRef(null);
  const [selected, setSelected] = useState(() => new Set(defaultSelected));
  const [showRef, setShowRef] = useState(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [columns.length]);
  const visibleRows = rows.filter((row) => columns.some((column) => row.values[column.key]));
  if (!columns.length || !visibleRows.length) return <p className="empty">{emptyText}</p>;
  const toggle = (key) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const graphRows = visibleRows.filter((row) => row.graph !== false && selected.has(row.key));

  return (
    <div className="cl-matrix-wrap">
      <div className="table-scroll cl-matrix-scroll" ref={scrollRef}>
        <table aria-label={label} className="data-table cl-matrix">
          <thead>
            <tr>
              {/* 基準値は項目の列（左に固定）の右端に置く。日付の列を右へ送っても隠れない */}
              <th className="cl-matrix-item" scope="col"><span className="cl-matrix-head">項目<span className="cl-matrix-ref">基準値</span></span></th>
              {columns.map((column) => (
                <th className={`cl-matrix-date${column.today ? " is-today" : ""}`} key={column.key} scope="col">
                  {onHeaderClick && column.editable !== false ? (
                    <button className="link-button" onClick={() => onHeaderClick(column)} title={column.title || "この日の記録を開く"} type="button">{column.label}</button>
                  ) : column.label}
                  {column.today ? <span className="cl-today">今日</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr className={row.side ? `is-${row.side}` : ""} key={row.key}>
                <th className="cl-matrix-item" scope="row">
                  <span className="cl-matrix-head">
                    <label className="cl-matrix-check">
                      {row.graph !== false ? <input aria-label={`${row.label}をグラフに出す`} checked={selected.has(row.key)} onChange={() => toggle(row.key)} type="checkbox" /> : <span className="cl-check-spacer" />}
                      <span>{row.label}{row.unit ? <span className="cl-unit">（{row.unit}）</span> : null}</span>
                    </label>
                    <span className="cl-matrix-ref">{refText(row)}</span>
                  </span>
                </th>
                {columns.map((column) => {
                  const cell = row.values[column.key];
                  const level = cell ? rangeLevel(cell.value, row.ref) : "";
                  return (
                    <td className={`cl-matrix-cell${level ? ` is-${level}` : ""}`} key={column.key}>
                      {cell ? (onCellClick ? (
                        <button className="cl-cell-button" onClick={() => onCellClick(row, column, cell)} title={cellTitle} type="button">{cell.text}</button>
                      ) : cell.text) : ""}
                      {level ? <span aria-hidden="true" className="abn-mark">{level === "high" ? "↑" : "↓"}</span> : null}
                      {level ? <span className="sr-only">{level === "high" ? "（高い）" : "（低い）"}</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cl-graph-tools">
        <span className="cl-graph-title">グラフ</span>
        <label className="check-line small"><input checked={showRef} onChange={(event) => setShowRef(event.target.checked)} type="checkbox" />基準値の線</label>
        <span className="muted small">表の左のチェックで項目を選びます。</span>
      </div>
      {graphRows.length ? <MatrixGraphs columns={columns} rows={graphRows} showRef={showRef} /> : <p className="muted small">グラフに出す項目を選んでください。</p>}
    </div>
  );
}

export function rangeLevel(value, ref) {
  if (!ref || !Number.isFinite(value)) return "";
  if (Number.isFinite(ref.high) && value > ref.high) return "high";
  if (Number.isFinite(ref.low) && value < ref.low) return "low";
  return "";
}

function refText(row) {
  if (row.refText !== undefined) return row.refText;
  const ref = row.ref;
  if (!ref) return "";
  if (Number.isFinite(ref.low) && Number.isFinite(ref.high)) return `${ref.low}〜${ref.high}`;
  if (Number.isFinite(ref.low)) return `${ref.low}以上`;
  if (Number.isFinite(ref.high)) return `${ref.high}以下`;
  return "";
}

const H = 132;
const PAD = { left: 38, right: 12, top: 10, bottom: 22 };

// 単位ごとに 1 枚。横軸は日付（日数に比例）、縦軸は値。基準値は破線。
// 視力は 0.01〜2.0 の対数軸。軸の外の値・指数弁などは軸の端に三角の印で置く（黙って落とさない）。
function MatrixGraphs({ columns, rows, showRef }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const groups = useMemo(() => {
    const byUnit = new Map();
    rows.forEach((row) => {
      const unit = row.graphUnit || row.unit || "";
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit).push(row);
    });
    return [...byUnit.entries()];
  }, [rows]);
  const days = columns.map((column) => dayNumber(column.date));
  const minDay = Math.min(...days);
  const maxDay = Math.max(...days);
  const x = (column) => PAD.left + (maxDay === minDay ? (width - PAD.left - PAD.right) / 2 : ((dayNumber(column.date) - minDay) / (maxDay - minDay)) * (width - PAD.left - PAD.right));
  let seriesIndex = 0;

  return (
    <div className="cl-graphs" ref={ref}>
      {groups.map(([unit, groupRows]) => {
        if (unit === "視力") {
          const series = groupRows.map((row) => ({ row, index: seriesIndex++ }));
          return <VaMatrixGraph columns={columns} key={unit} labels={thinDates(columns, x)} series={series} showRef={showRef} width={width} x={x} />;
        }
        const values = groupRows.flatMap((row) => columns.map((column) => row.values[column.key]?.value).filter(Number.isFinite));
        const refs = showRef ? groupRows.flatMap((row) => [row.ref?.low, row.ref?.high].filter(Number.isFinite)) : [];
        let low = Math.min(...values, ...refs);
        let high = Math.max(...values, ...refs);
        if (low === high) { low -= 1; high += 1; }
        const span = high - low;
        low -= span * 0.08;
        high += span * 0.08;
        const y = (value) => PAD.top + (1 - (value - low) / (high - low)) * (H - PAD.top - PAD.bottom);
        const ticks = [low + span * 0.08, (low + high) / 2, high - span * 0.08].map((value) => Math.round(value * 100) / 100);
        const series = groupRows.map((row) => ({ row, index: seriesIndex++ }));
        const labels = thinDates(columns, x);
        return (
          <figure className="cl-graph" key={unit || "none"}>
            <figcaption className="cl-legend">
              {series.map(({ row, index }) => <span className={`cl-legend-item cl-series-${index % 6}`} key={row.key}><span aria-hidden="true" className="cl-legend-swatch" />{row.label}</span>)}
              {unit ? <span className="muted small">（{unit}）</span> : null}
            </figcaption>
            <svg aria-label={`${series.map(({ row }) => row.label).join("・")}の経過`} className="cl-graph-svg" height={H} role="img" width={width}>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line className="cl-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                  <text className="cl-axis-text" textAnchor="end" x={PAD.left - 4} y={y(tick) + 4}>{formatTick(tick)}</text>
                </g>
              ))}
              {labels.map((column) => <text className="cl-axis-text" key={column.key} textAnchor="middle" x={x(column)} y={H - 6}>{column.axisLabel || column.label}</text>)}
              {showRef ? refLines(series).map(({ key, kind, value, index, label }) => (
                <g key={key}>
                  <line className={`cl-ref-line ${index === null ? "is-shared" : `cl-series-${index % 6}`}`} x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} />
                  <text className="cl-ref-text" textAnchor="end" x={width - PAD.right} y={y(value) - 3}>{label} {kind === "low" ? "下限" : "上限"} {value}</text>
                </g>
              )) : null}
              {series.map(({ row, index }) => {
                const points = columns.filter((column) => Number.isFinite(row.values[column.key]?.value)).map((column) => [x(column), y(row.values[column.key].value), column]);
                return (
                  <g className={`cl-series cl-series-${index % 6}`} key={row.key}>
                    {points.length > 1 ? <polyline fill="none" points={points.map(([px, py]) => `${px},${py}`).join(" ")} /> : null}
                    {points.map(([px, py, column]) => (
                      <circle cx={px} cy={py} key={column.key} r={3}><title>{`${column.label} ${row.label} ${row.values[column.key].text}`}</title></circle>
                    ))}
                  </g>
                );
              })}
            </svg>
          </figure>
        );
      })}
    </div>
  );
}

function VaMatrixGraph({ columns, series, showRef, width, x, labels }) {
  const axis = vaFixedAxis({ top: PAD.top, bottom: H - PAD.bottom });
  return (
    <figure className="cl-graph">
      <figcaption className="cl-legend">
        {series.map(({ row, index }) => <span className={`cl-legend-item cl-series-${index % 6}`} key={row.key}><span aria-hidden="true" className="cl-legend-swatch" />{row.label}</span>)}
        <span className="muted small">（視力・対数）</span>
      </figcaption>
      <svg aria-label={`${series.map(({ row }) => row.label).join("・")}の経過`} className="cl-graph-svg" height={H} role="img" width={width}>
        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line className="cl-grid" x1={PAD.left} x2={width - PAD.right} y1={axis.y(tick)} y2={axis.y(tick)} />
            <text className="cl-axis-text" textAnchor="end" x={PAD.left - 4} y={axis.y(tick) + 4}>{tick < 0.1 ? tick.toFixed(2) : tick.toFixed(1)}</text>
          </g>
        ))}
        {labels.map((column) => <text className="cl-axis-text" key={column.key} textAnchor="middle" x={x(column)} y={H - 6}>{column.axisLabel || column.label}</text>)}
        {showRef ? refLines(series).map(({ key, kind, value, index, label }) => (
          <g key={key}>
            <line className={`cl-ref-line ${index === null ? "is-shared" : `cl-series-${index % 6}`}`} x1={PAD.left} x2={width - PAD.right} y1={axis.y(value)} y2={axis.y(value)} />
            <text className="cl-ref-text" textAnchor="end" x={width - PAD.right} y={axis.y(value) - 3}>{label} {kind === "low" ? "下限" : "上限"} {value}</text>
          </g>
        )) : null}
        {series.map(({ row, index }) => {
          const points = columns
            .map((column) => ({ column, cell: row.values[column.key] }))
            .filter(({ cell }) => cell)
            .map(({ column, cell }) => ({ column, cell, place: vaPoint(cell.value, cell.text, axis) }))
            .filter(({ place }) => place);
          const line = points.filter(({ cell }) => Number.isFinite(cell.value));
          return (
            <g className={`cl-series cl-series-${index % 6}`} key={row.key}>
              {line.length > 1 ? <polyline fill="none" points={line.map(({ column, place }) => `${x(column)},${place.y}`).join(" ")} /> : null}
              {points.map(({ column, cell, place }) => (place.edge ? (
                <path className="cl-edge-mark" d={edgeMarkPath(x(column), place.y, place.edge)} key={column.key}>
                  <title>{`${column.label} ${row.label} ${cell.text}（${place.note}）`}</title>
                </path>
              ) : (
                <circle cx={x(column)} cy={place.y} key={column.key} r={3}><title>{`${column.label} ${row.label} ${cell.text}`}</title></circle>
              )))}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

// 基準値の線。同じ値の線（R・L で同じ基準値など）は 1 本にまとめ、色は付けずに「基準値」とだけ書く。
function refLines(series) {
  const lines = new Map();
  for (const { row, index } of series) {
    for (const [kind, value] of [["low", row.ref?.low], ["high", row.ref?.high]]) {
      if (!Number.isFinite(value)) continue;
      const key = `${kind}-${value}`;
      const line = lines.get(key);
      if (line) {
        line.index = null;
        line.label = "基準値";
      } else {
        lines.set(key, { key, kind, value, index, label: row.refLabel || row.label });
      }
    }
  }
  return [...lines.values()];
}

function thinDates(columns, x) {
  const picked = [];
  let last = -Infinity;
  for (const column of columns) {
    const position = x(column);
    if (position - last >= 54) {
      picked.push(column);
      last = position;
    }
  }
  return picked;
}

function formatTick(value) {
  return Math.abs(value) >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function dayNumber(iso) {
  return Math.round(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / 86400000);
}
