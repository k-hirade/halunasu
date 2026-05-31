import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_STATUSES,
  BILLING_PLAN_CODES,
  BILLING_STATUSES,
  approveReviewedNoteRequestSchema,
  archiveSoapFormatRequestSchema,
  authHelloSchema,
  billingPortalSessionResponseSchema,
  billingStatusResponseSchema,
  claimPairingRequestSchema,
  checkoutSessionResponseSchema,
  createContactSignupRequestSchema,
  createMemberRequestSchema,
  createOrganizationRequestSchema,
  createSessionRequestSchema,
  createSoapFormatRequestSchema,
  DEFAULT_RECORDING_MAX_DURATION_MINUTES,
  discardRecordingRequestSchema,
  enforceGracePeriodsRequestSchema,
  finalizeTaskPayloadSchema,
  MAX_RECORDING_MAX_DURATION_MINUTES,
  MEMBER_ROLES,
  MIN_RECORDING_MAX_DURATION_MINUTES,
  organizationAccessSchema,
  organizationBillingSchema,
  organizationSummarySchema,
  normalizeRecordingMaxDurationMinutes,
  operatorLoginRequestSchema,
  parseJsonBody,
  passwordSetupRequestSchema,
  passwordSetupTokenStateResponseSchema,
  processStripeEventRequestSchema,
  recordingAutoStopTaskPayloadSchema,
  reconcileSubscriptionRequestSchema,
  assignSoapFormatRequestSchema,
  previewSoapFormatRequestSchema,
  publishSoapFormatRequestSchema,
  regenerateSoapRequestSchema,
  registerTrustedRecorderRequestSchema,
  resetMemberPasswordRequestSchema,
  saveReviewedNoteRequestSchema,
  sessionStatusSchema,
  listSessionsResponseSchema,
  signupApplicationSchema,
  soapStatusSchema,
  startRecordingRequestSchema,
  stopRecordingRequestSchema,
  updateOrganizationRecordingPolicyRequestSchema,
  updateMemberPreferencesRequestSchema,
  updateSoapFormatDraftRequestSchema,
  updateSessionMetadataRequestSchema,
  updateSessionPromptProfileRequestSchema,
  canAssignMemberRoles,
  canManageMembersRoles,
  canManageOwnSoapFormatsRoles,
  canOpenAdminConsoleRoles,
  canOpenSettingsConsoleRoles,
  canReadOrganizationSessionsRoles,
  roleLabel
} from "../src/index.js";

test("create session and metadata schemas normalize unsafe text", () => {
  const parsed = createSessionRequestSchema.parse({
    facilityId: "  FAC-1\u0000 ",
    departmentId: "  内科\n外来  ",
    doctorMemberId: " doctor-1 ",
    promptProfileId: " profile-1 ",
    title: "  初診\t診療 ",
    patientId: " pat-1 ",
    patientDisplayName: "  山田\n太郎 ",
    visitReason: "  咳\t 発熱\u0007 "
  });

  assert.deepEqual(parsed, {
    facilityId: "FAC-1",
    departmentId: "内科 外来",
    doctorMemberId: "doctor-1",
    promptProfileId: "profile-1",
    title: "初診 診療",
    patientId: "pat-1",
    patientDisplayName: "山田 太郎",
    visitReason: "咳 発熱"
  });

  const metadata = updateSessionMetadataRequestSchema.parse({
    facilityId: " FAC-2 ",
    departmentId: " dep-2 ",
    patientId: " pat-2 ",
    patientDisplayName: "  佐藤\u0000花子  ",
    visitReason: "  腰痛\n再診  "
  });
  assert.deepEqual(metadata, {
    facilityId: "FAC-2",
    departmentId: "dep-2",
    patientId: "pat-2",
    patientDisplayName: "佐藤 花子",
    visitReason: "腰痛 再診"
  });

  assert.deepEqual(updateSessionPromptProfileRequestSchema.parse({ promptProfileId: " fmt_1\u0000 " }), {
    promptProfileId: "fmt_1"
  });
  assert.throws(() => updateSessionPromptProfileRequestSchema.parse({ promptProfileId: " " }), /Too small/);
});

