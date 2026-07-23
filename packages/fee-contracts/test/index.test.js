import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateCreateFeePatientInput,
  validateCreateFeeSessionInput,
  validateSidecarCalculationInput,
  validateUpdateFeeSessionInput,
  validateCreateFeeCalculationInput,
  defaultFeeSettings,
  validateUpdateFeeSettingsInput,
  hasPerformedBloodCollectionEvidence,
  hasPerformedBloodCollectionEvidenceInText,
  isClinicalDateRatioFalsePositiveContext
} from "../src/index.js";

test("defaults receipt exports to fail closed", () => {
  const settings = defaultFeeSettings({ facilityId: "fac_001" });
  assert.equal(settings.receiptPolicy.blockExportOnErrors, true);
  assert.equal(settings.receiptPolicy.connectorSpecVerified, false);
});

test("validates the sidecar v1 extraction and atomic identity contract", () => {
  const input = validateSidecarCalculationInput({
    contractVersion: "v1",
    facilityId: "fac_001",
    sourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "record-001",
    serviceDate: "2026-07-18",
    setting: "home_visit",
    encounterTypeSource: "user",
    sameBuilding: false,
    sameBuildingSource: "user",
    singleBuildingPatientCount: 1,
    clinicalText: "O: 訪問診療を実施。",
    extractionProof: {
      patientIdBefore: "1001",
      patientIdAfter: "1001",
      sourceRecordIdBefore: "record-001",
      sourceRecordIdAfter: "record-001",
      selectorContractVersion: "homis-v1",
      extractedAt: "2026-07-18T01:00:00.000Z",
      domMutationDetected: false,
      contractValidationPassed: true,
      previewMatched: true,
      requiredElementCount: 4,
      matchedRequiredElementCount: 4,
      clinicalTextNodeCount: 3
    }
  });

  assert.equal(input.contractVersion, "v1");
  assert.equal(input.setting, "home_visit");
  assert.equal(input.encounterTypeSource, "user");
  assert.equal(input.sameBuilding, false);
  assert.equal(input.sameBuildingSource, "user");
  assert.equal(input.singleBuildingPatientCount, 1);
  assert.equal(input.extractionProof.domMutationDetected, false);
  assert.equal(Object.hasOwn(input, "sourceUrl"), false);
});

test("validates three-state same-building sidecar inputs without treating unknown as outside", () => {
  const base = {
    contractVersion: "v1",
    facilityId: "fac_001",
    sourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "record-001",
    serviceDate: "2026-07-18",
    setting: "home_visit",
    encounterTypeSource: "dom",
    clinicalText: "O: 訪問診療を実施。",
    extractionProof: {
      patientIdBefore: "1001",
      patientIdAfter: "1001",
      sourceRecordIdBefore: "record-001",
      sourceRecordIdAfter: "record-001",
      selectorContractVersion: "homis-v3",
      extractedAt: "2026-07-18T01:00:00.000Z",
      domMutationDetected: false,
      contractValidationPassed: true,
      previewMatched: true,
      requiredElementCount: 4,
      matchedRequiredElementCount: 4,
      clinicalTextNodeCount: 3
    }
  };

  const unknown = validateSidecarCalculationInput(base);
  assert.equal(unknown.sameBuilding, null);
  assert.equal(unknown.sameBuildingSource, null);
  assert.equal(unknown.singleBuildingPatientCount, null);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: true,
    sameBuildingSource: null
  }), /sameBuildingSource is required/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: null,
    sameBuildingSource: "user"
  }), /must be null/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: "false",
    sameBuildingSource: "user"
  }), /boolean or null/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: false,
    sameBuildingSource: "dom",
    singleBuildingPatientCount: 0
  }), /positive number/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: true,
    sameBuildingSource: "dom",
    singleBuildingPatientCount: 1
  }), /must be at least 2/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: true,
    sameBuildingSource: "dom",
    singleBuildingPatientCount: null
  }), /must be at least 2/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: false,
    sameBuildingSource: "dom",
    singleBuildingPatientCount: 4
  }), /must be 1/);
  assert.doesNotThrow(() => validateSidecarCalculationInput({
    ...base,
    sameBuilding: false,
    sameBuildingSource: "user",
    singleBuildingPatientCount: 4
  }));
});

