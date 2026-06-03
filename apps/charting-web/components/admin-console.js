"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_RECORDING_MAX_DURATION_MINUTES,
  normalizeRecordingMaxDurationMinutes
} from "@medical/contracts";
import {
  buildBillingBannerCopy,
  formatAccessStatus,
  formatBillingDateTime,
  formatBillingStatus,
  getBillingDisplayState,
  getBillingActionLabel,
  getTrialDaysRemaining,
  shouldOpenBillingPortal,
  shouldStartBillingCheckout
} from "../lib/billing-display";
import {
  createBillingCheckoutSession,
  createBillingPortalSession
} from "../lib/billing-api";
import { getGatewayBaseUrl } from "../lib/runtime-config";
import { toUserFacingErrorMessage } from "../lib/user-facing-error";
import {
  canManageOrganization,
  canManageMembers,
  canManageOrganizationSoapFormats,
  canManageOwnSoapFormats,
  canManagePlatform,
  canOpenAdminConsole,
  canOpenSettingsConsole,
  fetchWithOperatorAuth,
  formatMemberRole,
  getAssignableRoleDefinitions,
  useOperatorAccess
} from "../lib/operator-access";
import { AdminSelect } from "./admin-select";
import { AudioTestPanel } from "./audio-test-panel";
import { Icon } from "./icon";
import { useAdminNav } from "./admin-nav-context";
import { OperatorLoginPanel } from "./operator-login-panel";

const SOAP_PROMPT_TEMPLATE_MARKER = "【テンプレート】";
const SOAP_PROMPT_EXAMPLE_MARKER = "【出力例】";
const SOAP_PROMPT_STYLE_MARKER = "【スタイル】";

const DEFAULT_OUTPUT_TEMPLATE_BODY = `#
S
【主訴】
【現病歴】
【併存症】
【既往歴】
【内服薬】
【家族歴】
【アレルギー】
【生活歴】

O
【全身状態】
【バイタル】
【身体所見】
【検体検査】
【生理検査】
【画像検査】

A
#1
所見の要約:
鑑別診断と根拠:
評価:

P
Dx:
Tx:
Ex:`;

const DEFAULT_OUTPUT_EXAMPLE = `S
【主訴】胸が痛い
【現病歴】本日午前10時頃、安静時に突然左前胸部の締め付けるような痛みが出現。持続時間は約15分。冷汗を伴った。嘔気なし、呼吸困難なし。来院時には痛みは軽減している。
【既往歴】高血圧、脂質異常症、2型糖尿病
【内服薬】アムロジピン5mg 1錠 朝、ロスバスタチン2.5mg 1錠 夕、メトホルミン500mg 2錠 朝夕
【家族歴】父が62歳時に心筋梗塞、母が70歳時に脳梗塞
【アレルギー】薬剤アレルギーなし、食物アレルギーなし
【生活歴】喫煙20本/日を35年、飲酒ビール350ml/日、ADL自立

O
意識清明。BT 36.5℃、BP 158/92mmHg、HR 88/分、RR 18/分、SpO2 98%（室内気）。心音整、呼吸音清。下肢浮腫なし。トロポニンI軽度上昇。

A
急性冠症候群疑い。冠危険因子を複数有し、心筋虚血の鑑別が必要。

P
循環器内科コンサルト
心電図モニター装着、安静
トロポニン再検
必要時ニトログリセリン頓用
禁煙指導`;

const DEFAULT_OUTPUT_STYLE = `出力例は文体と粒度の参考として使い、症状、数値、診断名、処方内容は現在の会話にある事実だけを書く。
会話にない身体所見、検査値、家族歴、既往歴は補わない。
Pは簡潔な改行列挙で記載する。`;

function buildPromptEditorText({
  templateText = DEFAULT_OUTPUT_TEMPLATE_BODY,
  exampleText = DEFAULT_OUTPUT_EXAMPLE,
  styleText = DEFAULT_OUTPUT_STYLE
} = {}) {
  const blocks = [
    `${SOAP_PROMPT_TEMPLATE_MARKER}\n${String(templateText || "").trim()}`,
    `${SOAP_PROMPT_EXAMPLE_MARKER}\n${String(exampleText || "").trim()}`
  ];

  if (String(styleText || "").trim()) {
    blocks.push(`${SOAP_PROMPT_STYLE_MARKER}\n${String(styleText || "").trim()}`);
  }

  return blocks.join("\n\n");
}

function parsePromptEditorText(value) {
  const normalized = String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const lines = normalized.split("\n");
  const sections = { templateText: [], exampleText: [], styleText: [] };
  const markerMap = new Map([
    [SOAP_PROMPT_TEMPLATE_MARKER, "templateText"],
    [SOAP_PROMPT_EXAMPLE_MARKER, "exampleText"],
    [SOAP_PROMPT_STYLE_MARKER, "styleText"]
  ]);
  const markers = [];
  let currentKey = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const nextKey = markerMap.get(line);

    if (nextKey) {
      currentKey = nextKey;
      markers.push(line);
      continue;
    }

    if (currentKey) {
      sections[currentKey].push(rawLine);
    }
  }

  const hasStructuredBlocks = markers.length > 0;
  return {
    hasStructuredBlocks,
    templateText: hasStructuredBlocks ? sections.templateText.join("\n").trim() : normalized,
    exampleText: hasStructuredBlocks ? sections.exampleText.join("\n").trim() : "",
    styleText: hasStructuredBlocks ? sections.styleText.join("\n").trim() : ""
  };
}

const DEFAULT_OUTPUT_TEMPLATE = buildPromptEditorText();

const RECORDING_MAX_DURATION_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240];

const NEW_PROMPT_BASE_NAME = "新しいプロンプト";
const INFERRED_PROMPT_BASE_NAME = "カルテ逆算フォーマット";
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;
const ORG_ADMIN_LOCKOUT_ROLES = new Set(["platform_admin", "org_owner", "org_admin"]);
const GENERATED_PASSWORD_GROUPS = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%+-_"
];
const GENERATED_PASSWORD_CHARS = GENERATED_PASSWORD_GROUPS.join("");

const DEFAULT_CUSTOMIZATION = {
  tone: "簡潔で臨床現場で編集しやすい日本語",
  detailLevel: "standard",
  globalInstruction: "",
  additionalInstructions: [],
  outputPreferences: {
    headingStyle: "soap_letters",
    copyFormat: "emr_plain_text"
  }
};

const EMPTY_MEMBER_FORM = {
  loginId: "",
  displayName: "",
  password: "",
  roles: ["doctor"],
  defaultRecordingSource: "linked_mobile"
};

const EMPTY_ORGANIZATION_FORM = {
  organizationCode: "",
  displayName: "",
  adminLoginId: "admin",
  adminDisplayName: "管理者",
  adminPassword: ""
};

const SAMPLE_TRANSCRIPT = `今日はどうされましたか。
一昨日の夜から喉が痛くて、昨日から咳と発熱があります。今朝も熱が下がらなかったので受診しました。
最高で何度くらいまで上がりましたか。
昨日の夜に38.2度でした。今朝は37.8度くらいです。
咳は乾いた咳ですか。それとも痰が絡みますか。
最初は乾いた咳でしたが、今朝から少し黄色っぽい痰が出ます。
息苦しさや胸の痛みはありますか。
息苦しさはありません。胸の痛みもないです。ただ咳をすると喉が痛いです。
鼻水、頭痛、関節痛、寒気はありますか。
鼻水は少しあります。頭痛は軽くあります。寒気は昨日の夜にありました。関節痛は強くないです。
食事や水分は取れていますか。吐き気や下痢はありますか。
食欲は少し落ちていますが、水分は取れています。吐き気と下痢はありません。
周りで同じような症状の方はいますか。
職場で咳をしている人が何人かいます。家族にはまだいません。
コロナやインフルエンザに最近かかった方との接触はありますか。
はっきりとは分かりません。職場でインフルエンザの人がいたとは聞きました。
持病はありますか。喘息、糖尿病、高血圧などはありますか。
高血圧で薬を飲んでいます。喘息や糖尿病はありません。
いま飲んでいる薬の名前は分かりますか。
アムロジピンを毎朝飲んでいます。市販の風邪薬は昨日の夜に一回だけ飲みました。
薬や食べ物のアレルギーはありますか。
特にありません。
タバコは吸いますか。
吸いません。
では診察します。喉を見ますね。少し赤いですが、膿は目立ちません。首のリンパ節は軽く腫れています。胸の音を聞きます。深呼吸してください。
はい。
呼吸音は大きな異常はなさそうです。酸素の値も問題ありません。症状と経過からは、ウイルス性の上気道炎をまず考えますが、インフルエンザの可能性もあるので検査をしましょう。
分かりました。
検査結果によって治療を決めます。現時点では水分をしっかり取って、発熱や喉の痛みには解熱鎮痛薬を使います。咳と痰がつらければ咳止めと去痰薬を出します。
仕事は休んだ方がいいですか。
熱がある間は休んでください。解熱後もしばらく咳が残ることがあります。息苦しさ、胸の痛み、水分が取れない、39度以上の高熱が続く場合は早めに再診してください。
分かりました。`;

const MEMBER_RECORDING_SOURCE_OPTIONS = [
  {
    value: "linked_mobile",
    label: "スマホ",
    description: "スマホを録音端末として使います。"
  },
  {
    value: "local_browser",
    label: "このパソコン",
    description: "このパソコンのマイクで録音します。"
  }
];

const SETTINGS_HOME_TAB = "home";
const FORMATS_INFER_TAB = "formats-infer";

const SETTINGS_HOME_PAGE = {
  id: SETTINGS_HOME_TAB,
  group: "トップ",
  label: "設定",
  description: "変更したい項目を選んでください。"
};

const FORMATS_INFER_PAGE = {
  id: FORMATS_INFER_TAB,
  group: "設定",
  label: "普段のカルテから作成",
  description: "過去のカルテ例から、プロンプト案を作成します。"
};

const ADMIN_SECTIONS = [
  {
    id: "members",
    group: "管理",
    label: "権限管理",
    description: "職員アカウント、権限、ログイン用パスワード、プロンプト割当を設定します。"
  },
  {
    id: "formats",
    group: "設定",
    label: "プロンプト設定",
    description: "SOAPプロンプトを作成、確認、公開します。"
  },
  {
    id: "audio-test",
    group: "設定",
    label: "音声テスト",
    description: "このパソコンのマイク入力、音量、聞こえ方を確認します。"
  },
  {
    id: "audit",
    group: "管理",
    label: "操作ログ",
    description: "病院内の設定変更と操作履歴を確認します。"
  },
  {
    id: "account",
    group: "管理",
    label: "アカウント",
    description: "ログイン中の職員情報とログイン状態を管理します。"
  }
];

const SECTION_QUERY_BY_TAB = {
  members: "members",
  formats: "prompts",
  [FORMATS_INFER_TAB]: "prompts-infer",
  "audio-test": "audio-test",
  audit: "audit",
  account: "account"
};

const TAB_BY_SECTION_QUERY = {
  members: "members",
  prompts: "formats",
  formats: "formats",
  "prompts-infer": FORMATS_INFER_TAB,
  "audio-test": "audio-test",
  audio: "audio-test",
  audit: "audit",
  account: "account"
};

const VALID_ADMIN_TAB_IDS = new Set([
  SETTINGS_HOME_TAB,
  FORMATS_INFER_TAB,
  ...ADMIN_SECTIONS.map((section) => section.id)
]);

function formatScope(scope) {
  return {
    organization: "病院標準",
    facility: "施設別",
    department: "診療科別",
    member: "医師個人"
  }[scope] || scope;
}

function formatStatus(format) {
  if (format.status === "active" && format.approved) {
    return "公開中";
  }

  if (format.status === "archived") {
    return "公開停止";
  }

  if (format.latestVersion?.validationStatus === "failed") {
    return "要修正";
  }

  return "下書き";
}

function formatStatusClass(format) {
  if (format.status === "archived") {
    return "is-archived";
  }

  if (format.status === "active" && format.approved) {
    return "is-active";
  }

  if (format.latestVersion?.validationStatus === "failed") {
    return "is-danger";
  }

  return "is-draft";
}

function pageMeta(activeTab, sections = ADMIN_SECTIONS) {
  if (activeTab === SETTINGS_HOME_TAB) {
    return SETTINGS_HOME_PAGE;
  }

  if (activeTab === FORMATS_INFER_TAB) {
    return FORMATS_INFER_PAGE;
  }

  return sections.find((section) => section.id === activeTab) || sections[0] || ADMIN_SECTIONS[0];
}

function tabFromSectionQuery(section) {
  return TAB_BY_SECTION_QUERY[section] || SETTINGS_HOME_TAB;
}

function readAdminTabFromUrl() {
  if (typeof window === "undefined") {
    return SETTINGS_HOME_TAB;
  }

  const params = new URLSearchParams(window.location.search);
  return tabFromSectionQuery(params.get("section"));
}

function bootstrapSectionForTab(tabId) {
  if (tabId === "formats" || tabId === FORMATS_INFER_TAB) {
    return "formats";
  }

  if (["members", "audio-test", "audit", "account"].includes(tabId)) {
    return tabId;
  }

  return "home";
}

function readBillingFlowHintFromUrl() {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const hint = params.get("billing");
  return hint === "success" || hint === "cancel" ? hint : null;
}

function clearBillingFlowHintFromUrl() {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);

  if (!url.searchParams.has("billing")) {
    return;
  }

  url.searchParams.delete("billing");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function resolveCoreAdminUrl() {
  if (typeof window === "undefined") {
    return "https://admin.halunasu.com";
  }

  const host = window.location.hostname;
  if (host.startsWith("stg.") || host.includes(".stg.") || host.includes("halunasu-charting-stg")) {
    return "https://admin.stg.halunasu.com";
  }

  return "https://admin.halunasu.com";
}

function syncAdminSectionUrl(tabId, { replace = false } = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  const queryValue = SECTION_QUERY_BY_TAB[tabId];

  if (queryValue) {
    url.searchParams.set("section", queryValue);
  } else {
    url.searchParams.delete("section");
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextUrl === currentUrl) {
    return;
  }

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", nextUrl);
}

function roleLabel(role) {
  return formatMemberRole(role);
}

function hasOrgAdminLockoutRole(roles = []) {
  return roles.some((role) => ORG_ADMIN_LOCKOUT_ROLES.has(role));
}

