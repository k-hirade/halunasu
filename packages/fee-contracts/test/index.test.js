import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clinicalServiceContextCues,
  clinicalServiceContextCuesForMention,
  validateCreateFeePatientInput,
  validateCreateFeeSessionInput,
  validateSidecarCandidateAcknowledgementInput,
  validateSidecarCalculationInput,
  validateUpdateFeeSessionInput,
  validateCreateFeeCalculationInput,
  validateMonthlyExclusionResolutionInput,
  defaultFeeSettings,
  validateUpdateFeeSettingsInput,
  hasPerformedBloodCollectionEvidence,
  hasPerformedBloodCollectionEvidenceInText,
  isClinicalDateRatioFalsePositiveContext,
  isPastOrExternalClinicalServiceContext,
  splitClinicalEvidenceClauses,
  validateReviewDecisionInput
} from "../src/index.js";

test("validates sidecar candidate acknowledgement optimistic-lock input", () => {
  const fingerprint = "a".repeat(64);
  assert.deepEqual(validateSidecarCandidateAcknowledgementInput({
    contractVersion: "v1",
    acknowledged: true,
    expectedSourceRevision: 2,
    expectedCalculationRevision: 3,
    expectedAcknowledgementVersion: 0,
    candidateFingerprint: fingerprint,
    candidateKey: "must_be_derived_by_the_server"
  }), {
    contractVersion: "v1",
    acknowledged: true,
    expectedSourceRevision: 2,
    expectedCalculationRevision: 3,
    expectedAcknowledgementVersion: 0,
    candidateFingerprint: fingerprint
  });

  for (const invalid of [
    { acknowledged: "true" },
    { expectedSourceRevision: 0 },
    { expectedSourceRevision: "1" },
    { expectedCalculationRevision: 1.5 },
    { expectedAcknowledgementVersion: false },
    { expectedAcknowledgementVersion: -1 },
    { candidateFingerprint: "A".repeat(64) },
    { candidateFingerprint: "a".repeat(63) },
    { candidateFingerprint: ` ${"a".repeat(64)}` }
  ]) {
    assert.throws(() => validateSidecarCandidateAcknowledgementInput({
      contractVersion: "v1",
      acknowledged: true,
      expectedSourceRevision: 1,
      expectedCalculationRevision: 1,
      expectedAcknowledgementVersion: 0,
      candidateFingerprint: fingerprint,
      ...invalid
    }));
  }
  assert.throws(() => validateSidecarCandidateAcknowledgementInput({
    acknowledged: true,
    expectedSourceRevision: 1,
    expectedCalculationRevision: 1,
    expectedAcknowledgementVersion: 0,
    candidateFingerprint: fingerprint
  }), /contractVersion/u);
});

test("validates structured extraction reject reasons", () => {
  assert.deepEqual(validateReviewDecisionInput({
    status: "rejected",
    rejectReason: "extraction_wrong"
  }), {
    status: "rejected",
    rejectReason: "extraction_wrong"
  });
  assert.throws(
    () => validateReviewDecisionInput({
      status: "approved",
      rejectReason: "duplicate"
    }),
    /rejectReason is only valid/u
  );
  assert.throws(
    () => validateReviewDecisionInput({
      status: "rejected",
      rejectReason: "free_text_reason"
    }),
    /rejectReason/u
  );
});

test("validates patient-month exclusion decisions and requires a basis for dual billing", () => {
  const base = {
    patientId: "pat_001",
    claimMonth: "2026-05",
    pairKey: "same_month:114005410:140003810",
    scopeKey: "2026-05",
    ruleFingerprint: "fingerprint-test"
  };
  assert.deepEqual(validateMonthlyExclusionResolutionInput({
    ...base,
    resolution: "auto_winner",
    action: "acknowledge_auto"
  }), {
    ...base,
    resolution: "auto_winner",
    action: "acknowledge_auto",
    revoke: false
  });
  assert.throws(
    () => validateMonthlyExclusionResolutionInput({
      ...base,
      resolution: "conditional_review",
      action: "allow_both_with_basis"
    }),
    /basisNote/
  );
  assert.equal(validateMonthlyExclusionResolutionInput({
    ...base,
    resolution: "conditional_review",
    action: "allow_both_with_basis",
    basisNote: "別部位に対してそれぞれ実施した。"
  }).basisNote, "別部位に対してそれぞれ実施した。");
  assert.equal(validateMonthlyExclusionResolutionInput({
    ...base,
    revoke: true,
    expectedUpdatedAt: "2026-05-28T00:00:00.000Z"
  }).revoke, true);
});

