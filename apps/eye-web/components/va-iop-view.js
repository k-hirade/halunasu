"use client";

import { useEffect, useRef, useState } from "react";
import { formatDate } from "../lib/format";
import { iopAxis, thinLabels, vaAxis } from "../lib/trend-scale.mjs";
import { IOP_METHOD_LABELS, VA_CORRECTION_TYPE_LABELS } from "../lib/format";

// 視力眼圧（トプコンのカルテ右上タブ「視力眼圧」に倣う）。
// 上に「視力の表 | 眼圧の表」、下に「眼圧のグラフ」「視力のグラフ」を縦に並べる。系列はチェックで切り替える。
// points は buildTrend(...).points（古い → 新しい）。カルテ画面からも使えるように、ほかの状態は持たない。
const PAD = { left: 48, right: 28, top: 14, bottom: 22 };
const PLOT_H = 150;
const IOP_SERIES = [
  { key: "iop-od", side: "od", field: "iop", label: "眼圧(右)", className: "series-od" },
  { key: "iop-os", side: "os", field: "iop", label: "眼圧(左)", className: "series-os" }
];
const VA_SERIES = [
  { key: "va-cor-od", side: "od", field: "vaCorrected", labelField: "vaCorrectedLabel", label: "矯正(右)", className: "series-od" },
  { key: "va-cor-os", side: "os", field: "vaCorrected", labelField: "vaCorrectedLabel", label: "矯正(左)", className: "series-os" },
  { key: "va-unc-od", side: "od", field: "vaUncorrected", labelField: "vaUncorrectedLabel", label: "裸眼(右)", className: "series-od is-dashed" },
  { key: "va-unc-os", side: "os", field: "vaUncorrected", labelField: "vaUncorrectedLabel", label: "裸眼(左)", className: "series-os is-dashed" }
];

