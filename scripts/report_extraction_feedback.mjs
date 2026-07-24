#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TOP_N = 10;
const DEFAULT_MAX_EVENTS = 50_000;

export function buildExtractionFeedbackReport(events = [], options = {}) {
  const normalized = (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event === "object")
    .map(normalizeEvent);
  const topN = positiveInteger(options.topN, DEFAULT_TOP_N);
  const outcomeCounts = countBy(normalized, (event) => event.outcome);
  const routeCounts = countBy(normalized, (event) => event.route);
  const rejectReasonCounts = countBy(
    normalized.filter((event) => event.outcome === "rejected"),
    (event) => event.rejectReason || "not_selected"
  );
  const featureTagCounts = countBy(
    normalized.flatMap((event) => event.failureFeatureTags),
    (value) => value
  );
  const holeRows = groupedRows(
    normalized.filter((event) => event.failureFeatureTags.length),
    (event) => `${event.specialty}\u001f${event.category}`,
    ([specialty, category], rows) => ({
      specialty,
      category,
      count: rows.length,
      featureTags: topEntries(countBy(
        rows.flatMap((event) => event.failureFeatureTags),
        (value) => value
      ), 5)
    })
  ).slice(0, topN);
  const rejectionRows = groupedRows(
    normalized.filter((event) => ["approved", "rejected", "corrected"].includes(event.outcome)),
    (event) => `${event.specialty}\u001f${event.category}\u001f${event.code}`,
    ([specialty, category, code], rows) => {
      const rejected = rows.filter((event) => event.outcome === "rejected").length;
      return {
        specialty,
        category,
        code,
        decisionCount: rows.length,
        rejectedCount: rejected,
        rejectionRate: rows.length ? rejected / rows.length : 0
      };
    },
    (left, right) => (
      right.rejectionRate - left.rejectionRate
      || right.decisionCount - left.decisionCount
      || `${left.specialty}:${left.category}:${left.code}`
        .localeCompare(`${right.specialty}:${right.category}:${right.code}`)
    )
  ).slice(0, topN);
  const confidenceCalibration = confidenceBuckets(normalized);
  return {
    schemaVersion: 1,
    generatedAt: String(options.generatedAt || new Date().toISOString()),
    period: {
      since: options.since || null,
      until: options.until || null
    },
    eventCount: normalized.length,
    learningEligibleCount: normalized.filter((event) => event.learningEligible).length,
    outcomeCounts,
    routeCounts,
    rejectReasonCounts,
    featureTagCounts,
    holesTopN: holeRows,
    rejectedPatternsTopN: rejectionRows,
    confidenceCalibration
  };
}

export function renderExtractionFeedbackMarkdown(report) {
  const lines = [
    "# 診療報酬抽出フィードバック週次レポート",
    "",
    `- 生成日時: ${report.generatedAt}`,
    `- 対象期間: ${report.period.since || "指定なし"} 〜 ${report.period.until || "指定なし"}`,
    `- イベント数: ${report.eventCount}`,
    `- 学習利用可能な構造化シグナル: ${report.learningEligibleCount}`,
    "",
    "## 結果概要",
    "",
    markdownKeyValueTable("結果", report.outcomeCounts),
    "",
    markdownKeyValueTable("経路", report.routeCounts),
    "",
    markdownKeyValueTable("却下理由", report.rejectReasonCounts),
    "",
    "## エンコーダの穴 Top-N（診療科 × カテゴリ）",
    "",
    "| 診療科 | カテゴリ | 件数 | 主な特徴タグ |",
    "| --- | --- | ---: | --- |",
    ...report.holesTopN.map((row) => (
      `| ${escapeCell(row.specialty)} | ${escapeCell(row.category)} | ${row.count} | ${
        escapeCell(row.featureTags.map(([tag, count]) => `${tag}: ${count}`).join(", "))
      } |`
    )),
    ...(report.holesTopN.length ? [] : ["| - | - | 0 | - |"]),
    "",
    "## 却下率の高い候補パターン",
    "",
    "| 診療科 | カテゴリ | コード | 判断数 | 却下数 | 却下率 |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...report.rejectedPatternsTopN.map((row) => (
      `| ${escapeCell(row.specialty)} | ${escapeCell(row.category)} | ${escapeCell(row.code)} | ${
        row.decisionCount
      } | ${row.rejectedCount} | ${percentage(row.rejectionRate)} |`
    )),
    ...(report.rejectedPatternsTopN.length ? [] : ["| - | - | - | 0 | 0 | 0.0% |"]),
    "",
    "## Confidence較正",
    "",
    "| Confidence帯 | 判断数 | 承認 | 抽出誤り却下 | 観測正答率 | 帯中央値との差 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.confidenceCalibration.map((row) => (
      `| ${row.label} | ${row.decisionCount} | ${row.approvedCount} | ${
        row.extractionWrongCount
      } | ${percentage(row.observedAccuracy)} | ${percentage(row.calibrationGap)} |`
    )),
    ...(report.confidenceCalibration.length ? [] : ["| - | 0 | 0 | 0 | - | - |"]),
    "",
    "> 本レポートは本文・スパン原文・患者識別子を含まない構造化イベントだけから生成しています。",
    ""
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const until = args.until || new Date().toISOString();
  const since = args.since || new Date(
    Date.parse(until) - args.days * 24 * 60 * 60 * 1000
  ).toISOString();
  const events = args.input
    ? await readEventsFile(args.input)
    : await readFirestoreEvents({
      projectId: args.projectId,
      orgId: args.orgId,
      since,
      until,
      maxEvents: args.maxEvents
    });
  const report = buildExtractionFeedbackReport(events, {
    since,
    until,
    topN: args.topN
  });
  const outputDir = path.resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    ),
    writeFile(
      path.join(outputDir, "README.md"),
      renderExtractionFeedbackMarkdown(report),
      "utf8"
    )
  ]);
  process.stdout.write(`${outputDir}\n`);
}