test("defaults receipt exports to fail closed", () => {
  const settings = defaultFeeSettings({ facilityId: "fac_001" });
  assert.equal(settings.receiptPolicy.blockExportOnErrors, true);
  assert.equal(settings.receiptPolicy.connectorSpecVerified, false);
  assert.equal(settings.sidecarPatientAutoProvision, false);
  assert.deepEqual(settings.pricingPolicy, { mode: "service_date" });
});

test("normalizes fee pricing policy without changing the default", () => {
  assert.deepEqual(validateUpdateFeeSettingsInput({
    facilityId: "fac_001"
  }).pricingPolicy, { mode: "service_date" });

  assert.deepEqual(validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    pricingPolicy: { mode: "current_master" }
  }).pricingPolicy, { mode: "current_master" });

  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityId: "fac_001",
      pricingPolicy: { mode: "latest" }
    }),
    /pricingPolicy\.mode/u
  );
});

test("keeps care fee integration disabled by default and validates explicit facility opt-in", () => {
  assert.deepEqual(defaultFeeSettings({ facilityId: "fac_001" }).careFeeIntegration, {
    enabled: false,
    facilityCode: "",
    careOfficeNumber: "",
    careServiceType: "",
    signalPolicy: "conservative"
  });
  const settings = validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    careFeeIntegration: {
      enabled: true,
      facilityCode: "care-001",
      careOfficeNumber: "1234567890",
      careServiceType: "care_medical_institution",
      signalPolicy: "explicit_only"
    }
  });
  assert.equal(settings.careFeeIntegration.enabled, true);
  assert.equal(settings.careFeeIntegration.careServiceType, "care_medical_institution");
  assert.throws(() => validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    careFeeIntegration: { enabled: true, facilityCode: "care-001" }
  }), /careFeeIntegration\.careServiceType/u);
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
    residenceType: "private",
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
  assert.equal(input.residenceType, "private");
  assert.equal(input.extractionProof.domMutationDetected, false);
  assert.equal(Object.hasOwn(input, "sourceUrl"), false);
});

