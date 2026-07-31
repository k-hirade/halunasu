import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildStandingStructuredFacts,
  evaluateStandingStructuredTriggers,
  standingStructuredFactsSummary,
  standingStructuredFamilyCatalogDiagnostics,
  standingStructuredTriggerArtifactMetadata,
  standingStructuredTriggerFamilySelectors
} from "../src/standing-structured-triggers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const snapshotPath = path.join(
  repoRoot,
  "data/tests/fee-standing-family-catalog-snapshot-2026-06.json"
);
const realMasterPath = path.join(
  repoRoot,
  "python/data/master/standard-master.sqlite"
);
const CATALOG_SNAPSHOT = JSON.parse(readFileSync(snapshotPath, "utf8"));

const HOME_MANAGEMENT_FAMILY = Object.freeze(family({
  familyId: "fee_family_home_management",
  name: "在医総管",
  section: "002",
  branch: "00",
  code: "114000001"
}));

const FACILITY_MANAGEMENT_FAMILY = Object.freeze(family({
  familyId: "fee_family_facility_management",
  name: "施医総管",
  section: "002",
  branch: "02",
  code: "114000002"
}));

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

test("standing trigger selectors match the versioned real-master snapshot", () => {
  assert.equal(CATALOG_SNAPSHOT.schemaVersion, "fee-standing-family-catalog-snapshot-v1");
  assert.equal(CATALOG_SNAPSHOT.selectorCount, standingStructuredTriggerFamilySelectors().length);
  assert.equal(CATALOG_SNAPSHOT.resolvedSelectorCount, CATALOG_SNAPSHOT.selectorCount);
  assert.deepEqual(
    CATALOG_SNAPSHOT.selectorResults
      .filter((entry) => entry.matchCount !== 1),
    []
  );
});

test("real master catalog produces the C002 trigger with the runtime fact contract", {
  skip: !existsSync(realMasterPath)
}, () => {
  const command = spawnSync("python3", [
    path.join(repoRoot, "scripts/export_fee_standing_family_snapshot.py"),
    "--master-db",
    realMasterPath,
    "--stdout"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: "python:."
    },
    maxBuffer: 20 * 1024 * 1024
  });
  assert.equal(command.status, 0, command.stderr || command.stdout);
  const liveCatalog = JSON.parse(command.stdout);
  assert.equal(liveCatalog.resolvedSelectorCount, liveCatalog.selectorCount);
  assert.deepEqual(liveCatalog.source, CATALOG_SNAPSHOT.source);
  assert.deepEqual(liveCatalog.selectorResults, CATALOG_SNAPSHOT.selectorResults);
  assert.deepEqual(liveCatalog.families, CATALOG_SNAPSHOT.families);

  const facts = buildStandingStructuredFacts({
    session: {
      setting: "home_visit",
      encounterDetails: { residenceType: "private" },
      diagnoses: [{ name: "慢性心不全", status: "active" }]
    },
    prepared: {
      clinicalEvents: [{
        type: "counseling",
        actionStatus: "instruction_only",
        temporalRelation: "current_visit",
        providerOwnership: "own_clinic"
      }]
    }
  });
  const result = evaluateStandingStructuredTriggers({
    families: liveCatalog.families,
    structuredFacts: facts
  });
  assert.ok(result.matches.some((match) => (
    match.trigger.triggerId === "c002_home_management_review_candidate"
  )), JSON.stringify(result.diagnostics, null, 2));
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
  assert.equal(
    result.diagnostics.perTrigger.find((entry) => (
      entry.triggerId === "c002_home_management_review_candidate"
    ))?.reason,
    "matched"
  );
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
  assert.deepEqual(
    medicationOnly.diagnostics.perTrigger.find((entry) => (
      entry.triggerId === "c002_home_management_review_candidate"
    ))?.missingFacts,
    ["clinical.currentManagementOrCounselingCount"]
  );
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
  assert.deepEqual(
    standingStructuredFactsSummary(facts, {
      clinicalEvents: [
        {
          type: "management",
          actionStatus: "performed",
          temporalRelation: "current_visit",
          providerOwnership: "own_clinic"
        },
        {
          type: "management",
          actionStatus: "planned",
          temporalRelation: "future",
          providerOwnership: "own_clinic"
        }
      ]
    }),
    {
      residenceType: "private",
      plannedHomeVisit: true,
      activeDiagnosisCount: 1,
      currentManagementOrCounselingCount: 1,
      currentManagementEventCount: 1,
      currentManagementStandingMentionCount: 0,
      currentManagementTextSignalCount: 0,
      currentLongitudinalPlanSignalCount: 0,
      standingMentionCount: 0,
      deviceFactCount: 1,
      eventCount: 2,
      currentOwnEventCount: 1,
      eventTypeCounts: { management: 2 },
      actionStatusCounts: { performed: 1, planned: 1 },
      temporalRelationCounts: { current_visit: 1, future: 1 },
      providerOwnershipCounts: { own_clinic: 2 }
    }
  );
  assert.deepEqual(
    standingStructuredFamilyCatalogDiagnostics([
      HOME_MANAGEMENT_FAMILY,
      FACILITY_MANAGEMENT_FAMILY
    ]),
    {
      familyCount: 2,
      additionalSelectorCount: CATALOG_SNAPSHOT.selectorCount,
      additionalSelectorResolvedCount: 2
    }
  );
});

