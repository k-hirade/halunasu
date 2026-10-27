"use client";

import { useEffect, useRef, useState } from "react";
import { formatDate } from "../lib/format";

const HEIGHT = 190;
const PAD = { left: 48, right: 40, top: 14, bottom: 28 };
const SIDE_STYLE = {
  od: { label: "右眼", className: "series-od" },
  os: { label: "左眼", className: "series-os" }
};
const VA_TICKS = [0.01, 0.1, 0.3, 1.0];

// 視力（対数軸）と眼圧の推移。点眼の開始・中止と注射を時間軸の下に並べる。
export function TrendPanel({ trend }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  const points = trend?.points || [];
  if (points.length === 0) {
    return <p className="empty" ref={containerRef}>確定済みのカルテがまだないため、経過は表示できません。</p>;
  }
  const times = points.map((point) => Date.parse(`${point.encounterDate}T00:00:00Z`));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const xOf = (iso) => {
    if (maxTime === minTime) return (PAD.left + width - PAD.right) / 2;
    const ratio = (Date.parse(`${iso}T00:00:00Z`) - minTime) / (maxTime - minTime);
    return PAD.left + ratio * (width - PAD.left - PAD.right);
  };

  return (
    <div className="trend" ref={containerRef}>
      <div className="legend">
        <span className="legend-item series-od">● 右眼</span>
        <span className="legend-item series-os">● 左眼</span>
      </div>
      <Chart
        ariaLabel="矯正視力の推移"
        width={width}
        title="視力（矯正優先）"
        points={points}
        xOf={xOf}
        valueOf={(point, side) => point[side].va}
        yScale={vaScale}
        ticks={VA_TICKS}
        format={(value) => value.toFixed(value < 0.1 ? 2 : 1)}
      />
      <Chart
        ariaLabel="眼圧の推移"
        width={width}
        title="眼圧 (mmHg)"
        points={points}
        xOf={xOf}
        valueOf={(point, side) => point[side].iop}
        yScale={iopScale(points)}
        ticks={iopTicks(points)}
        format={(value) => String(value)}
        threshold={21}
      />
      <EventRows trend={trend} />
    </div>
  );
}

function Chart({ ariaLabel, width, title, points, xOf, valueOf, yScale, ticks, format, threshold }) {
  const plotBottom = HEIGHT - PAD.bottom;
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg aria-label={ariaLabel} role="img" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} width={width}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={yScale(tick)} y2={yScale(tick)} />
            <text className="axis" textAnchor="end" x={PAD.left - 6} y={yScale(tick) + 4}>{format(tick)}</text>
          </g>
        ))}
        {threshold ? (
          <line className="threshold" x1={PAD.left} x2={width - PAD.right} y1={yScale(threshold)} y2={yScale(threshold)} />
        ) : null}
        {points.map((point) => (
          <text className="axis" key={point.encounterId} textAnchor="middle" x={xOf(point.encounterDate)} y={plotBottom + 16}>
            {formatDate(point.encounterDate).slice(2)}
          </text>
        ))}
        {Object.entries(SIDE_STYLE).map(([side, style]) => {
          const series = points
            .map((point) => ({ point, value: valueOf(point, side) }))
            .filter(({ value }) => value !== null && value !== undefined);
          const path = series.map(({ point, value }, index) => `${index === 0 ? "M" : "L"}${xOf(point.encounterDate)},${yScale(value)}`).join(" ");
          return (
            <g className={style.className} key={side}>
              {series.length > 1 ? <path className="line" d={path} /> : null}
              {series.map(({ point, value }) => (
                <circle className="dot" cx={xOf(point.encounterDate)} cy={yScale(value)} key={point.encounterId} r="4">
                  <title>{`${style.label} ${formatDate(point.encounterDate)}: ${format(value)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function EventRows({ trend }) {
  const events = [
    ...(trend.medicationEvents || []).map((event) => ({ ...event, kind: event.type })),
    ...(trend.injections || []).map((event) => ({ ...event, kind: "injection" }))
  ].sort((left, right) => left.encounterDate.localeCompare(right.encounterDate));
  if (events.length === 0) return null;
  const labels = { started: "開始", stopped: "中止", injection: "注射" };
  return (
    <div className="events">
      <h4>点眼・注射の変更</h4>
      <ol>
        {events.map((event, index) => (
          <li className={`event event-${event.kind}`} key={`${event.encounterDate}-${index}`}>
            <span className="event-date">{formatDate(event.encounterDate)}</span>
            <span className="event-kind">{labels[event.kind]}</span>
            <span>{event.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function vaScale(value) {
  const min = Math.log10(0.01);
  const max = Math.log10(2.0);
  const ratio = (Math.log10(Math.max(0.01, Math.min(2.0, value))) - min) / (max - min);
  return HEIGHT - PAD.bottom - ratio * (HEIGHT - PAD.top - PAD.bottom);
}

function iopRange(points) {
  const values = points.flatMap((point) => [point.od.iop, point.os.iop]).filter((value) => Number.isFinite(value));
  const max = Math.max(30, ...values);
  return { min: 0, max: Math.ceil(max / 10) * 10 };
}

function iopScale(points) {
  const { min, max } = iopRange(points);
  return (value) => HEIGHT - PAD.bottom - ((value - min) / (max - min)) * (HEIGHT - PAD.top - PAD.bottom);
}

function iopTicks(points) {
  const { max } = iopRange(points);
  return Array.from({ length: max / 10 + 1 }, (_, index) => index * 10);
}