test("validates homis-mock-v5 multi-surface inputs and matching surface proofs", () => {
  const sourceRecordId = [
    "homis-visible-record-v1",
    "homis",
    "1001",
    "2026-07-18",
    "10010718",
    "14:30"
  ].join("\u001f");
  const surfaceHash = `sha256-${"A".repeat(43)}`;
  const sourceSurfaces = {
    currentChart: {
      status: "ok",
      patientId: "1001",
      observedAt: "2026-07-18T01:00:00.000Z",
      surfaceHash,
      raw: {
        careInsuranceText: "要介護5",
        visitingNurseText: "訪問看護 週4回 MCS連携",
        deviceManagementText: "気管切開・複管カニューレ 8.0mm",
        prescriptionRows: ["薬剤A 1錠"],
        patientStartDate: "2026-05-01",
        calendarMonth: "2026-07",
        calendarVisitDates: ["2026-07-18"]
      }
    },
    documents: {
      status: "unavailable",
      patientId: "1001",
      observedAt: "2026-07-18T01:00:00.000Z",
      surfaceHash,
      unavailableReason: "timeout"
    }
  };
  const input = validateSidecarCalculationInput({
    contractVersion: "v1",
    facilityId: "fac_001",
    sourceSystem: "homis",
    externalPatientId: "1001",
    sourceRecordId,
    serviceDate: "2026-07-18",
    setting: "home_visit",
    encounterTypeSource: "dom",
    clinicalText: "O: 訪問診療を実施。",
    sourceSurfaces,
    extractionProof: {
      patientIdBefore: "1001",
      patientIdAfter: "1001",
      sourceRecordIdBefore: sourceRecordId,
      sourceRecordIdAfter: sourceRecordId,
      selectorContractVersion: "homis-mock-v5",
      extractedAt: "2026-07-18T01:00:00.000Z",
      domMutationDetected: false,
      contractValidationPassed: true,
      previewMatched: true,
      requiredElementCount: 7,
      matchedRequiredElementCount: 7,
      clinicalTextNodeCount: 1,
      surfaceProofs: {
        currentChart: {
          status: "ok",
          patientId: "1001",
          observedAt: "2026-07-18T01:00:00.000Z",
          surfaceHash
        },
        documents: {
          status: "unavailable",
          patientId: "1001",
          observedAt: "2026-07-18T01:00:00.000Z",
          surfaceHash
        }
      }
    }
  });

  assert.equal(input.sourceSurfaces.currentChart.raw.calendarVisitDates[0], "2026-07-18");
  assert.equal(input.sourceRecordId, sourceRecordId);
  assert.equal(input.sourceSurfaces.currentChart.raw.patientStartDate, "2026-05-01");
  assert.equal(input.sourceSurfaces.documents.unavailableReason, "timeout");
  assert.equal(input.extractionProof.surfaceProofs.documents.status, "unavailable");

  assert.throws(() => validateSidecarCalculationInput({
    ...input,
    sourceSurfaces: {
      ...sourceSurfaces,
      documents: { ...sourceSurfaces.documents, patientId: "1002" }
    }
  }), /patient does not match/);
  assert.throws(() => validateSidecarCalculationInput({
    ...input,
    extractionProof: {
      ...input.extractionProof,
      surfaceProofs: {
        ...input.extractionProof.surfaceProofs,
        currentChart: {
          ...input.extractionProof.surfaceProofs.currentChart,
          surfaceHash: `sha256-${"B".repeat(43)}`
        }
      }
    }
  }), /does not match sourceSurfaces/);
  assert.throws(() => validateSidecarCalculationInput({
    ...input,
    sourceSurfaces: undefined,
    extractionProof: {
      ...input.extractionProof,
      surfaceProofs: undefined
    }
  }), /sourceSurfaces is required for homis-mock-v5/);
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
  assert.equal(unknown.residenceType, null);
  assert.throws(() => validateSidecarCalculationInput({
    ...base,
    residenceType: "nursing_home"
  }), /residenceType/);
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
    residenceType: null,
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
      single_building_patient_count: 4,
      residence_type: "facility"
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
    residenceType: "facility",
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

test("normalizes auto-billing roles used by encounter governance", () => {
  const normalized = validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    autoBillingRules: [{
      ruleId: "home_visit",
      code: "114001110",
      action: "confirm",
      billingRole: "home_visit_basic",
      settings: ["home_visit"]
    }]
  });

  assert.equal(normalized.autoBillingRules[0].billingRole, "home_visit_basic");
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityId: "fac_001",
      autoBillingRules: [{
        code: "114001110",
        billingRole: "mock_patient_1009"
      }]
    }),
    /autoBillingRules\.billingRole/u
  );
});

