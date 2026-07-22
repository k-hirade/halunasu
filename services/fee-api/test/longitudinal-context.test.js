import assert from "node:assert/strict";
import { test } from "node:test";

import { buildClinicalTextPreprocessing } from "../src/clinical-calculation-input.js";
import {
  EXTRACTION_SNAPSHOT_SCHEMA_VERSION,
  buildExtractionSnapshotCore,
  clinicalFactsFromMemo,
  clinicalLineKeyEntries,
  planExtractionMemo,
  resolveCanonicalSidecarPatientIdentity
} from "../src/longitudinal-context.js";

test("sidecar source identity resolves to exactly one canonical patient", async () => {
  const result = await resolveCanonicalSidecarPatientIdentity({
    platformStore: {
      async listPatients() {
        return [{
          patientId: "pat_001",
          patientIdentifiers: [{
            sourceSystem: "homis",
            facilityId: "fac_001",
            patientNumber: "1001",
            status: "active"
          }]
        }];
      }
    },
    orgId: "org_001",
    facilityId: "fac_001",
    sourceSystem: "homis",
    externalPatientId: "1001",
    sidecarPatientKey: "sidecar_patient_001"
  });

  assert.equal(result.canonicalPatientId, "pat_001");
  assert.equal(result.resolutionStatus, "resolved");
  assert.equal(result.lookupCompleteness, "complete");
  assert.deepEqual(result.patientIdentityAliases, ["pat_001", "sidecar_patient_001"]);
});

test("canonical patient resolution fails closed for unavailable or ambiguous lookup", async () => {
  const common = {
    orgId: "org_001",
    facilityId: "fac_001",
    sourceSystem: "homis",
    externalPatientId: "1001",
    sidecarPatientKey: "sidecar_patient_001"
  };
  const unavailable = await resolveCanonicalSidecarPatientIdentity({
    ...common,
    platformStore: { async listPatients() { throw new Error("firestore unavailable"); } }
  });
  assert.equal(unavailable.canonicalPatientId, "sidecar_patient_001");
  assert.equal(unavailable.lookupCompleteness, "unavailable");

  const patient = {
    patientIdentifiers: [{
      sourceSystem: "homis",
      facilityId: "fac_001",
      patientNumber: "1001",
      status: "active"
    }]
  };
  const ambiguous = await resolveCanonicalSidecarPatientIdentity({
    ...common,
    platformStore: {
      async listPatients() {
        return [
          { ...patient, patientId: "pat_001" },
          { ...patient, patientId: "pat_002" }
        ];
      }
    }
  });
  assert.equal(ambiguous.resolutionStatus, "ambiguous");
  assert.equal(ambiguous.canonicalPatientId, "sidecar_patient_001");
  assert.equal(ambiguous.lookupCompleteness, "unavailable");
});

test("line keys survive line-number shifts and section-preserving reordering", () => {
  const first = clinicalLineKeyEntries([
    { lineId: "S-001", section: "S", text: "体調は安定。" },
    { lineId: "O-001", section: "O", text: "採血を実施。" }
  ]);
  const reordered = clinicalLineKeyEntries([
    { lineId: "O-009", section: "O", text: "採血を実施。" },
    { lineId: "S-004", section: "S", text: "体調は安定。" }
  ]);

  assert.equal(first[0].lineKey, reordered[1].lineKey);
  assert.equal(first[1].lineKey, reordered[0].lineKey);
  assert.notEqual(first[0].lineKey, first[1].lineKey);
});

test("memo excludes removed-line events and remaps continued evidence line ids", () => {
  const previousPreprocessing = buildClinicalTextPreprocessing([
    "S）状態は安定。",
    "O）前月に人工呼吸器を導入した。"
  ].join("\n"));
  const snapshot = buildExtractionSnapshotCore({
    promptVersion: "prompt-v1",
    preprocessing: previousPreprocessing,
    facts: {
      visit_facts: null,
      diagnoses: [],
      line_review: previousPreprocessing.lines.map((line) => ({
        line_id: line.lineId,
        has_billable_act: line.section === "O"
      })),
      clinical_events: [{
        type: "procedure",
        name: "人工呼吸器導入",
        evidence: "前月に人工呼吸器を導入した。",
        evidence_line_ids: ["O-001"]
      }]
    },
    extractedAt: "2026-06-01T00:00:00.000Z"
  });
  const currentPreprocessing = buildClinicalTextPreprocessing([
    "P）経過観察を継続。",
    "S）状態は安定。"
  ].join("\n"));
  const plan = planExtractionMemo({
    preprocessing: currentPreprocessing,
    snapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "complete"
  });
  const memoFacts = clinicalFactsFromMemo(snapshot, plan);

  assert.equal(plan.continued.length, 1);
  assert.equal(plan.newLines.length, 1);
  assert.equal(plan.removed.length, 1);
  assert.deepEqual(memoFacts.clinical_events, [], "past-only removed act must not leak into the current visit");
  assert.equal(memoFacts.line_review[0].line_id, "S-001");
});

test("multi-line events and billable lines without a local event are re-extracted", () => {
  const preprocessing = buildClinicalTextPreprocessing("O）創部を洗浄。\n被覆材を貼付。");
  const snapshot = buildExtractionSnapshotCore({
    promptVersion: "prompt-v1",
    preprocessing,
    facts: {
      diagnoses: [],
      line_review: preprocessing.lines.map((line) => ({ line_id: line.lineId, has_billable_act: true })),
      clinical_events: [{
        type: "treatment",
        name: "創傷処置",
        evidence_line_ids: preprocessing.lines.map((line) => line.lineId)
      }]
    },
    extractedAt: "2026-06-01T00:00:00.000Z"
  });
  const plan = planExtractionMemo({
    preprocessing,
    snapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "complete"
  });

  assert.equal(snapshot.schemaVersion, EXTRACTION_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.lines.every((line) => line.requiresReextract), true);
  assert.equal(plan.continued.length, 0);
  assert.equal(plan.newLines.length, 2);
});

