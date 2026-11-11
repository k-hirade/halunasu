// 眼科カルテの入力検証と列挙値。計算や版管理は eye-core に置く。

export * from "./patient-search.js";

export const EYE_PRODUCT_ID = "eye";
export const EYE_SIDES = Object.freeze(["od", "os"]);
export const EYE_TARGETS = Object.freeze(["od", "os", "ou"]);
export const EYE_TARGET_LABELS = Object.freeze({ od: "右眼", os: "左眼", ou: "両眼" });
export const VISIT_TYPES = Object.freeze(["initial", "revisit"]);
export const ENCOUNTER_STATUSES = Object.freeze(["draft", "finalized"]);
export const PRESCRIPTION_KINDS = Object.freeze(["eye_drop", "eye_ointment", "oral", "injection", "other"]);
// 処方・オーダーの Rp（まとまり）。同じ rpId の行が 1 つの Rp で、Rp の中にコメント行（kind "comment"）を置ける。
// rpId の無い古い行は、1 行で 1 つの Rp として読む。
export const COMMENT_KIND = "comment";
export const PRESCRIPTION_ROW_KINDS = Object.freeze([...PRESCRIPTION_KINDS, COMMENT_KIND]);
// 処方の Rp で共有する項目（用法・日数など）。Rp の先頭の薬剤行の値を、同じ Rp のほかの薬剤行にそろえる。
export const RP_SHARED_FIELDS = Object.freeze(["route", "usage", "timesPerDay", "days", "eye"]);
// コメントの載せ先: free = 処方箋・レセプトにも載せる、chart = カルテだけ。
export const COMMENT_SCOPES = Object.freeze(["free", "chart"]);
export const COMMENT_SCOPE_LABELS = Object.freeze({ free: "処方箋・レセプトに載せる", chart: "カルテだけ" });
// 公開マスター（支払基金の基本マスター）の種類。検索 API の type に使う。
export const EYE_MASTER_TYPES = Object.freeze(["drug", "disease", "modifier", "procedure"]);
// 学習リスト（この医院でよく使う組み合わせ）の区分
export const LEARNING_CATEGORIES = Object.freeze(["prescription", "order", "diagnosis"]);
// 確定済みカルテを直接編集したとき・修正理由を入れなかったときの理由
export const DEFAULT_AMENDMENT_REASON = "修正";
export const MODIFIER_POSITIONS = Object.freeze(["prefix", "suffix"]);
export const IOP_METHODS = Object.freeze(["nct", "goldmann", "icare", "other"]);
export const PRESCRIPTION_ROUTES = Object.freeze(["outside", "inside"]);
export const PHRASE_TARGETS = Object.freeze([
  "chiefComplaint", "history", "assessment", "plan", "staffNote", "findings.anterior", "findings.lens", "findings.fundus",
  // 追加の差し込み先（2026-11）。findings.other は眼ごと、findings.general と counselling.note は 1 欄。
  "findings.other", "findings.general", "counselling.note",
  // 主訴・所見の自由記載（1 欄）
  "findingsText"
]);
// 眼ごとに右・左・両を選んで差し込む定型文の欄
export const PER_EYE_PHRASE_TARGETS = Object.freeze(["findings.anterior", "findings.lens", "findings.fundus", "findings.other"]);
export const SKETCH_TEMPLATES = Object.freeze(["anterior", "fundus", "blank", "cornea", "lens", "gonio", "eyelid", "vfgrid"]);
// シェーマの描き方（無いときはフリーハンドのペン）。図形は始点・終点の 2 点で持つ。
export const SKETCH_TOOLS = Object.freeze(["pen", "line", "arrow", "ellipse", "rect", "text"]);
export const SKETCH_FILLS = Object.freeze(["solid", "hatch"]);
export const DIAGNOSIS_STATUSES = Object.freeze(["active", "resolved", "suspected"]);
export const VA_CORRECTION_TYPES = Object.freeze(["", "glasses", "contact", "pinhole", "trial"]);
export const ORDER_KINDS = Object.freeze(["exam", "procedure"]);
export const ORDER_STATUSES = Object.freeze(["planned", "performed", "cancelled"]);
// 受診カルテの項目。保存と衝突判定はこの単位で行う。
export const ENCOUNTER_SECTIONS = Object.freeze([
  "chiefComplaint", "history", "exam", "findings", "sketches", "diagnoses", "assessment", "plan",
  "prescriptions", "nextVisit", "staffNote", "orders", "flags", "optical",
  // 説明・同意の記録、点眼アドヒアランス。入力があるカルテだけが持つ（古いカルテには無い）。
  "counselling", "adherence",
  // 主訴・所見の自由記載（デジカルの「主訴・所見」、トプコンの文字所見にあたる 1 欄）。入力があるカルテだけが持つ。
  "findingsText"
]);
// 瞳孔・対光反射・RAPD・眼位・眼球運動（検査帯の追加項目）。値は exam.{od,os} と exam.binocular に入れる。
export const PUPIL_REACTIONS = Object.freeze(["brisk", "sluggish", "absent"]);
export const PUPIL_REACTION_LABELS = Object.freeze({ brisk: "迅速", sluggish: "緩慢", absent: "消失" });
export const RAPD_VALUES = Object.freeze(["none", "od", "os", "unknown"]);
export const RAPD_LABELS = Object.freeze({ none: "なし", od: "右眼", os: "左眼", unknown: "判定不能" });
export const ALIGNMENT_VALUES = Object.freeze(["ortho", "exo", "eso", "vertical", "other"]);
export const ALIGNMENT_LABELS = Object.freeze({ ortho: "正位", exo: "外斜位", eso: "内斜位", vertical: "上下斜位", other: "その他" });
export const MOTILITY_VALUES = Object.freeze(["normal", "limited"]);
export const MOTILITY_LABELS = Object.freeze({ normal: "正常", limited: "制限あり" });
// 説明・同意
export const COUNSELLING_TOPICS = Object.freeze(["condition", "treatment", "eye_drop", "dilation", "surgery", "ivi"]);
export const COUNSELLING_TOPIC_LABELS = Object.freeze({
  condition: "病状・検査結果", treatment: "治療方針", eye_drop: "点眼指導", dilation: "散瞳後の注意", surgery: "手術", ivi: "硝子体内注射"
});
export const COUNSELLING_RECIPIENTS = Object.freeze(["patient", "family", "both"]);
export const COUNSELLING_RECIPIENT_LABELS = Object.freeze({ patient: "本人", family: "家族", both: "本人・家族" });
export const CONSENT_VALUES = Object.freeze(["obtained", "not_obtained", "not_required"]);
export const CONSENT_LABELS = Object.freeze({ obtained: "同意あり", not_obtained: "同意なし", not_required: "同意不要" });
export const ADHERENCE_VALUES = Object.freeze(["good", "sometimes", "poor", "unknown"]);
export const ADHERENCE_LABELS = Object.freeze({ good: "良好", sometimes: "時々忘れる", poor: "不良", unknown: "未確認" });
export const OPTICAL_TYPES = Object.freeze(["", "glasses", "contact"]);
export const OPTICAL_PURPOSES = Object.freeze(["far", "near", "middle", "progressive", "bifocal"]);
// 処方箋の詳細（日本眼科医会の様式の項目）。どれも任意で、未入力の古いデータはそのまま通す。
export const OPTICAL_LENS_MATERIALS = Object.freeze(["organic", "inorganic", "polycarbonate", "other"]);
export const OPTICAL_LENS_MATERIAL_LABELS = Object.freeze({ organic: "プラスチック（有機）", inorganic: "ガラス（無機）", polycarbonate: "ポリカーボネート", other: "その他" });
export const OPTICAL_WEAR_MODES = Object.freeze(["always", "as_needed"]);
export const OPTICAL_WEAR_MODE_LABELS = Object.freeze({ always: "常時", as_needed: "必要時" });
export const CL_WEAR_SCHEDULES = Object.freeze(["daily_wear", "extended_wear"]);
export const CL_WEAR_SCHEDULE_LABELS = Object.freeze({ daily_wear: "終日装用", extended_wear: "連続装用" });
export const CL_REPLACEMENTS = Object.freeze(["one_day", "two_weeks", "one_month", "three_months", "conventional", "other"]);
export const CL_REPLACEMENT_LABELS = Object.freeze({
  one_day: "1日", two_weeks: "2週間", one_month: "1か月", three_months: "3か月", conventional: "従来型", other: "その他"
});
// 文書の宛名の敬称。未設定の文書は従来どおり「先生 御侍史」で出す（画面側の既定）。
export const DOCUMENT_HONORIFICS = Object.freeze(["御侍史", "御机下", "先生", "殿", "御中"]);
export const MAX_PRINT_NAME = 40;
export const DOCUMENT_TYPES = Object.freeze(["referral", "reply", "certificate", "other"]);
// face_photo: 顔写真（受付・診察での本人確認用。画像の比較には出さない）
export const FILE_KINDS = Object.freeze(["oct", "vf", "fundus_photo", "anterior_photo", "topography", "paper_chart", "referral_in", "other", "face_photo"]);
export const EYE_DOCUMENT_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse", "medical_clerk"]);
// 検査・処置の標準カタログ。医院ごとの追加はセットで行う。
export const DEFAULT_ORDER_CATALOG = Object.freeze([
  { code: "va", name: "視力検査", kind: "exam", requiresEye: true },
  { code: "refraction", name: "屈折検査（他覚）", kind: "exam", requiresEye: true },
  { code: "iop", name: "眼圧検査", kind: "exam", requiresEye: true },
  { code: "iop_gat", name: "精密眼圧測定（GAT）", kind: "exam", requiresEye: true },
  { code: "slit_lamp", name: "細隙灯顕微鏡検査", kind: "exam", requiresEye: true },
  { code: "fundus_dilated", name: "精密眼底検査（散瞳）", kind: "exam", requiresEye: true },
  { code: "vf_static", name: "静的視野検査", kind: "exam", requiresEye: true },
  { code: "vf_kinetic", name: "動的視野検査", kind: "exam", requiresEye: true },
  { code: "oct_retina", name: "OCT（網膜）", kind: "exam", requiresEye: true },
  { code: "oct_disc", name: "OCT（視神経乳頭）", kind: "exam", requiresEye: true },
  { code: "fundus_photo", name: "眼底写真", kind: "exam", requiresEye: true },
  { code: "keratometry", name: "角膜曲率測定", kind: "exam", requiresEye: true },
  { code: "axial_length", name: "眼軸長測定", kind: "exam", requiresEye: true },
  { code: "endothelium", name: "角膜内皮細胞検査", kind: "exam", requiresEye: true },
  { code: "tear", name: "涙液検査（BUT・シルマー）", kind: "exam", requiresEye: true },
  { code: "dilation", name: "散瞳", kind: "procedure", requiresEye: true },
  { code: "ivi", name: "硝子体内注射", kind: "procedure", requiresEye: true },
  { code: "foreign_body", name: "角膜異物除去", kind: "procedure", requiresEye: true }
]);
// 検査記録（1 日に複数回。検査日時＋検者の単位）。content.examRecords[] に持ち、content.exam はそこから作る「最新値」。
export const MAX_EXAM_RECORDS = 30;
export const MAX_IOP_READINGS = 3;
export const MAX_DEVICE_READINGS = 10;
export const EXAM_RECORD_SOURCES = Object.freeze(["manual", "chart", "device"]);
// IOL/CL 列: 眼内レンズ眼・コンタクトレンズ装用のまま測った値の印
export const IOL_CL_VALUES = Object.freeze(["iol", "cl"]);
export const IOL_CL_LABELS = Object.freeze({ iol: "IOL", cl: "CL" });
// 他覚屈折の出どころ
export const REFRACTION_SOURCES = Object.freeze(["autoref", "retinoscopy", "manual", "other"]);
export const REFRACTION_SOURCE_LABELS = Object.freeze({ autoref: "オートレフ", retinoscopy: "検影法", manual: "手入力", other: "その他" });
// 次回の診療予定の部位。none は眼を問わない項目（診察のみ・説明など）。
export const PLAN_ITEM_EYES = Object.freeze(["od", "os", "ou", "none"]);
export const PLAN_ITEM_EYE_LABELS = Object.freeze({ od: "右", os: "左", ou: "両", none: "なし" });
// 次回予定のプリセット（トプコンの「視・圧」などの新規作成ボタン）。項目は DEFAULT_ORDER_CATALOG の code。
export const NEXT_VISIT_PLAN_PRESETS = Object.freeze([
  { presetId: "va_iop", label: "視・圧", codes: ["va", "iop"] },
  { presetId: "va_iop_dilation", label: "視・圧・散", codes: ["va", "iop", "dilation", "fundus_dilated"] },
  { presetId: "cataract_preop", label: "白内障術前検査", codes: ["va", "refraction", "iop", "keratometry", "axial_length", "endothelium", "slit_lamp", "fundus_dilated"] },
  { presetId: "glaucoma", label: "視・圧・視野", codes: ["va", "iop", "vf_static", "oct_disc"] },
  { presetId: "consult_only", label: "診察のみ", codes: [] }
]);
// 検査入力（トプコンの大タブ）の追加の検査。記録の values.tests に入れる。どれも入力のある部分だけを持つ。
// Worth 4 灯: 見え方のパターン（赤フィルターを右眼に置いた見え方で記録する）
export const WORTH_PATTERNS = Object.freeze(["four", "red2", "green3", "five", "alternating", "unknown"]);
export const WORTH_PATTERN_LABELS = Object.freeze({
  four: "4灯（融像）", red2: "赤2灯（左眼抑制）", green3: "緑3灯（右眼抑制）", five: "5灯（複視）", alternating: "赤2・緑3が交互", unknown: "判定不能"
});
export const TEST_DISTANCES = Object.freeze(["near", "far"]);
export const TEST_DISTANCE_LABELS = Object.freeze({ near: "近見", far: "遠見" });
// 遮閉試験（Cover Test）
export const COVER_KINDS = Object.freeze(["ortho", "phoria", "intermittent", "tropia"]);
export const COVER_KIND_LABELS = Object.freeze({ ortho: "正位", phoria: "斜位", intermittent: "間欠性斜視", tropia: "斜視" });
export const COVER_DIRECTIONS = Object.freeze(["exo", "eso", "hyper", "hypo"]);
export const COVER_DIRECTION_LABELS = Object.freeze({ exo: "外", eso: "内", hyper: "上", hypo: "下" });
// 9 方向眼位。向きは患者から見た向き。値は「正常」か、制限（−1〜−4）・過動（+1〜+4）の程度。
export const NINE_GAZE_DIRECTIONS = Object.freeze(["up_right", "up", "up_left", "right", "center", "left", "down_right", "down", "down_left"]);
export const NINE_GAZE_DIRECTION_LABELS = Object.freeze({
  up_right: "右上", up: "上", up_left: "左上", right: "右", center: "正面", left: "左", down_right: "右下", down: "下", down_left: "左下"
});
export const NINE_GAZE_VALUES = Object.freeze(["normal", "-1", "-2", "-3", "-4", "+1", "+2", "+3", "+4"]);
// 形の決まっていない検査（公開資料で中身が分からないもの）は、文字の欄だけを持つ。
export const EXAM_TEXT_TESTS = Object.freeze({
  color: ["test", "od", "os", "note"],
  stereo: ["test", "result", "note"],
  accommodation: ["od", "os", "note"],
  anterior: ["od", "os", "note"],
  other: ["name", "text"]
});
export const DIAGNOSIS_OUTCOMES = Object.freeze(["", "cured", "discontinued", "transferred", "deceased", "other"]);
export const ALLERGY_CATEGORIES = Object.freeze(["drug", "food", "contrast", "latex", "other"]);
export const ALLERGY_SEVERITIES = Object.freeze(["unknown", "mild", "moderate", "severe"]);
// 傷病名の変更は医師（と管理者）だけ。アレルギー・既往は問診を取る職種も更新できる。
export const EYE_PROFILE_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse", "medical_clerk"]);