function roleCategoryClass(category) {
  return {
    platform: "member-role-chip--platform",
    organization: "member-role-chip--organization",
    clinical: "member-role-chip--clinical",
    operations: "member-role-chip--operations",
    governance: "member-role-chip--governance"
  }[category] || "member-role-chip--custom";
}

function secureRandomIndex(max) {
  if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    window.crypto.getRandomValues(values);
    return values[0] % max;
  }

  return Math.floor(Math.random() * max);
}

function shuffleSecure(values) {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomIndex(index + 1);
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function generateSecurePassword(length = 18) {
  const required = GENERATED_PASSWORD_GROUPS.map((group) => group[secureRandomIndex(group.length)]);
  const remaining = Array.from({ length: Math.max(length - required.length, 0) }, () => (
    GENERATED_PASSWORD_CHARS[secureRandomIndex(GENERATED_PASSWORD_CHARS.length)]
  ));

  return shuffleSecure([...required, ...remaining]).join("");
}

function assignedFormatName(member, formats) {
  const formatId = member.defaultPromptProfileId || "system-default";

  if (formatId === "system-default") {
    return "病院標準";
  }

  return formats.find((format) => format.formatId === formatId)?.displayName || "不明なプロンプト";
}

function normalizeRecordingSource(source) {
  return source === "local_browser" ? "local_browser" : "linked_mobile";
}

function recordingSourceLabel(source) {
  return normalizeRecordingSource(source) === "local_browser" ? "このパソコンで録音" : "スマホで録音";
}

function humanizeAuditType(type = "") {
  return type
    .split(".")
    .filter(Boolean)
    .map((part) => part.replaceAll("_", " "))
    .join(" / ");
}

function eventLabel(type) {
  return {
    "organization.created": "病院を追加",
    "organization.recording_policy_updated": "録音自動停止設定変更",
    "member.created": "職員作成",
    "member.password_reset": "ログイン用パスワード再設定",
    "member.roles_updated": "権限変更",
    "member.mfa_reset": "2段階認証リセット",
    "member.mfa_enabled": "2段階認証登録",
    "member.status_updated": "職員利用状態変更",
    "member.sessions_revoked": "強制ログアウト",
    "member.preferences_updated": "職員設定変更",
    "auth.login_failed": "ログイン失敗",
    "auth.mfa_failed": "2段階認証コードの確認に失敗",
    "billing.provisioning.completed": "病院アカウント作成完了",
    "billing.password_setup.completed": "ログイン用パスワード初回設定完了",
    "billing.checkout.created": "決済画面を作成",
    "billing.checkout.completed": "決済完了",
    "billing.subscription.updated": "契約状態更新",
    "billing.subscription.deleted": "契約終了",
    "billing.invoice.paid": "支払い完了",
    "billing.invoice.payment_failed": "支払い失敗",
    "billing.access.updated": "利用状態更新",
    "billing.access.restored": "利用再開",
    "billing.access.action_required": "支払い対応が必要",
    "billing.access.canceled": "利用停止",
    "billing.access.suspended": "利用一時停止",
    "billing.trial.expired": "無料利用期間終了",
    "billing.access.trial_expired": "無料利用期間終了により利用制限",
    "billing.grace_period.enforced": "支払い猶予期間終了",
    "trusted_recorder.registered": "録音端末登録",
    "trusted_recorder.refreshed": "録音端末確認",
    "trusted_recorder.revoked": "録音端末失効",
    "member.format_assigned": "プロンプト割当変更",
    "soap_format.assigned": "プロンプト割当変更",
    "soap_format.created": "プロンプト作成",
    "soap_format.draft_saved": "プロンプト保存",
    "soap_format.draft_updated": "プロンプト更新",
    "soap_format.published": "プロンプト公開",
    "soap_format.archived": "プロンプト公開停止",
    "session.prompt_profile_updated": "セッションのプロンプト変更",
    "encounter.created": "診療記録作成",
    "encounter.hidden_from_home": "診療履歴を一覧から削除",
    "pairing.created": "スマホ接続用QRを発行",
    "pairing.claimed": "スマホ接続完了",
    "recording.started": "録音開始",
    "recording.stopped": "録音停止",
    "recording.discarded": "録音を破棄",
    "transcript.final_repass.started": "書き起こし再処理開始",
    "transcript.final_repass.completed": "書き起こし再処理完了",
    "transcript.final_repass.failed": "書き起こし再処理失敗",
    "transcript.final_repass.skipped": "書き起こし再処理を省略",
    "transcript.final_repass.discarded": "追加録音を破棄",
    "soap.generation.started": "SOAP下書き作成開始",
    "soap.generation.completed": "SOAP下書き作成完了",
    "soap.generation.failed": "SOAP下書き作成失敗",
    "soap.regeneration.requested": "SOAP再作成を開始",
    "soap.regeneration.transcript_reused": "既存の書き起こしを使ってSOAP再作成",
    "soap.regeneration.completed": "SOAP再作成完了",
    "soap.regeneration.failed": "SOAP再作成失敗",
    "soap.regeneration.timed_out": "SOAP再作成が時間切れ",
    "soap.finalize.timed_out": "SOAP下書き作成が時間切れ",
    "review_note.saved": "診療記録を保存",
    "review_note.reopened": "確定済み診療記録を再編集",
    "review_note.approved": "診療記録を確定",
    "retention.cleanup.completed": "保存期限を過ぎたデータを整理"
  }[type] || humanizeAuditType(type);
}

function actorLabel(event, members, session) {
  if (!event.actorId || ["system", "gateway", "finalize-worker"].includes(event.actorId)) {
    return "システム";
  }

  const member = members.find((item) => item.memberId === event.actorId || item.loginId === event.actorId);

  if (member) {
    return `${member.displayName}（${member.loginId}）`;
  }

  if (session?.member && [session.member.memberId, session.member.loginId].includes(event.actorId)) {
    return `${session.member.displayName || session.member.loginId}（${session.member.loginId}）`;
  }

  return `個人ID: ${event.actorId}`;
}

function applyTargetLabel(target, members, organization) {
  if (!target) {
    return "未選択";
  }

  if (target.targetType === "organization") {
    return `${organization?.displayName || "この病院"}の標準`;
  }

  const member = members.find((item) => item.memberId === target.memberId);
  return member ? `${member.displayName}（${member.loginId}）` : "選択した職員";
}

function eventTone(type = "") {
  if (type.includes("archived") || type.includes("password")) {
    return "is-warning";
  }

  if (type.includes("published") || type.includes("created")) {
    return "is-success";
  }

  if (type.includes("format")) {
    return "is-info";
  }

  return "";
}

function billingBadgeClass(status) {
  switch (status) {
    case "trialing":
      return "badge--trialing";
    case "active":
      return "badge--billing_active";
    case "past_due":
    case "grace_period":
    case "unpaid":
    case "payment_required":
      return "badge--billing_warning";
    case "canceled":
      return "badge--billing_muted";
    default:
      return "badge--ready";
  }
}

function accessBadgeClass(status) {
  switch (status) {
    case "active":
      return "badge--billing_active";
    case "billing_action_required":
      return "badge--billing_warning";
    case "suspended":
    case "canceled":
      return "badge--billing_muted";
    default:
      return "badge--ready";
  }
}

function groupEventsByDate(events) {
  return events.reduce((groups, event) => {
    const date = event.createdAt ? new Date(event.createdAt) : null;
    const label = date
      ? date.toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
      : "日時不明";
    const existing = groups.find((group) => group.label === label);

    if (existing) {
      existing.events.push(event);
    } else {
      groups.push({ label, events: [event] });
    }

    return groups;
  }, []);
}

function formatDateTime(value) {
  if (!value) {
    return "未記録";
  }

  return new Date(value).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function createNewFormat(memberId) {
  return {
    displayName: NEW_PROMPT_BASE_NAME,
    scope: "member",
    ownerMemberId: memberId || "",
    facilityId: "",
    departmentId: "",
    templateKey: "outpatient_soap_note",
    outputTemplate: DEFAULT_OUTPUT_TEMPLATE,
    customization: DEFAULT_CUSTOMIZATION,
    sections: []
  };
}

function createInferenceSample(value = "") {
  return {
    id: `sample-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    value
  };
}

function normalizePromptDisplayNameKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(CONTROL_CHARS_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ja-JP");
}

function buildUniqueNewPromptName(formats) {
  return buildUniquePromptName(NEW_PROMPT_BASE_NAME, formats);
}

function buildUniquePromptName(baseName, formats) {
  const normalizedBaseName = String(baseName || "").trim() || NEW_PROMPT_BASE_NAME;
  const usedNames = new Set((formats || []).map((format) => normalizePromptDisplayNameKey(format.displayName)));

  if (!usedNames.has(normalizePromptDisplayNameKey(normalizedBaseName))) {
    return normalizedBaseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${normalizedBaseName}(${index})`;
    if (!usedNames.has(normalizePromptDisplayNameKey(candidate))) {
      return candidate;
    }
  }

  return `${normalizedBaseName}(${Date.now()})`;
}

function findDuplicatePromptName(formats, displayName, currentFormatId = "") {
  const displayNameKey = normalizePromptDisplayNameKey(displayName);

  if (!displayNameKey) {
    return null;
  }

  return (formats || []).find((format) => (
    format.formatId !== currentFormatId &&
    normalizePromptDisplayNameKey(format.displayName) === displayNameKey
  )) || null;
}

function normalizeFormatForEditor(format) {
  const parsedPrompt = parsePromptEditorText(format.outputTemplate || DEFAULT_OUTPUT_TEMPLATE);
  return {
    displayName: format.displayName || "プロンプト",
    scope: format.scope || "member",
    ownerMemberId: format.ownerMemberId || "",
    facilityId: format.facilityId || "",
    departmentId: format.departmentId || "",
    templateKey: format.templateKey || "outpatient_soap_note",
    outputTemplate: parsedPrompt.hasStructuredBlocks
      ? (format.outputTemplate || DEFAULT_OUTPUT_TEMPLATE)
      : buildPromptEditorText({
          templateText: parsedPrompt.templateText || DEFAULT_OUTPUT_TEMPLATE_BODY
        }),
    customization: {
      ...DEFAULT_CUSTOMIZATION,
      ...(format.customization || {}),
      outputPreferences: {
        ...DEFAULT_CUSTOMIZATION.outputPreferences,
        ...(format.customization?.outputPreferences || {})
      }
    },
    sections: []
  };
}

function formatHasEditorDetail(format) {
  return Boolean(format && Object.prototype.hasOwnProperty.call(format, "outputTemplate"));
}

function buildPayload(editor) {
  return {
    ...editor,
    ownerMemberId: editor.ownerMemberId || null,
    facilityId: editor.facilityId || null,
    departmentId: editor.departmentId || null,
    customization: {
      ...editor.customization,
      additionalInstructions: String(editor.customization.additionalInstructionsText || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      outputPreferences: editor.customization.outputPreferences
    }
  };
}

async function readJson(response, fallbackMessage) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(toUserFacingErrorMessage(payload.error || fallbackMessage, fallbackMessage));
  }

  return payload;
}

function parseEventStreamBuffer(buffer) {
  const events = [];
  let remaining = buffer;
  let boundaryIndex = remaining.indexOf("\n\n");

  while (boundaryIndex >= 0) {
    const rawEvent = remaining.slice(0, boundaryIndex);
    remaining = remaining.slice(boundaryIndex + 2);
    boundaryIndex = remaining.indexOf("\n\n");

    if (!rawEvent.trim()) {
      continue;
    }

    let eventName = "message";
    const dataLines = [];

    for (const rawLine of rawEvent.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!dataLines.length) {
      continue;
    }

    try {
      events.push({
        event: eventName,
        payload: JSON.parse(dataLines.join("\n"))
      });
    } catch {
      events.push({
        event: eventName,
        payload: {}
      });
    }
  }

  return {
    events,
    remaining
  };
}

function AdminModal({ title, description, children, footer, onClose }) {
  return (
    <div className="admin-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="admin-modal-card" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title">
        <button className="modal-close-button" type="button" onClick={onClose} aria-label="閉じる"><Icon name="x" size={16} /></button>
        <div className="admin-modal-head">
          <h2 id="admin-modal-title">{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <div className="admin-modal-body">{children}</div>
        {footer ? <div className="admin-modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function AdminConsole() {
  const { accessToken, clearAccess, isHydrated, setAccessToken } = useOperatorAccess();
  const { clearAdminNav, registerAdminNav } = useAdminNav();
  const [session, setSession] = useState(null);
  const [organizations, setOrganizations] = useState([]);
  const [roleDefinitions, setRoleDefinitions] = useState([]);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [formats, setFormats] = useState([]);
  const [members, setMembers] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [activeTab, setActiveTab] = useState(SETTINGS_HOME_TAB);
  const [selectedFormatId, setSelectedFormatId] = useState("");
  const [editor, setEditor] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [initialNewFormatName, setInitialNewFormatName] = useState("");
  const [previewTranscript, setPreviewTranscript] = useState(SAMPLE_TRANSCRIPT);
  const [preview, setPreview] = useState(null);
  const [previewState, setPreviewState] = useState("idle");
  const [previewError, setPreviewError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFormatDetailLoading, setIsFormatDetailLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [organizationForm, setOrganizationForm] = useState(EMPTY_ORGANIZATION_FORM);
  const [memberForm, setMemberForm] = useState(EMPTY_MEMBER_FORM);
  const [passwordForm, setPasswordForm] = useState({ password: "" });
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [passwordResetResult, setPasswordResetResult] = useState("");
  const [modalMode, setModalMode] = useState(null);
  const [passwordTarget, setPasswordTarget] = useState(null);
  const [roleTarget, setRoleTarget] = useState(null);
  const [roleForm, setRoleForm] = useState({ roles: ["doctor"] });
  const [statusTarget, setStatusTarget] = useState(null);
  const [securityActionTarget, setSecurityActionTarget] = useState(null);
  const [memberActionTarget, setMemberActionTarget] = useState(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [formatSearch, setFormatSearch] = useState("");
  const [auditTypeFilter, setAuditTypeFilter] = useState("");
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [inferDisplayName, setInferDisplayName] = useState("");
  const [inferSamples, setInferSamples] = useState(() => [createInferenceSample("")]);
  const [inferState, setInferState] = useState("idle");
  const [inferError, setInferError] = useState("");
  const [inferResult, setInferResult] = useState(null);
  const [applyForm, setApplyForm] = useState({ targetType: "member", memberId: "" });
  const [pendingApplyTarget, setPendingApplyTarget] = useState(null);
  const [savingMemberPreferenceIds, setSavingMemberPreferenceIds] = useState(new Set());
  const [savingPromptAssignmentIds, setSavingPromptAssignmentIds] = useState(new Set());
  const [isSavingRecordingPolicy, setIsSavingRecordingPolicy] = useState(false);
  const [isLaunchingBillingAction, setIsLaunchingBillingAction] = useState(false);
  const previewAbortControllerRef = useRef(null);
  const previewRequestIdRef = useRef(0);
  const previewScrollRef = useRef(null);

  const currentOrgId = session?.orgId || session?.organization?.orgId || "";
  const selectedOrganization = organizations.find((organization) => organization.orgId === selectedOrgId) || organizations[0] || null;
  const accountOrganization = selectedOrganization || session?.organization || null;
  const accountBilling = accountOrganization?.billing || session?.organization?.billing || null;
  const accountAccess = accountOrganization?.access || session?.organization?.access || null;
  const accountProductEntitlements = accountOrganization?.productEntitlements || session?.organization?.productEntitlements || null;
  const accountBillingDisplayState = getBillingDisplayState({
    billing: accountBilling,
    productEntitlements: accountProductEntitlements,
    productId: "charting"
  });
  const accountDisplayAccess = ["payment_required", "pending_checkout", "past_due", "grace_period", "unpaid"].includes(accountBillingDisplayState.status)
    ? { ...(accountAccess || {}), status: "billing_action_required" }
    : accountAccess;
  const accountBillingBanner = buildBillingBannerCopy({
    billing: accountBilling,
    access: accountDisplayAccess,
    productEntitlements: accountProductEntitlements,
    productId: "charting"
  });
  const trialDaysRemaining = getTrialDaysRemaining(accountBillingDisplayState.trialEndsAt);
  const selectedFormat = formats.find((format) => format.formatId === selectedFormatId) || null;
  const duplicatePromptName = editor ? findDuplicatePromptName(formats, editor.displayName, selectedFormatId) : null;
  const isPromptNameBlank = editor ? !normalizePromptDisplayNameKey(editor.displayName) : false;
  const promptNameError = isPromptNameBlank
    ? "プロンプト名を入力してください。"
    : duplicatePromptName
      ? "同じ名前のプロンプトが既にあります。別の名前にしてください。"
      : "";
  const activeFormats = formats.filter((format) => format.formatId !== "system-default" && format.status === "active" && format.approved);
  const isCurrentOrganization = !selectedOrgId || selectedOrgId === currentOrgId;
  const canOpenAdmin = canOpenAdminConsole(session);
  const canOpenSettings = canOpenSettingsConsole(session);
  const canManagePlatformSettings = canManagePlatform(session);
  const canManageOrgSettings = canManageOrganization(session);
  const canManageBilling = canManageOrgSettings || canManagePlatformSettings;
  const canLaunchCheckout = shouldStartBillingCheckout(accountBilling);
  const canLaunchPortal = shouldOpenBillingPortal(accountBilling);
  const canManageCurrentMembers = canManageMembers(session);
  const canManageOrgPrompts = canManageOrganizationSoapFormats(session);
  const canManageOwnPrompts = canManageOwnSoapFormats(session);
  const canManagePromptSettings = canManageOrgPrompts || canManageOwnPrompts;
  const promptAssignmentOptions = [
    {
      value: "system-default",
      label: "病院標準",
      description: "病院に設定された標準プロンプトを使います。"
    },
    ...activeFormats.map((format) => ({
      value: format.formatId,
      label: format.displayName,
      description: `${formatScope(format.scope)} ・ ${formatStatus(format)}`
    }))
  ];
  const visibleAdminSections = ADMIN_SECTIONS.filter((section) => {
    if (section.id === "members") {
      return canManageCurrentMembers;
    }

    if (section.id === "formats") {
      return canManagePromptSettings;
    }

    if (section.id === "audit") {
      return canOpenAdmin;
    }

    return canOpenSettings;
  });
  const visibleAdminSectionIds = visibleAdminSections.map((section) => section.id).join("|");
  const adminNavSections = visibleAdminSections;
  const currentPage = pageMeta(activeTab, visibleAdminSections);
  const showHeaderOrgSwitcher = false;
  const showMembersPageActions = activeTab === "members";
  const showFormatsPageAction = activeTab === "formats";
  const showFormatsInferPageAction = activeTab === FORMATS_INFER_TAB;
  const showAuditPageAction = activeTab === "audit";
  const showPageActions = showHeaderOrgSwitcher || showMembersPageActions || showFormatsPageAction || showFormatsInferPageAction || showAuditPageAction;
  const roleDefinitionById = new Map(roleDefinitions.map((role) => [role.roleId, role]));
  const assignableRoleDefinitions = getAssignableRoleDefinitions(session).map((role) => roleDefinitionById.get(role.roleId) || role);
  const displayRoleLabel = (role) => roleDefinitionById.get(role)?.label || roleLabel(role);
  const currentMember = members.find((member) => member.memberId === session?.member?.memberId) || session?.member || null;
  const currentMemberDefaultRecordingSource = normalizeRecordingSource(currentMember?.defaultRecordingSource);
  const organizationRecordingMaxDurationMinutes = normalizeRecordingMaxDurationMinutes(
    selectedOrganization?.recordingMaxDurationMinutes ?? DEFAULT_RECORDING_MAX_DURATION_MINUTES
  );
  const recordingMaxDurationOptions = RECORDING_MAX_DURATION_OPTIONS.includes(organizationRecordingMaxDurationMinutes)
    ? RECORDING_MAX_DURATION_OPTIONS
    : [...RECORDING_MAX_DURATION_OPTIONS, organizationRecordingMaxDurationMinutes].sort((left, right) => left - right);
  const filteredMembers = members.filter((member) => {
    const keyword = memberSearch.trim().toLowerCase();

    if (!keyword) {
      return true;
    }

    return [member.displayName, member.loginId, assignedFormatName(member, formats), recordingSourceLabel(member.defaultRecordingSource)]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(keyword));
  });
  const filteredFormats = formats.filter((format) => {
    const keyword = formatSearch.trim().toLowerCase();

    if (!keyword) {
      return true;
    }

    return [format.displayName, formatScope(format.scope), formatStatus(format)]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(keyword));
  });
  const activeOrgAdminCount = members.filter((member) => (
    member.status === "active" &&
    hasOrgAdminLockoutRole(member.roles || [])
  )).length;
  const roleTargetWouldRemoveLastAdmin = Boolean(
    roleTarget &&
    roleTarget.status === "active" &&
    hasOrgAdminLockoutRole(roleTarget.roles || []) &&
    !hasOrgAdminLockoutRole(roleForm.roles || []) &&
    activeOrgAdminCount <= 1
  );
  const auditTypes = Array.from(new Set(auditEvents.map((event) => event.type).filter(Boolean))).sort();
  const filteredAuditEvents = auditEvents.filter((event) => !auditTypeFilter || event.type === auditTypeFilter);
  const groupedAuditEvents = groupEventsByDate(filteredAuditEvents);
  const editorStatusText = isNew
    ? "未保存"
    : isEditorDirty
      ? "未保存の変更あり"
      : selectedFormat
        ? formatStatus(selectedFormat)
        : "未選択";
  const previewOutputText = preview?.soap?.outputText || preview?.soap?.output_text || "";
  const isPreviewRunning = previewState === "loading" || previewState === "streaming";
  const isInferringFormat = inferState === "loading";
  const canOpenFormatInference = canManagePromptSettings;

  function adminOrgQuery(orgId = selectedOrgId || currentOrgId, params = {}) {
    const query = new URLSearchParams();
    if (orgId) {
      query.set("orgId", orgId);
    }

    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") {
        query.set(key, value);
      }
    }

    const serialized = query.toString();
    return serialized ? `?${serialized}` : "";
  }

  function adminApiUrl(path, orgId = selectedOrgId || currentOrgId, params = {}) {
    return `${getGatewayBaseUrl()}${path}${adminOrgQuery(orgId, params)}`;
  }

  function cancelPreviewRequest() {
    if (previewAbortControllerRef.current) {
      previewAbortControllerRef.current.abort();
      previewAbortControllerRef.current = null;
    }
  }

  function buildPreviewRequestBody() {
    if (!editor) {
      return null;
    }

    return {
      format: {
        ...buildPayload(editor),
        displayName: editor.displayName || "プレビュー",
        scope: editor.scope || "member",
        ownerMemberId: editor.ownerMemberId || session?.member?.memberId || null
      },
      transcript: previewTranscript,
      sessionContext: {
        title: "プロンプト確認",
        visitReason: "咳と発熱"
      }
    };
  }

  const runPreview = useCallback(async ({ force = false } = {}) => {
    if (!editor) {
      setPreview(null);
      setPreviewState("idle");
      setPreviewError("");
      return;
    }

    const requestBody = buildPreviewRequestBody();

    if (!requestBody?.transcript?.trim() || !requestBody?.format?.outputTemplate?.trim()) {
      cancelPreviewRequest();
      setPreview(null);
      setPreviewState("idle");
      setPreviewError("");
      return;
    }

    if (!force && !accessToken) {
      return;
    }

    cancelPreviewRequest();

    const controller = new AbortController();
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    previewAbortControllerRef.current = controller;
    setPreview(null);
    setPreviewError("");
    setPreviewState("loading");

    try {
      const response = await fetchWithOperatorAuth(adminApiUrl("/api/v1/admin/soap-formats/preview-stream"), {
        method: "POST",
        headers: {
          Accept: "text/event-stream"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      }, accessToken);

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "出力例を作成できませんでした。" }));
        throw new Error(toUserFacingErrorMessage(payload.error || "", "出力例を作成できませんでした。"));
      }

      if (!response.body) {
        const payload = await readJson(response, "出力例を作成できませんでした。");
        if (previewRequestIdRef.current !== requestId) {
          return;
        }
        setPreview(payload);
        setPreviewState("ready");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffered += decoder.decode(value, { stream: true });
        const parsed = parseEventStreamBuffer(buffered);
        buffered = parsed.remaining;

        for (const item of parsed.events) {
          if (previewRequestIdRef.current !== requestId) {
            return;
          }

          if (item.event === "preview.started") {
            setPreviewState("loading");
            continue;
          }

          if (item.event === "preview.updated") {
            setPreview((current) => ({
              ...(current || {}),
              provider: item.payload.provider || current?.provider || "openai",
              soap: {
                ...(current?.soap || {}),
                outputText: item.payload.outputText || ""
              }
            }));
            setPreviewState("streaming");
            continue;
          }

          if (item.event === "preview.completed") {
            setPreview(item.payload);
            setPreviewState("ready");
            setPreviewError("");
            continue;
          }

          if (item.event === "preview.error") {
            throw new Error(toUserFacingErrorMessage(item.payload.error || "", "出力例を作成できませんでした。"));
          }
        }
      }
    } catch (nextError) {
      if (nextError?.name === "AbortError") {
        return;
      }

      if (previewRequestIdRef.current !== requestId) {
        return;
      }

      setPreviewState("error");
      setPreviewError(toUserFacingErrorMessage(nextError, "出力例を作成できませんでした。"));
    } finally {
      if (previewAbortControllerRef.current === controller) {
        previewAbortControllerRef.current = null;
      }
    }
  }, [accessToken, editor, previewTranscript, selectedOrgId, currentOrgId, session?.member?.memberId]);

  const selectAdminTab = useCallback((tabId, options = {}) => {
    const nextTab = VALID_ADMIN_TAB_IDS.has(tabId)
      ? tabId
      : SETTINGS_HOME_TAB;

    setActiveTab(nextTab);
    syncAdminSectionUrl(nextTab, { replace: Boolean(options.replace) });
    if (options.load !== false && accessToken && nextTab !== activeTab) {
      void loadAdminData(selectedOrgId, nextTab);
    }
  }, [accessToken, activeTab, selectedOrgId]);

  function defaultApplyTarget(format = selectedFormat) {
    const ownerMemberId = canManageCurrentMembers
      ? format?.ownerMemberId || editor?.ownerMemberId || session?.member?.memberId || members[0]?.memberId || ""
      : session?.member?.memberId || format?.ownerMemberId || editor?.ownerMemberId || "";

    return {
      targetType: format?.scope === "organization" && canManageOrgPrompts ? "organization" : "member",
      memberId: ownerMemberId
    };
  }

  function setEditorFromFormat(format) {
    const normalized = normalizeFormatForEditor(format);
    setEditor({
      ...normalized,
      customization: {
        ...normalized.customization,
        additionalInstructionsText: (normalized.customization.additionalInstructions || []).join("\n")
      }
    });
  }

  async function fetchFormatDetail(formatId, orgId = selectedOrgId) {
    const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/soap-formats/${encodeURIComponent(formatId)}`, orgId), {
      cache: "no-store"
    }, accessToken);
    const payload = await readJson(response, "プロンプト詳細を取得できませんでした。");
    const detail = payload.format;
    if (detail) {
      setFormats((current) => current.map((format) => (
        format.formatId === detail.formatId || format.profileId === detail.profileId ? { ...format, ...detail } : format
      )));
    }
    return detail;
  }

  async function selectFormatForEditor(format, options = {}) {
    if (!format) {
      setSelectedFormatId("");
      setEditor(null);
      setIsNew(false);
      setInitialNewFormatName("");
      setIsEditorDirty(false);
      return;
    }

    const formatId = format.formatId || format.profileId;
    if (options.updateTab !== false) {
      selectAdminTab("formats", { load: false });
    }
    setSelectedFormatId(formatId);
    setIsNew(false);
    setInitialNewFormatName("");
    setPreview(null);
    setPreviewState("idle");
    setPreviewError("");
    setIsEditorDirty(false);

    if (formatHasEditorDetail(format)) {
      setEditorFromFormat(format);
      return;
    }

    setEditor(null);
    setIsFormatDetailLoading(true);
    try {
      const detail = await fetchFormatDetail(formatId, options.orgId || selectedOrgId);
      if (detail) {
        setEditorFromFormat(detail);
      }
    } finally {
      setIsFormatDetailLoading(false);
    }
  }

  async function loadAdminData(targetOrgId = selectedOrgId, tabId = activeTab) {
    setIsLoading(true);
    setError("");

    try {
      const section = bootstrapSectionForTab(tabId);
      const response = await fetchWithOperatorAuth(adminApiUrl("/api/v1/admin/bootstrap", targetOrgId, {
        section,
        selectedFormatId: tabId === "formats" ? selectedFormatId : ""
      }), {
        cache: "no-store",
      }, accessToken);
      const payload = await readJson(response, "設定情報を取得できませんでした。");
      const normalizedSession = payload.session || null;
      setSession(normalizedSession);

      if (!canOpenSettingsConsole(normalizedSession)) {
        setOrganizations([]);
        setSelectedOrgId("");
        setRoleDefinitions([]);
        setFormats([]);
        setMembers([]);
        setAuditEvents([]);
        setSelectedFormatId("");
        setEditor(null);
        setIsNew(false);
        setInitialNewFormatName("");
        return;
      }

      const visibleOrganizations = payload.organizations || [];
      const nextOrgId = payload.selectedOrgId || targetOrgId || normalizedSession?.orgId || visibleOrganizations[0]?.orgId || "";
      const nextFormats = mergeFormatDetailIntoList(payload.formats || [], payload.selectedFormat);

      setOrganizations(visibleOrganizations);
      setSelectedOrgId(nextOrgId);
      setRoleDefinitions(payload.roles || []);
      setFormats(nextFormats);
      setMembers(payload.members || []);
      setAuditEvents(payload.events || []);

      if (tabId === "formats" && nextFormats.length) {
        const selected = payload.selectedFormat || nextFormats.find((format) => format.formatId === selectedFormatId) || nextFormats[0];
        await selectFormatForEditor(selected, { updateTab: false, orgId: nextOrgId });
      } else {
        setSelectedFormatId("");
        setEditor(null);
        setIsNew(false);
        setInitialNewFormatName("");
        setIsEditorDirty(false);
      }
    } catch (nextError) {
      setError(toUserFacingErrorMessage(nextError));
    } finally {
      setIsLoading(false);
    }
  }

  function mergeFormatDetailIntoList(formatList, detail) {
    if (!detail?.formatId) {
      return formatList;
    }

    const found = formatList.some((format) => format.formatId === detail.formatId);
    if (!found) {
      return [detail, ...formatList];
    }

    return formatList.map((format) => (
      format.formatId === detail.formatId ? { ...format, ...detail } : format
    ));
  }

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const initialTab = readAdminTabFromUrl();
    setActiveTab(initialTab);
    loadAdminData(selectedOrgId, initialTab);
  }, [accessToken]);

  useEffect(() => {
    function handlePopState() {
      const nextTab = readAdminTabFromUrl();
      setActiveTab(nextTab);
      if (accessToken) {
        loadAdminData(selectedOrgId, nextTab);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [accessToken, selectedOrgId]);

  useEffect(() => {
    const billingHint = readBillingFlowHintFromUrl();

    if (!billingHint) {
      return;
    }

    if (billingHint === "success") {
      setNotice("決済画面から戻りました。契約状態の反映には数秒かかることがあります。");
    } else if (billingHint === "cancel") {
      setNotice("決済は完了していません。必要であればもう一度お試しください。");
    }

    clearBillingFlowHintFromUrl();
  }, []);

  useEffect(() => {
    if (!session || !visibleAdminSections.length) {
      return;
    }

    if (
      activeTab !== SETTINGS_HOME_TAB &&
      activeTab !== FORMATS_INFER_TAB &&
      !visibleAdminSections.some((section) => section.id === activeTab)
    ) {
      selectAdminTab(SETTINGS_HOME_TAB, { replace: true });
      return;
    }

    if (activeTab === FORMATS_INFER_TAB && !canOpenFormatInference) {
      selectAdminTab(SETTINGS_HOME_TAB, { replace: true });
    }
  }, [activeTab, canOpenFormatInference, session, selectAdminTab, visibleAdminSectionIds]);

  useEffect(() => {
    if (!canOpenSettings || !visibleAdminSections.length) {
      clearAdminNav();
      return;
    }

    registerAdminNav({
      activeTab: activeTab === FORMATS_INFER_TAB ? "formats" : activeTab,
      currentPage,
      isAvailable: true,
      sections: adminNavSections,
      selectTab: selectAdminTab
    });
  }, [activeTab, canOpenSettings, clearAdminNav, currentPage, registerAdminNav, selectAdminTab, visibleAdminSectionIds]);

  useEffect(() => {
    return () => clearAdminNav();
  }, [clearAdminNav]);

  useEffect(() => {
    return () => cancelPreviewRequest();
  }, []);

  useEffect(() => {
    if (activeTab !== "formats" || !editor) {
      cancelPreviewRequest();
      setPreviewState("idle");
    }
  }, [activeTab, editor, previewTranscript, runPreview]);

  useEffect(() => {
    if (previewState !== "streaming") {
      return;
    }

    const element = previewScrollRef.current;
    if (!element) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [previewOutputText, previewState]);

  async function launchBillingAction() {
    if (!canManageBilling) {
      return;
    }

    setError("");
    setNotice("");
    setIsLaunchingBillingAction(true);

    try {
      if (canLaunchCheckout) {
        const payload = await createBillingCheckoutSession(accessToken);
        window.location.assign(payload.checkoutUrl);
        return;
      }

      if (canLaunchPortal) {
        const payload = await createBillingPortalSession(accessToken);
        window.location.assign(payload.url);
        return;
      }

      throw new Error("決済または請求管理の導線を表示できません。");
    } catch (nextError) {
      setError(toUserFacingErrorMessage(nextError, "決済画面を開けませんでした。"));
      setIsLaunchingBillingAction(false);
    }
  }

  function selectOrganization(orgId) {
    setSelectedOrgId(orgId);
    loadAdminData(orgId);
  }

  function selectFormat(format) {
    void selectFormatForEditor(format).catch((nextError) => {
      setError(toUserFacingErrorMessage(nextError));
    });
  }

  function startNewFormat() {
    const memberId = session?.member?.memberId || members[0]?.memberId || "";
    const nextDisplayName = buildUniqueNewPromptName(formats);
    const nextEditor = {
      ...createNewFormat(memberId),
      displayName: nextDisplayName
    };
    selectAdminTab("formats", { load: false });
    setSelectedFormatId("");
    setIsNew(true);
    setInitialNewFormatName(nextDisplayName);
    setPreview(null);
    setPreviewState("idle");
    setPreviewError("");
    setIsEditorDirty(true);
    setEditor({
      ...nextEditor,
      customization: {
        ...nextEditor.customization,
        additionalInstructionsText: ""
      }
    });
  }

  function openInferFormatPage() {
    setInferDisplayName(buildUniquePromptName(INFERRED_PROMPT_BASE_NAME, formats));
    setInferSamples([createInferenceSample("")]);
    setInferState("idle");
    setInferError("");
    setInferResult(null);
    selectAdminTab(FORMATS_INFER_TAB, { load: false });
  }

  function updateInferenceSample(sampleId, value) {
    setInferSamples((current) => current.map((sample) => (
      sample.id === sampleId
        ? {
            ...sample,
            value
          }
        : sample
    )));
  }

  function addInferenceSample() {
    setInferSamples((current) => [...current, createInferenceSample("")]);
  }

  function removeInferenceSample(sampleId) {
    setInferSamples((current) => {
      if (current.length <= 1) {
        return current;
      }

      return current.filter((sample) => sample.id !== sampleId);
    });
  }

  function closeInferFormatPage() {
    setInferState("idle");
    setInferError("");
    setInferResult(null);
    selectAdminTab("formats", { load: false });
  }

  function applyInferredFormatToEditor() {
    if (!inferResult?.format) {
      return;
    }

    const nextDisplayName = buildUniquePromptName(inferResult.format.displayName || inferDisplayName || INFERRED_PROMPT_BASE_NAME, formats);
    const nextFormat = {
      ...inferResult.format,
      displayName: nextDisplayName
    };
    const normalized = normalizeFormatForEditor(nextFormat);

    selectAdminTab("formats", { load: false });
    setSelectedFormatId("");
    setIsNew(true);
    setInitialNewFormatName(nextDisplayName);
    setPreview(null);
    setPreviewState("idle");
    setPreviewError("");
    setIsEditorDirty(true);
    setEditor({
      ...normalized,
      customization: {
        ...normalized.customization,
        additionalInstructionsText: (normalized.customization.additionalInstructions || []).join("\n")
      }
    });
    setNotice("カルテ例からプロンプト案を作成しました。必要に応じて調整してから保存してください。");
    closeInferFormatPage();
  }

  function saveInferredFormatDraft() {
    if (!inferResult?.format) {
      return;
    }

    const nextDisplayName = buildUniquePromptName(
      inferResult.format.displayName || inferDisplayName || INFERRED_PROMPT_BASE_NAME,
      formats
    );
    const nextFormat = {
      ...inferResult.format,
      displayName: nextDisplayName
    };

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl("/api/v1/admin/soap-formats"), {
          method: "POST",
          body: JSON.stringify(nextFormat)
        }, accessToken);
        const payload = await readJson(response, "プロンプトを保存できませんでした。");
        const savedFormat = payload.format;
        setNotice("下書きを保存しました。適用先を選択してください。");
        setIsNew(false);
        setSelectedFormatId(savedFormat.formatId);
        setFormats((current) => {
          const withoutSaved = current.filter((format) => format.formatId !== savedFormat.formatId);
          return [savedFormat, ...withoutSaved];
        });
        selectFormat(savedFormat);
        const nextApplyTarget = defaultApplyTarget(savedFormat);
        setApplyForm(nextApplyTarget);
        setPendingApplyTarget(null);
        setModalMode("prompt-apply");
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  async function runSoapFormatInference() {
    const normalizedSamples = inferSamples
      .map((sample) => sample.value.trim())
      .filter(Boolean);

    if (!normalizedSamples.length) {
      setInferError("カルテ例を少なくとも1件入力してください。");
      return;
    }

    setInferState("loading");
    setInferError("");
    setInferResult(null);

    try {
      const response = await fetchWithOperatorAuth(adminApiUrl("/api/v1/admin/soap-formats/infer"), {
        method: "POST",
        body: JSON.stringify({
          preferredDisplayName: inferDisplayName || undefined,
          samples: normalizedSamples
        })
      }, accessToken);
      const payload = await readJson(response, "カルテ例からプロンプト案を作成できませんでした。");
      setInferResult(payload);
      setInferState("ready");
    } catch (nextError) {
      setInferState("error");
      setInferError(toUserFacingErrorMessage(nextError, "カルテ例からプロンプト案を作成できませんでした。"));
    }
  }

  function updateEditor(path, value) {
    setEditor((current) => {
      if (!current) {
        return current;
      }

      const next = structuredClone(current);
      let target = next;
      for (const segment of path.slice(0, -1)) {
        target = target[segment];
      }
      target[path.at(-1)] = value;
      return next;
    });
    setIsEditorDirty(true);
  }

  function updateMemberRole(role, checked) {
    setMemberForm((current) => {
      const roles = checked
        ? Array.from(new Set([...current.roles, role]))
        : current.roles.filter((item) => item !== role);
      return {
        ...current,
        roles: roles.length ? roles : ["doctor"]
      };
    });
  }

  function updateRoleForm(role, checked) {
    setRoleForm((current) => {
      const roles = checked
        ? Array.from(new Set([...current.roles, role]))
        : current.roles.filter((item) => item !== role);
      return {
        roles: roles.length ? roles : ["doctor"]
      };
    });
  }

  function openRoleEditor(member) {
    setRoleTarget(member);
    setRoleForm({ roles: Array.isArray(member.roles) && member.roles.length ? [...member.roles] : ["doctor"] });
    setMemberActionTarget(null);
    setModalMode("member-roles");
  }

  function openPasswordReset(member) {
    setPasswordTarget(member);
    setPasswordForm({ password: "" });
    setPasswordVisible(false);
    setPasswordResetResult("");
    setMemberActionTarget(null);
    setModalMode("password");
  }

  function openMemberActionModal(member) {
    setMemberActionTarget(member);
    setModalMode("member-actions");
  }

  function memberStatusDisabledReason(member, status) {
    if (!isCurrentOrganization || !canManageCurrentMembers) {
      return "この病院の職員状態を変更する権限がありません。";
    }

    if (isSaving) {
      return "処理中です。";
    }

    if (status === "disabled" && member.memberId === session?.member?.memberId) {
      return "自分自身は停止できません。";
    }

    if (
      status === "disabled" &&
      member.status === "active" &&
      hasOrgAdminLockoutRole(member.roles || []) &&
      activeOrgAdminCount <= 1
    ) {
      return "病院内の最後の管理者は停止できません。別の管理者を追加してから操作してください。";
    }

    return "";
  }

  function requestMemberStatusChange(member, status) {
    const disabledReason = memberStatusDisabledReason(member, status);
    if (disabledReason) {
      setError(disabledReason);
      return;
    }

    setStatusTarget({ member, status });
    setMemberActionTarget(null);
    setModalMode("member-status");
  }

  function requestSecurityAction(kind, member) {
    setSecurityActionTarget({ kind, member });
    setMemberActionTarget(null);
    setModalMode("member-security-action");
  }

  function createOrganization(event) {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/admin/organizations`, {
          method: "POST",
          body: JSON.stringify(organizationForm)
        }, accessToken);
        const payload = await readJson(response, "病院を追加できませんでした。");
        setNotice(`${payload.organization.displayName}を追加しました。初期管理者も作成済みです。`);
        setModalMode(null);
        setOrganizationForm(EMPTY_ORGANIZATION_FORM);
        await loadAdminData(payload.organization.orgId);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function createMember(event) {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/admin/members`, {
          method: "POST",
          body: JSON.stringify({
            ...memberForm,
            orgId: selectedOrgId || currentOrgId
          })
        }, accessToken);
        const payload = await readJson(response, "医師を追加できませんでした。");
        setMembers((current) => [...current, payload.member]);
        setNotice(`${payload.member.displayName}を追加しました。`);
        setModalMode(null);
        setMemberForm(EMPTY_MEMBER_FORM);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function saveMemberRoles(event) {
    event.preventDefault();

    if (!roleTarget) {
      return;
    }

    if (roleTargetWouldRemoveLastAdmin) {
      setError("病院内の最後の管理者は降格できません。別の管理者を追加してから操作してください。");
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/members/${roleTarget.memberId}/roles`), {
          method: "PATCH",
          body: JSON.stringify({
            orgId: selectedOrgId || currentOrgId,
            roles: roleForm.roles
          })
        }, accessToken);
        const payload = await readJson(response, "権限を変更できませんでした。");
        setMembers((current) => current.map((member) => (member.memberId === payload.member.memberId ? payload.member : member)));
        if (payload.member.memberId === session?.member?.memberId) {
          setSession((current) => current
            ? {
                ...current,
                member: {
                  ...current.member,
                  roles: payload.member.roles,
                  mfaRequired: payload.member.mfaRequired,
                  mfaEnrolledAt: payload.member.mfaEnrolledAt
                }
              }
            : current);
        }
        setNotice(`${payload.member.displayName}の権限を変更しました。`);
        setModalMode(null);
        setRoleTarget(null);
        setRoleForm({ roles: ["doctor"] });
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function updateMemberDefaultRecordingSource(member, defaultRecordingSource) {
    if (!member?.memberId) {
      return;
    }

    const nextSource = normalizeRecordingSource(defaultRecordingSource);
    setSavingMemberPreferenceIds((current) => new Set([...current, member.memberId]));
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/members/${member.memberId}/preferences`), {
          method: "PATCH",
          body: JSON.stringify({
            orgId: selectedOrgId || currentOrgId,
            defaultRecordingSource: nextSource
          })
        }, accessToken);
        const payload = await readJson(response, "ふだん使う録音方法を保存できませんでした。");
        setMembers((current) => {
          const exists = current.some((item) => item.memberId === payload.member.memberId);
          if (!exists) {
            return current;
          }
          return current.map((item) => (item.memberId === payload.member.memberId ? payload.member : item));
        });
        if (payload.member.memberId === session?.member?.memberId) {
          setSession((current) => current
            ? {
                ...current,
                member: {
                  ...current.member,
                  defaultRecordingSource: payload.member.defaultRecordingSource
                }
              }
            : current);
        }
        setNotice("ふだん使う録音方法を保存しました。");
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setSavingMemberPreferenceIds((current) => {
          const next = new Set(current);
          next.delete(member.memberId);
          return next;
        });
      }
    });
  }

  function updateOrganizationRecordingMaxDurationMinutes(nextValue) {
    if (!selectedOrganization?.orgId) {
      return;
    }

    const recordingMaxDurationMinutes = normalizeRecordingMaxDurationMinutes(nextValue);
    setIsSavingRecordingPolicy(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(
          `/api/v1/admin/organizations/${encodeURIComponent(selectedOrganization.orgId)}/recording-policy`,
          selectedOrganization.orgId
        ), {
          method: "PATCH",
          body: JSON.stringify({
            orgId: selectedOrganization.orgId,
            recordingMaxDurationMinutes
          })
        }, accessToken);
        const payload = await readJson(response, "録音の自動停止設定を保存できませんでした。");
        setOrganizations((current) => current.map((organization) => (
          organization.orgId === payload.organization.orgId ? payload.organization : organization
        )));
        setNotice("録音の自動停止設定を保存しました。");
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSavingRecordingPolicy(false);
      }
    });
  }

  function resetPassword(event) {
    event.preventDefault();

    if (!passwordTarget) {
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(`${getGatewayBaseUrl()}/api/v1/admin/members/${passwordTarget.memberId}/password`, {
          method: "POST",
          body: JSON.stringify({
            orgId: selectedOrgId || currentOrgId,
            password: passwordForm.password
          })
        }, accessToken);
        const payload = await readJson(response, "ログイン用パスワードを再設定できませんでした。");
        setMembers((current) => current.map((member) => (member.memberId === payload.member.memberId ? payload.member : member)));
        setNotice(`${payload.member.displayName}のログイン用パスワードを再設定しました。`);
        setPasswordResetResult("新しいログイン用パスワードを本人に安全な経路で伝達してください。この画面を閉じると再表示できません。");
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function fillGeneratedPassword() {
    setPasswordForm({ password: generateSecurePassword() });
    setPasswordVisible(true);
    setPasswordResetResult("");
  }

  function copyPasswordToClipboard() {
    if (!passwordForm.password) {
      return;
    }

    navigator.clipboard?.writeText(passwordForm.password).then(() => {
      setNotice("ログイン用パスワードをコピーしました。");
    }).catch(() => {
      setError("クリップボードにコピーできませんでした。");
    });
  }

  function updateMemberStatus(member, status, options = {}) {
    if (!member?.memberId) {
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/members/${member.memberId}/status`), {
          method: "PATCH",
          body: JSON.stringify({
            orgId: selectedOrgId || currentOrgId,
            status
          })
        }, accessToken);
        const payload = await readJson(response, "職員状態を変更できませんでした。");
        setMembers((current) => current.map((item) => (item.memberId === payload.member.memberId ? payload.member : item)));
        setNotice(status === "active" ? `${payload.member.displayName}を再開しました。` : `${payload.member.displayName}を停止しました。`);
        if (options.closeModal) {
          setModalMode(null);
          setStatusTarget(null);
        }
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function revokeMemberSessions(member) {
    if (!member?.memberId) {
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/members/${member.memberId}/revoke-sessions`), {
          method: "POST",
          body: JSON.stringify({
            orgId: selectedOrgId || currentOrgId
          })
        }, accessToken);
        await readJson(response, "強制ログアウトできませんでした。");
        setNotice(`${member.displayName}を強制ログアウトしました。`);
        if (member.memberId === session?.member?.memberId) {
          clearAccess();
        }
        setModalMode(null);
        setSecurityActionTarget(null);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function resetMemberMfa(member) {
    if (!member?.memberId) {
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/members/${member.memberId}/mfa-reset`), {
          method: "POST",
          body: JSON.stringify({
            orgId: selectedOrgId || currentOrgId
          })
        }, accessToken);
        const payload = await readJson(response, "2段階認証をリセットできませんでした。");
        setMembers((current) => current.map((item) => (item.memberId === payload.member.memberId ? payload.member : item)));
        setNotice(`${payload.member.displayName}の2段階認証をリセットしました。`);
        if (member.memberId === session?.member?.memberId) {
          clearAccess();
        }
        setModalMode(null);
        setSecurityActionTarget(null);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function saveDraft(options = {}) {
    if (!editor) {
      return;
    }

    const duplicate = findDuplicatePromptName(formats, editor.displayName, selectedFormatId);

    if (!normalizePromptDisplayNameKey(editor.displayName)) {
      setError("プロンプト名を入力してください。");
      return;
    }

    if (duplicate) {
      setError("同じ名前のプロンプトが既にあります。別の名前にしてください。");
      return;
    }

    if (
      isNew &&
      !options.skipDefaultNameWarning &&
      initialNewFormatName &&
      normalizePromptDisplayNameKey(editor.displayName) === normalizePromptDisplayNameKey(initialNewFormatName)
    ) {
      setModalMode("prompt-name-confirm");
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const url = isNew
          ? adminApiUrl("/api/v1/admin/soap-formats")
          : adminApiUrl(`/api/v1/admin/soap-formats/${selectedFormatId}/draft`);
        const response = await fetchWithOperatorAuth(url, {
          method: "POST",
          body: JSON.stringify(buildPayload(editor))
        }, accessToken);
        const payload = await readJson(response, "プロンプトを保存できませんでした。");
        const savedFormat = payload.format;
        setNotice("下書きを保存しました。適用先を選択してください。");
        setIsNew(false);
        setSelectedFormatId(savedFormat.formatId);
        setFormats((current) => {
          const withoutSaved = current.filter((format) => format.formatId !== savedFormat.formatId);
          return [savedFormat, ...withoutSaved];
        });
        selectFormat(savedFormat);
        const nextApplyTarget = defaultApplyTarget(savedFormat);
        setApplyForm(nextApplyTarget);
        setPendingApplyTarget(null);
        setModalMode("prompt-apply");
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  async function applyPublishedPrompt(formatId, target) {
    if (!target) {
      return;
    }

    const body = target.targetType === "organization"
      ? { targetType: "organization", formatId }
      : { targetType: "member", memberId: target.memberId, formatId };
    const response = await fetchWithOperatorAuth(adminApiUrl("/api/v1/admin/soap-format-assignments"), {
      method: "POST",
      body: JSON.stringify(body)
    }, accessToken);
    const payload = await readJson(response, "プロンプトの適用先を更新できませんでした。");

    if (payload.member) {
      setMembers((current) => current.map((member) => (member.memberId === payload.member.memberId ? payload.member : member)));
    }

    if (payload.organization) {
      setOrganizations((current) => current.map((organization) => (organization.orgId === payload.organization.orgId ? payload.organization : organization)));
    }
  }

  function publishFormat(options = {}) {
    if (!selectedFormatId || isNew) {
      return;
    }

    const target = options?.target?.targetType ? options.target : null;

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/soap-formats/${selectedFormatId}/publish`), {
          method: "POST",
          body: JSON.stringify({})
        }, accessToken);
        const payload = await readJson(response, "プロンプトを公開できませんでした。");
        await applyPublishedPrompt(payload.format.formatId, target);
        setNotice(target ? "プロンプトを公開し、選択した適用先へ反映しました。" : "プロンプトを公開しました。次に作成する診療から利用できます。");
        setFormats((current) => current.map((format) => (format.formatId === payload.format.formatId ? payload.format : format)));
        selectFormat(payload.format);
        setModalMode(null);
        setPendingApplyTarget(null);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function applyPromptTarget() {
    const normalizedApplyForm = canManageCurrentMembers
      ? applyForm
      : { targetType: "member", memberId: session?.member?.memberId || "" };

    if (normalizedApplyForm.targetType === "member" && !normalizedApplyForm.memberId) {
      setError("適用先の職員を選択してください。");
      return;
    }

    if (!selectedFormatId || isNew) {
      setError("適用先を決める前に、まず下書きを保存してください。");
      return;
    }

    setError("");
    setIsSaving(true);

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/soap-formats/${selectedFormatId}/draft`), {
          method: "POST",
          body: JSON.stringify({
            scope: normalizedApplyForm.targetType === "organization" ? "organization" : "member",
            ownerMemberId: normalizedApplyForm.targetType === "member" ? normalizedApplyForm.memberId : null
          })
        }, accessToken);
        const payload = await readJson(response, "プロンプトの適用先を保存できませんでした。");
        setFormats((current) => current.map((format) => (format.formatId === payload.format.formatId ? payload.format : format)));
        selectFormat(payload.format);
        setPendingApplyTarget(normalizedApplyForm);
        setModalMode("prompt-publish-choice");
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function closePromptAsDraft() {
    setModalMode(null);
    setPendingApplyTarget(null);
    setNotice("下書きとして保存しました。公開するまで診療には反映されません。");
  }

  function archiveFormat() {
    if (!selectedFormatId || isNew) {
      return;
    }

    setIsSaving(true);
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl(`/api/v1/admin/soap-formats/${selectedFormatId}/archive`), {
          method: "POST",
          body: JSON.stringify({})
        }, accessToken);
        const payload = await readJson(response, "プロンプトを公開停止できませんでした。");
        setNotice("プロンプトを公開停止しました。割当中の職員は病院標準に戻しました。");
        setFormats((current) => current.map((format) => (format.formatId === payload.format.formatId ? payload.format : format)));
        setMembers((current) =>
          current.map((member) =>
            member.defaultPromptProfileId === payload.format.formatId
              ? { ...member, defaultPromptProfileId: "system-default" }
              : member
          )
        );
        setModalMode(null);
        selectFormat(payload.format);
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setIsSaving(false);
      }
    });
  }

  function updateMemberPromptAssignment(member, formatId) {
    if (!member?.memberId) {
      return;
    }

    setSavingPromptAssignmentIds((current) => new Set([...current, member.memberId]));
    setError("");
    setNotice("");

    startTransition(async () => {
      try {
        const response = await fetchWithOperatorAuth(adminApiUrl("/api/v1/admin/soap-format-assignments"), {
          method: "POST",
          body: JSON.stringify({
            targetType: "member",
            memberId: member.memberId,
            formatId
          })
        }, accessToken);
        const payload = await readJson(response, "職員へのプロンプト割当を更新できませんでした。");
        setMembers((current) => current.map((member) => (member.memberId === payload.member.memberId ? payload.member : member)));
        setNotice("プロンプト割当を保存しました。");
      } catch (nextError) {
        setError(toUserFacingErrorMessage(nextError));
      } finally {
        setSavingPromptAssignmentIds((current) => {
          const next = new Set(current);
          next.delete(member.memberId);
          return next;
        });
      }
    });
  }

  if (!isHydrated) {
    return <main className="admin-shell"><div className="skeleton skeleton-block" /></main>;
  }

  if (!accessToken) {
    return (
      <OperatorLoginPanel
        onAuthenticated={setAccessToken}
        title="設定にログイン"
        description="病院、権限、プロンプトを設定するにはログインしてください。"
      />
    );
  }

  if (isLoading && !session) {
    return (
      <main className="admin-shell admin-shell--console">
        <section className="admin-layout-grid">
          <section className="admin-content">
            <div className="admin-page-header admin-loading-shell">
              <div className="skeleton skeleton-heading" style={{ width: 220 }} />
              <div className="skeleton skeleton-text" style={{ width: 360 }} />
            </div>
            <div className="admin-loading-grid">
              <section className="card admin-loading-pane">
                <div className="skeleton skeleton-heading" style={{ width: 180 }} />
                <div className="skeleton skeleton-block" />
                <div className="skeleton skeleton-block" />
              </section>
              <section className="card admin-loading-pane">
                <div className="skeleton skeleton-heading" style={{ width: 220 }} />
                <div className="skeleton skeleton-block" />
                <div className="skeleton skeleton-block" />
              </section>
            </div>
          </section>
        </section>
      </main>
    );
  }

  if (!canOpenSettings) {
    return (
      <main className="admin-shell admin-access-denied">
        <section className="admin-denied-card">
          <span className="label">権限が必要です</span>
          <h1>設定を開けません</h1>
          <p>この画面はログイン済みの職員だけが利用できます。</p>
          <a className="btn btn--primary" href="/">診療一覧へ戻る</a>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-shell admin-shell--console">
      <section className="admin-layout-grid">
        <section className="admin-content">
          <header className="admin-page-header">
            <div className="admin-page-title-row">
              <div>
                <h1>{currentPage.label}</h1>
                <p>{currentPage.description}</p>
              </div>
              {showPageActions ? (
                <div className="admin-page-actions">
                  {showHeaderOrgSwitcher ? (
                    <div className="admin-org-switcher admin-org-switcher--page">
                      <span>医療機関</span>
                      {canManagePlatformSettings && organizations.length > 1 ? (
                        <select value={selectedOrgId} onChange={(event) => selectOrganization(event.target.value)} aria-label="病院を選択">
                          {organizations.map((organization) => (
                            <option key={organization.orgId} value={organization.orgId}>{organization.displayName}</option>
                          ))}
                        </select>
                      ) : (
                        <strong>{selectedOrganization?.displayName || "未選択"}</strong>
                      )}
                    </div>
                  ) : null}
                  {showMembersPageActions && canManagePlatformSettings ? (
                    <button className="btn btn--ghost" type="button" onClick={() => { setOrganizationForm(EMPTY_ORGANIZATION_FORM); setModalMode("organization"); }}>
                      病院を追加
                    </button>
                  ) : null}
                  {showMembersPageActions && canManageCurrentMembers ? (
                    <button className="btn btn--primary" type="button" onClick={() => { setMemberForm(EMPTY_MEMBER_FORM); setModalMode("member"); }}>
                      職員を追加
                    </button>
                  ) : null}
                  {showFormatsPageAction ? (
                    <>
                      <button className="btn btn--ghost" type="button" onClick={openInferFormatPage}>普段のカルテから作成</button>
                      <button className="btn btn--primary" type="button" onClick={startNewFormat}>プロンプトを作成</button>
                    </>
                  ) : null}
                  {showFormatsInferPageAction ? (
                    <button className="btn btn--ghost" type="button" onClick={() => selectAdminTab("formats")}>
                      プロンプト設定へ戻る
                    </button>
                  ) : null}
                  {showAuditPageAction ? (
                    <button className="btn btn--ghost" type="button" onClick={() => loadAdminData()} disabled={isLoading}>再読み込み</button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </header>

          {(error || notice) ? (
            <div className="toast-container admin-toast-container" aria-live="polite">
              {error ? (
                <div className="toast toast--error" role="status">
                  <span className="toast-message">{error}</span>
                  <button className="toast-close-button" type="button" onClick={() => setError("")} aria-label="通知を閉じる"><Icon name="x" size={14} /></button>
                </div>
              ) : null}
              {notice ? (
                <div className="toast toast--success" role="status">
                  <span className="toast-message">{notice}</span>
                  <button className="toast-close-button" type="button" onClick={() => setNotice("")} aria-label="通知を閉じる"><Icon name="x" size={14} /></button>
                </div>
              ) : null}
            </div>
          ) : null}

          {activeTab === SETTINGS_HOME_TAB ? (
            <div className="settings-home">
              {Array.from(new Set(visibleAdminSections.map((section) => section.group))).map((group) => (
                <section className="settings-home-group" key={group}>
                  <h2>{group}</h2>
                  <div className="settings-home-list">
                    {visibleAdminSections.filter((section) => section.group === group).map((section) => (
                      <button className="settings-home-item" key={section.id} type="button" onClick={() => selectAdminTab(section.id)}>
                        <span className="settings-home-copy">
                          <strong>{section.label}</strong>
                          <small>{section.description}</small>
                        </span>
                        <span className="settings-home-open">開く</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}

          {activeTab === "members" ? (
            <div className="admin-stack">
              <section className="card admin-table-card">
                <div className="admin-filter-bar">
                  <label className="admin-search-field">
                    <span>検索</span>
                    <input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="氏名・個人ID・録音方法・プロンプト名で検索" />
                  </label>
                  <div className="admin-filter-actions">
                    {isLoading ? <span className="badge badge--finalizing">同期中</span> : null}
                    <span className="admin-count-pill">{filteredMembers.length}名</span>
                  </div>
                </div>
                <div className="data-table admin-member-table">
                  <div className="data-table-row data-table-head">
                    <span>氏名</span>
                    <span>個人ID</span>
                    <span>権限</span>
                    <span>録音方法</span>
                    <span>プロンプト</span>
                    <span>操作</span>
                  </div>
                  {filteredMembers.map((member) => {
                    const roleItems = Array.from(new Set(member.roles || []))
                      .sort((left, right) => (roleDefinitionById.get(left)?.sortOrder || 999) - (roleDefinitionById.get(right)?.sortOrder || 999))
                      .map((role) => {
                        const definition = roleDefinitionById.get(role);
                        return {
                          role,
                          label: displayRoleLabel(role),
                          category: definition?.category || "custom"
                        };
                      });
                    const roleTitle = roleItems.length ? roleItems.map((role) => role.label).join("、") : "権限未設定";
                    const currentPromptId = member.defaultPromptProfileId || "system-default";
                    const memberPromptOptions = promptAssignmentOptions.some((option) => option.value === currentPromptId)
                      ? promptAssignmentOptions
                      : [
                          ...promptAssignmentOptions,
                          {
                            value: currentPromptId,
                            label: assignedFormatName(member, formats),
                            description: "現在割り当て中のプロンプトです。"
                          }
                        ];
                    return (
                      <div className="data-table-row admin-member-row" key={member.memberId}>
                        <div data-label="氏名">
                          <strong>{member.displayName}</strong>
                          <small>
                            {member.status === "active" ? "利用中" : "停止中"}
                            {member.mfaRequired ? ` / 2段階認証 ${member.mfaEnrolledAt ? "登録済み" : "未登録"}` : ""}
                          </small>
                        </div>
                        <span className="mono-value" data-label="個人ID">{member.loginId}</span>
                        <div className="member-role-summary" data-label="権限" title={roleTitle} aria-label={`権限: ${roleTitle}`}>
                          {roleItems.length ? (
                            <div className="member-role-chip-list">
                              {roleItems.map((role) => (
                                <span className={`member-role-chip ${roleCategoryClass(role.category)}`} key={role.role}>
                                  {role.label}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="member-role-chip member-role-chip--custom">権限未設定</span>
                          )}
                        </div>
                        <div className="member-recording-source" data-label="録音方法">
                          <AdminSelect
                            value={normalizeRecordingSource(member.defaultRecordingSource)}
                            onValueChange={(nextValue) => updateMemberDefaultRecordingSource(member, nextValue)}
                            options={MEMBER_RECORDING_SOURCE_OPTIONS}
                            disabled={!isCurrentOrganization || !canManageCurrentMembers}
                            isSaving={savingMemberPreferenceIds.has(member.memberId)}
                            ariaLabel={`${member.displayName}のふだん使う録音方法`}
                          />
                        </div>
                        <div className="member-prompt-assignment" data-label="プロンプト" title={assignedFormatName(member, formats)}>
                          <AdminSelect
                            value={currentPromptId}
                            onValueChange={(nextValue) => updateMemberPromptAssignment(member, nextValue)}
                            options={memberPromptOptions}
                            disabled={!isCurrentOrganization || !canManageCurrentMembers}
                            isSaving={savingPromptAssignmentIds.has(member.memberId)}
                            ariaLabel={`${member.displayName}のプロンプト割当`}
                          />
                        </div>
                        <div className="row-action-group" data-label="操作">
                          <button className="btn btn--ghost" type="button" onClick={() => openRoleEditor(member)} disabled={!isCurrentOrganization || !canManageCurrentMembers}>
                            権限変更
                          </button>
                          <button className="btn btn--ghost" type="button" onClick={() => openMemberActionModal(member)}>
                            その他
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {!filteredMembers.length ? <p className="empty-note">条件に一致する職員はありません。</p> : null}
                </div>
              </section>
            </div>
          ) : null}

          {activeTab === "audio-test" ? (
            <AudioTestPanel
              orgId={selectedOrganization?.orgId || currentOrgId}
              memberId={session?.member?.memberId || currentMember?.memberId}
              accessToken={accessToken}
              onAuthExpired={clearAccess}
            />
          ) : null}

          {activeTab === "formats" ? (
            <div className="admin-stack">
              <div className="template-workbench">
                <aside className="card template-list-pane">
                  <label className="admin-search-field">
                    <span>検索</span>
                    <input value={formatSearch} onChange={(event) => setFormatSearch(event.target.value)} placeholder="プロンプト名で検索" />
                  </label>
                  <div className="format-list">
                    {filteredFormats.map((format) => (
                      <button
                        key={format.formatId}
                        className={`format-list-item ${selectedFormatId === format.formatId ? "is-selected" : ""}`}
                        type="button"
                        onClick={() => selectFormat(format)}
                      >
                        <span className="status-dot-wrap">
                          <i className={`status-dot ${formatStatusClass(format)}`} aria-hidden="true" />
                          <strong>{format.displayName}</strong>
                        </span>
                        <small>{formatScope(format.scope)} ・ {formatStatus(format)}</small>
                      </button>
                    ))}
                    {!filteredFormats.length ? <p className="empty-note">条件に一致するプロンプトはありません。</p> : null}
                  </div>
                </aside>

                <div className="template-editor-column">
                  <section className="card template-editor-pane">
                    {isFormatDetailLoading ? (
                      <div className="empty-state">
                        <div className="skeleton skeleton-heading" style={{ width: 220 }} />
                        <div className="skeleton skeleton-block" />
                      </div>
                    ) : !editor ? (
                      <div className="empty-state">
                        <h2>プロンプトを選択してください</h2>
                        <p>プロンプトを作成すると、医師ごとに診療記録の完成形を変えられます。</p>
                      </div>
                    ) : (
                      <>
                        <div className="template-editor-head">
                          <div>
                            <h2>{isNew ? "新しいプロンプト" : editor.displayName}</h2>
                            <p>{formatScope(editor.scope)} ・ {editorStatusText}</p>
                          </div>
                        </div>
                        <div className="template-editor-body">
                          <label className="full-field prompt-name-field">
                            <span>プロンプト名</span>
                            <input
                              aria-invalid={Boolean(promptNameError)}
                              required
                              value={editor.displayName}
                              onChange={(event) => updateEditor(["displayName"], event.target.value)}
                            />
                            {promptNameError ? (
                              <small className="field-error">{promptNameError}</small>
                            ) : (
                              <small>同じ病院内で同じ名前は使えません。</small>
                            )}
                          </label>
                          <label className="full-field output-template-field">
                            <span>プロンプト本文</span>
                            <textarea
                              rows={24}
                              value={editor.outputTemplate || ""}
                              onChange={(event) => updateEditor(["outputTemplate"], event.target.value)}
                              placeholder="診療記録に含めたい見出し、出力例、文体を入力してください。"
                            />
                            <small>診療記録に含めたい見出し、出力例、文体を入力してください。出力例は文体と粒度の参考として使われ、会話にない事実は出力されません。</small>
                          </label>
                        </div>
                      </>
                    )}
                  </section>

                  {editor ? (
                    <section className="card template-preview-section">
                      <div className="template-preview-head">
                        <div>
                          <h2>作成例の確認</h2>
                          <p>編集中のプロンプトをそのまま使い、会話例から生成される診療記録を確認できます。</p>
                        </div>
                        <button
                          className="btn btn--ghost"
                          type="button"
                          onClick={() => void runPreview({ force: true })}
                          disabled={isPreviewRunning || !editor}
                        >
                          <span>{isPreviewRunning ? "生成中..." : "出力例を作成"}</span>
                        </button>
                      </div>
                      <div className="template-preview-grid">
                        <label className="full-field">
                          <span>会話例</span>
                          <textarea rows={12} value={previewTranscript} onChange={(event) => setPreviewTranscript(event.target.value)} />
                          <small>変更後は「出力例を作成」を押すと更新されます。</small>
                        </label>
                        {isPreviewRunning ? (
                          <div className="template-preview-processing-shell">
                            <div className="transcript-processing-card">
                              <div className="transcript-processing-title">
                                <span className="badge badge--finalizing">処理中</span>
                                <strong>出力例を作成しています</strong>
                              </div>
                              <div className="transcript-processing-steps">
                                <div className="transcript-processing-step transcript-processing-step--done">
                                  <span className="transcript-processing-step-icon"><Icon name="check" size={12} /></span>
                                  <span>会話例を確認</span>
                                </div>
                                <div className="transcript-processing-step transcript-processing-step--active">
                                  <span className="transcript-processing-step-icon"><span className="transcript-mode-badge__spinner" aria-hidden="true" /></span>
                                  <span>プロンプトを適用中</span>
                                </div>
                                <div className="transcript-processing-step">
                                  <span className="transcript-processing-step-icon"><Icon name="fileText" size={12} /></span>
                                  <span>出力例を整形中</span>
                                </div>
                              </div>
                            </div>
                            {previewOutputText ? (
                              <div className="preview-note preview-note--full preview-note--streaming" ref={previewScrollRef}>
                                <pre>{previewOutputText}</pre>
                              </div>
                            ) : (
                              <div className="preview-note preview-note--full preview-note--loading">
                                <div className="skeleton skeleton-heading" style={{ width: "46%" }} />
                                <div className="skeleton skeleton-text" />
                                <div className="skeleton skeleton-text" />
                                <div className="skeleton skeleton-text" style={{ width: "72%" }} />
                              </div>
                            )}
                          </div>
                        ) : previewOutputText ? (
                          <div className="preview-note preview-note--full preview-note--streaming" ref={previewScrollRef}>
                            <pre>{previewOutputText || "出力なし"}</pre>
                          </div>
                        ) : previewError ? (
                          <p className="empty-note empty-note--error">{previewError}</p>
                        ) : (
                          <p className="empty-note">「出力例を作成」を押すと、ここに生成結果を表示します。</p>
                        )}
                      </div>
                    </section>
                  ) : null}

                  {editor ? (
                    <div className="template-action-bar">
                      <div className="editor-state">
                        <i className={`status-dot ${isNew || isEditorDirty ? "is-draft" : formatStatusClass(selectedFormat || {})}`} aria-hidden="true" />
                        <span>{editorStatusText}</span>
                        <small>{isNew ? "保存前でも出力例は確認できます。公開すると次回以降の診療記録作成に反映されます。" : "公開すると次回以降の診療記録作成に反映されます。"}</small>
                      </div>
                      <div className="template-action-buttons">
                        {selectedFormat?.formatId !== "system-default" && selectedFormat?.status === "active" && selectedFormat?.approved ? (
                          <button className="btn btn--danger" type="button" onClick={() => setModalMode("archive-format")} disabled={isSaving || isNew}>
                            公開停止
                          </button>
                        ) : null}
                        <button className="btn btn--primary" type="button" onClick={() => saveDraft()} disabled={isSaving || !editor || Boolean(promptNameError)}>下書きを保存</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === FORMATS_INFER_TAB ? (
            <div className="admin-stack">
              <section className="card admin-table-card prompt-infer-page-card">
                <div className="prompt-infer-page-grid">
                  <div className="prompt-infer-page-main">
                    <label className="prompt-infer-form-field">
                      <span>下書き名</span>
                      <input
                        className="prompt-infer-name-input"
                        value={inferDisplayName}
                        onChange={(event) => setInferDisplayName(event.target.value)}
                        placeholder="例: 内科カルテ標準"
                      />
                    </label>

                    <div className="prompt-infer-samples-head">
	                  <div className="prompt-infer-samples-copy">
	                    <strong>カルテ例</strong>
	                    <small>3件以上あると、よく使う見出しや書き方を見つけやすくなります。</small>
	                  </div>
                      <button className="btn btn--ghost" type="button" onClick={addInferenceSample}>サンプルを追加</button>
                    </div>

                    <div className="prompt-infer-sample-list">
                      {inferSamples.map((sample, index) => (
                        <div className="prompt-infer-sample-card" key={sample.id}>
                          <div className="prompt-infer-sample-card-head">
                            <span>カルテ例 {index + 1}</span>
                            {inferSamples.length > 1 ? (
                              <button className="btn btn--ghost btn--sm" type="button" onClick={() => removeInferenceSample(sample.id)}>削除</button>
                            ) : null}
                          </div>
                          <textarea
                            className="editor-textarea prompt-infer-sample-textarea"
                            rows={14}
                            value={sample.value}
                            onChange={(event) => updateInferenceSample(sample.id, event.target.value)}
                            placeholder="完成済みカルテを貼り付けてください。患者名や住所など、個人が分かる情報は消してください。"
                          />
                        </div>
                      ))}
                    </div>

                    <div className="prompt-infer-run">
                      <button
                        className="btn btn--primary"
                        type="button"
                        onClick={runSoapFormatInference}
                        disabled={isInferringFormat}
                      >
                        <span>{isInferringFormat ? "プロンプト案を作成中..." : "プロンプト案を作成"}</span>
                      </button>
                    </div>

                    {inferError ? <p className="empty-note empty-note--error">{inferError}</p> : null}
                  </div>

                  <div className="prompt-infer-page-side">
                    <div className="prompt-infer-output-shell">
                      <div className="prompt-infer-output-head">
                        <span>推定されたプロンプト案</span>
                      </div>
                      {isInferringFormat ? (
                        <div className="prompt-infer-result">
                          <div className="transcript-processing-card">
                            <div className="transcript-processing-title">
                              <span className="badge badge--finalizing">処理中</span>
                              <strong>プロンプト案を作成しています</strong>
                            </div>
                            <div className="transcript-processing-steps">
                              <div className="transcript-processing-step transcript-processing-step--done">
                                <span className="transcript-processing-step-icon"><Icon name="check" size={12} /></span>
                                <span>カルテ例を確認</span>
                              </div>
                              <div className="transcript-processing-step transcript-processing-step--active">
                                <span className="transcript-processing-step-icon"><span className="transcript-mode-badge__spinner" aria-hidden="true" /></span>
                                <span>よく使う見出しを確認中</span>
                              </div>
                              <div className="transcript-processing-step">
                                <span className="transcript-processing-step-icon"><Icon name="fileText" size={12} /></span>
                                <span>プロンプト案を整えています</span>
                              </div>
                            </div>
                          </div>
                          <div className="preview-note preview-note--full preview-note--loading">
                            <div className="skeleton skeleton-heading" style={{ width: "48%" }} />
                            <div className="skeleton skeleton-text" />
                            <div className="skeleton skeleton-text" />
                            <div className="skeleton skeleton-text" style={{ width: "78%" }} />
                            <div className="skeleton skeleton-text" style={{ width: "63%" }} />
                          </div>
                        </div>
                      ) : inferResult ? (
                        <div className="prompt-infer-result">
                          <textarea
                            className="editor-textarea prompt-infer-output-textarea"
                            rows={14}
                            value={inferResult.format?.outputTemplate || ""}
                            readOnly
                          />
                          <div className="prompt-infer-run">
                            <button
                              className="btn btn--primary"
                              type="button"
                              onClick={saveInferredFormatDraft}
                              disabled={!inferResult?.format || isSaving}
                            >
                              <span>下書きを保存</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="prompt-infer-output-empty">
                          カルテ例を入力して「プロンプト案を作成」を押すと、ここにプロンプト案を表示します。
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </div>
          ) : null}

          {activeTab === "audit" ? (
            <section className="card admin-audit-card">
              <div className="admin-filter-bar">
                <label className="admin-search-field">
                  <span>種別</span>
                  <select value={auditTypeFilter} onChange={(event) => setAuditTypeFilter(event.target.value)}>
                    <option value="">すべて</option>
                    {auditTypes.map((type) => <option key={type} value={type}>{eventLabel(type)}</option>)}
                  </select>
                </label>
                <span className="admin-count-pill">{filteredAuditEvents.length}件</span>
              </div>
              <div className="audit-timeline">
                {groupedAuditEvents.map((group) => (
                  <section className="timeline-group" key={group.label}>
                    <h2>{group.label}</h2>
                    {group.events.map((event) => (
                      <article className="timeline-item" key={event.eventId}>
                        <i className={`status-dot ${eventTone(event.type)}`} aria-hidden="true" />
                        <time>{event.createdAt ? new Date(event.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</time>
                        <div>
                          <strong>{eventLabel(event.type)}</strong>
                          <small>実行者: {actorLabel(event, members, session)}</small>
                        </div>
                      </article>
                    ))}
                  </section>
                ))}
                {!filteredAuditEvents.length ? <p className="empty-note">表示できる監査ログはまだありません。</p> : null}
              </div>
            </section>
          ) : null}

          {activeTab === "account" ? (
            <div className="admin-stack">
              <div className="admin-stats-grid">
                <div className="card admin-stat-card">
                  <span>医療機関</span>
                  <h3>{selectedOrganization?.displayName || session?.organization?.displayName || "未選択"}</h3>
                  <dl>
                    <div><dt>病院コード</dt><dd>{selectedOrganization?.organizationCode || session?.organization?.organizationCode || "-"}</dd></div>
                    <div><dt>職員</dt><dd>{session?.member?.displayName || "職員"}</dd></div>
                  </dl>
                </div>
                <div className="card admin-stat-card">
                  <span>権限</span>
                  <div className="role-chip-list">
                    {(session?.member?.roles || []).map((role) => <span className="role-chip" key={role}>{displayRoleLabel(role)}</span>)}
                  </div>
                  <p>表示される設定項目は、この権限に応じて変わります。</p>
                </div>
              </div>
              {accountBilling ? (
                <section className="card admin-table-card admin-settings-group-card">
                  <div className="admin-settings-row">
                    <div className="editor-state editor-state--block">
                      <span>契約状態</span>
                      <small>{accountBillingBanner ? `${accountBillingBanner.title} ${accountBillingBanner.body}` : "現在の契約状態と継続利用の設定です。"}</small>
                    </div>
                    <div className="admin-settings-row-actions">
                      <span className={`badge ${billingBadgeClass(accountBillingDisplayState.status || accountBilling.status)}`}>{formatBillingStatus(accountBillingDisplayState.status || accountBilling.status)}</span>
                      {canManageBilling && (canLaunchCheckout || canLaunchPortal) ? (
                        <button
                          className="btn btn--primary"
                          type="button"
                          onClick={launchBillingAction}
                          disabled={isLaunchingBillingAction}
                        >
                          <span>{getBillingActionLabel({ billing: accountBilling, access: accountAccess })}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="admin-settings-row">
                    <div className="editor-state editor-state--block">
                      <span>利用状態</span>
                      <small>
                        {trialDaysRemaining == null
                          ? "無料利用期間の終了日時は未設定です。"
                          : trialDaysRemaining > 0
                            ? `無料利用期間の終了まであと${trialDaysRemaining}日です。`
                            : "無料利用期間は終了しています。"}
                      </small>
                    </div>
                    <div className="admin-settings-row-meta">
                      <span className={`badge ${accessBadgeClass(accountDisplayAccess?.status)}`}>{formatAccessStatus(accountDisplayAccess?.status)}</span>
                      <strong>{formatBillingDateTime(accountBillingDisplayState.trialEndsAt)}</strong>
                    </div>
                  </div>
                </section>
              ) : null}
              <section className="card admin-table-card admin-settings-group-card">
                <div className="admin-settings-row">
                  <div className="editor-state">
                    <span>ふだん使う録音方法</span>
                    <small>新しい診療記録を作成した時に、最初に選ばれる録音方法です。</small>
                  </div>
                  <select
                    className="account-preference-select"
                    value={currentMemberDefaultRecordingSource}
                    onChange={(event) => updateMemberDefaultRecordingSource(currentMember, event.target.value)}
                    disabled={!currentMember || savingMemberPreferenceIds.has(currentMember?.memberId)}
                    aria-label="自分のふだん使う録音方法"
                  >
                    <option value="linked_mobile">スマホで録音</option>
                    <option value="local_browser">このパソコンで録音</option>
                  </select>
                </div>
                <div className="admin-settings-row">
                  <div className="editor-state">
                    <span>録音の自動停止</span>
                    <small>切り忘れ対策として、録音開始から指定時間で自動停止します。</small>
                  </div>
                  <select
                    className="account-preference-select"
                    value={organizationRecordingMaxDurationMinutes}
                    onChange={(event) => updateOrganizationRecordingMaxDurationMinutes(event.target.value)}
                    disabled={!selectedOrganization || (!canManageOrgSettings && !canManagePlatformSettings) || isSavingRecordingPolicy}
                    aria-label="録音の自動停止時間"
                  >
                    {recordingMaxDurationOptions.map((minutes) => (
                      <option value={minutes} key={minutes}>{minutes}分</option>
                    ))}
                  </select>
                </div>
                <div className="admin-settings-row">
                  <div className="editor-state editor-state--block">
                    <span>施設管理画面</span>
                    <small>患者、施設、診療科は施設管理画面で追加・編集します。</small>
                  </div>
                  <button
                    className="btn btn--ghost"
                    onClick={() => window.open(resolveCoreAdminUrl(), "_blank", "noopener,noreferrer")}
                    type="button"
                  >
                    施設管理画面を開く
                    <Icon name="chevronRight" size={15} />
                  </button>
                </div>
                <div className="admin-settings-row">
                  <div className="editor-state">
                    <span>ログイン状態</span>
                    <small>共有端末では利用後にログアウトしてください。</small>
                  </div>
                  <button
                    className="btn btn--danger"
                    onClick={async () => {
                      await clearAccess();
                      window.location.assign("/");
                    }}
                    type="button"
                  >
                    ログアウト
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </section>
      </section>

      {modalMode === "organization" ? (
        <AdminModal
          title="病院を追加"
          description="病院コードと初期管理者のログイン情報を作成します。"
          onClose={() => setModalMode(null)}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => setModalMode(null)}>キャンセル</button>
              <button className="btn btn--primary" type="submit" form="organization-form" disabled={isSaving}>病院を追加</button>
            </>
          )}
        >
          <form id="organization-form" className="admin-modal-form" onSubmit={createOrganization}>
            <label><span>病院名</span><input required value={organizationForm.displayName} onChange={(event) => setOrganizationForm((current) => ({ ...current, displayName: event.target.value }))} /></label>
            <label><span>病院コード</span><input required value={organizationForm.organizationCode} onChange={(event) => setOrganizationForm((current) => ({ ...current, organizationCode: event.target.value.toLowerCase() }))} placeholder="例: tokyo-clinic" /></label>
            <label><span>初期管理者名</span><input required value={organizationForm.adminDisplayName} onChange={(event) => setOrganizationForm((current) => ({ ...current, adminDisplayName: event.target.value }))} /></label>
            <label><span>初期管理者の個人ID</span><input required value={organizationForm.adminLoginId} onChange={(event) => setOrganizationForm((current) => ({ ...current, adminLoginId: event.target.value.toLowerCase() }))} /></label>
            <label><span>初期ログイン用パスワード</span><input required type="password" minLength={12} value={organizationForm.adminPassword} onChange={(event) => setOrganizationForm((current) => ({ ...current, adminPassword: event.target.value }))} /></label>
          </form>
        </AdminModal>
      ) : null}

      {modalMode === "member" ? (
        <AdminModal
          title="職員を追加"
          description={`${selectedOrganization?.displayName || "選択中の病院"}にログインできる職員アカウントを作成します。`}
          onClose={() => setModalMode(null)}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => setModalMode(null)}>キャンセル</button>
              <button className="btn btn--primary" type="submit" form="member-form" disabled={isSaving}>職員を追加</button>
            </>
          )}
        >
          <form id="member-form" className="admin-modal-form" onSubmit={createMember}>
            <label><span>氏名</span><input required value={memberForm.displayName} onChange={(event) => setMemberForm((current) => ({ ...current, displayName: event.target.value }))} /></label>
            <label><span>個人ID</span><input required value={memberForm.loginId} onChange={(event) => setMemberForm((current) => ({ ...current, loginId: event.target.value.toLowerCase() }))} placeholder="例: dr-sato" /></label>
            <label><span>初期ログイン用パスワード</span><input required type="password" minLength={12} value={memberForm.password} onChange={(event) => setMemberForm((current) => ({ ...current, password: event.target.value }))} /></label>
            <label>
              <span>ふだん使う録音方法</span>
              <select value={memberForm.defaultRecordingSource} onChange={(event) => setMemberForm((current) => ({ ...current, defaultRecordingSource: event.target.value }))}>
                <option value="linked_mobile">スマホで録音</option>
                <option value="local_browser">このパソコンで録音</option>
              </select>
            </label>
            <fieldset className="role-checkboxes">
              <legend>権限</legend>
              {assignableRoleDefinitions.length ? assignableRoleDefinitions.map((role) => (
                <label key={role.roleId}>
                  <input type="checkbox" checked={memberForm.roles.includes(role.roleId)} onChange={(event) => updateMemberRole(role.roleId, event.target.checked)} />
                  <span>
                    <strong>{role.label}</strong>
                    <small>{role.description}</small>
                  </span>
                </label>
              )) : (
                <p className="role-checkboxes-empty">付与できる権限がありません。</p>
              )}
            </fieldset>
          </form>
        </AdminModal>
      ) : null}

      {modalMode === "prompt-apply" && selectedFormat ? (
        <AdminModal
          title="適用先を選択"
          description={`${selectedFormat.displayName}をどこに適用するか選択します。公開するまで実際の診療には反映されません。`}
          onClose={() => setModalMode(null)}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => setModalMode(null)}>あとで設定</button>
              <button className="btn btn--primary" type="button" onClick={applyPromptTarget} disabled={isSaving}>適用先を決定</button>
            </>
          )}
        >
          <div className="admin-modal-form">
            <div className="prompt-target-choice-list">
              {canManageOrgPrompts ? (
                <div className={`prompt-target-choice ${applyForm.targetType === "organization" ? "is-selected" : ""}`}>
                  <label className="prompt-target-choice-main">
                    <input
                      type="radio"
                      name="prompt-target-type"
                      checked={applyForm.targetType === "organization"}
                      onChange={() => setApplyForm({ targetType: "organization", memberId: "" })}
                    />
                    <span className="prompt-target-choice-marker" aria-hidden="true">
                      {applyForm.targetType === "organization" ? <Icon name="check" size={13} /> : null}
                    </span>
	                    <span className="prompt-target-choice-copy">
	                      <strong>病院標準</strong>
	                      <small>病院全体で最初に使うプロンプトとして設定します。</small>
                    </span>
                  </label>
                </div>
              ) : null}
              <div className={`prompt-target-choice ${applyForm.targetType === "member" ? "is-selected" : ""}`}>
                <label className="prompt-target-choice-main">
                  <input
                    type="radio"
                    name="prompt-target-type"
                    checked={applyForm.targetType === "member"}
                    onChange={() => setApplyForm({ targetType: "member", memberId: session?.member?.memberId || members[0]?.memberId || "" })}
                  />
                  <span className="prompt-target-choice-marker" aria-hidden="true">
                    {applyForm.targetType === "member" ? <Icon name="check" size={13} /> : null}
                  </span>
	                  <span className="prompt-target-choice-copy">
	                    <strong>{canManageCurrentMembers ? "職員を指定" : "自分に適用"}</strong>
	                    <small>
	                      {canManageCurrentMembers
	                        ? "指定した職員のプロンプトとして設定します。"
	                        : "自分の診療記録作成で使うプロンプトにします。"}
                    </small>
                  </span>
                </label>
                {applyForm.targetType === "member" && canManageCurrentMembers ? (
                  <label className="prompt-target-choice-field">
	                    <span>適用する職員</span>
                    <select value={applyForm.memberId} onChange={(event) => setApplyForm({ targetType: "member", memberId: event.target.value })}>
                      <option value="">選択してください</option>
                      {members.map((member) => (
                        <option key={member.memberId} value={member.memberId}>{member.displayName}（{member.loginId}）</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {applyForm.targetType === "member" && !canManageCurrentMembers ? (
                  <p className="prompt-target-choice-note">{session?.member?.displayName || "自分"}のプロンプトとして保存します。</p>
                ) : null}
              </div>
            </div>
            <p className="empty-note">適用先を決めると、次に「公開して反映」または「下書きで閉じる」を選べます。</p>
          </div>
        </AdminModal>
      ) : null}

      {modalMode === "prompt-publish-choice" && selectedFormat ? (
        <AdminModal
          title="下書きの扱いを選択"
          description={`${applyTargetLabel(pendingApplyTarget, members, selectedOrganization)}に適用する準備ができました。`}
          onClose={() => setModalMode(null)}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={closePromptAsDraft} disabled={isSaving}>下書きで閉じる</button>
              <button className="btn btn--primary" type="button" onClick={() => publishFormat({ target: pendingApplyTarget })} disabled={isSaving || !pendingApplyTarget}>公開して反映</button>
            </>
          )}
        >
          <div className="admin-modal-form">
            <p className="empty-note">公開すると、次回以降に作成するSOAP下書きからこのプロンプトが使われます。過去の診療記録は変更されません。</p>
          </div>
        </AdminModal>
      ) : null}

      {modalMode === "prompt-name-confirm" && editor ? (
        <AdminModal
          title="プロンプト名を確認"
          description="プロンプト名が初期名のままです。"
          onClose={() => setModalMode(null)}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => setModalMode(null)} disabled={isSaving}>名前を編集する</button>
              <button className="btn btn--primary" type="button" onClick={() => saveDraft({ skipDefaultNameWarning: true })} disabled={isSaving}>このまま保存する</button>
            </>
          )}
        >
          <div className="admin-modal-form">
            <p className="empty-note">あとから見分けやすいように、用途や担当者がわかる名前への変更を推奨します。</p>
          </div>
        </AdminModal>
      ) : null}

      {modalMode === "archive-format" && selectedFormat ? (
        <AdminModal
          title="プロンプトを公開停止"
          description={`${selectedFormat.displayName}を次回以降のSOAP作成で使えない状態にします。`}
          onClose={() => setModalMode(null)}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => setModalMode(null)}>キャンセル</button>
              <button className="btn btn--danger" type="button" onClick={archiveFormat} disabled={isSaving}>公開停止する</button>
            </>
          )}
        >
          <div className="admin-modal-form">
            <p className="empty-note">このプロンプトを割当中の職員は病院標準に戻ります。過去の診療記録や作成済みのSOAPは削除されません。</p>
          </div>
        </AdminModal>
      ) : null}

      {modalMode === "member-actions" && memberActionTarget ? (
        <AdminModal
          title={`${memberActionTarget.displayName}の操作`}
          description="注意が必要な操作を選択します。実行前に確認画面を表示します。"
          onClose={() => { setModalMode(null); setMemberActionTarget(null); }}
          footer={<button className="btn btn--ghost" type="button" onClick={() => { setModalMode(null); setMemberActionTarget(null); }}>閉じる</button>}
        >
          <div className="member-action-list">
            <button className="member-action-choice" type="button" onClick={() => openPasswordReset(memberActionTarget)} disabled={!isCurrentOrganization || !canManageCurrentMembers}>
              <strong>ログイン用パスワード再設定</strong>
              <span>新しいログイン用パスワードを生成・コピーします。</span>
            </button>
            <button className="member-action-choice" type="button" onClick={() => requestSecurityAction("revoke-sessions", memberActionTarget)} disabled={!isCurrentOrganization || !canManageCurrentMembers || isSaving}>
              <strong>強制ログアウト</strong>
              <span>現在ログイン中の状態を強制終了します。アカウント自体は停止されません。</span>
            </button>
            <button className="member-action-choice" type="button" onClick={() => requestSecurityAction("mfa-reset", memberActionTarget)} disabled={!isCurrentOrganization || !canManageCurrentMembers || isSaving || !memberActionTarget.mfaEnrolledAt}>
              <strong>2段階認証をリセット</strong>
              <span>次回ログイン時に認証アプリの再登録が必要になります。</span>
            </button>
            <button
              className={`member-action-choice ${memberActionTarget.status === "active" ? "member-action-choice--danger" : ""}`}
              type="button"
              onClick={() => requestMemberStatusChange(memberActionTarget, memberActionTarget.status === "active" ? "disabled" : "active")}
              disabled={Boolean(memberStatusDisabledReason(memberActionTarget, memberActionTarget.status === "active" ? "disabled" : "active"))}
              title={memberStatusDisabledReason(memberActionTarget, memberActionTarget.status === "active" ? "disabled" : "active")}
            >
              <strong>{memberActionTarget.status === "active" ? "アカウントを停止" : "アカウントを再開"}</strong>
              <span>{memberActionTarget.status === "active" ? "この職員はログインできなくなります。" : "この職員は再びログインできます。"}</span>
            </button>
          </div>
        </AdminModal>
      ) : null}

      {modalMode === "member-roles" && roleTarget ? (
        <AdminModal
          title="権限を変更"
          description={`${roleTarget.displayName}に付与する権限を選択します。変更後は再ログイン時に新しい権限が反映されます。`}
          onClose={() => { setModalMode(null); setRoleTarget(null); setRoleForm({ roles: ["doctor"] }); }}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => { setModalMode(null); setRoleTarget(null); }}>キャンセル</button>
              <button className="btn btn--primary" type="submit" form="member-roles-form" disabled={isSaving || roleTargetWouldRemoveLastAdmin}>権限を保存</button>
            </>
          )}
        >
          <form id="member-roles-form" className="admin-modal-form" onSubmit={saveMemberRoles}>
            <fieldset className="role-checkboxes">
              <legend>権限</legend>
              {assignableRoleDefinitions.length ? assignableRoleDefinitions.map((role) => (
                <label key={role.roleId}>
                  <input type="checkbox" checked={roleForm.roles.includes(role.roleId)} onChange={(event) => updateRoleForm(role.roleId, event.target.checked)} />
                  <span>
                    <strong>{role.label}</strong>
                    <small>{role.description}</small>
                  </span>
                </label>
              )) : (
                <p className="role-checkboxes-empty">付与できる権限がありません。</p>
              )}
            </fieldset>
            {roleTargetWouldRemoveLastAdmin ? (
              <p className="admin-warning-note">病院内の最後の管理者は降格できません。別の管理者を追加してから操作してください。</p>
            ) : null}
          </form>
        </AdminModal>
      ) : null}

      {modalMode === "member-status" && statusTarget ? (
        <AdminModal
          title={statusTarget.status === "active" ? "アカウントを再開" : "アカウントを停止"}
          description={`${statusTarget.member.displayName}のログイン可否を変更します。`}
          onClose={() => { setModalMode(null); setStatusTarget(null); }}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => { setModalMode(null); setStatusTarget(null); }}>キャンセル</button>
              <button
                className={statusTarget.status === "active" ? "btn btn--primary" : "btn btn--danger"}
                type="button"
                onClick={() => updateMemberStatus(statusTarget.member, statusTarget.status, { closeModal: true })}
                disabled={isSaving}
              >
                {statusTarget.status === "active" ? "再開する" : "停止する"}
              </button>
            </>
          )}
        >
          <div className="admin-modal-form">
            <p className="empty-note">
              {statusTarget.status === "active"
                ? "再開すると、この職員は再びログインできます。"
                : "停止すると、この職員はログインできなくなります。既にログイン中の場合は、強制ログアウトも実行してください。"}
            </p>
          </div>
        </AdminModal>
      ) : null}

      {modalMode === "member-security-action" && securityActionTarget ? (
        <AdminModal
          title={securityActionTarget.kind === "mfa-reset" ? "2段階認証をリセット" : "強制ログアウト"}
          description={`${securityActionTarget.member.displayName}に対するセキュリティ操作を実行します。`}
          onClose={() => { setModalMode(null); setSecurityActionTarget(null); }}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => { setModalMode(null); setSecurityActionTarget(null); }}>キャンセル</button>
              <button
                className="btn btn--danger"
                type="button"
                onClick={() => {
                  if (securityActionTarget.kind === "mfa-reset") {
                    resetMemberMfa(securityActionTarget.member);
                  } else {
                    revokeMemberSessions(securityActionTarget.member);
                  }
                }}
                disabled={isSaving}
              >
                実行する
              </button>
            </>
          )}
        >
          <div className="admin-modal-form">
            <p className="empty-note">
              {securityActionTarget.kind === "mfa-reset"
                ? "次回ログイン時に認証アプリの再登録が必要になります。本人確認が済んでいる場合だけ実行してください。"
                : securityActionTarget.member.memberId === session?.member?.memberId
                  ? "自分自身も強制ログアウトされます。実行後は再ログインが必要です。"
                  : "この職員を強制ログアウトします。アカウント自体は停止されません。"}
            </p>
          </div>
        </AdminModal>
      ) : null}

      {modalMode === "password" && passwordTarget ? (
        <AdminModal
          title="ログイン用パスワード再設定"
          description={`${passwordTarget.displayName}のログイン用パスワードを新しい値に変更します。現在のログイン用パスワードは確認できません。`}
          onClose={() => { setModalMode(null); setPasswordTarget(null); setPasswordForm({ password: "" }); setPasswordVisible(false); setPasswordResetResult(""); }}
          footer={(
            <>
              <button className="btn btn--ghost" type="button" onClick={() => { setModalMode(null); setPasswordTarget(null); setPasswordForm({ password: "" }); setPasswordVisible(false); setPasswordResetResult(""); }}>
                {passwordResetResult ? "閉じる" : "キャンセル"}
              </button>
              {!passwordResetResult ? (
                <button className="btn btn--danger" type="submit" form="password-form" disabled={isSaving || !passwordForm.password}>再設定する</button>
              ) : null}
            </>
          )}
        >
          <form id="password-form" className="admin-modal-form" onSubmit={resetPassword}>
            <label>
              <span>新しいログイン用パスワード</span>
              <input
                required
                type={passwordVisible ? "text" : "password"}
                minLength={12}
                value={passwordForm.password}
                onChange={(event) => { setPasswordForm({ password: event.target.value }); setPasswordResetResult(""); }}
              />
            </label>
            <div className="password-helper-actions">
              <button className="btn btn--ghost" type="button" onClick={fillGeneratedPassword}>安全なログイン用パスワードを作る</button>
              <button className="btn btn--ghost" type="button" onClick={() => setPasswordVisible((current) => !current)} disabled={!passwordForm.password}>
                {passwordVisible ? "非表示" : "表示"}
              </button>
              <button className="btn btn--ghost" type="button" onClick={copyPasswordToClipboard} disabled={!passwordForm.password}>コピー</button>
            </div>
            {passwordResetResult ? (
              <p className="admin-warning-note">{passwordResetResult}</p>
            ) : (
              <p className="empty-note">ランダム生成したログイン用パスワードを使い、本人へ安全な経路で伝達してください。</p>
            )}
          </form>
        </AdminModal>
      ) : null}
    </main>
  );
}
