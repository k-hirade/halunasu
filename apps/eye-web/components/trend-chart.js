"use client";

import { useEffect, useRef, useState } from "react";
import { formatDate, todayIso } from "../lib/format";
import { iopAxis, thinLabels, vaAxis } from "../lib/trend-scale.mjs";

// 視力（対数軸）と眼圧を同じ時間軸の上下 2 段に描き、間の「点眼」行に開始▲・中止▼・注射◆の印を置く。
const BAND = 112;
const MARK_ROW = 22;
const GAP = 10;
const AXIS_H = 20;
const PAD = { left: 66, right: 44, top: 10 };
const SIDES = [
  { side: "od", label: "右眼", short: "右", className: "series-od" },
  { side: "os", label: "左眼", short: "左", className: "series-os" }
];
const MARK_LABELS = { started: "開始", stopped: "中止", injection: "注射" };
const PERIODS = [
  { key: "1y", label: "1年", years: 1 },
  { key: "3y", label: "3年", years: 3 },
  { key: "all", label: "全期間", years: null }
];

export function TrendPanel({ trend }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(640);
  const [show, setShow] = useState({ va: true, iop: true });
  const [period, setPeriod] = useState("all");
  const [active, setActive] = useState(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setActive(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const allPoints = trend?.points || [];
  if (allPoints.length === 0) {
    return <p className="empty" ref={containerRef}>確定済みのカルテがまだないため、経過は表示できません。</p>;
  }

  const firstDate = allPoints[0].encounterDate;
  const spanYears = (dayNumber(todayIso()) - dayNumber(firstDate)) / 365;
  const periods = PERIODS.filter((item) => item.years === null || spanYears > item.years);
  const cutoff = periodCutoff(periods.some((item) => item.key === period) ? period : "all");
  const points = allPoints.filter((point) => point.encounterDate >= cutoff);
  const marks = buildMarks(trend, cutoff);

  const toggle = (key) => setShow((current) => {
    const next = { ...current, [key]: !current[key] };
    return next.va || next.iop ? next : current;
  });

  return (
    <div className="trend" ref={containerRef}>
      <div className="trend-head">
        <div aria-label="表示する値" className="trend-toggles" role="group">
          <button aria-pressed={show.va} className="btn btn-chip btn-sm" onClick={() => toggle("va")} type="button">視力</button>
          <button aria-pressed={show.iop} className="btn btn-chip btn-sm" onClick={() => toggle("iop")} type="button">眼圧</button>
        </div>
        <span className="trend-legend">
          <span className="legend-item series-od">● 右眼</span>
          <span className="legend-item series-os">● 左眼</span>
        </span>
        {periods.length > 1 ? (
          <select aria-label="期間" className="input trend-period" onChange={(event) => setPeriod(event.target.value)} value={period}>
            {periods.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        ) : null}
      </div>
      {points.length === 0 ? <p className="empty">この期間の記録はありません。</p> : (
        <div className="trend-plot">
          <TrendSvg
            active={active}
            marks={marks}
            onActivate={setActive}
            points={points}
            show={show}
            width={width}
          />
          {active ? (
            <div className="trend-pop" role="status" style={{ left: Math.max(4, Math.min(active.x - 90, width - 184)), top: active.y + 12 }}>
              {active.lines.map((line, index) => <div key={index}>{line}</div>)}
            </div>
          ) : null}
        </div>
      )}
      <p className="trend-note">視力は矯正視力（なければ裸眼）。点や印を押すと値が出ます。</p>
    </div>
  );
}

function TrendSvg({ points, marks, show, width, onActivate, active }) {
  const plotLeft = PAD.left;
  const plotRight = width - PAD.right;
  const times = points.map((point) => dayNumber(point.encounterDate));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const xOf = (iso) => {
    if (maxTime === minTime) return (plotLeft + plotRight) / 2;
    return plotLeft + ((dayNumber(iso) - minTime) / (maxTime - minTime)) * (plotRight - plotLeft);
  };

  let y = PAD.top;
  const vaBand = show.va ? { top: y, bottom: y + BAND } : null;
  if (vaBand) y = vaBand.bottom + GAP;
  const markBand = { top: y, bottom: y + MARK_ROW };
  y = markBand.bottom + GAP;
  const iopBand = show.iop ? { top: y, bottom: y + BAND } : null;
  if (iopBand) y = iopBand.bottom + 4;
  const height = y + AXIS_H;

  const vaValues = points.flatMap((point) => [point.od?.va, point.os?.va]).filter(isNumber);
  const iopValues = points.flatMap((point) => [point.od?.iop, point.os?.iop]).filter(isNumber);
  const va = vaBand && vaValues.length ? vaAxis(vaValues, vaBand) : null;
  const iop = iopBand && iopValues.length ? iopAxis(iopValues, iopBand) : null;

  const labels = thinLabels(points.map((point) => ({ key: point.encounterId, iso: point.encounterDate, x: xOf(point.encounterDate) })));
  const shortDate = (iso) => formatDate(iso).slice(2);

  const activate = (event, x, yPos, lines) => {
    event.stopPropagation();
    if (active && active.x === x && active.y === yPos) onActivate(null);
    else onActivate({ x, y: yPos, lines });
  };

  return (
    <svg
      aria-label="視力と眼圧の推移"
      className="trend-svg"
      height={height}
      onClick={() => onActivate(null)}
      role="group"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      {vaBand ? (
        <Band band={vaBand} label="視力" unit="" axis={va} format={formatVa} plotLeft={plotLeft} plotRight={plotRight} />
      ) : null}
      <g className="trend-marks">
        <text className="band-label" x={4} y={markBand.top + 15}>点眼</text>
        <line className="mark-rule" x1={plotLeft} x2={plotRight} y1={markBand.top + MARK_ROW / 2} y2={markBand.top + MARK_ROW / 2} />
        {marks.map((mark) => {
          const x = xOf(mark.encounterDate) + mark.offset;
          const cy = markBand.top + MARK_ROW / 2;
          const lines = [`${formatDate(mark.encounterDate)} ${MARK_LABELS[mark.kind]}`, ...mark.labels];
          return (
            <g
              aria-label={lines.join(" ")}
              className={`mark mark-${mark.kind}`}
              key={`${mark.encounterDate}-${mark.kind}`}
              onClick={(event) => activate(event, x, cy, lines)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(event, x, cy, lines); } }}
              role="button"
              tabIndex={0}
            >
              <title>{lines.join("\n")}</title>
              <rect className="mark-hit" height={MARK_ROW} width={16} x={x - 8} y={markBand.top} />
              <path d={markPath(mark.kind, x, cy)} />
            </g>
          );
        })}
      </g>
      {iopBand ? (
        <Band band={iopBand} label="眼圧" unit="mmHg" axis={iop} format={String} plotLeft={plotLeft} plotRight={plotRight} />
      ) : null}
      {[va && { axis: va, key: "va", format: formatVa, unit: "" }, iop && { axis: iop, key: "iop", format: String, unit: " mmHg" }]
        .filter(Boolean)
        .map(({ axis, key, format, unit }) => {
          const lastLabels = [];
          return (
            <g key={key}>
              {SIDES.map(({ side, label, short, className }) => {
                const series = points
                  .map((point) => ({ point, value: point[side]?.[key] }))
                  .filter(({ value }) => isNumber(value));
                if (series.length === 0) return null;
                const path = series.map(({ point, value }, index) => `${index === 0 ? "M" : "L"}${xOf(point.encounterDate)},${axis.y(value)}`).join(" ");
                const last = series.at(-1);
                let labelY = axis.y(last.value) + 4;
                for (const other of lastLabels) {
                  if (Math.abs(other - labelY) < 12) labelY = other + (labelY >= other ? 12 : -12);
                }
                lastLabels.push(labelY);
                return (
                  <g className={className} key={side}>
                    {series.length > 1 ? <path className="line" d={path} /> : null}
                    {series.map(({ point, value }) => {
                      const x = xOf(point.encounterDate);
                      const cy = axis.y(value);
                      const text = `${formatDate(point.encounterDate)} ${label} ${key === "va" ? point[side].vaLabel || format(value) : format(value)}${unit}`;
                      return (
                        <g className="dot-hit" key={point.encounterId} onClick={(event) => activate(event, x, cy, [text])}>
                          <circle className="dot" cx={x} cy={cy} r="4" />
                          <circle className="hit" cx={x} cy={cy} r="10" />
                          <title>{text}</title>
                        </g>
                      );
                    })}
                    <text className="last-label" x={xOf(last.point.encounterDate) + 8} y={labelY}>
                      {short} {key === "va" ? last.point[side].vaLabel || format(last.value) : format(last.value)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      {labels.map((item) => (
        <text className="axis" key={item.key} textAnchor="middle" x={item.x} y={height - 6}>{shortDate(item.iso)}</text>
      ))}
    </svg>
  );
}

function Band({ band, label, unit, axis, format, plotLeft, plotRight }) {
  return (
    <g>
      <text className="band-label" x={4} y={band.top + 12}>{label}</text>
      {unit ? <text className="band-unit" x={4} y={band.top + 26}>{unit}</text> : null}
      {axis ? axis.ticks.map((tick) => (
        <g key={tick}>
          <line className="grid" x1={plotLeft} x2={plotRight} y1={axis.y(tick)} y2={axis.y(tick)} />
          <text className="axis" textAnchor="end" x={plotLeft - 6} y={axis.y(tick) + 4}>{format(tick)}</text>
        </g>
      )) : <text className="axis" x={plotLeft} y={band.top + BAND / 2}>記録なし</text>}
    </g>
  );
}

function buildMarks(trend, cutoff) {
  const groups = new Map();
  const add = (encounterDate, kind, label) => {
    if (!encounterDate || encounterDate < cutoff) return;
    const key = `${encounterDate}|${kind}`;
    if (!groups.has(key)) groups.set(key, { encounterDate, kind, labels: [] });
    groups.get(key).labels.push(label);
  };
  for (const event of trend?.medicationEvents || []) add(event.encounterDate, event.type, event.label);
  for (const event of trend?.injections || []) add(event.encounterDate, "injection", event.label);
  const order = { started: 0, stopped: 1, injection: 2 };
  const marks = [...groups.values()].sort((left, right) => left.encounterDate.localeCompare(right.encounterDate) || order[left.kind] - order[right.kind]);
  // 同じ日の印は横に少しずらす
  const perDate = new Map();
  for (const mark of marks) perDate.set(mark.encounterDate, [...(perDate.get(mark.encounterDate) || []), mark]);
  for (const list of perDate.values()) {
    list.forEach((mark, index) => { mark.offset = (index - (list.length - 1) / 2) * 12; });
  }
  return marks;
}

function markPath(kind, x, y) {
  if (kind === "started") return `M${x},${y - 6} L${x + 6},${y + 5} L${x - 6},${y + 5} Z`;
  if (kind === "stopped") return `M${x - 6},${y - 5} L${x + 6},${y - 5} L${x},${y + 6} Z`;
  return `M${x},${y - 6} L${x + 6},${y} L${x},${y + 6} L${x - 6},${y} Z`;
}

function periodCutoff(key) {
  const period = PERIODS.find((item) => item.key === key);
  if (!period?.years) return "";
  const [year, month, day] = todayIso().split("-");
  return `${Number(year) - period.years}-${month}-${day}`;
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
