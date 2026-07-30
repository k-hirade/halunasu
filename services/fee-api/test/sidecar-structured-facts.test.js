import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSidecarStructuredFacts } from "../src/sidecar-structured-facts.js";

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

  assert.equal(facts.schemaVersion, "fee-sidecar-structured-facts-v1");
  assert.deepEqual(facts.sourceStatus, {
    currentChart: { status: "known", unavailableReason: null },
    documents: { status: "known", unavailableReason: null }
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
