import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStandingStructuredFacts,
  evaluateStandingStructuredTriggers,
  standingStructuredTriggerArtifactMetadata,
  standingStructuredTriggerFamilySelectors
} from "../src/standing-structured-triggers.js";

const HOME_MANAGEMENT_FAMILY = Object.freeze({
  familyId: "fee_family_home_management",
  name: "在医総管",
  hierarchy: {
    chapter: "2",
    part: "02",
    alphaPart: "C",
    section: "002",
    branch: "00"
  },
  variants: [{ code: "114000001", name: "在医総管（区分例）" }]
});

const FACILITY_MANAGEMENT_FAMILY = Object.freeze({
  familyId: "fee_family_facility_management",
  name: "施医総管",
  hierarchy: {
    chapter: "2",
    part: "02",
    alphaPart: "C",
    section: "002",
    branch: "02"
  },
  variants: [{ code: "114000002", name: "施医総管（区分例）" }]
});

function structuredFacts(overrides = {}) {
  return {
    encounter: {
      plannedHomeVisit: true,
      residenceType: "private",
      ...overrides.encounter
    },
    clinical: {
      activeDiagnosisCount: 1,
      currentManagementOrCounselingCount: 1,
      medicationFactCount: 0,
      deviceFactCount: 0,
      testFactCount: 0,
      ...overrides.clinical
    }
  };
}

test("standing trigger artifact is versioned and integrity checked on import", () => {
  const metadata = standingStructuredTriggerArtifactMetadata();
  assert.equal(metadata.schemaVersion, "fee-standing-structured-trigger-artifact-v3");
  assert.equal(metadata.effectiveFrom, "2026-06-01");
  assert.match(metadata.artifactPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.match(metadata.sourceDefinitionSha256, /^[a-f0-9]{64}$/u);
});

test("structured triggers select the exact C002 family from positive facts", () => {
  const result = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: structuredFacts()
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].family.familyId, HOME_MANAGEMENT_FAMILY.familyId);
  assert.equal(result.matches[0].trigger.version, "2026");
  assert.deepEqual(result.matches[0].matchedFacts, [
    "encounter.plannedHomeVisit",
    "encounter.residenceType",
    "clinical.activeDiagnosisCount",
    "clinical.currentManagementOrCounselingCount"
  ]);
});

test("facility residence selects C002-2 while outpatient and medication-only facts stay silent", () => {
  const facilityResult = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: structuredFacts({
      encounter: { residenceType: "facility" }
    })
  });
  assert.equal(facilityResult.matches.length, 1);
  assert.equal(facilityResult.matches[0].family.familyId, FACILITY_MANAGEMENT_FAMILY.familyId);

  const outpatient = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: structuredFacts({
      encounter: { plannedHomeVisit: false }
    })
  });
  assert.equal(outpatient.matches.length, 0);

  const medicationOnly = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: structuredFacts({
      clinical: {
        currentManagementOrCounselingCount: 0,
        medicationFactCount: 3
      }
    })
  });
  assert.equal(medicationOnly.matches.length, 0);
});

test("builds positive facts only from current own-clinic structured events", () => {
  const facts = buildStandingStructuredFacts({
    session: {
      setting: "home_visit",
      encounterDetails: {
        residenceType: "private",
        sameBuilding: false,
        singleBuildingPatientCount: 1
      },
      diagnoses: [
        { name: "慢性心不全", status: "active" },
        { name: "除外病名", status: "ruled_out" }
      ]
    },
    prepared: {
      diagnoses: [{ name: "慢性心不全", status: "confirmed" }],
      clinicalEvents: [
        {
          type: "management",
          actionStatus: "performed",
          temporalRelation: "current_visit",
          providerOwnership: "own_clinic"
        },
        {
          type: "counseling",
          actionStatus: "performed",
          temporalRelation: "past",
          providerOwnership: "own_clinic"
        },
        {
          type: "management",
          actionStatus: "planned",
          temporalRelation: "future",
          providerOwnership: "own_clinic"
        },
        {
          type: "management",
          actionStatus: "performed",
          temporalRelation: "current_visit",
          providerOwnership: "other_provider"
        },
        {
          type: "medication",
          actionStatus: "prescribed",
          temporalRelation: "current_visit",
          providerOwnership: "own_clinic"
        }
      ],
      calculationOptions: {
        devices: [{ name: "在宅機器" }],
        tests: [{ name: "検査" }]
      }
    }
  });

  assert.deepEqual(facts.encounter, {
    setting: "home_visit",
    plannedHomeVisit: true,
    residenceType: "private",
    sameBuilding: false,
    singleBuildingPatientCount: 1,
    patientStartDate: null,
    withinThreeMonthsOfPatientStart: null,
    monthlyVisitDays: [],
    monthlyVisitDayCount: 0
  });
  assert.equal(facts.clinical.activeDiagnosisCount, 1);
  assert.equal(facts.clinical.currentManagementOrCounselingCount, 1);
  assert.equal(facts.clinical.medicationFactCount, 1);
  assert.equal(facts.clinical.explicitMedicationReductionTwoOrMore, false);
  assert.equal(facts.clinical.deviceFactCount, 1);
  assert.deepEqual(facts.clinical.deviceTypes, []);
  assert.equal(facts.clinical.testFactCount, 1);
  assert.deepEqual(facts.care, {
    certificationLevel: null,
    visitingNurseWeeklyCount: null,
    ictCoordination: null
  });
});

