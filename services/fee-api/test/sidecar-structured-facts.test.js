import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSingleBuildingPatientCountFact,
  normalizeSidecarStructuredFacts
} from "../src/sidecar-structured-facts.js";

test("normalizes current-chart and document surfaces without inventing missing facts", () => {
  const facts = normalizeSidecarStructuredFacts({
    serviceDate: "2026-06-23",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          careInsuranceText: "要介護5",
          visitingNurseText: "訪問看護 週4回 MCS連携",
          deviceManagementText: "気管切開・複管カニューレ 8.0mm 陽圧式人工呼吸器（TPPV）",
          prescriptionRows: ["ラコサミド錠100mg 2錠", "分2 朝夕食後 28日分"],
          patientStartDate: "2026-04-01",
          calendarMonth: "2026-06",
          calendarVisitDates: ["2026-06-02", "2026-06-23"]
        }
      },
      documents: {
        status: "ok",
        raw: {
          rows: [{
            kind: "訪問看護指示書",
            period: "6/1 - 6/30",
            writtenDate: "6/1",
            status: "作成済"
          }]
        }
      }
    }
  });

  assert.equal(facts.schemaVersion, "fee-sidecar-structured-facts-v2");
  assert.deepEqual(facts.sourceStatus, {
    currentChart: { status: "known", unavailableReason: null },
    documents: { status: "known", unavailableReason: null },
    problems: { status: "unknown", unavailableReason: null },
    visitPlan: { status: "unknown", unavailableReason: null }
  });
  assert.deepEqual(facts.care, {
    certificationLevel: 5,
    certificationStatus: "known",
    visitingNurseWeeklyCount: 4,
    visitingNurseFrequencyStatus: "known",
    ictCoordination: true,
    ictCoordinationStatus: "known"
  });
  assert.deepEqual(facts.devices.map((device) => device.type), [
    "ventilator",
    "tracheostomy_cannula"
  ]);
  assert.deepEqual(facts.devices[1].attributes, {
    doubleTube: true,
    cuffed: null,
    suctionEnabled: null,
    sizeMm: 8
  });
  assert.equal(facts.documents[0].writtenDateText, "6/1");
  assert.equal(Object.hasOwn(facts.documents[0], "writtenDate"), false);
  assert.equal(facts.documents[0].actionStatus, "created");
  assert.equal(facts.documents[0].documentDate, "2026-06-01");
  assert.equal(facts.encounter.patientStartDate, "2026-04-01");
  assert.deepEqual(facts.encounter.monthlyVisitDays, ["2026-06-02", "2026-06-23"]);
});

test("keeps unknown values separate from an unavailable documents surface", () => {
  const facts = normalizeSidecarStructuredFacts({
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          careInsuranceText: "介護情報を確認中",
          visitingNurseText: "",
          deviceManagementText: "（在宅医療機器の登録なし）",
          prescriptionRows: [],
          calendarMonth: null,
          calendarVisitDates: []
        }
      },
      documents: {
        status: "unavailable",
        unavailableReason: "timeout"
      }
    }
  });

  assert.equal(facts.care.certificationStatus, "unknown");
  assert.equal(facts.care.certificationLevel, null);
  assert.equal(facts.care.ictCoordination, null);
  assert.deepEqual(facts.devices, []);
  assert.deepEqual(facts.documents, []);
  assert.deepEqual(facts.sourceStatus.documents, {
    status: "unavailable",
    unavailableReason: "timeout"
  });
});

test("normalizes an artificial nose as its own device fact", () => {
  const facts = normalizeSidecarStructuredFacts({
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          deviceManagementText: "気管切開カニューレ 複管 8.0mm（人工鼻使用）"
        }
      },
      documents: { status: "ok", raw: { rows: [] } }
    }
  });

  assert.deepEqual(facts.devices.map((device) => device.type), [
    "tracheostomy_cannula",
    "artificial_nose"
  ]);
});

