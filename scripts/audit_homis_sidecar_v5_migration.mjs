#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sidecarVisitAdoptionFingerprint } from "../packages/fee-core/src/sidecar-drafts.js";

const OLD_SELECTOR_CONTRACTS = new Set([
  "homis-mock-v2",
  "homis-mock-v3",
  "homis-mock-v4"
]);
const CURRENT_SELECTOR_CONTRACT = "homis-mock-v5";
const DEFAULT_MAX_DRAFTS = 10_000;

export function analyzeSidecarV5Migration(drafts = [], guards = [], options = {}) {
  const facilityId = required(options.facilityId, "facilityId");
  const guardByFingerprint = new Map(
    guards
      .filter((guard) => guard && typeof guard === "object")
      .map((guard) => [String(guard.visitFingerprint || guard.id || ""), guard])
      .filter(([fingerprint]) => fingerprint)
  );
  const scopedDrafts = drafts.filter((draft) => String(draft?.facilityId || "") === facilityId);
  const versionLifecycleCounts = {};
  const activeOldDraftRefs = [];
  const unknownVersionRefs = [];
  const fingerprintErrors = [];
  const fingerprintOwners = new Map();
  const backfills = [];
  const existingGuardConflicts = [];
  let adoptedOldDraftCount = 0;
  let adoptedOldGuardCount = 0;

  for (const draft of scopedDrafts) {
    const selectorContractVersion = String(draft?.extractionProof?.selectorContractVersion || "unknown");
    const lifecycleStatus = String(draft?.lifecycleStatus || "unknown");
    const countKey = `${selectorContractVersion}:${lifecycleStatus}`;
    versionLifecycleCounts[countKey] = Number(versionLifecycleCounts[countKey] || 0) + 1;

    if (selectorContractVersion === CURRENT_SELECTOR_CONTRACT) {
      continue;
    }
    if (!OLD_SELECTOR_CONTRACTS.has(selectorContractVersion)) {
      if (["draft", "adopted"].includes(lifecycleStatus)) {
        unknownVersionRefs.push(opaqueRef(draft?.sidecarDraftId));
      }
      continue;
    }
    if (lifecycleStatus === "draft") {
      activeOldDraftRefs.push(opaqueRef(draft?.sidecarDraftId));
      continue;
    }
    if (lifecycleStatus !== "adopted") {
      continue;
    }

    adoptedOldDraftCount += 1;
    if (!String(draft?.adoptedFeeSessionId || "").trim()) {
      fingerprintErrors.push({
        draftRef: opaqueRef(draft?.sidecarDraftId),
        reason: "adopted_fee_session_missing"
      });
      continue;
    }
    let visitFingerprint;
    try {
      visitFingerprint = sidecarVisitAdoptionFingerprint(draft, {});
    } catch {
      fingerprintErrors.push({
        draftRef: opaqueRef(draft?.sidecarDraftId),
        reason: "visit_fingerprint_incomplete"
      });
      continue;
    }
    const previousOwner = fingerprintOwners.get(visitFingerprint);
    if (previousOwner && previousOwner.sidecarDraftId !== draft.sidecarDraftId) {
      fingerprintErrors.push({
        draftRef: opaqueRef(draft?.sidecarDraftId),
        reason: "duplicate_adopted_visit_fingerprint"
      });
      continue;
    }
    fingerprintOwners.set(visitFingerprint, draft);

    const existingGuard = guardByFingerprint.get(visitFingerprint);
    if (existingGuard) {
      if (String(existingGuard.sidecarDraftId || "") !== String(draft.sidecarDraftId || "")
        || String(existingGuard.adoptedFeeSessionId || "") !== String(draft.adoptedFeeSessionId || "")) {
        existingGuardConflicts.push(opaqueRef(draft?.sidecarDraftId));
      } else {
        adoptedOldGuardCount += 1;
      }
      continue;
    }
    backfills.push({ visitFingerprint, draft });
  }

  const blockers = [];
  if (activeOldDraftRefs.length) blockers.push("active_old_drafts_present");
  if (unknownVersionRefs.length) blockers.push("selector_contract_version_unknown");
  if (fingerprintErrors.length) blockers.push("adopted_visit_fingerprint_invalid");
  if (existingGuardConflicts.length) blockers.push("existing_guard_conflict");
  if (backfills.length) blockers.push("adoption_guard_backfill_required");

  const report = {
    schemaVersion: 1,
    generatedAt: String(options.generatedAt || new Date().toISOString()),
    projectId: String(options.projectId || ""),
    orgId: String(options.orgId || ""),
    facilityId,
    selectorContractTarget: CURRENT_SELECTOR_CONTRACT,
    draftCount: scopedDrafts.length,
    versionLifecycleCounts: Object.fromEntries(Object.entries(versionLifecycleCounts).sort()),
    activeOldDraftCount: activeOldDraftRefs.length,
    activeOldDraftRefs,
    unknownVersionCount: unknownVersionRefs.length,
    unknownVersionRefs,
    adoptedOldDraftCount,
    adoptedOldGuardCount,
    guardBackfillRequiredCount: backfills.length,
    fingerprintErrors,
    existingGuardConflictCount: existingGuardConflicts.length,
    existingGuardConflictRefs: existingGuardConflicts,
    blockerCodes: blockers,
    migrationReady: blockers.length === 0
  };
  return { report, backfills };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectId = required(args.get("project-id"), "project-id");
  const orgId = required(args.get("org-id"), "org-id");
  const facilityId = required(args.get("facility-id"), "facility-id");
  const maxDrafts = positiveInteger(args.get("max-drafts"), DEFAULT_MAX_DRAFTS);
  const outputDir = path.resolve(required(args.get("output-dir"), "output-dir"));
  const applyBackfill = args.has("apply-backfill");
  const { db, drafts, guards } = await readFirestoreState({ projectId, orgId, facilityId, maxDrafts });
  let analysis = analyzeSidecarV5Migration(drafts, guards, { projectId, orgId, facilityId });

  if (applyBackfill) {
    const hardBlockers = analysis.report.blockerCodes.filter((code) => code !== "adoption_guard_backfill_required");
    if (hardBlockers.length) {
      throw new Error(`guard backfill blocked: ${hardBlockers.join(", ")}`);
    }
    for (const item of analysis.backfills) {
      await backfillGuard(db, orgId, item);
    }
    const refreshed = await readFirestoreState({ projectId, orgId, facilityId, maxDrafts, db });
    analysis = analyzeSidecarV5Migration(refreshed.drafts, refreshed.guards, {
      projectId,
      orgId,
      facilityId
    });
  }

  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "sidecar-v5-migration-audit.json");
  await writeFile(outputPath, `${JSON.stringify(analysis.report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(analysis.report, null, 2)}\nresult=${outputPath}\n`);
  if (!analysis.report.migrationReady) {
    process.exitCode = 2;
  }
}