test("recording schemas require a real device id and expose safe defaults", () => {
  assert.deepEqual(
    startRecordingRequestSchema.parse({
      deviceId: "  local-device  ",
      deviceLabel: "  診察室PC ",
      source: "local_browser"
    }),
    {
      deviceId: "local-device",
      deviceLabel: "診察室PC",
      source: "local_browser"
    }
  );

  assert.deepEqual(stopRecordingRequestSchema.parse({}), {
    enqueueSoapGeneration: false
  });

  assert.deepEqual(
    stopRecordingRequestSchema.parse({
      deviceId: " phone-1 ",
      enqueueSoapGeneration: true
    }),
    {
      deviceId: "phone-1",
      enqueueSoapGeneration: true
    }
  );

  assert.throws(
    () => startRecordingRequestSchema.parse({ deviceId: "   " }),
    /Too small/
  );

  assert.deepEqual(updateMemberPreferencesRequestSchema.parse({
    orgId: " org_1 ",
    defaultRecordingSource: "local_browser"
  }), {
    orgId: "org_1",
    defaultRecordingSource: "local_browser"
  });

  assert.equal(DEFAULT_RECORDING_MAX_DURATION_MINUTES, 60);
  assert.equal(normalizeRecordingMaxDurationMinutes(undefined), DEFAULT_RECORDING_MAX_DURATION_MINUTES);
  assert.equal(normalizeRecordingMaxDurationMinutes(1), MIN_RECORDING_MAX_DURATION_MINUTES);
  assert.equal(normalizeRecordingMaxDurationMinutes(999), MAX_RECORDING_MAX_DURATION_MINUTES);
  assert.deepEqual(updateOrganizationRecordingPolicyRequestSchema.parse({
    orgId: " org_1 ",
    recordingMaxDurationMinutes: "90"
  }), {
    orgId: "org_1",
    recordingMaxDurationMinutes: 90
  });
  assert.throws(
    () => updateOrganizationRecordingPolicyRequestSchema.parse({ recordingMaxDurationMinutes: 3 }),
    /Too small/
  );
});

test("pairing and trusted recorder schemas keep device metadata bounded", () => {
  const claim = claimPairingRequestSchema.parse({
    token: "pair-token",
    deviceId: "  iPhone\u0000Recorder ",
    deviceInfo: {
      platform: "  iOS  ",
      browser: "  Safari\nChrome  "
    }
  });

  assert.deepEqual(claim, {
    token: "pair-token",
    deviceId: "iPhone Recorder",
    deviceInfo: {
      platform: "iOS",
      browser: "Safari Chrome"
    }
  });

  assert.deepEqual(registerTrustedRecorderRequestSchema.parse({ deviceId: " x ", label: "  受付端末  " }), {
    deviceId: "x",
    label: "受付端末"
  });

  assert.throws(() => claimPairingRequestSchema.parse({ token: "", deviceId: "phone" }), /Too small/);
});

test("clinical review and auth schemas validate required fields", () => {
  assert.deepEqual(
    saveReviewedNoteRequestSchema.parse({
      transcript: "  主訴は咳  ",
      outputText: "  #\nS\n咳があります  "
    }),
    {
      transcript: "  主訴は咳  ",
      outputText: "  #\nS\n咳があります  "
    }
  );

  assert.deepEqual(approveReviewedNoteRequestSchema.parse({ versionId: " v1 " }), {
    versionId: "v1"
  });
  assert.deepEqual(discardRecordingRequestSchema.parse({}), {});
  assert.throws(() => saveReviewedNoteRequestSchema.parse({ transcript: "主訴", outputText: "" }), /Too small/);
  assert.throws(() => operatorLoginRequestSchema.parse({ organizationCode: "org", loginId: "doctor", password: "" }), /Too small/);
});

test("list sessions response schema exposes pagination metadata", () => {
  const parsed = listSessionsResponseSchema.parse({
    sessions: [],
    page: 1,
    pageSize: 20,
    totalCount: 0,
    totalPages: 0
  });

  assert.deepEqual(parsed, {
    sessions: [],
    page: 1,
    pageSize: 20,
    totalCount: 0,
    totalPages: 0
  });
});