export const EYE_READ_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse", "medical_clerk", "viewer"]);
export const EYE_WRITE_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse"]);
export const EYE_FINALIZE_ROLES = Object.freeze(["admin", "doctor"]);
export const EYE_SETTINGS_ROLES = Object.freeze(["admin"]);
// セット（とフォルダ）の作成・更新。医師はカルテから「現在のカルテからセットを作成」できる。
export const EYE_SET_ROLES = Object.freeze(["admin", "doctor"]);
export const EYE_RECEPTION_ROLES = Object.freeze(["admin", "doctor", "orthoptist", "nurse", "medical_clerk"]);

export const APPOINTMENT_PURPOSES = Object.freeze(["revisit", "initial", "exam", "injection", "postop", "contact_lens", "other"]);
// 受付の状態（デジカルの 11 種に合わせる）。保存する値はこの中のもの。
// - 再計待（rebill_waiting）は保存しない。会計待・会計済のうち、会計連携のあとでカルテの品目が変わったものを一覧で派生させる。
// - no_show（来院なし）は古いデータのための値。読むときは「不在」として扱い、新しく保存するときは absent にする。
export const APPOINTMENT_STATUSES = Object.freeze([
  "booked", "checked_in", "waiting_doctor", "in_consult", "in_exam", "in_treatment", "checkout", "done", "absent", "cancelled", "no_show"
]);
// プルダウンに並べる順（デジカルのメニュー順）。rebill_waiting は表示用の派生で、選んで保存はできない。
export const APPOINTMENT_STATUS_MENU = Object.freeze([
  "booked", "checked_in", "waiting_doctor", "in_consult", "in_exam", "in_treatment", "checkout", "done", "rebill_waiting", "absent", "cancelled"
]);
export const APPOINTMENT_DERIVED_STATUSES = Object.freeze(["rebill_waiting"]);
export const APPOINTMENT_STATUS_LABELS = Object.freeze({
  booked: "予約済",
  checked_in: "受付中",
  waiting_doctor: "診察待",
  in_consult: "診察中",
  in_exam: "検査中",
  in_treatment: "処置中",
  checkout: "会計待",
  done: "会計済",
  rebill_waiting: "再計待",
  absent: "不在",
  cancelled: "取消",
  no_show: "不在"
});
// 古い値の読み替え。入力でも受け付け、保存は新しい値で行う。
export const APPOINTMENT_STATUS_ALIASES = Object.freeze({ no_show: "absent" });
// 来院している（受付を済ませた）状態。ここへ初めて入ったときに受付番号と受付時刻を付ける。
export const APPOINTMENT_ARRIVED_STATUSES = Object.freeze(["checked_in", "waiting_doctor", "in_consult", "in_exam", "in_treatment", "checkout", "done"]);
// 予約の件数や「診察終了」の対象に数えない状態。
export const APPOINTMENT_INACTIVE_STATUSES = Object.freeze(["cancelled", "absent", "no_show"]);
// 状態はプルダウンでどこからどこへでも移れる（デジカルと同じ）。変更は statusHistory と操作記録に残る。
// 例外（その日のカルテがある受付は取消にできない）は、データを見て API が判断する。
// 古い画面のために遷移表の形は残す（各状態から、自分以外の保存できる状態すべてへ）。
const STORABLE_APPOINTMENT_STATUSES = APPOINTMENT_STATUSES.filter((status) => !APPOINTMENT_STATUS_ALIASES[status]);
export const APPOINTMENT_TRANSITIONS = Object.freeze(Object.fromEntries(APPOINTMENT_STATUSES.map((from) => [
  from,
  Object.freeze(STORABLE_APPOINTMENT_STATUSES.filter((to) => to !== (APPOINTMENT_STATUS_ALIASES[from] || from)))
])));
// 予約・受付のメモと診療科の長さ
export const MAX_APPOINTMENT_MEMO = 1000;
export const MAX_APPOINTMENT_DEPARTMENT = 40;
export const MAX_APPOINTMENT_RANGE_DAYS = 42;

export function normalizeAppointmentStatus(status) {
  return APPOINTMENT_STATUS_ALIASES[status] || status;
}

export function isActiveAppointmentStatus(status) {
  return !APPOINTMENT_INACTIVE_STATUSES.includes(status);
}

// 操作記録の種類。画面の絞り込みチップと API の category 絞り込みで同じ分け方を使う。
export const AUDIT_CATEGORIES = Object.freeze(["view", "change", "finalize", "export", "settings", "other"]);
const AUDIT_SETTINGS_EVENTS = new Set(["eye.drug_preset_saved", "eye.order_set_saved", "eye.set_folder_saved", "eye.phrase_saved", "eye.staff_profile_saved", "eye.facility_settings_saved", "eye.clinic_config_saved"]);
const AUDIT_APPROVAL_EVENTS = new Set(["eye.encounter_approval_requested", "eye.encounter_approved", "eye.encounter_returned"]);
const AUDIT_CHANGE_SUFFIX = /_(created|updated|saved|discarded|amend_started|confirmed|unconfirmed|status_changed|uploaded|archived|reviewed)$/u;

