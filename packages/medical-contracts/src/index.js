import { z } from "zod";

const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;

function normalizedText(maxLength) {
  return z
    .string()
    .transform((value) => value.replace(CONTROL_CHARS_PATTERN, " ").replace(/\s+/g, " ").trim())
    .pipe(z.string().max(maxLength));
}

function normalizedMultilineText(maxLength) {
  return z
    .string()
    .transform((value) =>
      value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
        .split("\n")
        .map((line) => line.replace(/\t/g, " ").trimEnd())
        .join("\n")
        .trim()
    )
    .pipe(z.string().max(maxLength));
}

function normalizedEmail(maxLength = 320) {
  return z
    .string()
    .transform((value) => value.replace(CONTROL_CHARS_PATTERN, " ").trim().toLowerCase())
    .pipe(z.string().max(maxLength).email());
}

export const SESSION_STATUSES = [
  "ready",
  "paired",
  "recording",
  "degraded_recording",
  "stopped",
  "finalizing",
  "soap_ready",
  "approved",
  "failed"
];

export const SOAP_STATUSES = ["generating", "ready", "failed", "approved"];
export const SOAP_FORMAT_SCOPES = ["organization", "facility", "department", "member"];
export const SOAP_SECTION_STYLES = ["paragraph", "bullet", "problem_list"];
export const SOAP_DETAIL_LEVELS = ["brief", "standard", "detailed"];
export const SOAP_EMPTY_BEHAVIORS = ["empty", "mention_not_discussed"];
export const SOAP_HEADING_STYLES = ["soap_letters", "japanese_labels", "none"];
export const SOAP_COPY_FORMATS = ["emr_plain_text", "markdown_like"];
export const RECORDING_SOURCES = ["linked_mobile", "local_browser"];
export const DEFAULT_RECORDING_MAX_DURATION_MINUTES = 60;
export const MIN_RECORDING_MAX_DURATION_MINUTES = 5;
export const MAX_RECORDING_MAX_DURATION_MINUTES = 240;
export const MEMBER_STATUSES = ["active", "disabled"];
export const SIGNUP_APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "verified",
  "checkout_created",
  "checkout_completed",
  "provisioning",
  "provisioned",
  "failed",
  "expired",
  "closed"
];
export const BILLING_PROVIDERS = ["stripe"];
export const BILLING_PLAN_CODES = ["medical_ai_monthly"];
export const BILLING_STATUSES = [
  "pending_checkout",
  "trialing",
  "active",
  "past_due",
  "grace_period",
  "canceled",
  "unpaid"
];
export const ACCESS_STATUSES = [
  "pending_setup",
  "active",
  "billing_action_required",
  "suspended",
  "canceled"
];
export const MEMBER_ROLE_DEFINITIONS = [
  {
    roleId: "platform_admin",
    label: "運営管理者",
    description: "全医療機関、組織、メンバー、設定を管理できます。",
    category: "platform",
    sortOrder: 10,
    assignableBy: ["platform_admin"],
    permissions: [
      "settings:open",
      "admin:open",
      "platform:manage",
      "organizations:manage",
      "members:manage",
      "roles:assign_platform",
      "settings:manage_org",
      "audit:read_org",
      "sessions:read_org",
      "soap_formats:manage_org"
    ]
  },
  {
    roleId: "org_owner",
    label: "病院オーナー",
    description: "病院内の管理責任者として、メンバーと設定を管理できます。",
    category: "organization",
    sortOrder: 20,
    assignableBy: ["platform_admin"],
    permissions: [
      "settings:open",
      "admin:open",
      "members:manage",
      "roles:assign_org",
      "settings:manage_org",
      "audit:read_org",
      "sessions:read_org",
      "soap_formats:manage_org"
    ]
  },
  {
    roleId: "org_admin",
    label: "病院管理者",
    description: "病院内のメンバー、権限、記録設定、監査ログを管理できます。",
    category: "organization",
    sortOrder: 30,
    assignableBy: ["platform_admin", "org_owner", "org_admin"],
    permissions: [
      "settings:open",
      "admin:open",
      "members:manage",
      "roles:assign_org",
      "settings:manage_org",
      "audit:read_org",
      "sessions:read_org",
      "soap_formats:manage_org"
    ]
  },
  {
    roleId: "it_admin",
    label: "システム管理者",
    description: "院内IT、ログイン、セキュリティ関連の管理を担当します。",
    category: "organization",
    sortOrder: 40,
    assignableBy: ["platform_admin", "org_owner", "org_admin"],
    permissions: [
      "settings:open",
      "admin:open",
      "members:manage",
      "roles:assign_staff",
      "security:manage",
      "audit:read_org"
    ]
  },
  {
    roleId: "clinical_admin",
    label: "診療管理者",
    description: "診療フロー、SOAP設定、診療履歴の管理を担当します。",
    category: "clinical",
    sortOrder: 50,
    assignableBy: ["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin"],
    permissions: [
      "settings:open",
      "admin:open",
      "members:manage_clinical",
      "roles:assign_clinical",
      "settings:manage_clinical",
      "audit:read_org",
      "sessions:read_org",
      "soap_formats:manage_org"
    ]
  },
  {
    roleId: "doctor",
    label: "医師",
    description: "診療を開始し、担当診療の記録作成、編集、確定ができます。",
    category: "clinical",
    sortOrder: 60,
    assignableBy: ["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin"],
    permissions: [
      "settings:open",
      "sessions:create",
      "sessions:read_assigned",
      "sessions:update_assigned",
      "recording:control_assigned",
      "transcript:read_assigned",
      "soap:generate_assigned",
      "soap:edit_assigned",
      "soap:approve_assigned",
      "soap:export_assigned",
      "soap_formats:manage_self"
    ]
  },
  {
    roleId: "nurse",
    label: "看護師",
    description: "診療準備、患者情報入力、録音補助、担当診療の確認ができます。",
    category: "clinical",
    sortOrder: 70,
    assignableBy: ["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin"],
    permissions: [
      "settings:open",
      "sessions:create",
      "sessions:read_assigned",
      "sessions:update_metadata_assigned",
      "recording:control_assigned",
      "transcript:read_assigned",
      "soap_formats:manage_self"
    ]
  },
  {
    roleId: "medical_scribe",
    label: "医療クラーク",
    description: "診療記録の下書き作成補助と担当診療の確認ができます。",
    category: "clinical",
    sortOrder: 80,
    assignableBy: ["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin"],
    permissions: [
      "settings:open",
      "sessions:create",
      "sessions:read_assigned",
      "sessions:update_metadata_assigned",
      "transcript:read_assigned",
      "soap:edit_draft_assigned",
      "soap_formats:manage_self"
    ]
  },
  {
    roleId: "reception",
    label: "受付",
    description: "受付業務向けの将来ロールです。MVPでは設定とアカウント確認のみ利用できます。",
    category: "operations",
    sortOrder: 90,
    assignableBy: ["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin"],
    permissions: [
      "settings:open"
    ]
  },
  {
    roleId: "billing_staff",
    label: "医事・請求",
    description: "確定済み診療記録の確認と出力を担当します。",
    category: "operations",
    sortOrder: 100,
    assignableBy: ["platform_admin", "org_owner", "org_admin", "it_admin"],
    permissions: [
      "settings:open",
      "sessions:read_approved_assigned",
      "soap:export_approved"
    ]
  },
  {
    roleId: "auditor",
    label: "監査閲覧",
    description: "操作ログと病院内の診療履歴を閲覧できます。編集はできません。",
    category: "governance",
    sortOrder: 110,
    assignableBy: ["platform_admin", "org_owner", "org_admin"],
    permissions: [
      "settings:open",
      "admin:open",
      "audit:read_org",
      "sessions:read_org"
    ]
  },
  {
    roleId: "readonly_clinical",
    label: "診療閲覧",
    description: "担当診療の閲覧のみできます。編集や確定はできません。",
    category: "clinical",
    sortOrder: 120,
    assignableBy: ["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin"],
    permissions: [
      "settings:open",
      "sessions:read_assigned",
      "transcript:read_assigned",
      "soap:read_assigned"
    ]
  }
];
export const MEMBER_ROLES = MEMBER_ROLE_DEFINITIONS.map((role) => role.roleId);
export const MEMBER_ROLE_MAP = Object.fromEntries(MEMBER_ROLE_DEFINITIONS.map((role) => [role.roleId, role]));

