import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPatientChargeContractSetting,
  buildPatientChargeContract,
  isPatientChargeSettingRetry,
  patientChargeContractId,
  resolvePatientChargeSetting
} from "../src/patient-charge-contracts.js";

function input(overrides = {}) {
  return {
    orgId: "org_1",
    facilityId: "fac_1",
    canonicalPatientId: "pat_1",
    chargeType: "home_medical_transport",
    handling: "charge",
    amountMode: "actual",
    amountYen: null,
    effectiveFrom: "2026-08-03",
    effectiveTo: null,
    expectedRevision: 0,
    updatedByMemberId: "mem_1",
    updatedFromDeviceId: "device_1",
    ...overrides
  };
}

test("patient charge contract IDs are stable and scoped to patient and facility", () => {
  const first = patientChargeContractId(input());
  assert.match(first, /^pcc_[a-f0-9]{32}$/u);
  assert.equal(first, patientChargeContractId(input()));
  assert.notEqual(first, patientChargeContractId(input({ canonicalPatientId: "pat_2" })));
  assert.notEqual(first, patientChargeContractId(input({ facilityId: "fac_2" })));
});

test("patient charge settings resolve by effective date without reviving an expired older setting", () => {
  const created = buildPatientChargeContract(input({
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-08-31"
  }), { now: new Date("2026-08-01T00:00:00.000Z") });
  const future = applyPatientChargeContractSetting(created, input({
    handling: "waive",
    amountMode: null,
    expectedRevision: 1,
    effectiveFrom: "2026-09-15",
    effectiveTo: "2026-09-30"
  }), { now: new Date("2026-09-01T00:00:00.000Z") });

  assert.equal(resolvePatientChargeSetting(future, "2026-08-10").handling, "charge");
  assert.equal(resolvePatientChargeSetting(future, "2026-09-10"), null);
  assert.equal(resolvePatientChargeSetting(future, "2026-09-20").handling, "waive");
  assert.equal(resolvePatientChargeSetting(future, "2026-10-01"), null);
});

test("same-date changes preserve audit history and select the latest revision", () => {
  const created = buildPatientChargeContract(input(), {
    now: new Date("2026-08-03T00:00:00.000Z")
  });
  const revised = applyPatientChargeContractSetting(created, input({
    handling: "included_in_contract",
    amountMode: null,
    expectedRevision: 1
  }), { now: new Date("2026-08-03T01:00:00.000Z") });

  assert.equal(revised.settingEvents.length, 2);
  assert.equal(revised.revision, 2);
  assert.equal(resolvePatientChargeSetting(revised, "2026-08-03").handling, "included_in_contract");
  assert.equal(isPatientChargeSettingRetry(revised, input({
    handling: "included_in_contract",
    amountMode: null,
    expectedRevision: 1
  })), true);
  assert.equal(isPatientChargeSettingRetry(revised, input({
    handling: "waive",
    amountMode: null,
    expectedRevision: 1
  })), false);
  assert.throws(() => applyPatientChargeContractSetting(revised, input({
    handling: "waive",
    amountMode: null,
    expectedRevision: 1
  })), /revision mismatch/u);
});

test("clear events retain the contract revision while removing the active setting", () => {
  const auditIdentity = {
    sidecarDraftId: "sidecar_charge_clear",
    updatedByLoginId: "member@example.test"
  };
  const created = buildPatientChargeContract(input({
    ...auditIdentity,
    effectiveFrom: "2026-08-01"
  }), { now: new Date("2026-08-01T00:00:00.000Z") });
  assert.equal(Object.hasOwn(created.settingEvents[0], "action"), false);

  const clearInput = input({
    ...auditIdentity,
    clear: true,
    handling: null,
    amountMode: null,
    amountYen: null,
    expectedRevision: 1,
    effectiveFrom: "2026-09-01"
  });
  const cleared = applyPatientChargeContractSetting(created, clearInput, {
    now: new Date("2026-09-01T00:00:00.000Z")
  });

  assert.equal(cleared.revision, 2);
  assert.deepEqual(
    cleared.settingEvents.map((event) => [event.revision, event.action || "set", event.handling]),
    [[1, "set", "charge"], [2, "clear", null]]
  );
  assert.equal(resolvePatientChargeSetting(cleared, "2026-08-31").handling, "charge");
  assert.equal(resolvePatientChargeSetting(cleared, "2026-09-01"), null);
  assert.equal(resolvePatientChargeSetting(cleared, "2026-10-01"), null);
  assert.equal(isPatientChargeSettingRetry(cleared, clearInput), true);
  assert.equal(isPatientChargeSettingRetry(cleared, {
    ...clearInput,
    clear: false,
    handling: "waive"
  }), false);

  const clearAudit = Object.values(cleared.auditOutbox)
    .find((entry) => entry.safePayload.revision === 2);
  assert.equal(clearAudit.safePayload.beforeHandling, "charge");
  assert.equal(clearAudit.safePayload.afterHandling, null);
});