export function auditEventCategory(eventType) {
  const type = String(eventType || "");
  if (AUDIT_SETTINGS_EVENTS.has(type)) return "settings";
  if (type.endsWith("_viewed")) return "view";
  // カルテの承認（承認待ちにした・承認・差し戻し）は確定と同じ分類にする
  if (type.endsWith("_finalized") || AUDIT_APPROVAL_EVENTS.has(type)) return "finalize";
  if (type.endsWith("_exported") || type === "eye.billing_handed_off") return "export";
  if (AUDIT_CHANGE_SUFFIX.test(type)) return "change";
  return "other";
}

const MAX_TEXT = 4000;
// 主訴・所見の自由記載は 1 欄にまとめて書くため長めにする
const MAX_LONG_TEXT = 10000;
const MAX_SHORT_TEXT = 200;
const MAX_LIST = 40;
// 処方・オーダーはコメント行も数えるため多めにする
const MAX_ROWS = 80;
const MAX_MODIFIERS = 10;
const MAX_SKETCHES = 8;
const MAX_STROKES = 600;
const MAX_POINTS_PER_STROKE = 2000;
const MAX_TOTAL_POINTS = 60000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function validateCreateEncounterInput(input = {}) {
  return {
    patientId: requiredString(input.patientId, "patientId", MAX_SHORT_TEXT),
    encounterDate: requiredDate(input.encounterDate, "encounterDate"),
    visitType: optionalEnum(input.visitType, VISIT_TYPES, "visitType") || "revisit",
    copyFromEncounterId: optionalString(input.copyFromEncounterId, "copyFromEncounterId", MAX_SHORT_TEXT),
    content: input.content === undefined ? undefined : validateEncounterContent(input.content)
  };
}

export function validateUpdateEncounterInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return {
    expectedRevision,
    encounterDate: input.encounterDate === undefined ? undefined : requiredDate(input.encounterDate, "encounterDate"),
    visitType: input.visitType === undefined ? undefined : requiredEnum(input.visitType, VISIT_TYPES, "visitType"),
    sections: validateEncounterSections(input),
    // 確定済みのカルテを直接編集したときの修正理由（任意。空なら「修正」）
    amendmentReason: optionalString(input.amendmentReason, "amendmentReason", MAX_TEXT)
  };
}

// 保存は変更した項目だけを送る（sections）。content を丸ごと送る古い形も受け付ける。
function validateEncounterSections(input) {
  const source = isPlainObject(input.sections) ? input.sections : isPlainObject(input.content) ? input.content : {};
  const keys = Object.keys(source).filter((key) => ENCOUNTER_SECTIONS.includes(key));
  const unknown = Object.keys(source).filter((key) => !ENCOUNTER_SECTIONS.includes(key));
  if (unknown.length) throw validationError(`unknown section: ${unknown.join(", ")}`, "sections");
  const validated = validateEncounterContent(Object.fromEntries(keys.map((key) => [key, source[key]])));
  return Object.fromEntries(keys.map((key) => [key, validated[key]]));
}

export function validateFinalizeEncounterInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return { expectedRevision };
}

// 修正理由は任意（デジカルと同じく、確定後もそのまま直せる）。空なら「修正」として版に残す。
export function validateAmendEncounterInput(input = {}) {
  return {
    reason: optionalString(input.reason, "reason", MAX_TEXT) || DEFAULT_AMENDMENT_REASON
  };
}

export function validateDrugPresetInput(input = {}) {
  const dropsPerBottle = optionalNumber(input.dropsPerBottle, "dropsPerBottle", { min: 1, max: 2000, integer: true });
  return {
    presetId: optionalString(input.presetId, "presetId", MAX_SHORT_TEXT),
    name: requiredString(input.name, "name", MAX_SHORT_TEXT),
    kind: optionalEnum(input.kind, PRESCRIPTION_KINDS, "kind") || "eye_drop",
    defaultTimesPerDay: optionalNumber(input.defaultTimesPerDay, "defaultTimesPerDay", { min: 0, max: 24, integer: true }),
    bottleVolumeMl: optionalNumber(input.bottleVolumeMl, "bottleVolumeMl", { min: 0.1, max: 100 }),
    dropsPerBottle: dropsPerBottle ?? null,
    defaultUsage: optionalString(input.defaultUsage, "defaultUsage", MAX_SHORT_TEXT),
    route: optionalEnum(input.route, PRESCRIPTION_ROUTES, "route") || "outside",
    active: input.active === undefined ? true : Boolean(input.active)
  };
}

// セット: よく使う処方・オーダー・方針文・病名・主訴所見の組み合わせ。カルテに一括で追加する。
// フォルダ（folderId）と並び順（sortOrder）は任意。病名・主訴所見は入力があるときだけ持たせる（古いセットの形を変えないため）。
export function validateOrderSetInput(input = {}) {
  const content = validateEncounterContent({
    prescriptions: input.prescriptions,
    orders: (input.orders || []).map((order, index) => ({ ...order, orderId: order.orderId || `set-${index}` })),
    diagnoses: input.diagnoses,
    ...(input.findingsText !== undefined ? { findingsText: input.findingsText } : {})
  });
  return {
    setId: optionalString(input.setId, "setId", MAX_SHORT_TEXT),
    name: requiredString(input.name, "name", MAX_SHORT_TEXT),
    description: optionalString(input.description, "description", MAX_SHORT_TEXT),
    prescriptions: content.prescriptions.map((item, index) => {
      if (item.kind !== COMMENT_KIND && !item.name) throw validationError("set prescriptions need a name", `prescriptions.${index}.name`);
      return item;
    }),
    orders: content.orders.map(({ orderId, statusChangedAt, statusChangedBy, ...order }) => (order.kind === COMMENT_KIND ? order : { ...order, status: "planned" })),
    plan: optionalText(input.plan, "plan"),
    active: input.active === undefined ? true : Boolean(input.active),
    ...compactValues({
      folderId: optionalString(input.folderId, "folderId", MAX_SHORT_TEXT),
      sortOrder: optionalNumber(input.sortOrder, "sortOrder", { min: -1000000, max: 1000000, integer: true }),
      diagnoses: content.diagnoses.map((item, index) => {
        if (!item.name) throw validationError("set diagnoses need a name", `diagnoses.${index}.name`);
        const { onsetDate, ...rest } = item;
        return rest;
      }),
      findingsText: content.findingsText
    })
  };
}

// セットのフォルダ。parentId で入れ子にできる（親の無いものが最上位）。
export function validateSetFolderInput(input = {}) {
  const folderId = optionalString(input.folderId, "folderId", MAX_SHORT_TEXT);
  const parentId = optionalString(input.parentId, "parentId", MAX_SHORT_TEXT);
  if (folderId && parentId === folderId) throw validationError("a folder cannot be its own parent", "parentId");
  return {
    folderId,
    name: requiredString(input.name, "name", MAX_SHORT_TEXT),
    parentId,
    sortOrder: optionalNumber(input.sortOrder, "sortOrder", { min: -1000000, max: 1000000, integer: true }) ?? 0,
    active: input.active === undefined ? true : Boolean(input.active)
  };
}

// 「現在のカルテからセットを作成」。setId を渡すとそのセットを現在のカルテで上書きする。
// include で写す項目を選ぶ（既定はすべて）。
export const SET_FROM_ENCOUNTER_PARTS = Object.freeze(["prescriptions", "orders", "diagnoses", "findingsText", "plan"]);

export function validateSetFromEncounterInput(input = {}) {
  const include = isPlainObject(input.include) ? input.include : {};
  return {
    encounterId: requiredString(input.encounterId, "encounterId", MAX_SHORT_TEXT),
    setId: optionalString(input.setId, "setId", MAX_SHORT_TEXT),
    name: optionalString(input.name, "name", MAX_SHORT_TEXT),
    description: optionalString(input.description, "description", MAX_SHORT_TEXT),
    folderId: input.folderId === undefined ? undefined : optionalString(input.folderId, "folderId", MAX_SHORT_TEXT),
    include: Object.fromEntries(SET_FROM_ENCOUNTER_PARTS.map((part) => [part, include[part] === undefined ? true : Boolean(include[part])]))
  };
}

// 定型文: 指定した欄に差し込む文。
export function validatePhraseInput(input = {}) {
  return {
    phraseId: optionalString(input.phraseId, "phraseId", MAX_SHORT_TEXT),
    target: requiredEnum(input.target, PHRASE_TARGETS, "target"),
    label: optionalString(input.label, "label", 60),
    text: requiredString(input.text, "text", MAX_TEXT),
    active: input.active === undefined ? true : Boolean(input.active)
  };
}

export function validateEncounterContent(input = {}) {
  if (!isPlainObject(input)) {
    throw validationError("content must be an object", "content");
  }
  return {
    chiefComplaint: optionalText(input.chiefComplaint, "content.chiefComplaint"),
    history: optionalText(input.history, "content.history"),
    exam: validateExam(input.exam || {}),
    findings: validateFindings(input.findings || {}),
    sketches: validateSketches(input.sketches),
    diagnoses: validateDiagnoses(input.diagnoses),
    assessment: optionalText(input.assessment, "content.assessment"),
    plan: optionalText(input.plan, "content.plan"),
    prescriptions: validatePrescriptions(input.prescriptions),
    nextVisit: validateNextVisit(input.nextVisit || {}),
    staffNote: optionalText(input.staffNote, "content.staffNote"),
    orders: validateOrders(input.orders),
    flags: validateFlags(input.flags || {}),
    optical: validateOptical(input.optical || {}),
    // 検査記録は 1 件以上あるときだけ持たせる（古いカルテの形・内容ハッシュを変えないため）。
    ...optionalExamRecords(input.examRecords),
    // 追加の項目は、送られてきたときだけ持たせる（古いカルテの形・内容ハッシュを変えないため）。
    ...(hasKey(input, "counselling") ? { counselling: validateCounselling(input.counselling) } : {}),
    ...(hasKey(input, "adherence") ? { adherence: validateAdherence(input.adherence) } : {}),
    ...(hasKey(input, "findingsText") ? { findingsText: optionalText(input.findingsText, "content.findingsText", MAX_LONG_TEXT) } : {})
  };
}

function hasKey(input, key) {
  return Object.hasOwn(input, key) && input[key] !== undefined;
}

// 説明・同意の記録。何を（topics）・誰に（recipient）・同意（consent）・メモ。
function validateCounselling(value) {
  const input = value === null ? {} : value;
  if (!isPlainObject(input)) throw validationError("counselling must be an object", "content.counselling");
  const topics = optionalList(input.topics, "content.counselling.topics", COUNSELLING_TOPICS.length).map((item, index) => (
    requiredEnum(item, COUNSELLING_TOPICS, `content.counselling.topics.${index}`)
  ));
  return compactValues({
    topics: [...new Set(topics)],
    recipient: optionalEnum(input.recipient, COUNSELLING_RECIPIENTS, "content.counselling.recipient"),
    consent: optionalEnum(input.consent, CONSENT_VALUES, "content.counselling.consent"),
    note: optionalText(input.note, "content.counselling.note")
  });
}