test("validates telephone revisit facts separately from eligibility", () => {
  const base = {
    contractVersion: "v1",
    facilityId: "fac_001",
    sourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "record-telephone-001",
    serviceDate: "2026-07-18",
    setting: "outpatient",
    encounterTypeSource: "dom",
    clinicalText: "家族から電話相談があり、療養上の指示を行った。",
    extractionProof: {
      patientIdBefore: "1001",
      patientIdAfter: "1001",
      sourceRecordIdBefore: "record-telephone-001",
      sourceRecordIdAfter: "record-telephone-001",
      selectorContractVersion: "homis-v3",
      extractedAt: "2026-07-18T01:00:00.000Z",
      domMutationDetected: false,
      contractValidationPassed: true,
      previewMatched: true,
      requiredElementCount: 4,
      matchedRequiredElementCount: 4,
      clinicalTextNodeCount: 1
    }
  };

  const normalized = validateSidecarCalculationInput({
    ...base,
    visitKind: "telephone_revisit",
    visitKindSource: "dom",
    telephoneEligibility: {
      establishedPatient: null,
      patientInitiated: true,
      instructionGiven: true,
      scheduledManagement: false
    }
  });
  assert.equal(normalized.visitKind, "telephone_revisit");
  assert.equal(normalized.visitKindSource, "dom");
  assert.deepEqual(normalized.telephoneEligibility, {
    establishedPatient: null,
    patientInitiated: true,
    instructionGiven: true,
    scheduledManagement: false
  });

  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    visitKind: "telephone_revisit",
    visitKindSource: null
  }), /visitKindSource is required/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    visitKind: null,
    visitKindSource: "user"
  }), /visitKindSource must be null/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    visitKind: "video_revisit",
    visitKindSource: "user"
  }), /encounterDetails.visitKind/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    telephoneEligibility: {
      patientInitiated: true
    }
  }), /only valid for telephone_revisit/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    visitKind: "telephone_revisit",
    visitKindSource: "user",
    telephoneEligibility: {
      patientInitiated: "true"
    }
  }), /boolean or null/);
});

test("normalizes telephone revisit details on a standard fee session", () => {
  const normalized = validateCreateFeeSessionInput({
    patientId: "pat_phone",
    facilityId: "fac_phone",
    serviceDate: "2026-06-12",
    setting: "outpatient",
    encounterDetails: {
      visitKind: "telephone_revisit",
      visitKindSource: "user",
      telephoneEligibility: {
        patientInitiated: true,
        instructionGiven: true,
        scheduledManagement: false
      }
    }
  });

  assert.deepEqual(normalized.encounterDetails, {
    sameBuilding: null,
    sameBuildingSource: null,
    singleBuildingPatientCount: null,
    visitKind: "telephone_revisit",
    visitKindSource: "user",
    telephoneEligibility: {
      establishedPatient: null,
      patientInitiated: true,
      instructionGiven: true,
      scheduledManagement: false
    }
  });
});

test("rejects sidecar source URLs, extraction races, ambiguous encounter types, and unsupported versions", () => {
  const base = {
    facilityId: "fac_001",
    sourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId: "record-001",
    serviceDate: "2026-07-18",
    setting: "home_visit",
    encounterTypeSource: "dom",
    clinicalText: "O: 訪問診療を実施。",
    extractionProof: {
      patientIdBefore: "1001",
      patientIdAfter: "1001",
      sourceRecordIdBefore: "record-001",
      sourceRecordIdAfter: "record-001",
      selectorContractVersion: "homis-v1",
      extractedAt: "2026-07-18T01:00:00.000Z",
      domMutationDetected: false,
      contractValidationPassed: true,
      previewMatched: true,
      requiredElementCount: 4,
      matchedRequiredElementCount: 4,
      clinicalTextNodeCount: 3
    }
  };

  assert.throws(() => validateSidecarCalculationInput({ ...base, sourceUrl: "https://example.invalid" }), /sourceUrl/);
  assert.throws(() => validateSidecarCalculationInput({ ...base, setting: undefined }), /setting is required/);
  assert.throws(() => validateSidecarCalculationInput({ ...base, contractVersion: "v2" }), /contractVersion/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    extractionProof: { ...base.extractionProof, patientIdAfter: "1002" }
  }), /changed during extraction/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    extractionProof: { ...base.extractionProof, domMutationDetected: true }
  }), /DOM changed/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    extractionProof: { ...base.extractionProof, extractedAt: "2026-07-18" }
  }), /ISO timestamp/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    extractionProof: { ...base.extractionProof, matchedRequiredElementCount: 3 }
  }), /required chart elements/);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    extractionProof: { ...base.extractionProof, previewMatched: false }
  }), /preview and payload/);
});

