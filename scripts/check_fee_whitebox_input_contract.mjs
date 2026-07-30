#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  canonicalizeClinicalText,
  canonicalRangeForRawRange
} from "../services/fee-api/src/clinical-text-normalization.js";
import {
  buildContextClassifierItems,
  splitWhiteboxEvidenceClauses
} from "../services/fee-api/src/whitebox-extraction.js";

const datasetPath = process.argv[2]
  || "data/tests/fee-specialty-matrix/training-view.json";
const caseLimit = Number(process.argv[3] || 20);
const semanticFields = [
  "text",
  "spanText",
  "charStart",
  "charEnd",
  "previousLine",
  "nextLine",
  "section",
  "encounterSetting",
  "specialty",
  "sourceType",
  "parentLineText",
  "clauseId",
  "clauseText",
  "clauseCharStart",
  "clauseCharEnd",
  "clauseSpanCharStart",
  "clauseSpanCharEnd",
  "inputSemantics"
];

const python = spawnSync(
  process.env.PYTHON || "python3",
  [
    "scripts/fee_whitebox_input_contract_reference.py",
    "--dataset",
    datasetPath,
    "--case-limit",
    String(caseLimit)
  ],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH || "python:."
    }
  }
);
if (python.status !== 0) {
  throw new Error(
    `training-side input contract failed: ${String(python.stderr || python.stdout).trim()}`
  );
}
const reference = JSON.parse(python.stdout);
const payload = JSON.parse(readFileSync(datasetPath, "utf8"));
const cases = (Array.isArray(payload.cases) ? payload.cases : [])
  .filter((item) => ["train", "development"].includes(String(item?.split || "")))
  .slice(0, caseLimit);
const contextByKey = new Map(
  reference.contexts.map((entry) => [
    `${entry.caseId}:${entry.spanIndex}`,
    entry.item
  ])
);
const normalizationByCase = new Map(
  reference.normalization.map((entry) => [entry.caseId, entry])
);

let contextItemCount = 0;
for (const item of cases) {
  const canonicalized = canonicalizeClinicalText(item.clinicalText);
  const normalizedSpans = (Array.isArray(item.expectedSpans) ? item.expectedSpans : [])
    .map((span) => {
      const range = canonicalRangeForRawRange(
        canonicalized,
        span.charStart,
        span.charEnd
      );
      assert.ok(range, `${item.caseId}: WX1 failed to remap a span`);
      return {
        text: canonicalized.text.slice(range.charStart, range.charEnd),
        charStart: range.charStart,
        charEnd: range.charEnd,
        category: String(span.category || "")
      };
    });
  assert.deepEqual(
    {
      caseId: item.caseId,
      text: canonicalized.text,
      spans: normalizedSpans
    },
    normalizationByCase.get(item.caseId),
    `${item.caseId}: WX1 train/serve normalization differs`
  );

  const normalizedCase = {
    ...item,
    clinicalText: canonicalized.text,
    expectedSpans: normalizedSpans
  };
  const lineRows = splitLines(normalizedCase.clinicalText);
  for (const [spanIndex, span] of normalizedSpans.entries()) {
    const line = lineRows.find(
      (entry) => span.charStart >= entry.charStart && span.charStart < entry.charEnd
    );
    assert.ok(line, `${item.caseId}:${spanIndex}: span has no runtime line`);
    const localStart = span.charStart - line.charStart;
    const localEnd = span.charEnd - line.charStart;
    const runtimeLines = lineRows.map((entry, index) => ({
      lineId: `L-${String(index + 1).padStart(3, "0")}`,
      text: entry.text,
      section: sectionForLine(entry.text)
    }));
    const runtimeLine = runtimeLines[line.index];
    const runtimeSpan = {
      lineId: runtimeLine.lineId,
      spanId: `${item.caseId}:span-${spanIndex}`,
      text: span.text,
      charStart: localStart,
      charEnd: localEnd
    };
    const clauses = splitWhiteboxEvidenceClauses({
      ...runtimeLine,
      cues: {}
    });
    const clause = clauses.find(
      (entry) => localStart < entry.charEnd && localEnd > entry.charStart
    ) || clauses[0];
    const [runtimeItem] = buildContextClassifierItems({
      lines: runtimeLines,
      runtimeEntries: [{ effectiveSpan: runtimeSpan, clause }],
      encounterSetting: item.encounterSetting,
      specialty: item.specialty
    });
    const actual = Object.fromEntries(
      semanticFields.map((field) => [field, runtimeItem[field]])
    );
    const expected = contextByKey.get(`${item.caseId}:${spanIndex}`);
    try {
      assert.deepEqual(actual, expected);
    } catch (error) {
      error.message = `${item.caseId}:${spanIndex}: WX3 train/serve payload differs\n${error.message}`;
      throw error;
    }
    contextItemCount += 1;
  }
}

assert.equal(cases.length, reference.caseCount);
assert.equal(contextItemCount, reference.contextItemCount);
process.stdout.write(JSON.stringify({
  status: "passed",
  caseCount: cases.length,
  contextItemCount
}) + "\n");

function splitLines(value) {
  const source = String(value || "");
  const rows = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu) || [];
  const lines = [];
  let offset = 0;
  for (const row of rows) {
    if (!row && lines.length) {
      continue;
    }
    const text = row.replace(/[\r\n]+$/u, "");
    lines.push({
      index: lines.length,
      text,
      charStart: offset,
      charEnd: offset + Array.from(text).length
    });
    offset += Array.from(row).length;
  }
  return lines.length ? lines : [{ index: 0, text: source, charStart: 0, charEnd: 0 }];
}

function sectionForLine(value) {
  return String(value || "").match(/^\s*([SOAP])(?:[）):：]|\s)/iu)?.[1]?.toUpperCase() || "";
}