// 点眼アドヒアランス（処方の近くで聞き取る）。
function validateAdherence(value) {
  const input = value === null ? {} : value;
  if (!isPlainObject(input)) throw validationError("adherence must be an object", "content.adherence");
  return compactValues({
    status: optionalEnum(input.status, ADHERENCE_VALUES, "content.adherence.status"),
    note: optionalString(input.note, "content.adherence.note", MAX_SHORT_TEXT)
  });
}

// 空の値（""・null・空配列・空オブジェクト）を落とす。
function compactValues(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmptyValue(value)));
}

function isEmptyValue(value) {
  if (value === "" || value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

// 眼鏡・コンタクトレンズの処方。発行するときの値の整合は確定前チェックで見る。
function validateOptical(input) {
  if (!isPlainObject(input)) throw validationError("optical must be an object", "content.optical");
  const side = (value, field) => {
    const item = isPlainObject(value) ? value : {};
    return {
      sphere: optionalNumber(item.sphere, `${field}.sphere`, { min: -30, max: 30 }),
      cylinder: optionalNumber(item.cylinder, `${field}.cylinder`, { min: -10, max: 10 }),
      axis: optionalNumber(item.axis, `${field}.axis`, { min: 0, max: 180, integer: true }),
      add: optionalNumber(item.add, `${field}.add`, { min: 0, max: 4 }),
      prism: optionalNumber(item.prism, `${field}.prism`, { min: 0, max: 20 }),
      base: optionalString(item.base, `${field}.base`, 20),
      bc: optionalNumber(item.bc, `${field}.bc`, { min: 6, max: 10 }),
      dia: optionalNumber(item.dia, `${field}.dia`, { min: 8, max: 16 }),
      product: optionalString(item.product, `${field}.product`, MAX_SHORT_TEXT),
      va: optionalString(item.va, `${field}.va`, 40)
    };
  };
  return {
    type: optionalEnum(input.type, OPTICAL_TYPES, "content.optical.type"),
    purpose: optionalEnum(input.purpose, OPTICAL_PURPOSES, "content.optical.purpose") || "far",
    od: side(input.od, "content.optical.od"),
    os: side(input.os, "content.optical.os"),
    pd: optionalNumber(input.pd, "content.optical.pd", { min: 40, max: 85 }),
    validDays: optionalNumber(input.validDays, "content.optical.validDays", { min: 1, max: 365, integer: true }),
    note: optionalString(input.note, "content.optical.note", MAX_SHORT_TEXT),
    issue: Boolean(input.issue),
    // 詳細は入力があるときだけ持たせる（未入力の古いデータの形を変えないため）。
    ...compactStrings({
      material: optionalEnum(input.material, OPTICAL_LENS_MATERIALS, "content.optical.material"),
      coating: optionalString(input.coating, "content.optical.coating", 40),
      tint: optionalString(input.tint, "content.optical.tint", 40),
      wearMode: optionalEnum(input.wearMode, OPTICAL_WEAR_MODES, "content.optical.wearMode"),
      wearSchedule: optionalEnum(input.wearSchedule, CL_WEAR_SCHEDULES, "content.optical.wearSchedule"),
      replacement: optionalEnum(input.replacement, CL_REPLACEMENTS, "content.optical.replacement")
    })
  };
}

function compactStrings(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

// 印刷用の氏名（職員ごと）。空にすると表示名から役割の括弧を除いた名前を使う。
export function validateStaffProfileInput(input = {}) {
  if (!isPlainObject(input)) throw validationError("body must be an object", "body");
  return { printName: optionalString(input.printName, "printName", MAX_PRINT_NAME) };
}

export function validateCreateFileInput(input = {}) {
  const size = optionalNumber(input.size, "size", { min: 1, max: 20 * 1024 * 1024, integer: true });
  if (size === null) throw validationError("size is required", "size");
  return {
    patientId: requiredString(input.patientId, "patientId", MAX_SHORT_TEXT),
    encounterId: optionalString(input.encounterId, "encounterId", MAX_SHORT_TEXT),
    kind: optionalEnum(input.kind, FILE_KINDS, "kind") || "other",
    eye: optionalEnum(input.eye, EYE_TARGETS, "eye"),
    takenOn: requiredDate(input.takenOn, "takenOn"),
    title: optionalString(input.title, "title", MAX_SHORT_TEXT),
    fileName: optionalString(input.fileName, "fileName", MAX_SHORT_TEXT),
    contentType: requiredEnum(input.contentType, ["application/pdf", "image/jpeg", "image/png", "image/webp"], "contentType"),
    size
  };
}

export function validateUpdateFileInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return {
    expectedRevision,
    kind: input.kind === undefined ? undefined : requiredEnum(input.kind, FILE_KINDS, "kind"),
    eye: input.eye === undefined ? undefined : optionalEnum(input.eye, EYE_TARGETS, "eye"),
    takenOn: input.takenOn === undefined ? undefined : requiredDate(input.takenOn, "takenOn"),
    title: input.title === undefined ? undefined : optionalString(input.title, "title", MAX_SHORT_TEXT),
    summary: input.summary === undefined ? undefined : optionalText(input.summary, "summary")
  };
}

export function validateCreateDocumentInput(input = {}) {
  return {
    patientId: requiredString(input.patientId, "patientId", MAX_SHORT_TEXT),
    encounterId: optionalString(input.encounterId, "encounterId", MAX_SHORT_TEXT),
    type: optionalEnum(input.type, DOCUMENT_TYPES, "type") || "referral"
  };
}

export function validateUpdateDocumentInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  const recipient = isPlainObject(input.recipient) ? input.recipient : {};
  return {
    expectedRevision,
    title: optionalString(input.title, "title", MAX_SHORT_TEXT),
    recipient: {
      institution: optionalString(recipient.institution, "recipient.institution", MAX_SHORT_TEXT),
      department: optionalString(recipient.department, "recipient.department", MAX_SHORT_TEXT),
      doctor: optionalString(recipient.doctor, "recipient.doctor", MAX_SHORT_TEXT),
      ...compactStrings({ honorific: optionalEnum(recipient.honorific, DOCUMENT_HONORIFICS, "recipient.honorific") })
    },
    body: optionalText(input.body, "body"),
    issueDate: optionalDate(input.issueDate, "issueDate")
  };
}

function validateOrders(value) {
  const rows = optionalList(value, "content.orders", MAX_ROWS).map((item, index) => {
    const field = `content.orders.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    const orderId = requiredString(item.orderId, `${field}.orderId`, MAX_SHORT_TEXT);
    if (item.kind === COMMENT_KIND) return { orderId, ...validateCommentRow(item, field) };
    return {
      orderId,
      code: optionalString(item.code, `${field}.code`, 60),
      name: optionalString(item.name, `${field}.name`, MAX_SHORT_TEXT),
      kind: optionalEnum(item.kind, ORDER_KINDS, `${field}.kind`) || "exam",
      eye: optionalEnum(item.eye, EYE_TARGETS, `${field}.eye`),
      status: optionalEnum(item.status, ORDER_STATUSES, `${field}.status`) || "planned",
      note: optionalString(item.note, `${field}.note`, MAX_SHORT_TEXT),
      statusChangedAt: optionalString(item.statusChangedAt, `${field}.statusChangedAt`, 40),
      statusChangedBy: isPlainObject(item.statusChangedBy) ? {
        memberId: optionalString(item.statusChangedBy.memberId, `${field}.statusChangedBy.memberId`, MAX_SHORT_TEXT),
        displayName: optionalString(item.statusChangedBy.displayName, `${field}.statusChangedBy.displayName`, MAX_SHORT_TEXT)
      } : null,
      // 前回の診療予定から作ったオーダーの、予定を立てたカルテ（予定から来たものだけ）。Rp（まとまり）と診療行為マスターのコード。入力があるときだけ持たせる。
      ...compactValues({
        sourceEncounterId: optionalString(item.sourceEncounterId, `${field}.sourceEncounterId`, MAX_SHORT_TEXT),
        rpId: optionalString(item.rpId, `${field}.rpId`, 60),
        procedureCode: optionalMasterCode(item.procedureCode, `${field}.procedureCode`)
      })
    };
  });
  return groupRows(rows);
}

// Rp の中のコメント行。どの Rp に付くかが分からないコメントは受け付けない。
function validateCommentRow(item, field) {
  const rpId = optionalString(item.rpId, `${field}.rpId`, 60);
  if (!rpId) throw validationError(`${field}.rpId is required for a comment row`, `${field}.rpId`);
  return {
    kind: COMMENT_KIND,
    rpId,
    text: optionalString(item.text, `${field}.text`, MAX_SHORT_TEXT),
    scope: optionalEnum(item.scope, COMMENT_SCOPES, `${field}.scope`) || "free"
  };
}

// 同じ rpId の行を、最初に出てきた位置にまとめる（Rp の中の順番はそのまま）。rpId の無い行は 1 行で 1 Rp。
function groupRows(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const key = row.rpId ? `rp:${row.rpId}` : `row:${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()].flat();
}

// マスターのコード（医薬品 9 桁、傷病名 7 桁、修飾語 4 桁、診療行為 9 桁）。英数字だけを受け付ける。
function optionalMasterCode(value, field) {
  const code = optionalString(value, field, 20);
  if (code && !/^[0-9A-Za-z]+$/u.test(code)) throw validationError(`${field} must be alphanumeric`, field);
  return code;
}

function validateFlags(input) {
  if (!isPlainObject(input)) throw validationError("flags must be an object", "content.flags");
  const startedAt = optionalString(input.dilationStartedAt, "content.flags.dilationStartedAt", 40);
  if (startedAt && Number.isNaN(Date.parse(startedAt))) {
    throw validationError("content.flags.dilationStartedAt must be an ISO timestamp", "content.flags.dilationStartedAt");
  }
  return {
    dilated: Boolean(input.dilated) || Boolean(startedAt),
    dilationStartedAt: startedAt,
    dilationEye: optionalEnum(input.dilationEye, EYE_TARGETS, "content.flags.dilationEye"),
    myopiaTreatment: Boolean(input.myopiaTreatment)
  };
}

export function validateExamConfirmInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  const eye = String(input.eye || "");
  if (!["od", "os", "both"].includes(eye)) throw validationError("eye must be od, os, or both", "eye");
  return { expectedRevision, eye, confirmed: input.confirmed !== false };
}

function validateExam(input) {
  if (!isPlainObject(input)) throw validationError("exam must be an object", "content.exam");
  const exam = Object.fromEntries(EYE_SIDES.map((side) => [side, validateEyeExam(input[side] || {}, `content.exam.${side}`)]));
  // 両眼で 1 つの値（RAPD・眼位・眼球運動）は od/os の外に置く。眼ごとの確認・前回値の写しの対象にしないため。
  const binocular = validateBinocular(input.binocular, "content.exam.binocular");
  return Object.keys(binocular).length ? { ...exam, binocular } : exam;
}

function validateBinocular(value, field) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw validationError(`${field} must be an object`, field);
  return compactValues({
    rapd: optionalEnum(value.rapd, RAPD_VALUES, `${field}.rapd`),
    alignment: optionalEnum(value.alignment, ALIGNMENT_VALUES, `${field}.alignment`),
    alignmentNote: optionalString(value.alignmentNote, `${field}.alignmentNote`, MAX_SHORT_TEXT),
    motility: optionalEnum(value.motility, MOTILITY_VALUES, `${field}.motility`),
    motilityNote: optionalString(value.motilityNote, `${field}.motilityNote`, MAX_SHORT_TEXT)
  });
}

function validateEyeExam(input, field) {
  if (!isPlainObject(input)) throw validationError(`${field} must be an object`, field);
  return {
    vaUncorrected: optionalString(input.vaUncorrected, `${field}.vaUncorrected`, 40),
    vaCorrected: optionalString(input.vaCorrected, `${field}.vaCorrected`, 40),
    correction: validateRefraction(input.correction || {}, `${field}.correction`),
    refraction: validateRefraction(input.refraction || {}, `${field}.refraction`),
    iop: optionalNumber(input.iop, `${field}.iop`, { min: 0, max: 90 }),
    iopMethod: optionalEnum(input.iopMethod, IOP_METHODS, `${field}.iopMethod`),
    vaCorrectionType: optionalEnum(input.vaCorrectionType, VA_CORRECTION_TYPES, `${field}.vaCorrectionType`),
    measuredAt: optionalTime(input.measuredAt, `${field}.measuredAt`),
    // 追加の検査値（近見視力・瞳孔・角膜曲率）。入力があるときだけ持たせる。
    ...compactValues({
      vaNear: optionalString(input.vaNear, `${field}.vaNear`, 40),
      pupil: validatePupil(input.pupil, `${field}.pupil`),
      keratometry: validateKeratometry(input.keratometry, `${field}.keratometry`)
    })
  };
}

// 瞳孔径（mm）と対光反射。散瞳の前に測る。
function validatePupil(value, field) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw validationError(`${field} must be an object`, field);
  return compactValues({
    sizeMm: optionalNumber(value.sizeMm, `${field}.sizeMm`, { min: 0.5, max: 12 }),
    reaction: optionalEnum(value.reaction, PUPIL_REACTIONS, `${field}.reaction`)
  });
}