test("normalizes fee session input to Platform identifiers", () => {
  const normalized = validateCreateFeeSessionInput({
    patient_id: "pat_123",
    patient_ref: "legacy-001",
    facility_id: "fac_123",
    department_id: "dep_123",
    service_date: "2026-05-28",
    claim_month: "2026-05",
    setting: "outpatient",
    clinical_text: "咳嗽。処方あり。",
    order_texts: [
      {
        order_id: "ord_1",
        order_type: "material",
        local_name: "テスト特定器材",
        standard_code: "710000001",
        quantity: "3"
      }
    ],
    claim_context: {
      material_inputs: [{ code: "710000001", quantity: 3 }]
    },
    calculation_options: {
      facility_standard_keys: ["検体検査管理加算1"]
    },
    encounter_details: {
      same_building: true,
      same_building_source: "dom",
      single_building_patient_count: 4
    }
  });

  assert.equal(normalized.patientId, "pat_123");
  assert.equal(normalized.patientRef, "legacy-001");
  assert.equal(normalized.facilityId, "fac_123");
  assert.equal(normalized.departmentId, "dep_123");
  assert.equal(normalized.claimMonth, "2026-05");
  assert.equal(normalized.orders[0].orderType, "material");
  assert.equal(normalized.orders[0].quantity, 3);
  assert.deepEqual(normalized.encounterDetails, {
    sameBuilding: true,
    sameBuildingSource: "dom",
    singleBuildingPatientCount: 4,
    visitKind: null,
    visitKindSource: null,
    telephoneEligibility: null
  });
  assert.equal(normalized.orders[0].sourceSystem, undefined);
  assert.deepEqual(normalized.claimContext.material_inputs, [{ code: "710000001", quantity: 3 }]);
  assert.deepEqual(normalized.calculationOptions.facility_standard_keys, ["検体検査管理加算1"]);
});

test("preserves user-added fee order audit metadata", () => {
  const normalized = validateUpdateFeeSessionInput({
    orders: [{
      orderType: "procedure",
      localName: "外来管理加算",
      standardCode: "112011010",
      standardName: "外来管理加算",
      quantity: 1,
      sourceSystem: "fee_web_user_added",
      sourceLabel: "ユーザー追加",
      note: "医事確認により追加",
      createdAt: "2026-06-16T00:00:00.000Z",
      createdBy: "user_1"
    }]
  });

  assert.equal(normalized.orders[0].sourceSystem, "fee_web_user_added");
  assert.equal(normalized.orders[0].sourceLabel, "ユーザー追加");
  assert.equal(normalized.orders[0].note, "医事確認により追加");
  assert.equal(normalized.orders[0].createdAt, "2026-06-16T00:00:00.000Z");
  assert.equal(normalized.orders[0].createdBy, "user_1");
});

test("allows draft fee session input before patient and facility are selected", () => {
  const normalized = validateCreateFeeSessionInput({});

  assert.equal(normalized.patientId, undefined);
  assert.equal(normalized.facilityId, undefined);
});