export function normalizeMemberRoles(roles = []) {
  const values = Array.isArray(roles) ? roles : [];
  const normalized = values.filter((role) => MEMBER_ROLE_MAP[role]);
  return Array.from(new Set(normalized.length ? normalized : ["doctor"]));
}

export function roleLabel(roleId) {
  return MEMBER_ROLE_MAP[roleId]?.label || roleId;
}

export function roleHasPermission(roleId, permission) {
  return Boolean(MEMBER_ROLE_MAP[roleId]?.permissions?.includes(permission));
}

export function memberRolesHavePermission(roles = [], permission) {
  return normalizeMemberRoles(roles).some((role) => roleHasPermission(role, permission));
}

export function canOpenAdminConsoleRoles(roles = []) {
  return memberRolesHavePermission(roles, "admin:open");
}

export function canOpenSettingsConsoleRoles(roles = []) {
  return memberRolesHavePermission(roles, "settings:open");
}

export function canManagePlatformRoles(roles = []) {
  return memberRolesHavePermission(roles, "platform:manage");
}

export function canManageOrganizationSoapFormatsRoles(roles = []) {
  return memberRolesHavePermission(roles, "soap_formats:manage_org");
}

export function canManageOwnSoapFormatsRoles(roles = []) {
  return memberRolesHavePermission(roles, "soap_formats:manage_self");
}

