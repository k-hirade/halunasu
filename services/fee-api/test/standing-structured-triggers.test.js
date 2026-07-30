import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStandingStructuredFacts,
  evaluateStandingStructuredTriggers,
  standingStructuredTriggerArtifactMetadata
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
  assert.equal(metadata.schemaVersion, "fee-standing-structured-trigger-artifact-v2");
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
    monthlyVisitDays: []
  });
  assert.equal(facts.clinical.activeDiagnosisCount, 1);
  assert.equal(facts.clinical.currentManagementOrCounselingCount, 1);
  assert.equal(facts.clinical.medicationFactCount, 1);
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

function family({ familyId, name, section, code }) {
  return {
    familyId,
    name,
    hierarchy: {
      chapter: "2",
      part: "02",
      alphaPart: "C",
      section,
      branch: "00"
    },
    variants: [{ code, name, points: 100 }]
  };
}