test("v15 management-continuation mentions satisfy W1c without treating medication-only text as management", () => {
  const current = buildStandingStructuredFacts({
    session: {
      setting: "home_visit",
      encounterDetails: { residenceType: "private" },
      diagnoses: [{ name: "慢性心不全", status: "active" }]
    },
    prepared: {
      clinicalEvents: [],
      standingMentions: [{
        lineId: "P1",
        target: "在宅療養",
        status: "continued",
        text: "訪問看護と連携し在宅療養を継続。次回は2週後の定期訪問予定。"
      }, {
        lineId: "P2",
        target: "現行処方",
        status: "continued",
        text: "現行処方を継続。"
      }, {
        lineId: "P3",
        target: "在宅療養管理",
        status: "stopped",
        text: "在宅療養管理を終了。"
      }, {
        lineId: "P4",
        target: "次月の在宅療養管理",
        status: "continued",
        text: "次月から在宅療養管理を継続する予定。"
      }]
    }
  });

  assert.equal(current.clinical.currentManagementEventCount, 0);
  assert.equal(current.clinical.currentManagementStandingMentionCount, 1);
  assert.equal(current.clinical.currentManagementOrCounselingCount, 1);
  assert.equal(current.clinical.standingMentionCount, 4);
  assert.ok(evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: current
  }).matches.some((match) => (
    match.trigger.triggerId === "c002_home_management_review_candidate"
  )));

  const medicationOnly = buildStandingStructuredFacts({
    session: {
      setting: "home_visit",
      encounterDetails: { residenceType: "private" },
      diagnoses: [{ name: "高血圧症", status: "active" }]
    },
    prepared: {
      standingMentions: [{
        lineId: "P1",
        target: "現行処方",
        status: "continued",
        text: "現行処方を継続。"
      }]
    }
  });
  assert.equal(medicationOnly.clinical.currentManagementOrCounselingCount, 0);
  assert.equal(evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: medicationOnly
  }).matches.length, 0);
});

test("explicit current counseling text recovers the W1c positive fact without billing-name or non-current noise", () => {
  const current = buildStandingStructuredFacts({
    session: {
      setting: "home_visit",
      encounterDetails: { residenceType: "private" },
      diagnoses: [{ name: "パーキンソン病", status: "active" }],
      clinicalText: [
        "A）パーキンソン病は安定。",
        "P）起立時はゆっくり動作するよう家族へ指導。",
        "転倒予防について訪問看護と情報共有。"
      ].join("\n")
    }
  });
  assert.equal(current.clinical.currentManagementTextSignalCount, 2);
  assert.equal(current.clinical.currentManagementOrCounselingCount, 2);
  assert.ok(evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: current
  }).matches.some((match) => (
    match.trigger.triggerId === "c002_home_management_review_candidate"
  )));

  for (const clinicalText of [
    "前回、家族へ療養上の注意を説明した。",
    "次回、家族へ療養上の注意を説明する予定。",
    "本日は説明せず、次回に持ち越した。",
    "特定疾患療養管理料の算定可否を確認。",
    "現行処方を継続。"
  ]) {
    const nonCurrent = buildStandingStructuredFacts({
      session: {
        setting: "home_visit",
        encounterDetails: { residenceType: "private" },
        diagnoses: [{ name: "慢性疾患", status: "active" }],
        clinicalText
      }
    });
    assert.equal(
      nonCurrent.clinical.currentManagementTextSignalCount,
      0,
      clinicalText
    );
  }
});