test("normalizes first-wave material device attributes without inferring missing values", () => {
  const facts = normalizeSidecarStructuredFacts({
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          deviceManagementText: [
            "経鼻栄養カテーテル 経腸栄養用",
            "膀胱留置カテーテル 2管（2） 閉鎖式",
            "胃瘻カテーテル 胃留置型 バルーン型"
          ].join("\n")
        }
      },
      documents: { status: "ok", raw: { rows: [] } }
    },
    serviceDate: "2026-06-25"
  });

  const byType = new Map(facts.devices.map((device) => [device.type, device.attributes]));
  assert.deepEqual(byType.get("enteral_nasal_tube"), {
    route: "nasal",
    variant: "enteral_nutrition"
  });
  assert.deepEqual(byType.get("urinary_indwelling_catheter"), {
    variant: "two_lumen_2",
    system: "closed"
  });
  assert.deepEqual(byType.get("gastrostomy_catheter"), {
    placement: "stomach",
    retention: "balloon",
    guidewire: null
  });
});

test("derives one patient only from the same private-residence evidence revision", () => {
  assert.deepEqual(deriveSingleBuildingPatientCountFact({
    privateResidence: true,
    sameBuilding: false,
    singleBuildingPatientCount: null,
    sourceRevision: "sha256-screen"
  }), {
    value: 1,
    status: "known",
    source: "derived:screen.privateResidence+screen.sameBuildingOutside",
    sourceRevision: "sha256-screen"
  });
  assert.equal(deriveSingleBuildingPatientCountFact({
    privateResidence: false,
    sameBuilding: false
  }).status, "unknown");
  assert.equal(deriveSingleBuildingPatientCountFact({
    sameBuilding: false,
    singleBuildingPatientCount: 6
  }).status, "conflict");
});

test("builds provenance-bearing selection facts from complete supplemental surfaces", () => {
  const facts = normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v6",
    serviceDate: "2026-07-25",
    privateResidence: true,
    sameBuilding: false,
    sourceRevisionHash: "sha256-request-revision",
    observedAt: "2026-08-03T00:00:00.000Z",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        surfaceHash: "sha256-current",
        observedAt: "2026-08-03T00:00:00.000Z",
        raw: {
          deviceManagementText: "（在宅医療機器の登録なし）",
          deviceManagementListCompleteness: "complete",
          calendarMonth: "2026-07",
          calendarVisitDates: ["2026-07-11", "2026-07-25"],
          calendarVisitListCompleteness: "complete"
        }
      },
      problems: {
        status: "ok",
        surfaceHash: "sha256-problems",
        observedAt: "2026-08-03T00:00:00.000Z",
        raw: {
          listCompleteness: "complete",
          rows: [{
            name: "高血圧症",
            startDate: "2020-01-01",
            outcome: "継続",
            suspected: false
          }]
        }
      },
      visitPlan: {
        status: "ok",
        surfaceHash: "sha256-plan",
        observedAt: "2026-08-03T00:00:00.000Z",
        raw: {
          calendarMonth: "2026-07",
          basis: "encounter_history",
          listCompleteness: "complete",
          rows: [
            {
              serviceDate: "2026-07-11", encounterType: "home_visit", status: "completed",
              sourceRecordId: "record-0711"
            },
            {
              serviceDate: "2026-07-25", encounterType: "home_visit", status: "completed",
              sourceRecordId: "record-0725"
            }
          ]
        }
      }
    }
  });

  assert.deepEqual(facts.selection.singleBuildingPatientCount, {
    value: 1,
    status: "known",
    source: "derived:screen.privateResidence+screen.sameBuildingOutside",
    sourceRevision: "sha256-request-revision",
    observedAt: "2026-08-03T00:00:00.000Z"
  });
  const monthlyVisitRevision = facts.selection.qualifyingMonthlyVisits.sourceRevision;
  assert.deepEqual(facts.selection.qualifyingMonthlyVisits, {
    value: 2,
    status: "complete",
    source: "homis.encounterHistory+currentChart.calendar",
    sourceRevision: monthlyVisitRevision,
    observedAt: "2026-08-03T00:00:00.000Z",
    serviceDates: ["2026-07-11", "2026-07-25"]
  });
  assert.match(
    facts.selection.qualifyingMonthlyVisits.sourceRevision,
    /^sha256-[A-Za-z0-9_-]{43}$/u
  );
  assert.equal(facts.selection.specialDisease.value, "not_eligible");
  assert.equal(facts.selection.specialDisease.status, "known");
  assert.equal(
    facts.selection.specialDisease.source,
    "homis.problems+currentChart.devices+feeRule.c002SpecialDisease.r8"
  );
  assert.match(facts.selection.specialDisease.sourceRevision, /^sha256-[A-Za-z0-9_-]{43}$/u);
  assert.equal(facts.selection.specialDisease.observedAt, "2026-08-03T00:00:00.000Z");
});

