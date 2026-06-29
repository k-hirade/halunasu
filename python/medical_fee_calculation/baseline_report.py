"""導入前 一括レセプト差分診断のバッチ集計とレポート生成。

baseline_diagnosis のコアを使い、複数の患者×月をまとめて診断し、
3分類(算定もれ候補/要確認/検討)の業務レポートを生成する(stdlibのみ)。

外向き表現は「増収」ではなく「確認対象点数 / 概算影響額(点数×10円・総医療費ベース)」。
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from html import escape

from medical_fee_calculation.baseline_diagnosis import (
    CATEGORY_CONSIDER,
    CATEGORY_LABELS,
    CATEGORY_MISSING,
    CATEGORY_REVIEW,
    ClaimDiagnosis,
    diagnose_claim,
    estimate_yen,
)

CATEGORY_ORDER = (CATEGORY_MISSING, CATEGORY_REVIEW, CATEGORY_CONSIDER)

YEN_DISCLAIMER = "概算影響額は点数×10円・総医療費ベースの概算です（負担割合・保険者按分は含みません）。"
JUDGEMENT_NOTE = "差分はすべて要確認です。実施事実・算定要件・施設基準・病名を確認のうえ判断してください。"


@dataclass(frozen=True)
class BatchDiagnosis:
    diagnoses: tuple[ClaimDiagnosis, ...]

    @property
    def patient_month_count(self) -> int:
        return len(self.diagnoses)

    def all_findings(self):
        for diagnosis in self.diagnoses:
            for finding in diagnosis.findings:
                yield diagnosis, finding

    def _count(self, category: str) -> int:
        return sum(len(diagnosis.findings_in(category)) for diagnosis in self.diagnoses)

    def summary(self) -> dict:
        missing_points = sum(diagnosis.missing_points for diagnosis in self.diagnoses)
        return {
            "patient_month_count": self.patient_month_count,
            "missing_candidate_count": self._count(CATEGORY_MISSING),
            "missing_candidate_points": missing_points,
            "missing_candidate_estimated_yen": estimate_yen(missing_points),
            "needs_review_count": self._count(CATEGORY_REVIEW),
            "consider_count": self._count(CATEGORY_CONSIDER),
            "baseline_total_points": sum(d.baseline_total_points for d in self.diagnoses),
            "engine_total_points": sum(d.engine_total_points for d in self.diagnoses),
        }


def diagnose_batch(pairs, **options) -> BatchDiagnosis:
    """(baselineClaim, engineClaim) の列を診断する。options は diagnose_claim へ委譲。"""
    diagnoses = tuple(diagnose_claim(baseline, engine, **options) for baseline, engine in pairs)
    return BatchDiagnosis(diagnoses=diagnoses)


def report_rows(batch: BatchDiagnosis) -> list[dict]:
    """所見をフラットな行に展開(CSV/TSV用)。分類→点数降順で並べる。"""
    rows = []
    for diagnosis, finding in batch.all_findings():
        rows.append({
            "patient_id": diagnosis.patient_id,
            "claim_month": diagnosis.claim_month,
            "category": finding.category_label,
            "code": finding.code,
            "name": finding.name,
            "points": finding.points,
            "estimated_yen": finding.estimated_yen,
            "side": finding.side,
            "reason": finding.reason,
            "detail": finding.detail,
        })
    rows.sort(key=lambda row: (CATEGORY_ORDER.index(_category_key(row["category"])), -float(row["points"] or 0)))
    return rows


def _category_key(label: str) -> str:
    for key, value in CATEGORY_LABELS.items():
        if value == label:
            return key
    return CATEGORY_CONSIDER


_COLUMNS = [
    ("patient_id", "患者"),
    ("claim_month", "請求月"),
    ("category", "分類"),
    ("code", "コード"),
    ("name", "名称"),
    ("points", "点数"),
    ("estimated_yen", "概算影響額(円)"),
    ("side", "差分側"),
    ("reason", "理由"),
    ("detail", "補足"),
]


def to_csv(batch: BatchDiagnosis) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([label for _key, label in _COLUMNS])
    for row in report_rows(batch):
        writer.writerow([row[key] for key, _label in _COLUMNS])
    return buffer.getvalue()


def to_tsv(batch: BatchDiagnosis) -> str:
    lines = ["\t".join(label for _key, label in _COLUMNS)]
    for row in report_rows(batch):
        lines.append("\t".join(str(row[key]) for key, _label in _COLUMNS))
    return "\n".join(lines) + "\n"


def to_markdown(batch: BatchDiagnosis) -> str:
    summary = batch.summary()
    lines = [
        "# レセプト差分診断レポート",
        "",
        f"- 対象: 患者×月 {summary['patient_month_count']}件",
        f"- 算定もれ候補: {summary['missing_candidate_count']}件 / {summary['missing_candidate_points']:g}点 / 約{summary['missing_candidate_estimated_yen']:,}円",
        f"- 要確認: {summary['needs_review_count']}件",
        f"- 検討: {summary['consider_count']}件",
        "",
        f"> {JUDGEMENT_NOTE}",
        f"> {YEN_DISCLAIMER}",
        "",
        "| 患者 | 請求月 | 分類 | コード | 名称 | 点数 | 概算影響額(円) | 理由 |",
        "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ]
    for row in report_rows(batch):
        lines.append(
            f"| {row['patient_id']} | {row['claim_month']} | {row['category']} | {row['code']} | "
            f"{row['name']} | {row['points']:g} | {row['estimated_yen']:,} | {row['reason']} |"
        )
    return "\n".join(lines) + "\n"


def to_html(batch: BatchDiagnosis) -> str:
    summary = batch.summary()
    cards = [
        ("対象 患者×月", f"{summary['patient_month_count']}件"),
        ("算定もれ候補", f"{summary['missing_candidate_count']}件 / {summary['missing_candidate_points']:g}点"),
        ("概算影響額", f"約{summary['missing_candidate_estimated_yen']:,}円"),
        ("要確認", f"{summary['needs_review_count']}件"),
        ("検討", f"{summary['consider_count']}件"),
    ]
    card_html = "".join(
        f'<div class="card"><span>{escape(label)}</span><strong>{escape(value)}</strong></div>'
        for label, value in cards
    )
    body_rows = []
    for row in report_rows(batch):
        category_key = _category_key(row["category"])
        body_rows.append(
            f'<tr class="cat-{category_key}">'
            f'<td>{escape(str(row["patient_id"]))}</td>'
            f'<td>{escape(str(row["claim_month"]))}</td>'
            f'<td class="cat">{escape(str(row["category"]))}</td>'
            f'<td>{escape(str(row["code"]))}</td>'
            f'<td>{escape(str(row["name"]))}</td>'
            f'<td class="num">{float(row["points"] or 0):g}</td>'
            f'<td class="num">{int(row["estimated_yen"] or 0):,}</td>'
            f'<td>{escape(str(row["reason"]))}</td>'
            "</tr>"
        )
    rows_html = "".join(body_rows) or '<tr><td colspan="8">差分はありません。</td></tr>'
    return f"""<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>レセプト差分診断レポート</title>