export function canManageOrganizationRoles(roles = []) {
  return normalizeMemberRoles(roles).some((role) =>
    ["platform_admin", "org_owner", "org_admin", "clinical_admin"].includes(role)
  );
}

export function canManageMembersRoles(roles = []) {
  return normalizeMemberRoles(roles).some((role) =>
    ["platform_admin", "org_owner", "org_admin", "it_admin", "clinical_admin"].includes(role)
  );
}

export function canReadOrganizationSessionsRoles(roles = []) {
  return normalizeMemberRoles(roles).some((role) =>
    ["platform_admin", "org_owner", "org_admin", "clinical_admin", "auditor"].includes(role)
  );
}

export function canAssignRole(operatorRoles = [], targetRole) {
  const normalizedOperatorRoles = normalizeMemberRoles(operatorRoles);
  const definition = MEMBER_ROLE_MAP[targetRole];

  if (!definition) {
    return false;
  }

  if (normalizedOperatorRoles.includes("platform_admin")) {
    return true;
  }

  return definition.assignableBy.some((role) => normalizedOperatorRoles.includes(role));
}

export function canAssignMemberRoles(operatorRoles = [], targetRoles = []) {
  const targetValues = Array.isArray(targetRoles) ? targetRoles : [];

  if (!targetValues.length || targetValues.some((role) => !MEMBER_ROLE_MAP[role])) {
    return false;
  }

  const roles = Array.from(new Set(targetValues));
  return roles.length > 0 && roles.every((role) => canAssignRole(operatorRoles, role));
}

export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export const soapStatusSchema = z.enum(SOAP_STATUSES);

export const createSessionRequestSchema = z.object({
  facilityId: normalizedText(80).optional(),
  departmentId: normalizedText(80).optional(),
  doctorMemberId: normalizedText(120).optional(),
  promptProfileId: normalizedText(120).optional(),
  title: normalizedText(120).optional(),
  patientId: normalizedText(120).optional(),
  patientDisplayName: normalizedText(120).optional(),
  visitReason: normalizedText(500).optional()
});

export const updateSessionMetadataRequestSchema = z.object({
  facilityId: normalizedText(80).optional().nullable(),
  departmentId: normalizedText(80).optional().nullable(),
  patientId: normalizedText(120).optional().nullable(),
  patientDisplayName: normalizedText(120).optional(),
  visitReason: normalizedText(500).optional()
});

export const updateSessionPromptProfileRequestSchema = z.object({
  promptProfileId: normalizedText(120).pipe(z.string().min(1))
});

export const regenerateSoapRequestSchema = z.object({
  promptProfileId: normalizedText(120).pipe(z.string().min(1))
});

export const soapFormatSectionSchema = z.object({
  key: normalizedText(80).pipe(z.string().min(1)),
  label: normalizedText(80).pipe(z.string().min(1)),
  order: z.number().int().positive().max(50),
  style: z.enum(SOAP_SECTION_STYLES).default("paragraph"),
  detailLevel: z.enum(SOAP_DETAIL_LEVELS).default("standard"),
  emptyBehavior: z.enum(SOAP_EMPTY_BEHAVIORS).default("empty"),
  customInstruction: normalizedText(1000).optional()
});

export const soapFormatCustomizationSchema = z.object({
  tone: normalizedText(200).optional(),
  detailLevel: z.enum(SOAP_DETAIL_LEVELS).default("standard"),
  globalInstruction: normalizedText(2000).optional(),
  additionalInstructions: z.array(normalizedText(500)).max(12).default([]),
  outputPreferences: z
    .object({
      headingStyle: z.enum(SOAP_HEADING_STYLES).default("soap_letters"),
      copyFormat: z.enum(SOAP_COPY_FORMATS).default("emr_plain_text")
    })
    .default({
      headingStyle: "soap_letters",
      copyFormat: "emr_plain_text"
    })
});

export const createSoapFormatRequestSchema = z.object({
  displayName: normalizedText(120).pipe(z.string().min(1)),
  scope: z.enum(SOAP_FORMAT_SCOPES).default("member"),
  ownerMemberId: normalizedText(120).optional().nullable(),
  facilityId: normalizedText(120).optional().nullable(),
  departmentId: normalizedText(120).optional().nullable(),
  templateKey: normalizedText(120).default("outpatient_soap_note"),
  outputTemplate: normalizedMultilineText(8000).pipe(z.string().min(1)),
  customization: soapFormatCustomizationSchema.default({}),
  sections: z.array(soapFormatSectionSchema).max(12).default([])
});

