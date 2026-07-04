// 導入前 売上改善診断レポート。正規化claim(患者×月)に決定論点検を回し、
// 「算定もれ候補 / 査定・返戻リスク」を集約して成果物(サマリ+明細)にする。
// 点検ロジックは claim-checks.js を再利用。lookup/procedureMeta は注入(呼び出し側=CLIがPythonで解決)。

import {
  buildMissingBillingFindings,
  buildIndicationFindings
} from "./claim-checks.js";
import { estimateReceiptYen } from "./receipt-utils.js";

const ASSESSMENT_CATEGORIES = new Set(["医薬品適応", "診療行為適応"]);

function enrichClaimItems(claim = {}, procedureMeta = {}) {
  const items = Array.isArray(claim.items) ? claim.items : [];
  return {
    ...claim,
    items: items.map((item) => {
      const meta = procedureMeta[item.code];
      if (!meta) {
        return item;
      }
      return {
        ...item,
        name: item.name || meta.name || "",
        judgementKind: item.judgementKind || meta.judgementKind || "",
        judgementGroup: item.judgementGroup || meta.judgementGroup || ""
      };
    })
  };
}

function classifyFinding(finding) {
  if (finding.category === "算定もれ") {
    return "billing_miss";
  }
  if (ASSESSMENT_CATEGORIES.has(finding.category)) {
    return "assessment_risk";
  }
  return "other";
}

// claims: 正規化claim[]  /  options.lookup: check_lookupの戻り  /  options.procedureMeta: コード→判断区分メタ
export function buildClinicDiagnosisReport(claims = [], { lookup = {}, procedureMeta = {} } = {}) {
  const findings = [];
  const patientKeys = new Set();
  const months = new Set();

  for (const claim of Array.isArray(claims) ? claims : []) {
    if (claim.patientKey) {
      patientKeys.add(claim.patientKey);
    }
    if (claim.claimMonth) {
      months.add(claim.claimMonth);
    }
    const enriched = enrichClaimItems(claim, procedureMeta);
    const claimFindings = [
      ...buildMissingBillingFindings(enriched),
      ...buildIndicationFindings(enriched, lookup)
    ];
    for (const finding of claimFindings) {
      findings.push({
        ...finding,
        group: classifyFinding(finding),
        patientKey: claim.patientKey || "",
        claimMonth: claim.claimMonth || "",
        estimatedYen: Number.isFinite(Number(finding.points)) ? estimateReceiptYen(finding.points) : 0
      });
    }
  }

  const billingMiss = findings.filter((f) => f.group === "billing_miss");
  const assessmentRisk = findings.filter((f) => f.group === "assessment_risk");
  const byRule = {};
  for (const finding of findings) {
    const key = finding.ruleId || finding.ruleName || "unknown";
    if (!byRule[key]) {
      byRule[key] = { ruleId: finding.ruleId || "", ruleName: finding.ruleName || "", category: finding.category || "", count: 0 };
    }
    byRule[key].count += 1;
  }

  return {
    summary: {
      claimCount: Array.isArray(claims) ? claims.length : 0,
      patientCount: patientKeys.size,
      months: [...months].sort(),
      billingMissCount: billingMiss.length,
      billingMissEstimatedYen: billingMiss.reduce((sum, f) => sum + (Number(f.estimatedYen) || 0), 0),
      assessmentRiskCount: assessmentRisk.length,
      errorCount: findings.filter((f) => f.severity === "error").length
    },
    byRule: Object.values(byRule).sort((a, b) => b.count - a.count),
    findings
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

const SEVERITY_LABEL = Object.freeze({ error: "要修正", warning: "要確認", info: "候補" });

export function clinicDiagnosisReportToHtml(report = {}, { title = "売上改善診断レポート", subtitle = "" } = {}) {
  const summary = report.summary || {};
  const ruleRows = (report.byRule || [])
    .map((r) => `<tr><td>${escapeHtml(r.ruleName)}</td><td>${escapeHtml(r.category)}</td><td class="num">${r.count}</td></tr>`)
    .join("") || '<tr><td colspan="3">指摘はありません。</td></tr>';
  const findingRows = (report.findings || [])
    .map((f) => (
      `<tr class="g-${escapeHtml(f.group)}">`
      + `<td>${escapeHtml(f.patientKey)}</td>`
      + `<td>${escapeHtml(f.claimMonth)}</td>`
      + `<td class="sev sev-${escapeHtml(f.severity)}">${escapeHtml(SEVERITY_LABEL[f.severity] || f.severity)}</td>`
      + `<td>${escapeHtml(f.category)}</td>`
      + `<td>${escapeHtml(f.message)}</td>`
      + `<td>${escapeHtml(f.suggestion)}</td></tr>`
    ))
    .join("") || '<tr><td colspan="6">指摘はありません。</td></tr>';

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:'Noto Sans JP',system-ui,sans-serif;color:#111827;margin:24px;font-size:13px}
h1{font-size:1.4rem;margin:0 0 4px}.sub{color:#475467;font-size:12px;margin:0 0 12px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
.card{border:1px solid #e4e7ec;border-radius:10px;padding:10px 14px;min-width:150px}
.card .n{font-size:1.6rem;font-weight:800}.card .l{color:#64748b;font-size:11px}
table{width:100%;border-collapse:collapse;margin:8px 0 18px}th,td{border-top:1px solid #e4e7ec;padding:7px 8px;text-align:left;vertical-align:top}
th{color:#64748b;font-size:11px}td.num{text-align:right}
td.sev{font-weight:700}.sev-error{color:#b42318}.sev-warning{color:#b54708}.sev-info{color:#1d4ed8}
.note{color:#475467;font-size:11px}@media print{body{margin:0}}</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(subtitle)}</p>
<div class="cards">
  <div class="card"><div class="n">${summary.patientCount || 0}</div><div class="l">対象患者</div></div>
  <div class="card"><div class="n">${summary.claimCount || 0}</div><div class="l">対象レセ(患者×月)</div></div>
  <div class="card"><div class="n">${summary.billingMissCount || 0}</div><div class="l">算定もれ候補</div></div>
  <div class="card"><div class="n">${summary.assessmentRiskCount || 0}</div><div class="l">査定・返戻リスク</div></div>
  <div class="card"><div class="n">${summary.errorCount || 0}</div><div class="l">要修正(エラー)</div></div>
</div>
<p class="note">概算影響額は算定される点数×10円・総医療費ベースの概算です（患者負担・公費按分なし）。最終判断は告示・通知・審査取扱いに基づき医事課/診療部門で行ってください。</p>
<h2 style="font-size:1rem">指摘サマリ(ルール別)</h2>
<table><thead><tr><th>ルール</th><th>分類</th><th>件数</th></tr></thead><tbody>${ruleRows}</tbody></table>
<h2 style="font-size:1rem">明細</h2>
<table><thead><tr><th>患者</th><th>請求月</th><th>重大度</th><th>分類</th><th>指摘</th><th>対応の目安</th></tr></thead><tbody>${findingRows}</tbody></table>
</body></html>`;
}

export function clinicDiagnosisReportToCsv(report = {}) {
  const clean = (value) => String(value ?? "").replace(/[",\n]/gu, " ");
  const lines = ["患者,請求月,重大度,分類,ルール,指摘,対応の目安"];
  for (const f of report.findings || []) {
    lines.push([
      clean(f.patientKey), clean(f.claimMonth), clean(SEVERITY_LABEL[f.severity] || f.severity),
      clean(f.category), clean(f.ruleName), clean(f.message), clean(f.suggestion)
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}