<style>
body{{font-family:'Noto Sans JP',system-ui,sans-serif;color:#111827;margin:24px;font-size:13px}}
h1{{font-size:1.4rem;margin:0 0 4px}}
.note{{color:#475467;font-size:12px;margin:2px 0}}
.cards{{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}}
.card{{border:1px solid #d8dee8;border-radius:8px;padding:10px 14px;min-width:120px}}
.card span{{display:block;color:#64748b;font-size:11px;font-weight:800}}
.card strong{{font-size:1.05rem}}
table{{width:100%;border-collapse:collapse;margin-top:8px}}
th,td{{border-top:1px solid #e4e7ec;padding:7px 8px;text-align:left;vertical-align:top}}
th{{color:#64748b;font-size:11px}}
td.num{{text-align:right;white-space:nowrap}}
td.cat{{font-weight:800}}
tr.cat-missing_candidate td.cat{{color:#1d4ed8}}
tr.cat-needs_review td.cat{{color:#b42318}}
tr.cat-consider td.cat{{color:#475467}}
@media print{{body{{margin:0}}}}
</style></head>
<body>
<h1>レセプト差分診断レポート</h1>
<p class="note">{escape(JUDGEMENT_NOTE)}</p>
<p class="note">{escape(YEN_DISCLAIMER)}</p>
<div class="cards">{card_html}</div>
<table>
<thead><tr><th>患者</th><th>請求月</th><th>分類</th><th>コード</th><th>名称</th><th>点数</th><th>概算影響額(円)</th><th>理由</th></tr></thead>
<tbody>{rows_html}</tbody>
</table>
</body></html>
"""
