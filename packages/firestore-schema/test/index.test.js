import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collections,
  auditEventPath,
  chartingEncounterPath,
  careFeeAuditLogPath,
  careFeeEpisodePath,
  careFeeEvidenceReceiptPath,
  careFeeFacilitySettingsPath,
  careFeeImportJobPath,
  careFeeMonthlyClaimPath,
  careFeeMonthlyRunPath,
  dataRequestPath,
  departmentPath,
  facilityPath,
  feeCareEvidenceOutboxPath,
  feeMonthlyExclusionResolutionPath,
  feeSessionPath,
  sidecarAdoptionGuardPath,
  sidecarCalculationDraftPath,
  loginIdentityKey,
  loginIdentityPath,
  organizationPath,
  passwordSetupTokenPath,
  patientAliasPath,
  patientIdentifierIndexPath,
  patientPath,
  productEntitlementPath,
  rateLimitPath,
  referralPath,
  sidecarDeviceAuthorizationPath,
  sidecarDeviceGrantPath,
  signupEmailTokenPath,
  signupApplicationPath
} from "../src/index.js";

test("builds platform document paths", () => {
  assert.equal(organizationPath("org_123"), "organizations/org_123");
  assert.equal(facilityPath("org_123", "fac_456"), "organizations/org_123/facilities/fac_456");
  assert.equal(departmentPath("org_123", "dep_456"), "organizations/org_123/departments/dep_456");
  assert.equal(patientPath("org_123", "pat_456"), "organizations/org_123/patients/pat_456");
  assert.equal(
    patientIdentifierIndexPath("org_123", "abc123"),
    "organizations/org_123/patient_identifier_index/abc123"
  );
  assert.equal(
    productEntitlementPath("org_123", "charting"),
    "organizations/org_123/product_entitlements/charting"
  );
  assert.equal(auditEventPath("org_123", "aud_456"), "organizations/org_123/audit_events/aud_456");
  assert.equal(
    dataRequestPath("org_123", "drq_456"),
    "organizations/org_123/data_requests/drq_456"
  );
  assert.equal(
    chartingEncounterPath("org_123", "enc_456"),
    "organizations/org_123/charting_encounters/enc_456"
  );
  assert.equal(
    feeSessionPath("org_123", "fee_456"),
    "organizations/org_123/fee_sessions/fee_456"
  );
  assert.equal(
    feeMonthlyExclusionResolutionPath("org_123", "resolution_456"),
    "organizations/org_123/fee_monthly_exclusion_resolutions/resolution_456"
  );
  assert.equal(
    feeCareEvidenceOutboxPath("org_123", "fce_456"),
    "organizations/org_123/fee_care_evidence_outbox/fce_456"
  );
  assert.equal(
    sidecarCalculationDraftPath("org_123", "sidecar_456"),
    "organizations/org_123/sidecar_calculation_drafts/sidecar_456"
  );
  assert.equal(
    sidecarAdoptionGuardPath("org_123", "a".repeat(64)),
    `organizations/org_123/sidecar_adoption_guards/${"a".repeat(64)}`
  );
  assert.equal(careFeeEpisodePath("org_123", "cep_456"), "organizations/org_123/care_fee_episodes/cep_456");
  assert.equal(careFeeMonthlyClaimPath("org_123", "ccm_456"), "organizations/org_123/care_fee_monthly_claims/ccm_456");
  assert.equal(careFeeMonthlyRunPath("org_123", "cmr_456"), "organizations/org_123/care_fee_monthly_runs/cmr_456");
  assert.equal(careFeeFacilitySettingsPath("org_123", "fac_456"), "organizations/org_123/care_fee_facility_settings/fac_456");
  assert.equal(careFeeImportJobPath("org_123", "cij_456"), "organizations/org_123/care_fee_import_jobs/cij_456");
  assert.equal(careFeeEvidenceReceiptPath("org_123", "cer_456"), "organizations/org_123/care_fee_evidence_receipts/cer_456");
  assert.equal(careFeeAuditLogPath("org_123", "cau_456"), "organizations/org_123/care_fee_audit_logs/cau_456");
  assert.equal(
    referralPath("org_123", "ref_456"),
    "organizations/org_123/referrals/ref_456"
  );
  assert.equal(signupApplicationPath("app_123"), "signup_applications/app_123");
  assert.equal(signupEmailTokenPath("emv_123"), "signup_email_tokens/emv_123");
  assert.equal(passwordSetupTokenPath("setup_123"), "password_setup_tokens/setup_123");
  assert.equal(rateLimitPath("login:local:clinic:admin"), "rate_limits/login:local:clinic:admin");
  assert.equal(
    sidecarDeviceAuthorizationPath("sda_123"),
    "sidecar_device_authorizations/sda_123"
  );
  assert.equal(sidecarDeviceGrantPath("sgr_123"), "sidecar_device_grants/sgr_123");
  assert.equal(
    patientAliasPath("org_123", "pat_456", "alias_789"),
    "organizations/org_123/patients/pat_456/aliases/alias_789"
  );
});

test("builds login identity keys and paths", () => {
  assert.equal(loginIdentityKey("clinic-a", "doctor"), "clinic-a:doctor");
  assert.equal(loginIdentityPath("clinic-a", "doctor"), "login_identities/clinic-a:doctor");
});

test("rejects invalid path segments", () => {
  assert.throws(() => organizationPath("bad/id"), /must not contain/);
  assert.throws(() => patientPath("org_123", ""), /patientId is required/);
});

test("exports canonical collection names", () => {
  assert.equal(collections.organizations, "organizations");
  assert.equal(collections.patients, "patients");
  assert.equal(collections.patientIdentifierIndex, "patient_identifier_index");
  assert.equal(collections.feeMonthlyExclusionResolutions, "fee_monthly_exclusion_resolutions");
  assert.equal(collections.feeCareEvidenceOutbox, "fee_care_evidence_outbox");
  assert.equal(collections.sidecarCalculationDrafts, "sidecar_calculation_drafts");
  assert.equal(collections.sidecarAdoptionGuards, "sidecar_adoption_guards");
  assert.equal(collections.careFeeEpisodes, "care_fee_episodes");
  assert.equal(collections.sidecarDeviceAuthorizations, "sidecar_device_authorizations");
  assert.equal(collections.sidecarDeviceGrants, "sidecar_device_grants");
});
