import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveSpecificMaterialAttributes,
  specificMaterialClassificationMetadata
} from "../src/specific-material-attribute-resolver.js";

test("classification artifact is integrity checked and versioned", () => {
  const metadata = specificMaterialClassificationMetadata();
  assert.equal(metadata.schemaVersion, "fee-specific-material-classification-artifact-v1");
  assert.equal(metadata.revision, "2026-06-first-wave-v1");
  assert.match(metadata.artifactPayloadSha256, /^[a-f0-9]{64}$/u);
});

test("exact full tracheostomy material name resolves only the medical table 2 code", () => {
  const result = resolveSpecificMaterialAttributes({
    event: {
      name: "気管切開後留置用チューブ（一般・カフ付き・吸引有・二重管）",
      evidence: "本日、複管8.0mmのカニューレ交換を実施。カフ圧確認、吸引あり。"
    },
    serviceDate: "2026-06-23"
  });

  assert.equal(result.status, "exact");
  assert.equal(result.candidates[0].code, "733840000");
  assert.equal(result.candidates[0].notificationTableNumber, "2");
  assert.deepEqual(result.attributes, {
    cuffed: true,
    suctionEnabled: true,
    tubeStructure: "double"
  });
});

test("structured device attributes narrow a generic home tracheostomy event", () => {
  const result = resolveSpecificMaterialAttributes({
    event: {
      name: "気管カニューレ交換",
      evidence: "本日交換を実施。",
      notification_table_no: "1"
    },
    structuredSourceFacts: {
      devices: [{
        type: "tracheostomy_cannula",
        attributes: {
          doubleTube: true,
          cuffed: true,
          suctionEnabled: true,
          sizeMm: 8
        }
      }]
    },
    serviceDate: "2026-06-23"
  });

  assert.equal(result.status, "exact");
  assert.equal(result.candidates[0].code, "732740000");
  assert.equal(result.candidates[0].notificationTableNumber, "1");
});

test("same functional gastrostomy material remains ambiguous without billing table evidence", () => {
  const result = resolveSpecificMaterialAttributes({
    event: {
      name: "交換用胃瘻カテーテル（胃留置型・バルーン型）",
      evidence: "胃留置型バルーンの交換を実施。"
    },
    serviceDate: "2026-06-25"
  });

  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.candidates.map((candidate) => candidate.code), [
    "721004000",
    "733810000"
  ]);
});

test("missing urinary catheter attributes stays insufficient and does not guess", () => {
  const result = resolveSpecificMaterialAttributes({
    event: {
      name: "膀胱留置カテーテル交換",
      evidence: "本日交換を実施。"
    },
    serviceDate: "2026-06-25"
  });

  assert.equal(result.status, "insufficient");
  assert.ok(result.candidates.length > 1);
  assert.equal(result.reasonCode, "material_attributes_missing");
});

test("undefined material categories keep the legacy lane unchanged", () => {
  const result = resolveSpecificMaterialAttributes({
    event: {
      name: "腰椎コルセット",
      evidence: "腰椎コルセットを使用。"
    }
  });
  assert.equal(result.status, "unconfigured");
  assert.deepEqual(result.candidates, []);
});