// 角膜曲率。K1（弱主経線）・K2（強主経線）を屈折力（D）で、axis は K1 の軸（度）。
function validateKeratometry(value, field) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw validationError(`${field} must be an object`, field);
  return compactValues({
    k1: optionalNumber(value.k1, `${field}.k1`, { min: 30, max: 70 }),
    k2: optionalNumber(value.k2, `${field}.k2`, { min: 30, max: 70 }),
    axis: optionalNumber(value.axis, `${field}.axis`, { min: 0, max: 180, integer: true })
  });
}

function validateRefraction(input, field) {
  if (!isPlainObject(input)) throw validationError(`${field} must be an object`, field);
  return {
    sphere: optionalNumber(input.sphere, `${field}.sphere`, { min: -40, max: 40 }),
    cylinder: optionalNumber(input.cylinder, `${field}.cylinder`, { min: -20, max: 20 }),
    axis: optionalNumber(input.axis, `${field}.axis`, { min: 0, max: 180, integer: true })
  };
}

function validateFindings(input) {
  if (!isPlainObject(input)) throw validationError("findings must be an object", "content.findings");
  const findings = Object.fromEntries(EYE_SIDES.map((side) => {
    const value = input[side] || {};
    if (!isPlainObject(value)) throw validationError(`findings.${side} must be an object`, `content.findings.${side}`);
    const field = `content.findings.${side}`;
    return [side, {
      anterior: optionalText(value.anterior, `${field}.anterior`),
      lens: optionalText(value.lens, `${field}.lens`),
      fundus: optionalText(value.fundus, `${field}.fundus`),
      // 追加の所見（その他・C/D 比・隅角）。入力があるときだけ持たせる。
      ...compactValues({
        other: optionalText(value.other, `${field}.other`),
        cdRatio: optionalNumber(value.cdRatio, `${field}.cdRatio`, { min: 0, max: 1 }),
        angle: optionalString(value.angle, `${field}.angle`, 20),
        angleNote: optionalString(value.angleNote, `${field}.angleNote`, MAX_SHORT_TEXT)
      })
    }];
  }));
  // 両眼・全体（眼瞼・全身状態など）
  const general = optionalText(input.general, "content.findings.general");
  return general ? { ...findings, general } : findings;
}

function validateSketches(value) {
  const list = optionalList(value, "content.sketches", MAX_SKETCHES);
  let totalPoints = 0;
  return list.map((sketch, index) => {
    const field = `content.sketches.${index}`;
    if (!isPlainObject(sketch)) throw validationError(`${field} must be an object`, field);
    const strokes = optionalList(sketch.strokes, `${field}.strokes`, MAX_STROKES).map((stroke, strokeIndex) => {
      const strokeField = `${field}.strokes.${strokeIndex}`;
      if (!isPlainObject(stroke)) throw validationError(`${strokeField} must be an object`, strokeField);
      const points = normalizeStrokePoints(stroke.points, `${strokeField}.points`);
      totalPoints += points.length / 2;
      const tool = optionalEnum(stroke.tool, SKETCH_TOOLS, `${strokeField}.tool`);
      const text = tool === "text" ? optionalString(stroke.text, `${strokeField}.text`, 100) : "";
      const fill = tool === "ellipse" || tool === "rect" ? optionalEnum(stroke.fill, SKETCH_FILLS, `${strokeField}.fill`) : "";
      // 古いデータ（ペンのみ）は形を変えない: tool・text・fill は値があるときだけ持たせる
      return {
        color: optionalColor(stroke.color, `${strokeField}.color`) || "#1f2937",
        width: optionalNumber(stroke.width, `${strokeField}.width`, { min: 1, max: 40 }) ?? 3,
        points,
        ...(tool && tool !== "pen" ? { tool } : {}),
        ...(text ? { text } : {}),
        ...(fill ? { fill } : {})
      };
    });
    if (totalPoints > MAX_TOTAL_POINTS) {
      throw validationError("sketches are too detailed", "content.sketches");
    }
    return {
      sketchId: requiredString(sketch.sketchId, `${field}.sketchId`, MAX_SHORT_TEXT),
      template: optionalEnum(sketch.template, SKETCH_TEMPLATES, `${field}.template`) || "blank",
      eye: optionalEnum(sketch.eye, EYE_TARGETS, `${field}.eye`) || "ou",
      caption: optionalString(sketch.caption, `${field}.caption`, MAX_SHORT_TEXT),
      strokes
    };
  });
}

// Firestore は配列の入れ子を保存できないため、座標は [x1, y1, x2, y2, ...] の平らな配列で持つ。
// 入力は [[x, y], ...] の形も受け付ける。座標は 0〜1000 に正規化する。
function normalizeStrokePoints(value, field) {
  const list = value === undefined || value === null ? [] : value;
  if (!Array.isArray(list)) throw validationError(`${field} must be an array`, field);
  const flat = list.length > 0 && Array.isArray(list[0])
    ? list.flatMap((point) => {
      if (!Array.isArray(point) || point.length < 2) throw validationError(`${field} must contain [x, y] pairs`, field);
      return [point[0], point[1]];
    })
    : list;
  if (flat.length % 2 !== 0) throw validationError(`${field} must contain an even number of coordinates`, field);
  if (flat.length / 2 > MAX_POINTS_PER_STROKE) {
    throw validationError(`${field} must contain at most ${MAX_POINTS_PER_STROKE} points`, field);
  }
  return flat.map((coordinate) => clampInteger(coordinate, 0, 1000));
}

function validateDiagnoses(value) {
  return optionalList(value, "content.diagnoses", MAX_LIST).map((diagnosis, index) => {
    const field = `content.diagnoses.${index}`;
    if (!isPlainObject(diagnosis)) throw validationError(`${field} must be an object`, field);
    const { status, suspected } = diagnosisStatus(diagnosis, field);
    return {
      name: optionalString(diagnosis.name, `${field}.name`, MAX_SHORT_TEXT),
      eye: optionalEnum(diagnosis.eye, EYE_TARGETS, `${field}.eye`) || "ou",
      status,
      onsetDate: optionalDate(diagnosis.onsetDate, `${field}.onsetDate`),
      ...diagnosisCodes(diagnosis, field, suspected)
    };
  });
}

// 「疑い」は状態（継続・治癒）とは別のフラグ（疑いのまま転帰することがあるため）。
// 古いデータの status "suspected" は、継続中（active）の疑いとして読む。
export function diagnosisStatus(diagnosis = {}, field = "diagnosis") {
  const status = optionalEnum(diagnosis.status, DIAGNOSIS_STATUSES, `${field}.status`) || "active";
  const legacy = status === "suspected";
  return { status: legacy ? "active" : status, suspected: legacy || diagnosis.suspected === true };
}

export function isSuspectedDiagnosis(diagnosis = {}) {
  return diagnosis.suspected === true || diagnosis.status === "suspected";
}

// 傷病名コード・修飾語・疑い・診療科。入力があるときだけ持たせる（古いデータの形を変えないため）。
function diagnosisCodes(diagnosis, field, suspected) {
  const modifiers = optionalList(diagnosis.modifiers, `${field}.modifiers`, MAX_MODIFIERS).map((item, index) => {
    const itemField = `${field}.modifiers.${index}`;
    if (!isPlainObject(item)) throw validationError(`${itemField} must be an object`, itemField);
    const modifier = compactValues({
      code: optionalMasterCode(item.code, `${itemField}.code`),
      name: optionalString(item.name, `${itemField}.name`, 40),
      position: optionalEnum(item.position, MODIFIER_POSITIONS, `${itemField}.position`)
    });
    if (!modifier.code && !modifier.name) throw validationError(`${itemField} needs a code or a name`, itemField);
    return modifier;
  });
  return {
    ...compactValues({
      code: optionalMasterCode(diagnosis.code, `${field}.code`),
      modifiers,
      department: optionalString(diagnosis.department, `${field}.department`, 40)
    }),
    ...(suspected ? { suspected: true } : {})
  };
}