export const updateSoapFormatDraftRequestSchema = z.object({
  displayName: normalizedText(120).pipe(z.string().min(1)).optional(),
  scope: z.enum(SOAP_FORMAT_SCOPES).optional(),
  ownerMemberId: normalizedText(120).optional().nullable(),
  facilityId: normalizedText(120).optional().nullable(),
  departmentId: normalizedText(120).optional().nullable(),
  templateKey: normalizedText(120).optional(),
  outputTemplate: normalizedMultilineText(8000).pipe(z.string().min(1)).optional(),
  customization: soapFormatCustomizationSchema.partial().optional(),
  sections: z.array(soapFormatSectionSchema).max(12).optional()
});

export const previewSoapFormatDefinitionSchema = z.object({
  displayName: normalizedText(120).optional(),
  scope: z.enum(SOAP_FORMAT_SCOPES).default("member"),
  ownerMemberId: normalizedText(120).optional().nullable(),
  facilityId: normalizedText(120).optional().nullable(),
  departmentId: normalizedText(120).optional().nullable(),
  templateKey: normalizedText(120).default("outpatient_soap_note"),
  outputTemplate: normalizedMultilineText(8000).pipe(z.string().min(1)),
  customization: soapFormatCustomizationSchema.default({}),
  sections: z.array(soapFormatSectionSchema).max(12).default([])
});

export const publishSoapFormatRequestSchema = z.object({
  versionId: z.string().trim().optional()
});

export const archiveSoapFormatRequestSchema = z.object({});

export const assignSoapFormatRequestSchema = z.object({
  targetType: z.enum(["member", "organization"]).default("member"),
  memberId: normalizedText(120).optional().nullable(),
  formatId: normalizedText(120).pipe(z.string().min(1)).nullable()
});

export const previewSoapFormatRequestSchema = z.object({
  transcript: z.string().trim().min(1).max(20_000),
  sessionContext: z.record(z.string(), z.unknown()).default({})
});

export const previewSoapFormatDraftRequestSchema = z.object({
  format: previewSoapFormatDefinitionSchema,
  transcript: z.string().trim().min(1).max(20_000),
  sessionContext: z.record(z.string(), z.unknown()).default({})
});

export const inferSoapFormatRequestSchema = z.object({
  preferredDisplayName: normalizedText(120).optional(),
  samples: z.array(normalizedMultilineText(12_000).pipe(z.string().min(1))).min(1).max(10)
});

export const startRecordingRequestSchema = z.object({
  deviceId: normalizedText(160).pipe(z.string().min(1)),
  deviceLabel: normalizedText(120).optional(),
  source: z.enum(RECORDING_SOURCES).default("linked_mobile")
});

export const selectRecordingSourceRequestSchema = z.object({
  source: z.enum(RECORDING_SOURCES)
});

export const stopRecordingRequestSchema = z.object({
  deviceId: normalizedText(160).pipe(z.string().min(1)).optional(),
  enqueueSoapGeneration: z.boolean().default(false)
});

export const discardRecordingRequestSchema = z.object({});

export const saveReviewedNoteRequestSchema = z.object({
  transcript: z.string().min(1),
  outputText: z.string().min(1)
});

export const approveReviewedNoteRequestSchema = z.object({
  versionId: z.string().trim().optional()
});

export const claimPairingRequestSchema = z.object({
  token: z.string().min(1),
  deviceId: normalizedText(160).pipe(z.string().min(1)),
  deviceInfo: z
    .object({
      platform: normalizedText(120).optional(),
      browser: normalizedText(240).optional()
    })
    .partial()
    .optional()
});

export const registerTrustedRecorderRequestSchema = z.object({
  deviceId: normalizedText(160).pipe(z.string().min(1)),
  label: normalizedText(120).optional()
});

export const assignTrustedRecorderRequestSchema = z.object({
  deviceId: normalizedText(160).pipe(z.string().min(1)).optional()
});

export const operatorLoginRequestSchema = z.object({
  organizationCode: z.string().trim().min(1),
  loginId: z.string().trim().min(1),
  password: z.string().min(1)
});