test("does not turn incomplete problem or state surfaces into disease non-eligibility", () => {
  const incompleteProblems = normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v6",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          deviceManagementText: "（在宅医療機器の登録なし）",
          deviceManagementListCompleteness: "complete"
        }
      },
      problems: {
        status: "unavailable",
        unavailableReason: "timeout"
      }
    }
  });
  assert.equal(incompleteProblems.selection.specialDisease.value, "unknown");
  assert.equal(
    incompleteProblems.selection.specialDisease.reason,
    "incomplete_c002_table_8_2_sources"
  );

  const incompleteStates = normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v6",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          deviceManagementText: "（在宅医療機器の登録なし）",
          deviceManagementListCompleteness: "unknown"
        }
      },
      problems: {
        status: "ok",
        raw: {
          listCompleteness: "complete",
          rows: [{
            name: "高血圧症", startDate: "2020-01-01", outcome: "継続", suspected: false
          }]
        }
      }
    }
  });
  assert.equal(incompleteStates.selection.specialDisease.value, "unknown");
  assert.equal(
    incompleteStates.selection.specialDisease.reason,
    "incomplete_c002_table_8_2_sources"
  );
});

test("counts only typed completed home visits through the selected service date", () => {
  const facts = normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v6",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        surfaceHash: "sha256-current",
        raw: {
          calendarMonth: "2026-07",
          calendarVisitDates: ["2026-07-04", "2026-07-25", "2026-07-30"],
          calendarVisitListCompleteness: "complete"
        }
      },
      visitPlan: {
        status: "ok",
        surfaceHash: "sha256-plan",
        raw: {
          calendarMonth: "2026-07",
          basis: "encounter_history",
          listCompleteness: "complete",
          rows: [
            {
              serviceDate: "2026-07-04", encounterType: "outpatient",
              visitKind: "telephone_revisit", status: "completed", sourceRecordId: "phone-0704"
            },
            {
              serviceDate: "2026-07-25", encounterType: "home_visit",
              status: "completed", sourceRecordId: "home-0725"
            },
            {
              serviceDate: "2026-07-30", encounterType: "home_visit",
              status: "completed", sourceRecordId: "home-0730"
            }
          ]
        }
      }
    }
  });

  assert.equal(facts.selection.qualifyingMonthlyVisits.value, 1);
  assert.deepEqual(facts.selection.qualifyingMonthlyVisits.serviceDates, ["2026-07-25"]);
});

test("v7 accepts only restored and reconciled visible-chart navigation as complete history", () => {
  const sourceRecordId = "homis-visible-record-v1\u001fhomis\u001f1001\u001f2026-07-25\u001f10010725\u001f10:30";
  const buildFacts = (integrity = {}) => normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v7",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        surfaceHash: "sha256-current",
        raw: {
          calendarMonth: "2026-07",
          calendarVisitDates: ["2026-07-11", "2026-07-25"],
          calendarVisitListCompleteness: "complete"
        }
      },
      visitPlan: {
        status: "ok",
        surfaceHash: "sha256-plan",
        raw: {
          calendarMonth: "2026-07",
          basis: "encounter_history",
          listCompleteness: "complete",
          collectionMethod: "chart_navigation",
          traversalComplete: true,
          calendarReconciled: true,
          originalSourceRecordId: sourceRecordId,
          restoredSourceRecordId: sourceRecordId,
          ...integrity,
          rows: [{
            serviceDate: "2026-07-11", encounterType: "home_visit",
            status: "completed", sourceRecordId: "record-0711"
          }, {
            serviceDate: "2026-07-25", encounterType: "home_visit",
            status: "completed", sourceRecordId
          }]
        }
      }
    }
  });

  const complete = buildFacts();
  assert.equal(complete.selection.qualifyingMonthlyVisits.value, 2);
  assert.equal(complete.selection.qualifyingMonthlyVisits.status, "complete");
  assert.equal(
    complete.selection.qualifyingMonthlyVisits.source,
    "homis.chartNavigation+currentChart.calendar"
  );

  for (const integrity of [
    { traversalComplete: false },
    { calendarReconciled: false },
    { restoredSourceRecordId: "different-record" },
    { collectionMethod: null }
  ]) {
    const failed = buildFacts(integrity);
    assert.equal(failed.selection.qualifyingMonthlyVisits.value, null);
    assert.equal(failed.selection.qualifyingMonthlyVisits.status, "incomplete");
  }
});