async function readEventsFile(filePath) {
  const content = await readFile(path.resolve(filePath), "utf8");
  if (filePath.endsWith(".jsonl")) {
    return content.split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("feedback input JSON must be an array");
  }
  return parsed;
}

async function readFirestoreEvents({
  projectId,
  orgId,
  since,
  until,
  maxEvents
}) {
  if (!projectId || !orgId) {
    throw new Error("--project-id and --org-id are required without --input");
  }
  const { initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({
    credential: applicationDefault(),
    projectId
  }, `fee-feedback-report-${Date.now()}`);
  const collection = getFirestore(app)
    .collection("organizations")
    .doc(orgId)
    .collection("fee_extraction_feedback_events");
  const events = [];
  let cursor = null;
  while (events.length < maxEvents) {
    let query = collection
      .where("occurredAt", ">=", since)
      .where("occurredAt", "<=", until)
      .orderBy("occurredAt", "desc")
      .limit(Math.min(1000, maxEvents - events.length));
    if (cursor) {
      query = query.startAfter(cursor);
    }
    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }
    events.push(...snapshot.docs.map((doc) => doc.data()));
    cursor = snapshot.docs.at(-1);
    if (snapshot.size < 1000) {
      break;
    }
  }
  return events;
}

function normalizeEvent(event) {
  return {
    eventType: String(event.eventType || "unknown"),
    code: String(event.code || "unresolved"),
    category: String(event.category || "unknown"),
    specialty: String(event.specialty || "unknown"),
    confidence: finiteProbability(event.confidence),
    route: String(event.route || "unknown"),
    outcome: String(event.outcome || "observed"),
    rejectReason: event.rejectReason == null ? null : String(event.rejectReason),
    failureFeatureTags: [...new Set((Array.isArray(event.failureFeatureTags)
      ? event.failureFeatureTags
      : []).map(String))].sort(),
    learningEligible: event.learningEligible === true
  };
}

function confidenceBuckets(events) {
  const buckets = Array.from({ length: 10 }, (unused, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    approvedCount: 0,
    extractionWrongCount: 0
  }));
  for (const event of events) {
    if (event.confidence == null) continue;
    if (event.outcome !== "approved"
      && !(event.outcome === "rejected" && event.rejectReason === "extraction_wrong")) {
      continue;
    }
    const index = Math.min(9, Math.floor(event.confidence * 10));
    if (event.outcome === "approved") {
      buckets[index].approvedCount += 1;
    } else {
      buckets[index].extractionWrongCount += 1;
    }
  }
  return buckets.map((bucket) => {
    const decisionCount = bucket.approvedCount + bucket.extractionWrongCount;
    const observedAccuracy = decisionCount ? bucket.approvedCount / decisionCount : null;
    const midpoint = (bucket.lower + bucket.upper) / 2;
    return {
      label: `${bucket.lower.toFixed(1)}–${bucket.upper.toFixed(1)}`,
      decisionCount,
      approvedCount: bucket.approvedCount,
      extractionWrongCount: bucket.extractionWrongCount,
      observedAccuracy,
      calibrationGap: observedAccuracy == null ? null : Math.abs(observedAccuracy - midpoint)
    };
  }).filter((bucket) => bucket.decisionCount > 0);
}

function groupedRows(events, keyFor, rowFor, sorter = null) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFor(event);
    const rows = groups.get(key) || [];
    rows.push(event);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, rows]) => (
    rowFor(key.split("\u001f"), rows)
  )).sort(sorter || ((left, right) => (
    right.count - left.count
    || JSON.stringify(left).localeCompare(JSON.stringify(right))
  )));
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = String(keyFor(value) || "unknown");
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

function topEntries(counts, limit) {
  return Object.entries(counts).sort((left, right) => (
    right[1] - left[1] || left[0].localeCompare(right[0])
  )).slice(0, limit);
}

function markdownKeyValueTable(label, values) {
  const rows = Object.entries(values);
  return [
    `| ${label} | 件数 |`,
    "| --- | ---: |",
    ...(rows.length ? rows.map(([key, count]) => `| ${escapeCell(key)} | ${count} |`) : ["| - | 0 |"])
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    input: "",
    projectId: "",
    orgId: "",
    since: "",
    until: "",
    days: 7,
    topN: DEFAULT_TOP_N,
    maxEvents: DEFAULT_MAX_EVENTS,
    outputDir: `docs/fee-extraction-feedback/${timestampForPath(new Date())}`
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--input") args.input = value, index += 1;
    else if (option === "--project-id") args.projectId = value, index += 1;
    else if (option === "--org-id") args.orgId = value, index += 1;
    else if (option === "--since") args.since = value, index += 1;
    else if (option === "--until") args.until = value, index += 1;
    else if (option === "--days") args.days = positiveInteger(value, 7), index += 1;
    else if (option === "--top") args.topN = positiveInteger(value, DEFAULT_TOP_N), index += 1;
    else if (option === "--max-events") args.maxEvents = positiveInteger(value, DEFAULT_MAX_EVENTS), index += 1;
    else if (option === "--output-dir") args.outputDir = value, index += 1;
    else throw new Error(`unknown or incomplete option: ${option}`);
  }
  return args;
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function finiteProbability(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function percentage(value) {
  return value == null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function timestampForPath(date) {
  return date.toISOString().replace(/\D/gu, "").slice(0, 14);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