function validatePrescriptions(value) {
  const rows = optionalList(value, "content.prescriptions", MAX_ROWS).map((item, index) => {
    const field = `content.prescriptions.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    if (item.kind === COMMENT_KIND) return validateCommentRow(item, field);
    return {
      kind: optionalEnum(item.kind, PRESCRIPTION_KINDS, `${field}.kind`) || "eye_drop",
      name: optionalString(item.name, `${field}.name`, MAX_SHORT_TEXT),
      presetId: optionalString(item.presetId, `${field}.presetId`, MAX_SHORT_TEXT),
      eye: optionalEnum(item.eye, EYE_TARGETS, `${field}.eye`),
      timesPerDay: optionalNumber(item.timesPerDay, `${field}.timesPerDay`, { min: 0, max: 24, integer: true }),
      quantity: optionalNumber(item.quantity, `${field}.quantity`, { min: 0, max: 999 }),
      unit: optionalString(item.unit, `${field}.unit`, 20),
      days: optionalNumber(item.days, `${field}.days`, { min: 0, max: 365, integer: true }),
      note: optionalString(item.note, `${field}.note`, MAX_SHORT_TEXT),
      route: optionalEnum(item.route, PRESCRIPTION_ROUTES, `${field}.route`) || "outside",
      usage: optionalString(item.usage, `${field}.usage`, MAX_SHORT_TEXT),
      issued: item.issued === undefined ? true : Boolean(item.issued),
      // 前回から引き継いだまま、まだ今回の内容として確認していない処方
      carriedOver: Boolean(item.carriedOver),
      // Rp（まとまり）と医薬品マスターのコード。入力があるときだけ持たせる。
      ...compactValues({
        rpId: optionalString(item.rpId, `${field}.rpId`, 60),
        drugCode: optionalMasterCode(item.drugCode, `${field}.drugCode`)
      })
    };
  });
  return alignRpSharedFields(groupRows(rows));
}

// 同じ Rp の薬剤行は、用法・日数・院内外・回数・眼を先頭の薬剤行にそろえる（Rp で 1 つの指示）。
function alignRpSharedFields(rows) {
  const heads = new Map();
  return rows.map((row) => {
    if (!row.rpId || row.kind === COMMENT_KIND) return row;
    const head = heads.get(row.rpId);
    if (!head) {
      heads.set(row.rpId, row);
      return row;
    }
    return { ...row, ...Object.fromEntries(RP_SHARED_FIELDS.map((key) => [key, head[key]])) };
  });
}

function validateNextVisit(input) {
  if (!isPlainObject(input)) throw validationError("nextVisit must be an object", "content.nextVisit");
  const planItems = validatePlanItems(input.planItems, "content.nextVisit.planItems");
  return {
    intervalWeeks: optionalNumber(input.intervalWeeks, "content.nextVisit.intervalWeeks", { min: 0, max: 104 }),
    date: optionalDate(input.date, "content.nextVisit.date"),
    note: optionalString(input.note, "content.nextVisit.note", MAX_SHORT_TEXT),
    // 次回の診療予定（項目 × 部位）。1 件以上あるときだけ持たせる。
    ...(planItems.length ? { planItems } : {})
  };
}

export function validatePlanItems(value, field = "planItems") {
  return optionalList(value, field, MAX_LIST).map((item, index) => {
    const itemField = `${field}.${index}`;
    if (!isPlainObject(item)) throw validationError(`${itemField} must be an object`, itemField);
    const code = optionalString(item.code, `${itemField}.code`, 60);
    const name = optionalString(item.name, `${itemField}.name`, MAX_SHORT_TEXT);
    if (!code && !name) throw validationError(`${itemField} needs a code or a name`, `${itemField}.name`);
    return {
      code,
      name,
      eye: optionalEnum(item.eye, PLAN_ITEM_EYES, `${itemField}.eye`) || "none",
      ...compactValues({ comment: optionalString(item.comment, `${itemField}.comment`, MAX_SHORT_TEXT) })
    };
  });
}

// ---- 検査記録 ----
// Firestore は配列の入れ子を持てないため、測定の繰り返し（眼圧 3 回など）はオブジェクトの配列にする。

function optionalExamRecords(value) {
  if (value === undefined || value === null) return {};
  const records = validateExamRecords(value);
  return records.length ? { examRecords: records } : {};
}

export function validateExamRecords(value, field = "content.examRecords") {
  const records = optionalList(value, field, MAX_EXAM_RECORDS).map((item, index) => validateExamRecord(item, `${field}.${index}`));
  const ids = new Set();
  records.forEach((record, index) => {
    if (ids.has(record.recordId)) throw validationError(`${field}.${index}.recordId is duplicated`, `${field}.${index}.recordId`);
    ids.add(record.recordId);
  });
  return records;
}

// 保存されている記録（サーバーが付けた recordId・登録者・時刻を含む）の検証。
export function validateExamRecord(input, field = "examRecord") {
  if (!isPlainObject(input)) throw validationError(`${field} must be an object`, field);
  const at = requiredString(input.at, `${field}.at`, 40);
  if (Number.isNaN(Date.parse(at))) throw validationError(`${field}.at must be an ISO timestamp`, `${field}.at`);
  return {
    recordId: requiredString(input.recordId, `${field}.recordId`, MAX_SHORT_TEXT),
    at,
    source: optionalEnum(input.source, EXAM_RECORD_SOURCES, `${field}.source`) || "manual",
    examinerMemberId: optionalString(input.examinerMemberId, `${field}.examinerMemberId`, MAX_SHORT_TEXT),
    examinerName: optionalString(input.examinerName, `${field}.examinerName`, MAX_SHORT_TEXT),
    values: validateExamRecordValues(input.values, `${field}.values`),
    ...compactValues({
      note: optionalString(input.note, `${field}.note`, MAX_SHORT_TEXT),
      // カルテ画面（exam の直接編集）で消した項目の印。前の記録の値は残したまま、最新値だけを空にする。
      cleared: validateClearedPaths(input.cleared, `${field}.cleared`),
      recordedBy: validateActorRef(input.recordedBy, `${field}.recordedBy`),
      recordedAt: optionalString(input.recordedAt, `${field}.recordedAt`, 40),
      updatedBy: validateActorRef(input.updatedBy, `${field}.updatedBy`),
      updatedAt: optionalString(input.updatedAt, `${field}.updatedAt`, 40)
    })
  };
}

// API で受け取る新しい記録（partial=false）・記録の変更（partial=true）。recordId と登録者はサーバーが付ける。
// 変更で送らなかった項目は undefined のまま返す（今の値を残す）。
export function validateExamRecordInput(input = {}, { partial = false } = {}) {
  if (!isPlainObject(input)) throw validationError("body must be an object", "body");
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  const at = optionalString(input.at, "at", 40);
  if (at && Number.isNaN(Date.parse(at))) throw validationError("at must be an ISO timestamp", "at");
  const pick = (key, read) => (partial && input[key] === undefined ? undefined : read());
  return {
    expectedRevision,
    at: at ? new Date(Date.parse(at)).toISOString() : undefined,
    source: pick("source", () => optionalEnum(input.source, EXAM_RECORD_SOURCES, "source") || "manual"),
    examinerMemberId: pick("examinerMemberId", () => optionalString(input.examinerMemberId, "examinerMemberId", MAX_SHORT_TEXT)),
    examinerName: pick("examinerName", () => optionalString(input.examinerName, "examinerName", MAX_SHORT_TEXT)),
    note: pick("note", () => optionalString(input.note, "note", MAX_SHORT_TEXT)),
    values: pick("values", () => validateExamRecordValues(input.values, "values"))
  };
}

// exam の項目（記録から作る「最新値」の単位）。カルテ画面で消した印（cleared）もこの書き方で持つ。
export const EXAM_FIELD_PATHS = Object.freeze([
  ...EYE_SIDES.flatMap((side) => [
    "vaUncorrected", "vaCorrected", "vaCorrectionType", "correction", "refraction", "iop", "iopMethod", "measuredAt",
    "vaNear", "pupil", "keratometry"
  ].map((key) => `${side}.${key}`)),
  ...["rapd", "alignment", "alignmentNote", "motility", "motilityNote"].map((key) => `binocular.${key}`)
]);

function validateClearedPaths(value, field) {
  const list = optionalList(value, field, EXAM_FIELD_PATHS.length).map((item, index) => {
    const path = optionalString(item, `${field}.${index}`, 60);
    if (!EXAM_FIELD_PATHS.includes(path)) throw validationError(`${field}.${index} is not an exam field`, `${field}.${index}`);
    return path;
  });
  return [...new Set(list)];
}

function validateActorRef(value, field) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw validationError(`${field} must be an object`, field);
  return compactValues({
    memberId: optionalString(value.memberId, `${field}.memberId`, MAX_SHORT_TEXT),
    loginId: optionalString(value.loginId, `${field}.loginId`, MAX_SHORT_TEXT),
    displayName: optionalString(value.displayName, `${field}.displayName`, MAX_SHORT_TEXT)
  });
}

// 記録の値。トプコンの視力の表（遠見・近見 × R / L / B）、他覚屈折、角膜曲率、眼圧（3 回＋平均）、
// 瞳孔・眼位（両眼）、機器の値（オートレフ・ケラト・眼圧計）。どれも入力のある部分だけを持つ。
export function validateExamRecordValues(value, field = "values") {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw validationError(`${field} must be an object`, field);
  return compactValues({
    vision: validateVisionGrid(value.vision, `${field}.vision`),
    refraction: validateRecordRefraction(value.refraction, `${field}.refraction`),
    keratometry: perEye(value.keratometry, `${field}.keratometry`, validateKeratometry),
    iop: validateRecordIop(value.iop, `${field}.iop`),
    pupil: perEye(value.pupil, `${field}.pupil`, validatePupil),
    binocular: validateBinocular(value.binocular, `${field}.binocular`),
    devices: validateDevices(value.devices, `${field}.devices`),
    // 追加（2026-11 段階 2C）: 瞳孔間距離と、眼位・両眼視などの検査
    pd: validatePd(value.pd, `${field}.pd`),
    tests: validateExamTests(value.tests, `${field}.tests`)
  });
}

function validatePd(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  return compactValues({
    far: optionalNumber(input.far, `${field}.far`, { min: 40, max: 85 }),
    near: optionalNumber(input.near, `${field}.near`, { min: 40, max: 85 })
  });
}

function validateExamTests(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  const fixing = (raw, rawField) => optionalEnum(raw, EYE_SIDES, rawField);
  const worth = (() => {
    const item = requireObject(input.worth, `${field}.worth`);
    if (!item) return {};
    return compactValues({
      fixingEye: fixing(item.fixingEye, `${field}.worth.fixingEye`),
      distance: optionalEnum(item.distance, TEST_DISTANCES, `${field}.worth.distance`),
      pattern: optionalEnum(item.pattern, WORTH_PATTERNS, `${field}.worth.pattern`),
      note: optionalString(item.note, `${field}.worth.note`, MAX_SHORT_TEXT)
    });
  })();
  const cover = (() => {
    const item = requireObject(input.cover, `${field}.cover`);
    if (!item) return {};
    const row = (raw, rowField) => {
      const entry = requireObject(raw, rowField);
      if (!entry) return {};
      return compactValues({
        fixingEye: fixing(entry.fixingEye, `${rowField}.fixingEye`),
        kind: optionalEnum(entry.kind, COVER_KINDS, `${rowField}.kind`),
        direction: optionalEnum(entry.direction, COVER_DIRECTIONS, `${rowField}.direction`),
        amount: optionalString(entry.amount, `${rowField}.amount`, 20)
      });
    };
    return compactValues(Object.fromEntries(TEST_DISTANCES.map((distance) => [distance, row(item[distance], `${field}.cover.${distance}`)])));
  })();
  const nineGaze = (() => {
    const item = requireObject(input.nineGaze, `${field}.nineGaze`);
    if (!item) return {};
    const cells = requireObject(item.cells, `${field}.nineGaze.cells`) || {};
    for (const key of Object.keys(cells)) {
      if (!NINE_GAZE_DIRECTIONS.includes(key)) throw validationError(`${field}.nineGaze.cells.${key} is not a direction`, `${field}.nineGaze.cells.${key}`);
    }
    return compactValues({
      condition: optionalString(item.condition, `${field}.nineGaze.condition`, 40),
      cells: compactValues(Object.fromEntries(NINE_GAZE_DIRECTIONS.map((direction) => {
        const cellField = `${field}.nineGaze.cells.${direction}`;
        const cell = requireObject(cells[direction], cellField);
        if (!cell) return [direction, {}];
        return [direction, compactValues(Object.fromEntries(EYE_SIDES.map((side) => [side, optionalEnum(cell[side], NINE_GAZE_VALUES, `${cellField}.${side}`)])))];
      }))),
      note: optionalString(item.note, `${field}.nineGaze.note`, MAX_SHORT_TEXT)
    });
  })();
  const texts = Object.fromEntries(Object.entries(EXAM_TEXT_TESTS).map(([key, fields]) => {
    const item = requireObject(input[key], `${field}.${key}`);
    if (!item) return [key, {}];
    return [key, compactValues(Object.fromEntries(fields.map((name) => [name, optionalString(item[name], `${field}.${key}.${name}`, MAX_SHORT_TEXT)])))];
  }));
  return compactValues({ worth, cover, nineGaze, ...texts });
}

function requireObject(value, field) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw validationError(`${field} must be an object`, field);
  return value;
}

function perEye(value, field, validate) {
  const input = requireObject(value, field);
  if (!input) return {};
  return compactValues(Object.fromEntries(EYE_SIDES.map((side) => [side, validate(input[side], `${field}.${side}`)])));
}

function validateVisionGrid(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  const distance = (raw, distanceField) => {
    const row = requireObject(raw, distanceField);
    if (!row) return {};
    return compactValues({
      od: validateVisionRow(row.od, `${distanceField}.od`),
      os: validateVisionRow(row.os, `${distanceField}.os`),
      // B（両眼）は裸眼・矯正の視力だけ
      ou: validateBinocularVisionRow(row.ou, `${distanceField}.ou`)
    });
  };
  return compactValues({
    far: distance(input.far, `${field}.far`),
    near: distance(input.near, `${field}.near`),
    // 視標・条件など（グリッド左上のプルダウン）
    condition: optionalString(input.condition, `${field}.condition`, 40),
    comment: optionalText(input.comment, `${field}.comment`)
  });
}

function validateVisionRow(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  return compactValues({
    uncorrected: optionalString(input.uncorrected, `${field}.uncorrected`, 40),
    iolCl: optionalEnum(input.iolCl, IOL_CL_VALUES, `${field}.iolCl`),
    corrected: optionalString(input.corrected, `${field}.corrected`, 40),
    correctionType: optionalEnum(input.correctionType, VA_CORRECTION_TYPES, `${field}.correctionType`),
    sphere: optionalNumber(input.sphere, `${field}.sphere`, { min: -40, max: 40 }),
    cylinder: optionalNumber(input.cylinder, `${field}.cylinder`, { min: -20, max: 20 }),
    axis: optionalNumber(input.axis, `${field}.axis`, { min: 0, max: 180, integer: true }),
    rg: optionalString(input.rg, `${field}.rg`, 40)
  });
}

function validateBinocularVisionRow(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  return compactValues({
    uncorrected: optionalString(input.uncorrected, `${field}.uncorrected`, 40),
    corrected: optionalString(input.corrected, `${field}.corrected`, 40)
  });
}

function validateSca(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  return compactValues({
    sphere: optionalNumber(input.sphere, `${field}.sphere`, { min: -40, max: 40 }),
    cylinder: optionalNumber(input.cylinder, `${field}.cylinder`, { min: -20, max: 20 }),
    axis: optionalNumber(input.axis, `${field}.axis`, { min: 0, max: 180, integer: true })
  });
}

function validateRecordRefraction(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  return compactValues({
    od: validateSca(input.od, `${field}.od`),
    os: validateSca(input.os, `${field}.os`),
    source: optionalEnum(input.source, REFRACTION_SOURCES, `${field}.source`),
    device: optionalString(input.device, `${field}.device`, 60)
  });
}

// 眼圧: 眼ごとに最大 3 回の値と測定法・時刻。平均はここで計算して持つ（送られてきた平均は使わない）。
function validateRecordIop(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  const eye = (raw, eyeField) => {
    const item = requireObject(raw, eyeField);
    if (!item) return {};
    const readings = validateIopReadings(item.readings, `${eyeField}.readings`, MAX_IOP_READINGS);
    return compactValues({
      readings,
      average: averageOf(readings.map((reading) => reading.value)),
      method: optionalEnum(item.method, IOP_METHODS, `${eyeField}.method`),
      at: optionalTime(item.at, `${eyeField}.at`)
    });
  };
  return compactValues({
    od: eye(input.od, `${field}.od`),
    os: eye(input.os, `${field}.os`),
    comment: optionalString(input.comment, `${field}.comment`, MAX_SHORT_TEXT)
  });
}

function validateIopReadings(value, field, max) {
  return optionalList(value, field, max).map((item, index) => {
    const readingField = `${field}.${index}`;
    // 数値だけの配列（[15, 16]）も受け付け、保存はオブジェクトの配列にする。
    const raw = isPlainObject(item) ? item.value : item;
    const number = optionalNumber(raw, `${readingField}.value`, { min: 0, max: 90 });
    if (number === null) throw validationError(`${readingField}.value is required`, `${readingField}.value`);
    return { value: number };
  });
}

// 平均（2 回以上なら小数 1 桁に丸める。1 回ならその値のまま）。値がなければ null。
export function averageOf(values = []) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  if (numbers.length === 1) return numbers[0];
  return Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10;
}

// 機器の値（参照パネル用。exam には自動で採用しない）。
function validateDevices(value, field) {
  const input = requireObject(value, field);
  if (!input) return {};
  const panel = (raw, deviceField, eyeValidate, extra = () => ({})) => {
    const item = requireObject(raw, deviceField);
    if (!item) return {};
    return compactValues({
      device: optionalString(item.device, `${deviceField}.device`, 60),
      measuredAt: optionalString(item.measuredAt, `${deviceField}.measuredAt`, 40),
      raw: optionalText(item.raw, `${deviceField}.raw`),
      ...extra(item, deviceField),
      od: eyeValidate(item.od, `${deviceField}.od`),
      os: eyeValidate(item.os, `${deviceField}.os`)
    });
  };
  const autorefEye = (raw, eyeField) => {
    const item = requireObject(raw, eyeField);
    if (!item) return {};
    return compactValues({
      readings: optionalList(item.readings, `${eyeField}.readings`, MAX_DEVICE_READINGS)
        .map((reading, index) => validateSca(reading, `${eyeField}.readings.${index}`))
        .filter((reading) => Object.keys(reading).length),
      representative: validateSca(item.representative, `${eyeField}.representative`)
    });
  };
  const keratoEye = (raw, eyeField) => {
    const item = requireObject(raw, eyeField);
    if (!item) return {};
    return compactValues({
      ...validateKeratometry(item, eyeField),
      r1: optionalNumber(item.r1, `${eyeField}.r1`, { min: 5, max: 12 }),
      r2: optionalNumber(item.r2, `${eyeField}.r2`, { min: 5, max: 12 }),
      cylinder: optionalNumber(item.cylinder, `${eyeField}.cylinder`, { min: -20, max: 20 })
    });
  };
  const tonometerEye = (raw, eyeField) => {
    const item = requireObject(raw, eyeField);
    if (!item) return {};
    const readings = validateIopReadings(item.readings, `${eyeField}.readings`, MAX_DEVICE_READINGS);
    return compactValues({ readings, average: averageOf(readings.map((reading) => reading.value)) });
  };
  return compactValues({
    autoref: panel(input.autoref, `${field}.autoref`, autorefEye, (item, deviceField) => ({
      pd: optionalNumber(item.pd, `${deviceField}.pd`, { min: 40, max: 85 })
    })),
    kerato: panel(input.kerato, `${field}.kerato`, keratoEye),
    tonometer: panel(input.tonometer, `${field}.tonometer`, tonometerEye, (item, deviceField) => ({
      method: optionalEnum(item.method, IOP_METHODS, `${deviceField}.method`)
    }))
  });
}

// アレルギー・副作用の発症時期。YYYY または YYYY-MM（月は 01〜12）。空なら持たない。
export function allergyOnset(value, field) {
  const text = String(value ?? "").trim();
  if (!text) return {};
  if (!/^\d{4}(-(0[1-9]|1[0-2]))?$/u.test(text)) throw validationError(`${field} must be YYYY or YYYY-MM`, field);
  return { onset: text };
}

export function validatePatientProfileInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw validationError("expectedRevision must be zero or a positive integer", "expectedRevision");
  }
  const allergies = optionalList(input.allergies, "allergies", MAX_LIST).map((item, index) => {
    const field = `allergies.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    return {
      allergyId: optionalString(item.allergyId, `${field}.allergyId`, MAX_SHORT_TEXT),
      category: optionalEnum(item.category, ALLERGY_CATEGORIES, `${field}.category`) || "drug",
      substance: requiredString(item.substance, `${field}.substance`, MAX_SHORT_TEXT),
      reaction: optionalString(item.reaction, `${field}.reaction`, MAX_SHORT_TEXT),
      severity: optionalEnum(item.severity, ALLERGY_SEVERITIES, `${field}.severity`) || "unknown",
      // 発症時期（任意。YYYY または YYYY-MM）。値があるときだけ持つ
      ...allergyOnset(item.onset, `${field}.onset`)
    };
  });
  const noKnownAllergies = Boolean(input.noKnownAllergies);
  if (noKnownAllergies && allergies.length > 0) {
    throw validationError("noKnownAllergies cannot be set together with allergies", "noKnownAllergies");
  }
  const diagnoses = optionalList(input.diagnoses, "diagnoses", MAX_LIST).map((item, index) => {
    const field = `diagnoses.${index}`;
    if (!isPlainObject(item)) throw validationError(`${field} must be an object`, field);
    const { status, suspected } = diagnosisStatus(item, field);
    const startDate = optionalDate(item.startDate, `${field}.startDate`);
    const endDate = optionalDate(item.endDate, `${field}.endDate`);
    if (startDate && endDate && endDate < startDate) {
      throw validationError(`${field}.endDate must be on or after startDate`, `${field}.endDate`);
    }
    return {
      diagnosisId: optionalString(item.diagnosisId, `${field}.diagnosisId`, MAX_SHORT_TEXT),
      name: requiredString(item.name, `${field}.name`, MAX_SHORT_TEXT),
      eye: optionalEnum(item.eye, EYE_TARGETS, `${field}.eye`) || "ou",
      status,
      startDate,
      endDate,
      outcome: optionalEnum(item.outcome, DIAGNOSIS_OUTCOMES, `${field}.outcome`) || (status === "resolved" ? "cured" : ""),
      primary: Boolean(item.primary),
      note: optionalString(item.note, `${field}.note`, MAX_SHORT_TEXT),
      ...diagnosisCodes(item, field, suspected)
    };
  });
  return {
    expectedRevision,
    allergies,
    noKnownAllergies,
    diagnoses,
    medicalHistory: optionalText(input.medicalHistory, "medicalHistory"),
    ophthalmicHistory: optionalText(input.ophthalmicHistory, "ophthalmicHistory"),
    contactLensUser: Boolean(input.contactLensUser),
    // 患者メモ（受付・カルテで共通に見るメモ）。送らなかったときは undefined にし、保存済みの値を残す。
    patientMemo: input.patientMemo === undefined ? undefined : optionalText(input.patientMemo, "patientMemo")
  };
}