test("normalizes fee session update input", () => {
  const normalized = validateUpdateFeeSessionInput({
    patient_id: "pat_123",
    facility_id: "fac_123",
    department_id: null,
    service_date: "2026-05-29",
    clinical_text: "",
    orders: [],
    claimContext: null,
    calculationOptions: {
      history: {
        same_month_history_codes: ["160000410"]
      }
    },
    monthly_claim_work: {
      status: "diagnosis_requested",
      note: "病名出し済み",
      diagnosis_candidates: [{ name: "急性上気道炎" }],
      diagnosis_request_reason: "病名不足のため確認",
      doctor_name: "山田医師",
      collected_result: "急性上気道炎",
      applied_diagnosis_names: ["急性上気道炎"]
    },
    receipt_annotations: {
      comments: [{
        status: "confirmed",
        shinryo_identification: "60",
        code: "830000001",
        text: "コメント本文",
        source_review_item_id: "review_1"
      }],
      symptom_details: [{
        status: "draft",
        kubun: "01",
        text: "症状詳記本文"
      }]
    }
  });

  assert.equal(normalized.patientId, "pat_123");
  assert.equal(normalized.facilityId, "fac_123");
  assert.equal(normalized.departmentId, null);
  assert.equal(normalized.claimMonth, "2026-05");
  assert.equal(normalized.clinicalText, "");
  assert.deepEqual(normalized.orders, []);
  assert.equal(normalized.claimContext, null);
  assert.deepEqual(normalized.calculationOptions.history.same_month_history_codes, ["160000410"]);
  assert.equal(normalized.monthlyClaimWork.status, "diagnosis_requested");
  assert.equal(normalized.monthlyClaimWork.note, "病名出し済み");
  assert.equal(normalized.monthlyClaimWork.diagnosisCandidates[0].name, "急性上気道炎");
  assert.equal(normalized.monthlyClaimWork.diagnosisRequestReason, "病名不足のため確認");
  assert.equal(normalized.monthlyClaimWork.doctorName, "山田医師");
  assert.equal(normalized.monthlyClaimWork.collectedResult, "急性上気道炎");
  assert.deepEqual(normalized.monthlyClaimWork.appliedDiagnosisNames, ["急性上気道炎"]);
  assert.equal(normalized.receiptAnnotations.comments[0].status, "confirmed");
  assert.equal(normalized.receiptAnnotations.comments[0].shinryoIdentification, "60");
  assert.equal(normalized.receiptAnnotations.comments[0].sourceReviewItemId, "review_1");
  assert.equal(normalized.receiptAnnotations.symptomDetails[0].kubun, "01");
});

test("validates shared patient shape for fee patient creation", () => {
  const patient = validateCreateFeePatientInput({
    display_name: "山田 太郎",
    birth_date: "1970-01-01",
    sex: "male",
    external_patient_ids: ["legacy-001"]
  });

  assert.equal(patient.displayName, "山田 太郎");
  assert.deepEqual(patient.externalPatientIds, ["legacy-001"]);
});

test("normalizes calculation override input", () => {
  const input = validateCreateFeeCalculationInput({
    orders: [
      {
        content: "採血",
        orderType: "lab"
      }
    ],
    claimContext: {
      procedure_codes: ["160000410"]
    },
    calculationOptions: {
      comment_inputs: [{ code: "840000001", text: "コメント" }]
    },
    calculationMode: "reuse_clinical"
  });

  assert.equal(input.orders[0].orderType, "lab");
  assert.deepEqual(input.claimContext.procedure_codes, ["160000410"]);
  assert.deepEqual(input.calculationOptions.comment_inputs[0], { code: "840000001", text: "コメント" });
  assert.equal(input.calculationMode, "reuse_clinical");
});

test("normalizes facility receipt policy settings without dropping current defaults", () => {
  const normalized = validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    current: {
      receiptPolicy: {
        ukeEncoding: "shift_jis",
        validationSeverity: {
          patientSex: "off"
        }
      }
    },
    receiptPolicy: {
      ukeEncoding: "UTF-8",
      blockExportOnErrors: true,
      connectorSpecVerified: true,
      defaultReceiptScope: "monthly",
      validationSeverity: {
        patientBirthDate: "error"
      },
      annotationDefaults: {
        commentShinryoIdentification: "60"
      }
    }
  });

  assert.equal(normalized.receiptPolicy.ukeEncoding, "utf-8");
  assert.equal(normalized.receiptPolicy.blockExportOnErrors, true);
  assert.equal(normalized.receiptPolicy.connectorSpecVerified, true);
  assert.equal(normalized.receiptPolicy.validationSeverity.patientSex, "off");
  assert.equal(normalized.receiptPolicy.validationSeverity.patientBirthDate, "error");
  assert.equal(normalized.receiptPolicy.validationSeverity.insuranceInsurerNumber, "error");
  assert.equal(normalized.receiptPolicy.annotationDefaults.commentShinryoIdentification, "60");
  assert.equal(normalized.receiptPolicy.defaultReceiptScope, "monthly");
});

