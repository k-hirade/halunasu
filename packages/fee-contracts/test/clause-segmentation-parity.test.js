import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CLAUSE_SEGMENTATION_VERSION,
  splitClinicalEvidenceClauses
} from "../src/index.js";

const fixturePath = new URL(
  "../../../data/tests/fee-clause-segmentation/parity-cases.json",
  import.meta.url
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

test("matches the cross-language clause segmentation contract and fingerprint", () => {
  assert.equal(fixture.schemaVersion, "fee-clause-segmentation-parity-v1");
  assert.equal(
    fixture.clauseSegmentationVersion,
    CLAUSE_SEGMENTATION_VERSION
  );

  const behavior = fixture.cases.map((item) => {
    const clauses = splitClinicalEvidenceClauses(item.text, {
      lineId: item.lineId
    }).map(projectClause);
    assert.deepEqual(
      clauses,
      item.expectedClauses,
      `clause segmentation mismatch: ${item.name}`
    );
    return {
      name: item.name,
      lineId: item.lineId,
      text: item.text,
      clauses
    };
  });

  assert.equal(
    createHash("sha256").update(canonicalJson(behavior)).digest("hex"),
    fixture.behaviorSha256
  );
});

function projectClause(clause) {
  return {
    clauseId: clause.clauseId,
    text: clause.text,
    charStart: clause.charStart,
    charEnd: clause.charEnd,
    sentenceIndex: clause.sentenceIndex,
    parentheticalDepth: clause.parentheticalDepth,
    separatorAfter: clause.separatorAfter
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