export function validateCreateAppointmentInput(input = {}) {
  const patientId = optionalString(input.patientId, "patientId", MAX_SHORT_TEXT);
  const patientName = optionalString(input.patientName, "patientName", MAX_SHORT_TEXT);
  if (!patientId && !patientName) {
    throw validationError("patientId or patientName is required", "patientId");
  }
  return {
    date: requiredDate(input.date, "date"),
    time: optionalTime(input.time, "time"),
    patientId,
    patientName,
    purpose: optionalEnum(input.purpose, APPOINTMENT_PURPOSES, "purpose") || "revisit",
    note: appointmentMemo(input) || "",
    doctorMemberId: optionalString(input.doctorMemberId, "doctorMemberId", MAX_SHORT_TEXT),
    department: optionalString(input.department, "department", MAX_APPOINTMENT_DEPARTMENT),
    walkIn: Boolean(input.walkIn),
    sourceEncounterId: optionalString(input.sourceEncounterId, "sourceEncounterId", MAX_SHORT_TEXT)
  };
}

// 受付メモ。保存する欄は従来の note のまま（古いデータがそのまま受付メモとして読める）。
// 新しい名前 receptionMemo でも受け付け、両方あるときは receptionMemo を使う。未指定は undefined。
function appointmentMemo(input) {
  if (input.receptionMemo !== undefined) {
    const memo = optionalText(input.receptionMemo === null ? "" : input.receptionMemo, "receptionMemo").trim();
    if (memo.length > MAX_APPOINTMENT_MEMO) throw validationError(`receptionMemo must be at most ${MAX_APPOINTMENT_MEMO} characters`, "receptionMemo");
    return memo;
  }
  if (input.note !== undefined) return optionalString(input.note, "note", MAX_APPOINTMENT_MEMO);
  return undefined;
}