test("current advice and a complete longitudinal SOAP plan recover W1c without accepting medication-only Do", () => {
  const advice = buildStandingStructuredFacts({
    session: {
      setting: "home_visit",
      encounterDetails: { residenceType: "private" },
      diagnoses: [{ name: "起立性低血圧", status: "active" }],
      clinicalText: [
        "A）起立性低血圧は継続。",
        "P）起立性低血圧に注意を促し、次回訪問で症状を再評価。"
      ].join("\n")
    }
  });
  assert.equal(advice.clinical.currentManagementTextSignalCount, 1);
  assert.equal(advice.clinical.currentManagementOrCounselingCount, 1);

  for (const clinicalText of [
    [
      "A）高血圧症・変形性膝関節症は安定。",
      "P）現行処方を継続。次月も定期訪問予定。"
    ].join("\n"),
    [
      "A）多発性硬化症は安定。神経因性疼痛はコントロール中。",
      "P）現行処方を継続。次回、内服内容と眠気を見直す方針。"
    ].join("\n")
  ]) {
    const facts = buildStandingStructuredFacts({
      session: {
        setting: "home_visit",
        encounterDetails: { residenceType: "private" },
        diagnoses: [{ name: "慢性疾患", status: "active" }],
        clinicalText
      }
    });
    assert.equal(facts.clinical.currentLongitudinalPlanSignalCount, 1, clinicalText);
    assert.equal(facts.clinical.currentManagementOrCounselingCount, 1, clinicalText);
  }

  for (const clinicalText of [
    "P）現行処方を継続。",
    "A）高血圧症は安定。P）現行処方を継続。",
    "A）高血圧症は安定。P）次回から処方を継続する予定。",
    "A）高血圧症は安定。P）現行処方は継続しない。次回訪問予定。",
    "前回は高血圧症が安定。前回の処方を継続し、次回訪問予定。"
  ]) {
    const facts = buildStandingStructuredFacts({
      session: {
        setting: "home_visit",
        encounterDetails: { residenceType: "private" },
        diagnoses: [{ name: "高血圧症", status: "active" }],
        clinicalText
      }
    });
    assert.equal(facts.clinical.currentLongitudinalPlanSignalCount, 0, clinicalText);
  }
});

test("current own-clinic management events with unknown action status stay candidate-only eligible", () => {
  const facts = buildStandingStructuredFacts({
    session: {
      setting: "home_visit",
      encounterDetails: { residenceType: "private" },
      diagnoses: [{ name: "がん性疼痛", status: "active" }]
    },
    prepared: {
      clinicalEvents: [{
        type: "management",
        actionStatus: "unknown",
        temporalRelation: "current_visit",
        providerOwnership: "own_clinic"
      }, {
        type: "management",
        actionStatus: "unknown",
        temporalRelation: "future",
        providerOwnership: "own_clinic"
      }, {
        type: "management",
        actionStatus: "unknown",
        temporalRelation: "current_visit",
        providerOwnership: "other_provider"
      }]
    }
  });

  assert.equal(facts.clinical.currentManagementEventCount, 1);
  assert.equal(facts.clinical.currentManagementOrCounselingCount, 1);
  const match = evaluateStandingStructuredTriggers({
    families: [HOME_MANAGEMENT_FAMILY, FACILITY_MANAGEMENT_FAMILY],
    structuredFacts: facts
  }).matches.find((entry) => (
    entry.trigger.triggerId === "c002_home_management_review_candidate"
  ));
  assert.ok(match);
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
  const snapshot = CATALOG_SNAPSHOT.families.find((entry) => (
    entry.name === name
    && entry.hierarchy?.chapter === "2"
    && entry.hierarchy?.part === part
    && entry.hierarchy?.alphaPart === alphaPart
    && entry.hierarchy?.section === section
    && entry.hierarchy?.branch === branch
  ));
  assert.ok(snapshot, `standing family is absent from real-master snapshot: ${name}`);
  return {
    ...structuredClone(snapshot),
    familyId: familyId || snapshot.familyId,
    variants: [{ code, name, points: 100 }]
  };
}