test("organization and member admin schemas validate account management input", () => {
  assert.deepEqual(
    createOrganizationRequestSchema.parse({
      organizationCode: "clinic-a",
      displayName: "  A病院 ",
      adminLoginId: "admin",
      adminDisplayName: " 管理者 ",
      adminPassword: "Temporary-password-1!"
    }),
    {
      organizationCode: "clinic-a",
      displayName: "A病院",
      adminLoginId: "admin",
      adminDisplayName: "管理者",
      adminPassword: "Temporary-password-1!"
    }
  );

  assert.deepEqual(
    createMemberRequestSchema.parse({
      orgId: " org_a ",
      loginId: "doctor-1",
      displayName: "  佐藤医師 ",
      password: "Temporary-password-1!",
      roles: ["doctor", "clinical_admin"]
    }),
    {
      orgId: "org_a",
      loginId: "doctor-1",
      displayName: "佐藤医師",
      password: "Temporary-password-1!",
      roles: ["doctor", "clinical_admin"],
      defaultRecordingSource: "linked_mobile"
    }
  );

  assert.deepEqual(resetMemberPasswordRequestSchema.parse({ orgId: " org_a ", password: "Next-password-1!" }), {
    orgId: "org_a",
    password: "Next-password-1!"
  });
  assert.equal(MEMBER_ROLES.includes("nurse"), true);
  assert.equal(MEMBER_ROLES.includes("medical_scribe"), true);
  assert.equal(roleLabel("it_admin"), "システム管理者");
  assert.equal(canOpenAdminConsoleRoles(["org_admin"]), true);
  assert.equal(canOpenAdminConsoleRoles(["doctor"]), false);
  assert.equal(canOpenSettingsConsoleRoles(["doctor"]), true);
  assert.equal(canManageMembersRoles(["it_admin"]), true);
  assert.equal(canManageOwnSoapFormatsRoles(["doctor"]), true);
  assert.equal(canManageOwnSoapFormatsRoles(["auditor"]), false);
  assert.equal(canReadOrganizationSessionsRoles(["auditor"]), true);
  assert.equal(canAssignMemberRoles(["clinical_admin"], ["doctor", "nurse"]), true);
  assert.equal(canAssignMemberRoles(["clinical_admin"], ["org_admin"]), false);
  assert.throws(() => createOrganizationRequestSchema.parse({ organizationCode: "CLINIC A", displayName: "A", adminLoginId: "admin", adminDisplayName: "Admin", adminPassword: "Temporary-password-1!" }), /lowercase/);
  assert.throws(() => createMemberRequestSchema.parse({ loginId: "dr", displayName: "医師", password: "short", roles: ["doctor"] }), /Too small/);
});

test("contact signup and password setup schemas normalize public onboarding input", () => {
  assert.deepEqual(
    createContactSignupRequestSchema.parse({
      organizationName: " A病院 ",
      adminName: " 事務 管理者 ",
      adminEmail: " ADMIN@EXAMPLE.COM ",
      seatEstimate: " 12 ",
      notes: " 初回導入の相談です。\nよろしくお願いします。 ",
      consentAccepted: true
    }),
    {
      organizationName: "A病院",
      adminName: "事務 管理者",
      adminEmail: "admin@example.com",
      seatEstimate: 12,
      notes: "初回導入の相談です。\nよろしくお願いします。",
      consentAccepted: true
    }
  );

  assert.deepEqual(passwordSetupRequestSchema.parse({ password: "Temporary-password-1!" }), {
    password: "Temporary-password-1!"
  });

  assert.throws(
    () => createContactSignupRequestSchema.parse({
      organizationName: "A病院",
      adminName: "管理者",
      adminEmail: "bad-email",
      consentAccepted: true
    }),
    /email/
  );
});