test("prompt/schema mismatch and unavailable history force full extraction", () => {
  const preprocessing = buildClinicalTextPreprocessing("P）処方を継続。");
  const snapshot = buildExtractionSnapshotCore({
    promptVersion: "prompt-v1",
    preprocessing,
    facts: {
      diagnoses: [],
      line_review: [{ line_id: "P-001", has_billable_act: false }],
      clinical_events: []
    },
    extractedAt: "2026-06-01T00:00:00.000Z"
  });

  const versionMismatch = planExtractionMemo({
    preprocessing,
    snapshot,
    promptVersion: "prompt-v2",
    historyCompleteness: "complete"
  });
  assert.equal(versionMismatch.compatible, false);
  assert.equal(versionMismatch.newLines.length, 1);

  const unavailable = planExtractionMemo({
    preprocessing,
    snapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "unavailable"
  });
  assert.equal(unavailable.compatible, false);
  assert.equal(unavailable.reason, "history_unavailable");
});

test("new or removed prescription-mode lines force full extraction for visit facts", () => {
  const stablePreprocessing = buildClinicalTextPreprocessing(
    "S）状態は安定。\nP）現行処方を継続。"
  );
  const stableSnapshot = buildExtractionSnapshotCore({
    promptVersion: "prompt-v1",
    preprocessing: stablePreprocessing,
    facts: {
      visit_facts: {
        outside_prescription_issued: "unknown",
        generic_name_prescription: "unknown",
        prescription_evidence: ""
      },
      diagnoses: [],
      line_review: stablePreprocessing.lines.map((line) => ({ line_id: line.lineId, has_billable_act: false })),
      clinical_events: []
    },
    extractedAt: "2026-06-01T00:00:00.000Z"
  });
  const outsidePrescription = planExtractionMemo({
    preprocessing: buildClinicalTextPreprocessing(
      "S）状態は安定。\nP）院外処方箋を発行。"
    ),
    snapshot: stableSnapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "complete"
  });
  assert.equal(outsidePrescription.compatible, false);
  assert.equal(outsidePrescription.reason, "visit_facts_sensitive_change");
  assert.equal(outsidePrescription.memoHitLineRatio, 0);
  assert.equal(outsidePrescription.newLines.length, 2);

  const outsidePreprocessing = buildClinicalTextPreprocessing(
    "S）状態は安定。\nP）院内処方とした。"
  );
  const outsideSnapshot = buildExtractionSnapshotCore({
    promptVersion: "prompt-v1",
    preprocessing: outsidePreprocessing,
    facts: {
      visit_facts: {
        outside_prescription_issued: "no",
        generic_name_prescription: "unknown",
        prescription_evidence: "院内処方"
      },
      diagnoses: [],
      line_review: outsidePreprocessing.lines.map((line) => ({ line_id: line.lineId, has_billable_act: false })),
      clinical_events: []
    },
    extractedAt: "2026-06-01T00:00:00.000Z"
  });
  const removedPrescriptionMode = planExtractionMemo({
    preprocessing: buildClinicalTextPreprocessing("S）状態は安定。\nP）経過観察。"),
    snapshot: outsideSnapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "complete"
  });
  assert.equal(removedPrescriptionMode.compatible, false);
  assert.equal(removedPrescriptionMode.reason, "visit_facts_sensitive_change");
  assert.equal(removedPrescriptionMode.removed.length, 1);
});

test("ordinary prescription continuation remains eligible for memo reuse", () => {
  const preprocessing = buildClinicalTextPreprocessing("S）状態は安定。\nP）現行処方を継続。");
  const snapshot = buildExtractionSnapshotCore({
    promptVersion: "prompt-v1",
    preprocessing,
    facts: {
      diagnoses: [],
      line_review: preprocessing.lines.map((line) => ({ line_id: line.lineId, has_billable_act: false })),
      clinical_events: []
    },
    extractedAt: "2026-06-01T00:00:00.000Z"
  });
  const plan = planExtractionMemo({
    preprocessing,
    snapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "complete"
  });
  assert.equal(plan.compatible, true);
  assert.equal(plan.memoHitLineRatio, 1);
});

test("visit type is reused only when the caller proves an exact same-source rerun", () => {
  const preprocessing = buildClinicalTextPreprocessing("P）経過観察を継続。");
  const snapshot = buildExtractionSnapshotCore({
    promptVersion: "prompt-v1",
    preprocessing,
    facts: {
      visit_type: { kind: "initial", evidence: "当院初診", confidence: "high" },
      diagnoses: [],
      line_review: [{ line_id: "P-001", has_billable_act: false }],
      clinical_events: []
    },
    extractedAt: "2026-06-01T00:00:00.000Z"
  });
  const plan = planExtractionMemo({
    preprocessing,
    snapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "complete"
  });

  assert.equal(clinicalFactsFromMemo(snapshot, plan).visit_type, undefined);
  assert.deepEqual(
    clinicalFactsFromMemo(snapshot, plan, { reuseSourceScopedFacts: true }).visit_type,
    { kind: "initial", evidence: "当院初診", confidence: "high" }
  );
  const changedPlan = planExtractionMemo({
    preprocessing: buildClinicalTextPreprocessing("S）症状が悪化。\nP）経過観察を継続。"),
    snapshot,
    promptVersion: "prompt-v1",
    historyCompleteness: "complete"
  });
  assert.equal(
    clinicalFactsFromMemo(snapshot, changedPlan, { reuseSourceScopedFacts: true }).visit_type,
    undefined
  );
});