test("normalizes structured facility standards and drops unused policy fields", () => {
  const normalized = validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    historyPolicy: { defaultLookbackMonths: 6, externalHistoryEnabled: true },
    facilityStandards: [
      { key: "lab_management_1", name: "検体検査管理加算(I)", acceptanceNumber: "第1号", claimStartDate: "2026-06-01", status: "active" },
      { name: "", key: "" }
    ]
  });

  assert.equal(normalized.historyPolicy.defaultLookbackMonths, 6);
  assert.equal(normalized.historyPolicy.externalHistoryEnabled, true);
  assert.equal(normalized.facilityStandards.length, 1);
  assert.equal(normalized.facilityStandards[0].key, "lab_management_1");
  assert.equal(normalized.facilityStandards[0].status, "active");
  assert.equal(normalized.facilityStandards[0].claimStartDate, "2026-06-01");
  assert.equal(normalized.initialRevisitPolicy.requireReviewWhenNoHistory, true);
  assert.equal(normalized.standingFactsPolicy.stalenessMonths, 3);
  assert.equal(normalized.historyPolicy.missingHistoryBehavior, undefined);
  assert.equal(normalized.reviewPolicy, undefined);
  assert.equal(normalized.initialRevisitPolicy.priorHistoryBehavior, undefined);
});

test("normalizes standing fact staleness policy within the supported range", () => {
  assert.equal(validateUpdateFeeSettingsInput({
    standingFactsPolicy: { stalenessMonths: 5 }
  }).standingFactsPolicy.stalenessMonths, 5);
  assert.equal(validateUpdateFeeSettingsInput({
    standingFactsPolicy: { stalenessMonths: 99 }
  }).standingFactsPolicy.stalenessMonths, 6);
  assert.equal(validateUpdateFeeSettingsInput({
    standingFactsPolicy: { stalenessMonths: 0 }
  }).standingFactsPolicy.stalenessMonths, 1);
});

test("rejects mutually exclusive active detail-issuance facility standards", () => {
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityId: "fac_001",
      facilityStandards: [
        { key: "meisaisho_hakko_taisei", status: "active" },
        { key: "denshiteki_shinryo_joho_renkei_taisei", status: "active" }
      ]
    }),
    (error) => (
      error?.name === "ValidationError"
      && error?.field === "facilityStandards"
    )
  );

  const historical = validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    facilityStandards: [
      { key: "meisaisho_hakko_taisei", status: "expired" },
      { key: "denshiteki_shinryo_joho_renkei_taisei", status: "active" }
    ]
  });
  assert.equal(historical.facilityStandards.length, 2);
});

test("detects performed blood collection using the shared strict predicate", () => {
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 静脈採血を実施し、血液検体を提出した。"), true);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 静脈採血でCRP 0.3mg/dLを確認した。"), true);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 採血の必要性を確認した。"), false);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("既往歴: 静脈血栓症。O: 尿検査を実施。"), false);
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 血清Cr 1.2mg/dL、尿一般を確認。"), false);
  assert.equal(hasPerformedBloodCollectionEvidence({ specimen: "血清" }), true);
  assert.equal(hasPerformedBloodCollectionEvidence({ payload: { collection_method: "blood_venous" } }), true);
});

test("filters pain-scale ratios from clinical date extraction contexts", () => {
  assert.equal(isClinicalDateRatioFalsePositiveContext("疼痛 NRS 7/10、VAS 6/10"), true);
  assert.equal(isClinicalDateRatioFalsePositiveContext("血圧 130/80"), true);
  assert.equal(isClinicalDateRatioFalsePositiveContext("7/10 再診、採血実施"), false);
  assert.equal(isClinicalDateRatioFalsePositiveContext("7/10に再診予定"), false);
});