test("billing response schemas model organization billing and token state", () => {
  assert.equal(BILLING_PLAN_CODES.includes("medical_ai_monthly"), true);
  assert.equal(BILLING_STATUSES.includes("trialing"), true);
  assert.equal(ACCESS_STATUSES.includes("suspended"), true);

  const billing = organizationBillingSchema.parse({
    provider: "stripe",
    planCode: "medical_ai_monthly",
    status: "trialing",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    stripePriceId: "price_123",
    trialEndsAt: "2026-05-01T00:00:00.000Z",
    currentPeriodEnd: "2026-05-01T00:00:00.000Z",
    gracePeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    seatQuantity: 1,
    lastStripeEventId: "evt_123",
    updatedAt: "2026-04-23T00:00:00.000Z"
  });
  const access = organizationAccessSchema.parse({
    status: "pending_setup",
    reason: null,
    restrictedAt: null,
    updatedAt: "2026-04-23T00:00:00.000Z"
  });

  assert.equal(organizationSummarySchema.parse({
    orgId: "org_1",
    clinicId: "org_1",
    organizationCode: "clinic-a",
    displayName: "A病院",
    status: "active",
    timezone: "Asia/Tokyo",
    defaultPromptProfileId: null,
    recordingMaxDurationMinutes: 60,
    billing,
    access,
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z"
  }).billing.status, "trialing");

  assert.equal(checkoutSessionResponseSchema.parse({
    signupId: "signup_1",
    checkoutSessionId: "cs_test_123",
    checkoutUrl: "https://checkout.stripe.com/test/session",
    expiresAt: null
  }).checkoutSessionId, "cs_test_123");

  assert.equal(signupApplicationSchema.parse({
    signupId: "signup_1",
    organizationCode: "clinic-a",
    displayName: "A病院",
    adminLoginId: "admin",
    adminDisplayName: "管理者",
    adminEmail: "admin@example.com",
    planCode: "medical_ai_monthly",
    consentAcceptedAt: "2026-05-06T00:00:00.000Z",
    consentVersion: "halunasu-terms-privacy-2026-05-06",
    consentTermsUrl: "https://halunasu.com/terms.html",
    consentPrivacyUrl: "https://halunasu.com/privacy.html",
    consentClientIp: "203.0.113.1",
    consentUserAgent: "Mozilla/5.0",
    status: "submitted",
    createdAt: "2026-04-23T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z"
  }).consentVersion, "halunasu-terms-privacy-2026-05-06");

  assert.equal(passwordSetupTokenStateResponseSchema.parse({
    token: {
      tokenId: "plain-token",
      orgId: "org_1",
      memberId: "mem_1",
      organizationDisplayName: "A病院",
      memberDisplayName: "管理者",
      email: "admin@example.com",
      status: "active",
      expiresAt: "2026-04-24T00:00:00.000Z",
      usedAt: null,
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:00.000Z"
    }
  }).token.status, "active");

  assert.equal(billingStatusResponseSchema.parse({ billing, access }).access.status, "pending_setup");
  assert.equal(billingPortalSessionResponseSchema.parse({ url: "https://billing.stripe.com/session/test" }).url.includes("stripe.com"), true);
  assert.deepEqual(processStripeEventRequestSchema.parse({ eventId: " evt_123 " }), { eventId: "evt_123" });
  assert.deepEqual(reconcileSubscriptionRequestSchema.parse({ subscriptionId: " sub_123 " }), { subscriptionId: "sub_123" });
  assert.deepEqual(enforceGracePeriodsRequestSchema.parse({}), {});
});

test("status, websocket auth, and finalize payload schemas reject invalid states", () => {
  assert.equal(sessionStatusSchema.parse("soap_ready"), "soap_ready");
  assert.equal(soapStatusSchema.parse("approved"), "approved");
  assert.throws(() => sessionStatusSchema.parse("done"), /Invalid option/);
  assert.throws(() => soapStatusSchema.parse("done"), /Invalid option/);

  assert.deepEqual(
    authHelloSchema.parse({
      type: "auth.hello",
      role: "mobile",
      sessionId: "ses_1",
      token: "stream-token",
      deviceId: "phone-1",
      pairingId: "pair-1"
    }),
    {
      type: "auth.hello",
      role: "mobile",
      sessionId: "ses_1",
      token: "stream-token",
      deviceId: "phone-1",
      pairingId: "pair-1"
    }
  );

  assert.deepEqual(finalizeTaskPayloadSchema.parse({ sessionId: "ses_1", clinicId: "org_1" }), {
    sessionId: "ses_1",
    clinicId: "org_1",
    rawAudioPath: null,
    enqueueSoapGeneration: true,
    finalizeRequestedAt: null,
    gatewayStartedAt: null,
    gatewayEnqueuedAt: null
  });
  assert.deepEqual(recordingAutoStopTaskPayloadSchema.parse({
    sessionId: "ses_1",
    clinicId: "org_1",
    recordingExpiresAt: "2026-04-20T10:00:00.000Z"
  }), {
    sessionId: "ses_1",
    clinicId: "org_1",
    recordingExpiresAt: "2026-04-20T10:00:00.000Z"
  });
});