async function readFirestoreState({ projectId, orgId, facilityId, maxDrafts, db: existingDb }) {
  const db = existingDb || await createFirestore(projectId);
  const org = db.collection("organizations").doc(orgId);
  const draftsSnapshot = await org.collection("sidecar_calculation_drafts")
    .where("facilityId", "==", facilityId)
    .limit(maxDrafts + 1)
    .get();
  if (draftsSnapshot.size > maxDrafts) {
    throw new Error(`sidecar draft count exceeds --max-drafts=${maxDrafts}`);
  }
  const guardsSnapshot = await org.collection("sidecar_adoption_guards")
    .where("facilityId", "==", facilityId)
    .limit(maxDrafts + 1)
    .get();
  if (guardsSnapshot.size > maxDrafts) {
    throw new Error(`sidecar adoption guard count exceeds --max-drafts=${maxDrafts}`);
  }
  return {
    db,
    drafts: draftsSnapshot.docs.map((doc) => ({ sidecarDraftId: doc.id, ...doc.data() })),
    guards: guardsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  };
}

async function createFirestore(projectId) {
  const { applicationDefault, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ credential: applicationDefault(), projectId }, `sidecar-v5-audit-${Date.now()}`);
  return getFirestore(app);
}

async function backfillGuard(db, orgId, { visitFingerprint, draft }) {
  const guardRef = db.collection("organizations").doc(orgId)
    .collection("sidecar_adoption_guards").doc(visitFingerprint);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(guardRef);
    if (snapshot.exists) {
      const existing = snapshot.data();
      if (String(existing.sidecarDraftId || "") !== String(draft.sidecarDraftId || "")
        || String(existing.adoptedFeeSessionId || "") !== String(draft.adoptedFeeSessionId || "")) {
        throw new Error("sidecar adoption guard changed during migration backfill");
      }
      return;
    }
    transaction.set(guardRef, {
      visitFingerprint,
      sidecarDraftId: draft.sidecarDraftId,
      adoptedFeeSessionId: draft.adoptedFeeSessionId,
      facilityId: draft.facilityId,
      canonicalPatientId: draft.canonicalPatientId || draft.patientId,
      serviceDate: draft.serviceDate,
      sourceRecordDisplayId: draft.sourceRecordDisplayId,
      receptionTime: draft.receptionTime,
      setting: draft.setting,
      createdAt: new Date().toISOString(),
      migrationBackfill: true
    });
  });
}

function parseArgs(values) {
  const result = new Map();
  const valueOptions = new Set([
    "project-id",
    "org-id",
    "facility-id",
    "max-drafts",
    "output-dir"
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    if (!raw.startsWith("--")) throw new Error(`unknown argument: ${raw}`);
    const key = raw.slice(2);
    if (key === "apply-backfill") {
      result.set(key, true);
      continue;
    }
    if (!valueOptions.has(key) || index + 1 >= values.length) {
      throw new Error(`unknown or incomplete option: ${raw}`);
    }
    result.set(key, values[index + 1]);
    index += 1;
  }
  return result;
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`--${label} is required`);
  return normalized;
}

function positiveInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--max-drafts must be a positive integer");
  return parsed;
}

function opaqueRef(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