export function validateUpdateAppointmentInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return {
    expectedRevision,
    date: input.date === undefined ? undefined : requiredDate(input.date, "date"),
    time: input.time === undefined ? undefined : optionalTime(input.time, "time"),
    patientId: input.patientId === undefined ? undefined : optionalString(input.patientId, "patientId", MAX_SHORT_TEXT),
    patientName: input.patientName === undefined ? undefined : optionalString(input.patientName, "patientName", MAX_SHORT_TEXT),
    purpose: input.purpose === undefined ? undefined : requiredEnum(input.purpose, APPOINTMENT_PURPOSES, "purpose"),
    note: appointmentMemo(input),
    doctorMemberId: input.doctorMemberId === undefined ? undefined : optionalString(input.doctorMemberId, "doctorMemberId", MAX_SHORT_TEXT),
    department: input.department === undefined ? undefined : optionalString(input.department, "department", MAX_APPOINTMENT_DEPARTMENT)
  };
}

export function validateAppointmentStatusInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  return {
    expectedRevision,
    status: requiredAppointmentStatus(input.status, "status")
  };
}

// 状態の名前を確かめ、古い値は新しい値に読み替える。再計待は派生なので選べない。
function requiredAppointmentStatus(value, field) {
  if (APPOINTMENT_DERIVED_STATUSES.includes(String(value ?? "").trim())) {
    throw validationError(`${field} ${value} is derived from billing and cannot be set`, field);
  }
  return normalizeAppointmentStatus(requiredEnum(value, APPOINTMENT_STATUSES, field));
}

// どこからどこへでも移れる。保存できない値（派生・古い値）への変更だけを拒む。
export function assertAppointmentTransition(from, to) {
  if (!(APPOINTMENT_TRANSITIONS[from] || STORABLE_APPOINTMENT_STATUSES).includes(to) && normalizeAppointmentStatus(from) !== to) {
    const error = validationError(`appointment cannot move from ${from} to ${to}`, "status");
    error.name = "ConflictError";
    error.statusCode = 409;
    throw error;
  }
}

// 診察終了（確定 → 受付の状態を進める → 次の患者）。nextStatus の既定は会計待。
export function validateCloseEncounterInput(input = {}) {
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw validationError("expectedRevision must be a positive integer", "expectedRevision");
  }
  const nextStatus = input.nextStatus === undefined || input.nextStatus === null || input.nextStatus === ""
    ? "checkout"
    : requiredAppointmentStatus(input.nextStatus, "nextStatus");
  if (nextStatus === "cancelled") throw validationError("a visit with a chart cannot be cancelled", "nextStatus");
  return {
    expectedRevision,
    nextStatus,
    appointmentId: optionalString(input.appointmentId, "appointmentId", MAX_SHORT_TEXT)
  };
}

// 1 人分の会計連携。
export function validateBillingSendInput(input = {}) {
  return {
    date: requiredDate(input.date, "date"),
    encounterId: requiredString(input.encounterId, "encounterId", MAX_SHORT_TEXT),
    appointmentId: optionalString(input.appointmentId, "appointmentId", MAX_SHORT_TEXT)
  };
}

// 予約状況（週 × 時間）の期間。両端を含み、最大 MAX_APPOINTMENT_RANGE_DAYS 日。
export function validateAppointmentRangeInput(input = {}) {
  const from = requiredDate(input.from, "from");
  const to = requiredDate(input.to, "to");
  if (to < from) throw validationError("to must be on or after from", "to");
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_APPOINTMENT_RANGE_DAYS) throw validationError(`the range must be at most ${MAX_APPOINTMENT_RANGE_DAYS} days`, "to");
  return { from, to, days, doctorMemberId: optionalString(input.doctorMemberId, "doctorMemberId", MAX_SHORT_TEXT) };
}

export function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.field = field;
  return error;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalList(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${field} must be an array`, field);
  if (value.length > max) throw validationError(`${field} must contain at most ${max} items`, field);
  return value;
}

function requiredString(value, field, max) {
  const normalized = optionalString(value, field, max);
  if (!normalized) throw validationError(`${field} is required`, field);
  return normalized;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw validationError(`${field} must be a string`, field);
  }
  const normalized = String(value).trim();
  if (normalized.length > max) throw validationError(`${field} must be at most ${max} characters`, field);
  return normalized;
}

function optionalText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw validationError(`${field} must be a string`, field);
  const normalized = value.replace(/\r\n?/gu, "\n").trimEnd();
  if (normalized.length > max) throw validationError(`${field} must be at most ${max} characters`, field);
  return normalized;
}

function optionalNumber(value, field, { min, max, integer = false }) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw validationError(`${field} must be a number`, field);
  if (integer && !Number.isInteger(number)) throw validationError(`${field} must be an integer`, field);
  if (number < min || number > max) throw validationError(`${field} must be between ${min} and ${max}`, field);
  return number;
}

function clampInteger(value, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function requiredDate(value, field) {
  const normalized = optionalDate(value, field);
  if (!normalized) throw validationError(`${field} is required`, field);
  return normalized;
}

function optionalDate(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!DATE_PATTERN.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw validationError(`${field} must be YYYY-MM-DD`, field);
  }
  return normalized;
}

function optionalTime(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(normalized)) throw validationError(`${field} must be HH:MM`, field);
  return normalized;
}

function requiredEnum(value, allowed, field) {
  const normalized = optionalEnum(value, allowed, field);
  if (!normalized) throw validationError(`${field} is required`, field);
  return normalized;
}

function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!allowed.includes(normalized)) {
    throw validationError(`${field} must be one of: ${allowed.join(", ")}`, field);
  }
  return normalized;
}

function optionalColor(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const normalized = String(value).trim();
  if (!/^#[0-9a-fA-F]{6}$/u.test(normalized)) throw validationError(`${field} must be #RRGGBB`, field);
  return normalized.toLowerCase();
}