export function VaIopView({ points = [], emptyText = "確定済みのカルテがまだないため、視力・眼圧の記録はありません。" }) {
  const [shown, setShown] = useState(() => new Set([...IOP_SERIES, ...VA_SERIES].map((series) => series.key)));
  if (!points.length) return <p className="empty">{emptyText}</p>;
  const newestFirst = [...points].reverse();
  const toggle = (key) => setShown((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <div className="vi-view">
      <div className="vi-tables">
        <div className="vi-table-wrap" aria-label="視力の記録" role="region" tabIndex={0}>
          <table className="vi-table">
            <thead>
              <tr><th scope="col">検査日</th><th scope="col">種</th><th scope="col">遠近</th><th scope="col">右眼</th><th scope="col">左眼</th></tr>
            </thead>
            <tbody>
              {newestFirst.flatMap((point) => {
                const rows = [];
                const type = typeLabel(point);
                if (hasFar(point.od) || hasFar(point.os)) {
                  rows.push(
                    <tr key={`${point.encounterId}-far`}>
                      <td className="mono">{formatDate(point.encounterDate)}</td>
                      <td>{type}</td>
                      <td>遠</td>
                      <td className="vi-od">{farText(point.od)}</td>
                      <td className="vi-os">{farText(point.os)}</td>
                    </tr>
                  );
                }
                if (point.od?.vaNearLabel || point.os?.vaNearLabel) {
                  rows.push(
                    <tr key={`${point.encounterId}-near`}>
                      <td className="mono">{rows.length ? "" : formatDate(point.encounterDate)}</td>
                      <td>{rows.length ? "" : type}</td>
                      <td>近</td>
                      <td className="vi-od">{point.od?.vaNearLabel || "—"}</td>
                      <td className="vi-os">{point.os?.vaNearLabel || "—"}</td>
                    </tr>
                  );
                }
                return rows;
              })}
            </tbody>
          </table>
        </div>
        <div className="vi-table-wrap is-iop" aria-label="眼圧の記録" role="region" tabIndex={0}>
          <table className="vi-table">
            <thead>
              <tr><th scope="col">検査日</th><th scope="col">方式</th><th scope="col">右眼</th><th scope="col">左眼</th></tr>
            </thead>
            <tbody>
              {newestFirst.filter((point) => isNumber(point.od?.iop) || isNumber(point.os?.iop)).map((point) => (
                <tr key={point.encounterId}>
                  <td className="mono">{formatDate(point.encounterDate)}</td>
                  <td>{IOP_METHOD_LABELS[point.od?.iopMethod || point.os?.iopMethod] || "—"}</td>
                  <td className="vi-od">{iopText(point.od)}</td>
                  <td className="vi-os">{iopText(point.os)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <SeriesChart kind="iop" points={points} series={IOP_SERIES} shown={shown} title="眼圧" toggle={toggle} unit="mmHg" />
      <SeriesChart kind="va" points={points} series={VA_SERIES} shown={shown} title="視力" toggle={toggle} />
    </div>
  );
}

function SeriesChart({ kind, title, unit = "", points, series, shown, toggle }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const active = series.filter((item) => shown.has(item.key));
  const values = points.flatMap((point) => active.map((item) => point[item.side]?.[item.field])).filter(isNumber);
  const band = { top: PAD.top, bottom: PAD.top + PLOT_H };
  const axis = values.length ? (kind === "va" ? vaAxis(values, band) : iopAxis(values, band)) : null;
  const height = band.bottom + PAD.bottom;
  const left = PAD.left;
  const right = width - PAD.right;
  const days = points.map((point) => dayNumber(point.encounterDate));
  const min = Math.min(...days);
  const max = Math.max(...days);
  const xOf = (iso) => (max === min ? (left + right) / 2 : left + ((dayNumber(iso) - min) / (max - min)) * (right - left));
  const labels = thinLabels(points.map((point) => ({ key: point.encounterId, iso: point.encounterDate, x: xOf(point.encounterDate) })));
  const format = kind === "va" ? formatVa : String;
  return (
    <section className={`vi-chart is-${kind}`} aria-label={`${title}のグラフ`}>
      <div className="vi-chart-head">
        <strong>{title}{unit ? <span className="vi-unit">（{unit}）</span> : null}</strong>
        <span className="vi-series" role="group" aria-label={`${title}の表示する系列`}>
          {series.map((item) => (
            <label className={`vi-series-item ${item.className}`} key={item.key}>
              <input checked={shown.has(item.key)} onChange={() => toggle(item.key)} type="checkbox" />
              <span className="vi-swatch" aria-hidden="true" />
              {item.label}
            </label>
          ))}
        </span>
      </div>
      <div className="vi-plot" ref={ref}>
        <svg className="trend-svg vi-svg" height={height} role="img" aria-label={`${title}の推移`} viewBox={`0 0 ${width} ${height}`} width={width}>
          {axis ? axis.ticks.map((tick) => (
            <g key={tick}>
              <line className="grid" x1={left} x2={right} y1={axis.y(tick)} y2={axis.y(tick)} />
              <text className="axis" textAnchor="end" x={left - 6} y={axis.y(tick) + 4}>{format(tick)}</text>
            </g>
          )) : <text className="axis" x={left} y={band.top + PLOT_H / 2}>表示する値がありません</text>}
          {axis ? active.map((item) => {
            const list = points.filter((point) => isNumber(point[item.side]?.[item.field]));
            if (!list.length) return null;
            const path = list.map((point, index) => `${index ? "L" : "M"}${xOf(point.encounterDate)},${axis.y(point[item.side][item.field])}`).join(" ");
            return (
              <g className={item.className} key={item.key}>
                {list.length > 1 ? <path className="line" d={path} /> : null}
                {list.map((point) => {
                  const value = point[item.side][item.field];
                  const x = xOf(point.encounterDate);
                  const y = axis.y(value);
                  const text = kind === "va" ? point[item.side][item.labelField] || formatVa(value) : String(value);
                  return (
                    <g key={point.encounterId}>
                      <circle className="dot" cx={x} cy={y} r={3.5} />
                      <text className="vi-value" textAnchor="middle" x={x} y={item.side === "od" ? y - 7 : y + 14}>{text}</text>
                      <title>{`${formatDate(point.encounterDate)} ${item.label} ${text}${unit ? ` ${unit}` : ""}`}</title>
                    </g>
                  );
                })}
              </g>
            );
          }) : null}
          {labels.map((item) => <text className="axis" key={item.key} textAnchor="middle" x={item.x} y={height - 4}>{formatDate(item.iso).slice(2)}</text>)}
        </svg>
      </div>
    </section>
  );
}

function typeLabel(point) {
  const type = point.od?.vaCorrectionType || point.os?.vaCorrectionType;
  return VA_CORRECTION_TYPE_LABELS[type] || "自覚";
}

function hasFar(eye) {
  return Boolean(eye?.vaUncorrectedLabel || eye?.vaCorrectedLabel);
}

// 「0.3（1.0×S-1.00 C-0.50 A180）」の形
export function farText(eye) {
  if (!hasFar(eye)) return "—";
  const correction = eye.correction || {};
  const lens = [
    isNumber(correction.sphere) ? `S${signed(correction.sphere)}` : "",
    isNumber(correction.cylinder) ? `C${signed(correction.cylinder)}` : "",
    isNumber(correction.axis) ? `A${correction.axis}` : ""
  ].filter(Boolean).join(" ");
  const inner = eye.vaCorrectedLabel || lens ? `（${eye.vaCorrectedLabel || "—"}${lens ? `×${lens}` : ""}）` : "";
  return `${eye.vaUncorrectedLabel || "—"}${inner}`;
}

function iopText(eye) {
  if (!isNumber(eye?.iop)) return "—";
  return eye.iopReadings?.length > 1 ? `${eye.iop}（${eye.iopReadings.join(" ")}）` : String(eye.iop);
}

function signed(value) {
  const fixed = Number(value).toFixed(2);
  return value > 0 ? `+${fixed}` : fixed;
}

function formatVa(value) {
  return value < 0.1 ? value.toFixed(2) : value.toFixed(1);
}

function dayNumber(iso) {
  return Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / 86400000;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
