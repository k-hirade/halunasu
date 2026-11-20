// 記載の型（医師ごとの主訴・所見のひな形。例「S)\nO)\nA)\nP)」）。医師ごとに 1 件を版つきで持つ。
//   GET /v1/eye/chart-templates            眼科の役割を持つ全員が読める。医師（の役割を持つ職員）ごとの型の一覧。
//   PUT /v1/eye/chart-templates/:memberId  { expectedRevision, text, active }。管理者はどの医師の型も、医師は自分の型だけ直せる
//                                          （セットと同じく EYE_SET_ROLES。管理者でない医師は自分の分だけ）。
// 新しいカルテを作るとき、主訴・所見が空なら担当医の型を入れる（chartTemplateForNewEncounter）。
// 担当医 = その日のその患者の予約・受付の担当医。無ければ、作った人が医師ならその人。

import { forbiddenError } from "../../../packages/auth-client/src/index.js";
import { EYE_SET_ROLES, EYE_SETTINGS_ROLES, validateChartTemplateInput } from "../../../packages/eye-contracts/src/index.js";
import { isActiveAppointment } from "./appointments.js";

const DOCTOR_ROLE = "doctor";

export function chartTemplateView(member, stored) {
  return {
    memberId: member.memberId,
    displayName: member.displayName || "",
    resolvedName: member.resolvedName || member.displayName || "",
    status: member.status || "active",
    text: stored?.text || "",
    active: stored ? stored.active !== false : false,
    revision: stored?.revision || 0,
    updatedAt: stored?.updatedAt || "",
    updatedBy: stored?.updatedBy || null
  };
}

// カルテで使う型（有効で文のあるものだけ）。起動時の bootstrap で画面へ渡す。
export function activeChartTemplates(stored = []) {
  return stored
    .filter((item) => item?.memberId && item.active !== false && String(item.text || "").trim())
    .map((item) => ({ memberId: item.memberId, text: item.text }));
}

export function buildChartTemplate(current, { memberId, text, active }, { actor, now }) {
  return {
    memberId,
    text,
    active,
    revision: (current?.revision || 0) + 1,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    updatedBy: actor,
    schemaVersion: 1
  };
}

// 新しいカルテの担当医。その日のその患者の予約（取消・不在を除く）の担当医を先に、無ければ作った人（医師のとき）。
export async function resolveTemplateDoctor({ eyeStore, orgId, patientId, encounterDate, actorMemberId, actorIsDoctor }) {
  const appointments = await Promise.resolve()
    .then(() => eyeStore.listPatientAppointments(orgId, patientId))
    .catch(() => []);
  const sameDay = (appointments || []).filter((item) => item.date === encounterDate && isActiveAppointment(item) && item.doctorMemberId);
  if (sameDay.length) return sameDay[0].doctorMemberId;
  return actorIsDoctor ? actorMemberId : "";
}

// 新しいカルテに入れる型の文。主訴・所見がすでにある（前回から写った・取り込み）ときは入れない（上書きしない）。
export async function chartTemplateForNewEncounter({ eyeStore, orgId, content, doctorMemberId }) {
  if (!doctorMemberId || String(content?.findingsText || "").trim()) return null;
  const stored = await Promise.resolve().then(() => eyeStore.getChartTemplate(orgId, doctorMemberId)).catch(() => null);
  if (!stored || stored.active === false || !String(stored.text || "").trim()) return null;
  return { memberId: doctorMemberId, text: stored.text };
}

export async function handleChartTemplateRoute({ method, parts, input, context, eyeStore, orgId, actor, now, audit, loadStaff, helpers }) {
  if (parts[0] !== "v1" || parts[1] !== "eye" || parts[2] !== "chart-templates") return null;
  const { ok, requireAccess, requireCsrf, hasAccess, notFound, badRequest } = helpers;

  if (method === "GET" && parts.length === 3) {
    const [staff, stored] = await Promise.all([loadStaff(), eyeStore.listChartTemplates(orgId)]);
    const byMember = new Map((stored || []).map((item) => [item.memberId, item]));
    // 医師の役割を持つ職員（停止中の人は型を保存していれば出す）
    const doctors = staff.filter((member) => member.eyeRoles.includes(DOCTOR_ROLE) && ((member.status || "active") === "active" || byMember.has(member.memberId)));
    return ok({
      templates: doctors.map((member) => chartTemplateView(member, byMember.get(member.memberId))),
      canEditAll: hasAccess(EYE_SETTINGS_ROLES),
      canEditOwn: hasAccess(EYE_SET_ROLES)
    });
  }

  if (method === "PUT" && parts.length === 4) {
    requireAccess(context, EYE_SET_ROLES, "Chart templates can be changed by doctors and administrators");
    requireCsrf(input.headers || {}, context.session);
    const memberId = parts[3];
    if (!hasAccess(EYE_SETTINGS_ROLES) && memberId !== context.session.memberId) throw forbiddenError("自分の記載の型だけを変えられます。");
    const validated = validateChartTemplateInput(input.body || {});
    const member = (await loadStaff()).find((item) => item.memberId === memberId);
    if (!member) throw notFound("staff member not found");
    if (!member.eyeRoles.includes(DOCTOR_ROLE)) throw badRequest("記載の型は医師ごとに設定します。", "memberId");
    const current = await eyeStore.getChartTemplate(orgId, memberId);
    const saved = await eyeStore.saveChartTemplate(orgId, buildChartTemplate(current, { memberId, text: validated.text, active: validated.active }, { actor, now }), validated.expectedRevision);
    // 本文は残さない（長さと有効かどうかだけ）
    await audit({ eventType: "eye.chart_template_saved", targetType: "chart_template", targetId: memberId, safePayload: { active: saved.active, length: saved.text.length } });
    return ok({ template: chartTemplateView(member, saved) });
  }

  return null;
}