test("normalizes effective-dated facility service schedules", () => {
  const normalized = validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    facilityServiceSchedules: [{
      scheduleId: "clinic-hours-2026",
      effectiveFrom: "2026-06-01",
      effectiveTo: "2026-12-31",
      timezone: "Asia/Tokyo",
      weeklyHours: {
        monday: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
        tuesday: [{ start: "09:00", end: "18:00" }],
        wednesday: [{ start: "09:00", end: "18:00" }],
        thursday: [{ start: "09:00", end: "18:00" }],
        friday: [{ start: "09:00", end: "18:00" }],
        saturday: [{ start: "09:00", end: "12:00" }]
      },
      holidayDates: ["2026-07-20"],
      specialHours: [{
        date: "2026-07-19",
        hours: [{ start: "10:00", end: "13:00" }]
      }]
    }]
  });

  assert.equal(normalized.facilityServiceSchedules.length, 1);
  assert.equal(normalized.facilityServiceSchedules[0].scheduleId, "clinic-hours-2026");
  assert.deepEqual(normalized.facilityServiceSchedules[0].weeklyHours.sunday, []);
  assert.deepEqual(normalized.facilityServiceSchedules[0].holidayDates, ["2026-07-20"]);
  assert.deepEqual(normalized.facilityServiceSchedules[0].specialHours, [{
    date: "2026-07-19",
    hours: [{ start: "10:00", end: "13:00" }]
  }]);
});

test("rejects ambiguous or invalid facility service schedules", () => {
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityServiceSchedules: [{
        effectiveFrom: "2026-06-01",
        weeklyHours: {
          monday: [
            { start: "09:00", end: "12:00" },
            { start: "11:00", end: "13:00" }
          ]
        }
      }]
    }),
    /windows must not overlap/
  );
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityServiceSchedules: [
        {
          scheduleId: "first",
          effectiveFrom: "2026-06-01",
          effectiveTo: "2026-08-31",
          weeklyHours: { monday: [{ start: "09:00", end: "18:00" }] }
        },
        {
          scheduleId: "second",
          effectiveFrom: "2026-08-01",
          weeklyHours: { monday: [{ start: "09:00", end: "18:00" }] }
        }
      ]
    }),
    /effective periods overlap/
  );
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityServiceSchedules: [{
        effectiveFrom: "2026-06-01",
        timezone: "UTC",
        weeklyHours: { monday: [{ start: "09:00", end: "18:00" }] }
      }]
    }),
    /timezone must be Asia\/Tokyo/
  );
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

test("validates sidecar patient auto-provision as a strict facility boolean", () => {
  assert.equal(validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    sidecarPatientAutoProvision: true
  }).sidecarPatientAutoProvision, true);
  assert.equal(validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    current: { sidecarPatientAutoProvision: true }
  }).sidecarPatientAutoProvision, true);
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityId: "fac_001",
      sidecarPatientAutoProvision: "true"
    }),
    /sidecarPatientAutoProvision must be a boolean/
  );
});

test("validates facility standard completeness as a strict facility boolean", () => {
  assert.equal(defaultFeeSettings({ facilityId: "fac_001" }).facilityStandardsConfirmed, false);
  assert.equal(validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    facilityStandardsConfirmed: true
  }).facilityStandardsConfirmed, true);
  assert.equal(validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    current: { facilityStandardsConfirmed: true }
  }).facilityStandardsConfirmed, true);
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityId: "fac_001",
      facilityStandardsConfirmed: "true"
    }),
    /facilityStandardsConfirmed must be a boolean/
  );
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