test("typed device facts create management candidates without inventing absent devices", () => {
  const ventilatorFamily = family({
    familyId: "ventilator",
    name: "在宅人工呼吸指導管理料",
    section: "107",
    code: "114005410"
  });
  const tracheostomyFamily = family({
    familyId: "tracheostomy",
    name: "在宅気管切開患者指導管理料",
    section: "112",
    code: "114011110"
  });
  const result = evaluateStandingStructuredTriggers({
    families: [ventilatorFamily, tracheostomyFamily],
    structuredFacts: {
      clinical: {
        deviceTypes: ["ventilator"]
      }
    }
  });

  assert.deepEqual(result.matches.map((match) => match.family.familyId), ["ventilator"]);
  assert.equal(result.matches[0].trigger.ruleKind, "device_management");
});

test("dependent add-ons require a parent family, facility key, and positive typed facts", () => {
  const informationFamily = family({
    familyId: "information",
    name: "在宅医療情報連携加算",
    section: "002",
    code: "114723810"
  });
  const facts = {
    care: { ictCoordination: true },
    facility: {
      activeStandardKeys: ["zaitaku_iryo_joho_renkei_kasan"]
    }
  };
  const withoutParent = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, informationFamily],
    structuredFacts: facts
  });
  assert.equal(withoutParent.matches.length, 0);
  assert.equal(withoutParent.diagnostics.reasonCounts.parent_family_missing, 1);

  const withParent = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, informationFamily],
    structuredFacts: facts,
    availableParentFamilyIds: [HOME_MANAGEMENT_FAMILY.familyId]
  });
  assert.equal(withParent.matches.length, 1);
  assert.equal(withParent.matches[0].family.familyId, "information");
  assert.deepEqual(withParent.matches[0].parentFamilyIds, [
    HOME_MANAGEMENT_FAMILY.familyId
  ]);
});

test("confirm-with-note keeps an ICT candidate when the facility standard is unresolved", () => {
  const informationFamily = family({
    familyId: "information",
    name: "在宅医療情報連携加算",
    section: "002",
    code: "114723810"
  });
  const result = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, informationFamily],
    structuredFacts: {
      care: { ictCoordination: true },
      facility: { activeStandardKeys: [] }
    },
    availableParentFamilyIds: [HOME_MANAGEMENT_FAMILY.familyId]
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].trigger.failureMode, "confirm_with_note");
  assert.equal(
    result.matches[0].unresolvedConditions[0].conditionId,
    "required_facility_standard"
  );
  assert.ok(result.matches[0].humanVerifiableConditions.length >= 2);
});

test("typed devices emit only their dependent add-ons when the parent management family is available", () => {
  const oxygenManagement = family({
    familyId: "oxygen_management",
    name: "在宅酸素療法指導管理料",
    section: "103",
    code: "114002410"
  });
  const concentrator = family({
    familyId: "oxygen_concentrator",
    name: "酸素濃縮装置加算",
    section: "158",
    code: "114006210"
  });
  const cylinder = family({
    familyId: "oxygen_cylinder",
    name: "酸素ボンベ加算",
    section: "157",
    code: "114006310"
  });
  const result = evaluateStandingStructuredTriggers({
    families: [oxygenManagement, concentrator, cylinder],
    structuredFacts: {
      clinical: { deviceTypes: ["oxygen_concentrator"] }
    },
    availableParentFamilyIds: [oxygenManagement.familyId]
  });

  assert.deepEqual(
    result.matches
      .filter((match) => match.trigger.ruleKind === "dependent_addon")
      .map((match) => match.trigger.triggerId),
    ["c158_oxygen_concentrator_addon_review_candidate"]
  );
  assert.equal(
    result.matches.find((match) => match.trigger.ruleKind === "dependent_addon")
      .trigger.failureMode,
    "confirm_with_note"
  );
});

test("home-care enhancement add-on requires the matching parent branch and facility standard", () => {
  const enhancement = family({
    familyId: "home_care_enhancement",
    name: "在宅医療充実体制加算",
    section: "002",
    branch: "00",
    code: "114034570"
  });
  const result = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, enhancement],
    structuredFacts: {
      encounter: { plannedHomeVisit: true },
      facility: { activeStandardKeys: ["4248"] }
    },
    availableParentFamilyIds: [HOME_MANAGEMENT_FAMILY.familyId]
  });

  assert.equal(result.matches.length, 1);
  assert.equal(
    result.matches[0].trigger.triggerId,
    "c002_home_care_enhancement_addon_review_candidate"
  );
  assert.deepEqual(result.matches[0].parentFamilyIds, [HOME_MANAGEMENT_FAMILY.familyId]);
});