export const createOrganizationRequestSchema = z.object({
  organizationCode: normalizedText(80)
    .pipe(z.string().min(2).regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use lowercase letters, numbers, dots, underscores, or hyphens.")),
  displayName: normalizedText(120).pipe(z.string().min(1)),
  adminLoginId: normalizedText(80)
    .pipe(z.string().min(2).regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use lowercase letters, numbers, dots, underscores, or hyphens.")),
  adminDisplayName: normalizedText(120).pipe(z.string().min(1)),
  adminPassword: z.string().min(12).max(128)
});

export const createContactSignupRequestSchema = z.object({
  organizationName: normalizedText(160).pipe(z.string().min(1)),
  adminName: normalizedText(120).pipe(z.string().min(1)),
  adminEmail: normalizedEmail(),
  phoneNumber: normalizedText(40).optional(),
  seatEstimate: z.coerce.number().int().min(1).max(1000).optional().nullable(),
  notes: normalizedMultilineText(4000).optional().default(""),
  consentAccepted: z.literal(true)
});

export const verifyContactSignupQuerySchema = z.object({
  token: normalizedText(4096).pipe(z.string().min(1))
});

export const verifyContactSignupRequestSchema = z.object({
  token: normalizedText(4096).pipe(z.string().min(1))
});

export const passwordSetupRequestSchema = z.object({
  password: z.string().min(12).max(128)
});

export const createMemberRequestSchema = z.object({
  orgId: normalizedText(120).optional(),
  loginId: normalizedText(80)
    .pipe(z.string().min(2).regex(/^[a-z0-9][a-z0-9_.-]*$/, "Use lowercase letters, numbers, dots, underscores, or hyphens.")),
  displayName: normalizedText(120).pipe(z.string().min(1)),
  password: z.string().min(12).max(128),
  roles: z.array(z.enum(MEMBER_ROLES)).min(1).max(4).default(["doctor"]),
  defaultRecordingSource: z.enum(RECORDING_SOURCES).default("linked_mobile")
});

export const resetMemberPasswordRequestSchema = z.object({
  orgId: normalizedText(120).optional(),
  password: z.string().min(12).max(128)
});

export const processStripeEventRequestSchema = z.object({
  eventId: normalizedText(255).pipe(z.string().min(1))
});

export const reconcileSubscriptionRequestSchema = z.object({
  subscriptionId: normalizedText(255).pipe(z.string().min(1))
});

export const enforceGracePeriodsRequestSchema = z.object({
  now: z.string().datetime().optional()
});

export const enforceTrialExpirationRequestSchema = z.object({
  now: z.string().datetime().optional()
});

export const updateMemberStatusRequestSchema = z.object({
  orgId: normalizedText(120).optional(),
  status: z.enum(MEMBER_STATUSES)
});

export const updateMemberRolesRequestSchema = z.object({
  orgId: normalizedText(120).optional(),
  roles: z.array(z.enum(MEMBER_ROLES)).min(1).max(4)
});

export const revokeMemberSessionsRequestSchema = z.object({
  orgId: normalizedText(120).optional()
});

export const resetMemberMfaRequestSchema = z.object({
  orgId: normalizedText(120).optional()
});

export const revokeTrustedRecorderRequestSchema = z.object({
  orgId: normalizedText(120).optional()
});

export const createAudioTestRequestSchema = z.object({
  orgId: normalizedText(120).optional()
});

export const claimAudioTestRequestSchema = z.object({
  token: normalizedText(512).pipe(z.string().min(1)),
  deviceId: normalizedText(160).pipe(z.string().min(1)),
  deviceLabel: normalizedText(200).optional()
});

export const updateAudioTestStateRequestSchema = z.object({
  token: normalizedText(512).pipe(z.string().min(1)),
  deviceId: normalizedText(160).pipe(z.string().min(1)),
  permissionState: z.enum(["prompt", "granted", "denied", "unsupported", "unknown"]).optional(),
  deviceState: z.enum(["waiting", "connected", "monitoring", "blocked", "idle"]).optional(),
  level: z.number().int().min(0).max(100).optional(),
  deviceLabel: normalizedText(200).optional(),
  inputLabel: normalizedText(200).optional(),
  sampleRate: z.number().int().min(8_000).max(192_000).optional()
});

export const completeAudioTestRequestSchema = z.object({
  token: normalizedText(512).pipe(z.string().min(1)),
  deviceId: normalizedText(160).pipe(z.string().min(1))
});

export const operatorMfaVerifyRequestSchema = z.object({
  challengeId: normalizedText(4096).pipe(z.string().min(1)),
  code: z.string().trim().regex(/^[0-9]{6}$/)
});

export const operatorMfaEnrollConfirmRequestSchema = z.object({
  challengeId: normalizedText(4096).pipe(z.string().min(1)),
  code: z.string().trim().regex(/^[0-9]{6}$/)
});

export const updateMemberPreferencesRequestSchema = z.object({
  orgId: normalizedText(120).optional(),
  defaultRecordingSource: z.enum(RECORDING_SOURCES)
});

export function normalizeRecordingMaxDurationMinutes(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_RECORDING_MAX_DURATION_MINUTES;
  }

  return Math.min(
    MAX_RECORDING_MAX_DURATION_MINUTES,
    Math.max(MIN_RECORDING_MAX_DURATION_MINUTES, Math.round(parsed))
  );
}

export const recordingMaxDurationMinutesSchema = z.coerce
  .number()
  .int()
  .min(MIN_RECORDING_MAX_DURATION_MINUTES)
  .max(MAX_RECORDING_MAX_DURATION_MINUTES);

export const updateOrganizationRecordingPolicyRequestSchema = z.object({
  orgId: normalizedText(120).optional(),
  recordingMaxDurationMinutes: recordingMaxDurationMinutesSchema
});

export const authHelloSchema = z.object({
  type: z.literal("auth.hello"),
  role: z.enum(["pc", "mobile", "recorder"]),
  sessionId: z.string().min(1),
  token: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  pairingId: z.string().min(1).optional()
});

export const transcriptTurnSchema = z.object({
  turnId: z.string(),
  turnIndex: z.number().int().nonnegative(),
  source: z.enum(["live_stt", "final_repass", "manual_edit"]),
  speaker: z.enum(["unknown", "doctor", "patient", "other"]),
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  isCorrected: z.boolean().default(false),
  provider: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const soapVersionSchema = z.object({
  versionId: z.string(),
  version: z.number().int().positive(),
  status: soapStatusSchema,
  outputText: z.string(),
  structuredJson: z.record(z.string(), z.unknown()).default({}),
  model: z.string(),
  promptVersion: z.string(),
  templateKey: z.string().nullable().default(null),
  promptProfileId: z.string().nullable().default(null),
  promptProfileVersionId: z.string().nullable().default(null),
  resolvedPromptHash: z.string().nullable().default(null),
  inputTranscriptRevision: z.string(),
  createdBy: z.string(),
  approvedByUserId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const sessionSchema = z.object({
  sessionId: z.string(),
  orgId: z.string().optional(),
  clinicId: z.string(),
  facilityId: z.string().nullable().default(null),
  departmentId: z.string().nullable().default(null),
  createdByUserId: z.string(),
  createdByMemberId: z.string().optional(),
  assignedDoctorUserId: z.string().nullable().default(null),
  doctorMemberId: z.string().nullable().default(null),
  accessMemberIds: z.array(z.string()).default([]),
  hiddenByMemberIds: z.array(z.string()).default([]),
  status: sessionStatusSchema,
  pairingCode: z.string(),
  pairingTokenId: z.string(),
  title: z.string().nullable().default(null),
  patientId: z.string().nullable().default(null),
  patientSnapshot: z.record(z.string(), z.unknown()).nullable().default(null),
  patientDisplayName: z.string().nullable().default(null),
  visitReason: z.string().nullable().default(null),
  promptProfileId: z.string().nullable().default(null),
  promptProfileSelectedAt: z.string().nullable().default(null),
  promptProfileSelectedByMemberId: z.string().nullable().default(null),
  promptProfileSelectionSource: z.enum(["default", "manual"]).default("default"),
  latestSoapVersionId: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  stoppedAt: z.string().nullable().default(null),
  recordingMaxDurationMinutes: z.number().int().positive().default(DEFAULT_RECORDING_MAX_DURATION_MINUTES),
  recordingExpiresAt: z.string().nullable().default(null),
  recordingAutoStopTaskName: z.string().nullable().default(null),
  recordingStopReason: z.string().nullable().default(null),
  finalizedAt: z.string().nullable().default(null),
  approvedAt: z.string().nullable().default(null),
  lastSequenceNo: z.number().int().nonnegative().default(0),
  liveSttProvider: z.string(),
  finalSttProvider: z.string(),
  soapProvider: z.string(),
  mobileConnectionState: z.enum(["disconnected", "connected", "mic_ready", "recording"]),
  audioSourceType: z.enum(RECORDING_SOURCES).nullable().default(null),
  audioConnectionState: z.enum(["disconnected", "connected", "mic_ready", "recording", "interrupted"]).default("disconnected"),
  audioDeviceId: z.string().nullable().default(null),
  audioDeviceLabel: z.string().nullable().default(null),
  pcConnectionCount: z.number().int().nonnegative().default(0),
  latestPartialPreview: z.string().nullable().default(null),
  latestFinalTurnIndex: z.number().int().nonnegative().default(0),
  rawAudioPath: z.string().nullable().default(null),
  errorCode: z.string().nullable().default(null),
  errorMessageSafe: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const organizationBillingSchema = z.object({
  provider: z.enum(BILLING_PROVIDERS),
  planCode: z.enum(BILLING_PLAN_CODES),
  status: z.enum(BILLING_STATUSES),
  stripeCustomerId: z.string().nullable().default(null),
  stripeSubscriptionId: z.string().nullable().default(null),
  stripePriceId: z.string().nullable().default(null),
  trialEndsAt: z.string().nullable().default(null),
  currentPeriodEnd: z.string().nullable().default(null),
  gracePeriodEndsAt: z.string().nullable().default(null),
  cancelAtPeriodEnd: z.boolean().default(false),
  seatQuantity: z.number().int().positive().default(1),
  lastStripeEventId: z.string().nullable().default(null),
  updatedAt: z.string()
});

export const organizationAccessSchema = z.object({
  status: z.enum(ACCESS_STATUSES),
  reason: z.string().nullable().default(null),
  restrictedAt: z.string().nullable().default(null),
  updatedAt: z.string()
});

export const organizationSummarySchema = z.object({
  orgId: z.string(),
  clinicId: z.string(),
  organizationCode: z.string().nullable().default(null),
  displayName: z.string(),
  status: z.string().default("active"),
  timezone: z.string().default("Asia/Tokyo"),
  defaultPromptProfileId: z.string().nullable().default(null),
  recordingMaxDurationMinutes: z.number().int().positive().default(DEFAULT_RECORDING_MAX_DURATION_MINUTES),
  billing: organizationBillingSchema.nullable().default(null),
  access: organizationAccessSchema.nullable().default(null),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null)
});

export const billingPlanSchema = z.object({
  planCode: z.enum(BILLING_PLAN_CODES),
  displayName: z.string(),
  description: z.string(),
  currency: z.string(),
  taxExclusiveUnitAmount: z.number().int().positive(),
  unitAmount: z.number().int().positive(),
  interval: z.string(),
  intervalCount: z.number().int().positive(),
  seatQuantity: z.number().int().positive(),
  trialDays: z.number().int().nonnegative()
});

export const pairingSchema = z.object({
  pairingId: z.string(),
  sessionId: z.string(),
  shortCode: z.string(),
  status: z.enum(["active", "claimed", "expired", "revoked"]),
  expiresAt: z.string(),
  claimedByDeviceId: z.string().nullable().default(null),
  claimedAt: z.string().nullable().default(null),
  createdAt: z.string()
});

export const sessionStateResponseSchema = z.object({
  session: sessionSchema,
  pairing: pairingSchema.nullable(),
  turns: z.array(transcriptTurnSchema),
  latestSoap: soapVersionSchema.nullable()
});

export const sessionSummarySchema = sessionSchema.pick({
  sessionId: true,
  orgId: true,
  clinicId: true,
  facilityId: true,
  departmentId: true,
  createdByMemberId: true,
  doctorMemberId: true,
  status: true,
  title: true,
  patientId: true,
  patientDisplayName: true,
  visitReason: true,
  promptProfileId: true,
  promptProfileSelectedAt: true,
  promptProfileSelectedByMemberId: true,
  promptProfileSelectionSource: true,
  latestSoapVersionId: true,
  startedAt: true,
  stoppedAt: true,
  recordingMaxDurationMinutes: true,
  recordingExpiresAt: true,
  recordingAutoStopTaskName: true,
  recordingStopReason: true,
  finalizedAt: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true
});

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative()
});

export const signupApplicationSchema = z.object({
  signupId: z.string(),
  organizationCode: z.string(),
  displayName: z.string(),
  adminLoginId: z.string(),
  adminDisplayName: z.string(),
  adminEmail: z.string(),
  planCode: z.enum(BILLING_PLAN_CODES),
  source: z.string().nullable().default(null),
  organizationName: z.string().nullable().default(null),
  adminName: z.string().nullable().default(null),
  phoneNumber: z.string().nullable().default(null),
  seatEstimate: z.number().int().positive().nullable().default(null),
  notes: z.string().nullable().default(null),
  consentAcceptedAt: z.string().nullable().default(null),
  consentVersion: z.string().nullable().default(null),
  consentTermsUrl: z.string().nullable().default(null),
  consentPrivacyUrl: z.string().nullable().default(null),
  consentClientIp: z.string().nullable().default(null),
  consentUserAgent: z.string().nullable().default(null),
  emailVerifiedAt: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  status: z.enum(SIGNUP_APPLICATION_STATUSES),
  stripeCustomerId: z.string().nullable().default(null),
  stripeSubscriptionId: z.string().nullable().default(null),
  stripeCheckoutSessionId: z.string().nullable().default(null),
  orgId: z.string().nullable().default(null),
  memberId: z.string().nullable().default(null),
  passwordSetupTokenId: z.string().nullable().default(null),
  slackProvisionedNotificationSentAt: z.string().nullable().default(null),
  slackProvisionedNotificationErrorAt: z.string().nullable().default(null),
  slackProvisionedNotificationErrorMessageSafe: z.string().nullable().default(null),
  errorCode: z.string().nullable().default(null),
  errorMessageSafe: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const contactSignupResponseSchema = z.object({
  signup: z.object({
    signupId: z.string(),
    status: z.enum(SIGNUP_APPLICATION_STATUSES),
    organizationName: z.string().nullable().default(null),
    adminEmailMasked: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string()
  }),
  verificationRequested: z.boolean(),
  verificationPreviewUrl: z.string().url().nullable().default(null)
});

export const contactSignupVerificationInspectResponseSchema = z.object({
  signup: z.object({
    signupId: z.string(),
    status: z.enum(SIGNUP_APPLICATION_STATUSES),
    organizationName: z.string().nullable().default(null),
    adminEmailMasked: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string()
  }),
  tokenStatus: z.enum(["active", "used", "expired"]),
  canProceed: z.boolean()
});

export const contactSignupVerificationResponseSchema = z.object({
  signup: z.object({
    signupId: z.string(),
    status: z.enum(SIGNUP_APPLICATION_STATUSES),
    organizationName: z.string().nullable().default(null),
    organizationCode: z.string().nullable().default(null),
    adminLoginId: z.string().nullable().default(null),
    adminEmailMasked: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string()
  }),
  verificationConsumed: z.boolean(),
  loginUrl: z.string().url(),
  passwordSetupUrl: z.string().url().nullable().default(null)
});

export const contactSignupStatusResponseSchema = z.object({
  signup: z.object({
    signupId: z.string(),
    status: z.enum(SIGNUP_APPLICATION_STATUSES),
    organizationName: z.string().nullable().default(null),
    adminEmailMasked: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string()
  })
});

export const resendContactSignupMailResponseSchema = z.object({
  mode: z.enum(["verification", "password_setup"]),
  delivered: z.boolean(),
  previewUrl: z.string().url().nullable().default(null)
});

export const emailVerificationTokenSchema = z.object({
  tokenId: z.string(),
  signupId: z.string(),
  email: z.string(),
  status: z.enum(["active", "used", "expired"]),
  expiresAt: z.string(),
  consumedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const checkoutSessionResponseSchema = z.object({
  signupId: z.string(),
  checkoutSessionId: z.string(),
  checkoutUrl: z.string().url(),
  expiresAt: z.string().nullable().default(null)
});

export const passwordSetupTokenSchema = z.object({
  tokenId: z.string(),
  orgId: z.string(),
  memberId: z.string(),
  organizationDisplayName: z.string().nullable().default(null),
  memberDisplayName: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  status: z.enum(["active", "used", "expired"]),
  expiresAt: z.string(),
  usedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const passwordSetupTokenStateResponseSchema = z.object({
  token: passwordSetupTokenSchema
});

export const billingStatusResponseSchema = z.object({
  billing: organizationBillingSchema.nullable(),
  access: organizationAccessSchema.nullable()
});

export const billingPortalSessionResponseSchema = z.object({
  url: z.string().url()
});

export const billingCheckoutSessionResponseSchema = z.object({
  checkoutSessionId: z.string(),
  checkoutUrl: z.string().url(),
  expiresAt: z.string().nullable().default(null)
});

export const finalizeTaskPayloadSchema = z.object({
  sessionId: z.string().min(1),
  clinicId: z.string().min(1),
  rawAudioPath: z.string().nullable().default(null),
  enqueueSoapGeneration: z.boolean().default(true),
  finalizeRequestedAt: z.string().nullable().default(null),
  gatewayStartedAt: z.string().nullable().default(null),
  gatewayEnqueuedAt: z.string().nullable().default(null)
});

export const recordingAutoStopTaskPayloadSchema = z.object({
  sessionId: z.string().min(1),
  clinicId: z.string().min(1),
  recordingExpiresAt: z.string().min(1)
});

export const WS_SERVER_EVENT_TYPES = [
  "auth.ok",
  "session.state.updated",
  "audio.first_frame_received",
  "audio.activity",
  "transcript.partial",
  "transcript.final",
  "transcript.corrected",
  "highlights.updated",
  "soap.status",
  "soap.stream.updated",
  "soap.ready",
  "recording.started",
  "recording.stopped",
  "recording.discarded",
  "warning",
  "error",
  "ping",
  "pong"
];

export function parseJsonBody(schema, payload) {
  try {
    return schema.parse(payload ?? {});
  } catch (error) {
    error.statusCode = 400;
    error.publicMessage = "入力内容を確認してください。";
    throw error;
  }
}