test("rejects multiple active after-hours response system standards", () => {
  assert.throws(
    () => validateUpdateFeeSettingsInput({
      facilityId: "fac_001",
      facilityStandards: [
        { key: "jikan_gai_taio_taisei_1", status: "active" },
        { key: "jikan_gai_taio_taisei_3", status: "active" }
      ]
    }),
    (error) => (
      error?.name === "ValidationError"
      && error?.field === "facilityStandards"
      && /only one after-hours response system standard/u.test(error.message)
    )
  );

  const normalized = validateUpdateFeeSettingsInput({
    facilityId: "fac_001",
    facilityStandards: [
      { key: "jikan_gai_taio_taisei_1", status: "expired" },
      { key: "jikan_gai_taio_taisei_3", status: "active" }
    ]
  });
  assert.equal(normalized.facilityStandards.length, 2);
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

test("classifies past and external clinical-service context through the shared predicate", () => {
  assert.equal(isPastOrExternalClinicalServiceContext("前回は電話再診だった。"), true);
  assert.equal(isPastOrExternalClinicalServiceContext("他院で検査を実施した。"), true);
  assert.equal(isPastOrExternalClinicalServiceContext("院外で検査を実施した。"), true);
  assert.equal(isPastOrExternalClinicalServiceContext("本日、院外処方箋を交付した。"), false);
  assert.equal(isPastOrExternalClinicalServiceContext("院外処方でアムロジピンを処方した。"), false);
  assert.equal(isPastOrExternalClinicalServiceContext("院外で処方した。"), false);
  assert.equal(isPastOrExternalClinicalServiceContext("処方は院外とした。"), false);
  assert.equal(isPastOrExternalClinicalServiceContext("本日、電話再診として対応した。"), false);
});

test("builds shared clinical-service cues without treating outside prescriptions as external care", () => {
  assert.deepEqual(clinicalServiceContextCues("本日、院外処方箋を交付した。"), {
    futureOrOrderOnly: false,
    negatedService: false,
    pastOrExternal: false,
    currentVisit: true
  });
  assert.deepEqual(clinicalServiceContextCues("前医で前回CTを実施した。"), {
    futureOrOrderOnly: false,
    negatedService: false,
    pastOrExternal: true,
    currentVisit: false
  });
  assert.deepEqual(clinicalServiceContextCues("次回は採血を実施予定。"), {
    futureOrOrderOnly: true,
    negatedService: false,
    pastOrExternal: false,
    currentVisit: false
  });
});

test("splits clinical evidence at punctuation and parenthetical boundaries with code-point offsets", () => {
  const text = "O）😀静脈採血を施行（HbA1cは後日確認予定）、尿検査も実施。";
  const clauses = splitClinicalEvidenceClauses(text, { lineId: "O-001" });
  assert.deepEqual(clauses.map((clause) => clause.text), [
    "O）😀静脈採血を施行",
    "HbA1cは後日確認予定",
    "尿検査も実施。"
  ]);
  assert.equal(
    Array.from(text).slice(clauses[0].charStart, clauses[0].charEnd).join(""),
    "O）😀静脈採血を施行"
  );
});

test("scopes future cues to the mentioned act and keeps governing past cues", () => {
  const performed = clinicalServiceContextCuesForMention(
    "静脈採血を施行（HbA1c・腎機能・電解質を確認予定）。",
    "静脈採血"
  );
  assert.equal(performed.futureOrOrderOnly, false);
  assert.equal(performed.performedEvidence, true);
  assert.match(performed.scopedText, /静脈採血を施行/u);
  assert.doesNotMatch(performed.scopedText, /確認予定/u);

  const planned = clinicalServiceContextCuesForMention("次回、静脈採血を予定。", "静脈採血");
  assert.equal(planned.futureOrOrderOnly, true);

  const past = clinicalServiceContextCuesForMention("前医で、静脈採血を実施。", "静脈採血");
  assert.equal(past.pastOrExternal, true);
});

test("blood collection predicate separates performed collection from future result review", () => {
  assert.equal(
    hasPerformedBloodCollectionEvidenceInText(
      "O: 静脈採血を施行（HbA1c・腎機能・電解質を確認予定）。"
    ),
    true
  );
  assert.equal(hasPerformedBloodCollectionEvidenceInText("P: 次回、静脈採血を予定。"), false);
  assert.equal(
    hasPerformedBloodCollectionEvidenceInText("O: 静脈採血を実施。P: 次回も静脈採血を予定。"),
    true
  );
  assert.equal(hasPerformedBloodCollectionEvidenceInText("O: 静脈採血を実施せず。"), false);
});

test("filters pain-scale ratios from clinical date extraction contexts", () => {
  assert.equal(isClinicalDateRatioFalsePositiveContext("疼痛 NRS 7/10、VAS 6/10"), true);
  assert.equal(isClinicalDateRatioFalsePositiveContext("血圧 130/80"), true);
  assert.equal(isClinicalDateRatioFalsePositiveContext("7/10 再診、採血実施"), false);
  assert.equal(isClinicalDateRatioFalsePositiveContext("7/10に再診予定"), false);
});