test("medication reduction fact requires current explicit reduction of two or more drugs", () => {
  const medicationFamily = family({
    familyId: "medication_reduction",
    name: "薬剤総合評価調整管理料",
    part: "01",
    alphaPart: "B",
    section: "008",
    branch: "02",
    code: "113023110"
  });
  const current = buildStandingStructuredFacts({
    session: {
      clinicalText: "P）催眠薬と三環系抗うつ薬の2剤を中止した。"
    }
  });
  const past = buildStandingStructuredFacts({
    session: {
      clinicalText: "前回、催眠薬と三環系抗うつ薬の2剤を中止した。"
    }
  });
  const planned = buildStandingStructuredFacts({
    session: {
      clinicalText: "次回、催眠薬と三環系抗うつ薬の2剤を中止する予定。"
    }
  });
  const external = buildStandingStructuredFacts({
    session: {
      clinicalText: "他院で催眠薬と三環系抗うつ薬の2剤を中止した。"
    }
  });

  assert.equal(current.clinical.explicitMedicationReductionTwoOrMore, true);
  assert.equal(past.clinical.explicitMedicationReductionTwoOrMore, false);
  assert.equal(planned.clinical.explicitMedicationReductionTwoOrMore, false);
  assert.equal(external.clinical.explicitMedicationReductionTwoOrMore, false);
  assert.equal(evaluateStandingStructuredTriggers({
    families: [medicationFamily],
    structuredFacts: current
  }).matches.length, 1);
});

test("frequent-visit selector is exported and requires four current-month visit days", () => {
  const selector = standingStructuredTriggerFamilySelectors().find((entry) => (
    entry.name === "頻回訪問加算"
  ));
  assert.ok(selector);
  const frequentFamily = family({
    familyId: "frequent_visit",
    name: "頻回訪問加算",
    section: "002",
    code: "114716010"
  });
  const matched = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, frequentFamily],
    structuredFacts: {
      encounter: { monthlyVisitDayCount: 4 }
    },
    availableParentFamilyIds: [HOME_MANAGEMENT_FAMILY.familyId]
  });
  const absent = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, frequentFamily],
    structuredFacts: {
      encounter: { monthlyVisitDayCount: 3 }
    },
    availableParentFamilyIds: [HOME_MANAGEMENT_FAMILY.familyId]
  });

  assert.equal(matched.matches.length, 1);
  assert.equal(matched.matches[0].trigger.triggerId, "c002_frequent_visit_addon_review_candidate");
  assert.equal(absent.matches.length, 0);
});

test("recall-first triggers emit no candidate when every minimum positive fact is absent", () => {
  const families = [
    HOME_MANAGEMENT_FAMILY,
    family({
      familyId: "information",
      name: "在宅医療情報連携加算",
      section: "002",
      code: "114723810"
    }),
    family({
      familyId: "early_transition",
      name: "在宅移行早期加算",
      section: "002",
      code: "114016070"
    }),
    family({
      familyId: "frequent_visit",
      name: "頻回訪問加算",
      section: "002",
      code: "114716010"
    }),
    family({
      familyId: "medication_reduction",
      name: "薬剤総合評価調整管理料",
      part: "01",
      alphaPart: "B",
      section: "008",
      branch: "02",
      code: "113043210"
    }),
    family({
      familyId: "oxygen_concentrator",
      name: "酸素濃縮装置加算",
      section: "158",
      code: "114006210"
    }),
    family({
      familyId: "home_care_enhancement",
      name: "在宅医療充実体制加算",
      section: "002",
      code: "114034570"
    })
  ];
  const result = evaluateStandingStructuredTriggers({
    families,
    structuredFacts: {
      encounter: {
        withinThreeMonthsOfPatientStart: false,
        monthlyVisitDayCount: 3
      },
      care: {
        ictCoordination: false
      },
      clinical: {
        deviceTypes: [],
        explicitMedicationReductionTwoOrMore: false
      }
    },
    availableParentFamilyIds: [HOME_MANAGEMENT_FAMILY.familyId]
  });

  assert.equal(result.matches.length, 0);
  assert.ok(Number(result.diagnostics.reasonCounts.required_positive_fact_missing || 0) >= 4);
});

function family({
  familyId,
  name,
  part = "02",
  alphaPart = "C",
  section,
  branch = "00",
  code
}) {
  return {
    familyId,
    name,
    hierarchy: {
      chapter: "2",
      part,
      alphaPart,
      section,
      branch
    },
    variants: [{ code, name, points: 100 }]
  };
}