test("parseJsonBody returns parsed data and converts validation failures to public errors", () => {
  assert.deepEqual(
    parseJsonBody(operatorLoginRequestSchema, {
      organizationCode: " org ",
      loginId: " doctor ",
      password: "secret"
    }),
    {
      organizationCode: "org",
      loginId: "doctor",
      password: "secret"
    }
  );

  try {
    parseJsonBody(operatorLoginRequestSchema, { organizationCode: "", loginId: "doctor", password: "" });
    assert.fail("parseJsonBody should throw");
  } catch (error) {
    assert.equal(error.statusCode, 400);
    assert.equal(error.publicMessage, "入力内容を確認してください。");
  }
});

test("SOAP format schemas normalize admin-editable format definitions", () => {
  const format = createSoapFormatRequestSchema.parse({
    displayName: "  田中医師 標準SOAP ",
    scope: "member",
    ownerMemberId: " doctor-1 ",
    templateKey: " outpatient_soap_note ",
    outputTemplate: "  #\n【主訴】\n\nS\n  ",
    customization: {
      tone: "  簡潔に ",
      detailLevel: "detailed",
      globalInstruction: "  Pには再診目安を含める\n",
      additionalInstructions: ["  Aは短く  ", ""],
      outputPreferences: {
        headingStyle: "japanese_labels",
        copyFormat: "markdown_like"
      }
    },
    sections: [
      {
        key: "subjective",
        label: " S ",
        order: 1,
        style: "bullet",
        detailLevel: "brief",
        emptyBehavior: "mention_not_discussed",
        customInstruction: " 主訴を時系列で "
      }
    ]
  });

  assert.equal(format.displayName, "田中医師 標準SOAP");
  assert.equal(format.ownerMemberId, "doctor-1");
  assert.equal(format.outputTemplate, "#\n【主訴】\n\nS");
  assert.equal(format.customization.globalInstruction, "Pには再診目安を含める");
  assert.deepEqual(format.customization.additionalInstructions, ["Aは短く", ""]);
  assert.equal(format.sections[0].label, "S");
  assert.equal(format.sections[0].customInstruction, "主訴を時系列で");

  assert.deepEqual(updateSoapFormatDraftRequestSchema.parse({ displayName: " 更新 " }), {
    displayName: "更新"
  });
  assert.deepEqual(publishSoapFormatRequestSchema.parse({}), {});
  assert.deepEqual(archiveSoapFormatRequestSchema.parse({}), {});
  assert.deepEqual(assignSoapFormatRequestSchema.parse({ memberId: " mem_1 ", formatId: " fmt_1 " }), {
    targetType: "member",
    memberId: "mem_1",
    formatId: "fmt_1"
  });
  assert.deepEqual(assignSoapFormatRequestSchema.parse({ targetType: "organization", formatId: " fmt_1 " }), {
    targetType: "organization",
    formatId: "fmt_1"
  });
  assert.deepEqual(previewSoapFormatRequestSchema.parse({ transcript: " 会話 ", sessionContext: { visitReason: "咳" } }), {
    transcript: "会話",
    sessionContext: { visitReason: "咳" }
  });
  assert.deepEqual(regenerateSoapRequestSchema.parse({ promptProfileId: " fmt_1 " }), {
    promptProfileId: "fmt_1"
  });
  assert.throws(() => createSoapFormatRequestSchema.parse({ displayName: "表示名", outputTemplate: "" }), /Too small/);
});