test("does not collapse distinct same-day encounter records into one monthly visit", () => {
  const facts = normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v6",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        surfaceHash: "sha256-current",
        raw: {
          calendarMonth: "2026-07",
          calendarVisitDates: ["2026-07-25"],
          calendarVisitListCompleteness: "complete"
        }
      },
      visitPlan: {
        status: "ok",
        surfaceHash: "sha256-plan",
        raw: {
          calendarMonth: "2026-07",
          basis: "encounter_history",
          listCompleteness: "complete",
          rows: [{
            serviceDate: "2026-07-25", encounterType: "home_visit",
            status: "completed", sourceRecordId: "home-0725-a"
          }, {
            serviceDate: "2026-07-25", encounterType: "home_visit",
            status: "completed", sourceRecordId: "home-0725-b"
          }]
        }
      }
    }
  });

  assert.equal(facts.selection.qualifyingMonthlyVisits.value, null);
  assert.equal(facts.selection.qualifyingMonthlyVisits.status, "incomplete");
});

test("fails closed when the current-month chart calendar is not proven complete", () => {
  const facts = normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v6",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          calendarMonth: "2026-07",
          calendarVisitDates: ["2026-07-25"],
          calendarVisitListCompleteness: "unknown"
        }
      },
      visitPlan: {
        status: "ok",
        raw: {
          calendarMonth: "2026-07",
          basis: "encounter_history",
          listCompleteness: "complete",
          rows: [{
            serviceDate: "2026-07-25", encounterType: "home_visit",
            status: "completed", sourceRecordId: "home-0725"
          }]
        }
      }
    }
  });

  assert.equal(facts.selection.qualifyingMonthlyVisits.value, null);
  assert.equal(facts.selection.qualifyingMonthlyVisits.status, "incomplete");
});

test("v5 payloads cannot opt into v6 disease or encounter-history evidence", () => {
  const facts = normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v5",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        raw: {
          deviceManagementText: "在宅人工呼吸器（TPPV）",
          deviceManagementListCompleteness: "complete",
          calendarMonth: "2026-07",
          calendarVisitDates: ["2026-07-11", "2026-07-25"],
          calendarVisitListCompleteness: "complete"
        }
      },
      problems: {
        status: "ok",
        raw: {
          listCompleteness: "complete",
          rows: [{ name: "筋萎縮性側索硬化症", outcome: "継続", suspected: false }]
        }
      },
      visitPlan: {
        status: "ok",
        raw: {
          calendarMonth: "2026-07",
          basis: "encounter_history",
          listCompleteness: "complete",
          rows: [{
            serviceDate: "2026-07-11", encounterType: "home_visit",
            status: "completed", sourceRecordId: "record-0711"
          }, {
            serviceDate: "2026-07-25", encounterType: "home_visit",
            status: "completed", sourceRecordId: "record-0725"
          }]
        }
      }
    }
  });
  assert.equal(facts.selection.specialDisease.value, "unknown");
  assert.equal(facts.selection.qualifyingMonthlyVisits.value, null);
  assert.equal(facts.selection.qualifyingMonthlyVisits.status, "unknown");
});

test("special-disease provenance changes when a patient evidence surface changes", () => {
  const resolveRevision = (problemHash) => normalizeSidecarStructuredFacts({
    selectorContractVersion: "homis-mock-v6",
    serviceDate: "2026-07-25",
    sourceSurfaces: {
      currentChart: {
        status: "ok",
        surfaceHash: "sha256-current",
        raw: {
          deviceManagementText: "（在宅医療機器の登録なし）",
          deviceManagementListCompleteness: "complete"
        }
      },
      problems: {
        status: "ok",
        surfaceHash: problemHash,
        raw: {
          listCompleteness: "complete",
          rows: [{
            name: "高血圧症", startDate: "2020-01-01", outcome: "継続", suspected: false
          }]
        }
      }
    }
  }).selection.specialDisease.sourceRevision;

  assert.notEqual(resolveRevision("sha256-problems-a"), resolveRevision("sha256-problems-b"));
});
