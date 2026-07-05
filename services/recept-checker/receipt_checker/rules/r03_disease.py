"""R03: 傷病名チェック

疑い病名の長期放置、重複病名、主傷病未設定、未コード化傷病名、
転帰の整合性、病名数過多など、審査で指摘されやすい傷病名の問題を点検する。
"""

from __future__ import annotations

from ..models import Receipt, Severity, months_between
from .base import CheckContext, Rule

# 疑い病名をこの月数を超えて放置していたら指摘
SUSPECTED_MONTHS_LIMIT = 3
# 急性疾患がこの月数を超えて「継続」だったら指摘
ACUTE_MONTHS_LIMIT = 3
# レセプト1件あたりの傷病名数がこれを超えたら整理を提案
DISEASE_COUNT_WARN = 20

ACUTE_KEYWORDS = ["急性", "感冒", "インフルエンザ", "急性上気道炎", "急性胃腸炎", "急性気管支炎"]


class SuspectedDiseaseRule(Rule):
    rule_id = "SY-001"
    name = "疑い病名の長期放置"
    category = "傷病名"
    description = f"診療開始日から{SUSPECTED_MONTHS_LIMIT}か月を超えて「疑い」のまま継続している傷病名を検出"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        shinryo = receipt.shinryo_ym_as_date()
        if not shinryo:
            return out
        for d in receipt.diseases:
            if not d.is_suspected or d.tenki not in ("", "1"):
                continue
            start = d.start_date_as_date()
            if not start:
                continue
            months = months_between(start, shinryo)
            if months > SUSPECTED_MONTHS_LIMIT:
                out.append(
                    self.make_finding(
                        receipt,
                        f"疑い病名「{d.display_name}」が診療開始から{months}か月経過しても確定・削除されていません",
                        target=d.display_name,
                        detail=f"診療開始日: {start}",
                        suggestion="確定病名への変更、または検査で否定されたなら転帰「中止」を記録してください。疑い病名の長期継続は縦覧点検での査定対象になりやすい項目です。",
                    )
                )
        return out


class AcuteDiseaseLongRule(Rule):
    rule_id = "SY-002"
    name = "急性疾患の長期継続"
    category = "傷病名"
    description = f"急性疾患が{ACUTE_MONTHS_LIMIT}か月を超えて転帰なく継続している場合に検出"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        shinryo = receipt.shinryo_ym_as_date()
        if not shinryo:
            return out
        for d in receipt.diseases:
            if d.tenki not in ("", "1"):
                continue
            name = d.display_name
            if not any(kw in name for kw in ACUTE_KEYWORDS):
                continue
            start = d.start_date_as_date()
            if not start:
                continue
            months = months_between(start, shinryo)
            if months > ACUTE_MONTHS_LIMIT:
                out.append(
                    self.make_finding(
                        receipt,
                        f"急性疾患「{name}」が{months}か月継続したままです(転帰未記録)",
                        target=name,
                        detail=f"診療開始日: {start}",
                        suggestion="治ゆ・中止の転帰を記録するか、慢性病名への変更を検討してください。",
                    )
                )
        return out


class DuplicateDiseaseRule(Rule):
    rule_id = "SY-003"
    name = "傷病名の重複"
    category = "傷病名"
    description = "同一コード・同一名称の傷病名が重複して記録されていないか点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        seen: dict = {}
        for d in receipt.diseases:
            # 診療開始日が異なるものは別エピソード(治ゆ後の再発等)なので重複としない
            key = (
                (d.code, d.modifiers, d.start_date)
                if not d.is_uncoded
                else ("uncoded", d.name, d.start_date)
            )
            if key in seen:
                out.append(
                    self.make_finding(
                        receipt,
                        f"傷病名「{d.display_name}」が重複して記録されています",
                        target=d.display_name,
                        suggestion="重複分を削除してください。",
                    )
                )
            seen[key] = d
        return out


class MainDiseaseRule(Rule):
    rule_id = "SY-004"
    name = "主傷病の未設定・複数設定"
    category = "傷病名"
    description = "主傷病が1件も設定されていない、または多数設定されているレセプトを検出"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        if not receipt.diseases:
            return out
        mains = receipt.main_diseases
        if not mains:
            out.append(
                self.make_finding(
                    receipt,
                    "主傷病が設定されていません",
                    suggestion="診療の中心となる傷病名に主傷病フラグを設定してください。医学管理料算定時は特に重要です。",
                )
            )
        elif len(mains) > 3:
            out.append(
                self.make_finding(
                    receipt,
                    f"主傷病が{len(mains)}件設定されています",
                    suggestion="主傷病は原則として診療の中心となる少数の傷病に絞ってください。",
                )
            )
        return out


class NoDiseaseRule(Rule):
    rule_id = "SY-005"
    name = "傷病名の未記録"
    category = "傷病名"
    description = "傷病名が1件もないレセプトを検出"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        if not receipt.diseases:
            return [
                self.make_finding(
                    receipt,
                    "傷病名が1件も記録されていません",
                    suggestion="診療内容に対応する傷病名を記録してください。傷病名のないレセプトは返戻対象です。",
                )
            ]
        return []


class UncodedDiseaseRule(Rule):
    rule_id = "SY-006"
    name = "未コード化傷病名(ワープロ病名)"
    category = "傷病名"
    description = "傷病名コード0000999(未コード化)の使用を検出し、コード化候補を提示"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        for d in receipt.diseases:
            if not d.is_uncoded:
                continue
            detail = ""
            official = ctx.masters.official
            if official and d.name:
                deco = official.decompose_uncoded_name(d.name)
                if deco:
                    cand = deco["candidates"][0]
                    parts = []
                    for code, name in deco["prefixes"]:
                        parts.append(f"接頭語{code}({name})")
                    parts.append(f"{cand[0]}({cand[1]})")
                    for code, name in deco["suffixes"]:
                        parts.append(f"接尾語{code}({name})")
                    match_note = "" if cand[2] == "exact" else "(部分一致)"
                    detail = f"コード化候補{match_note}: " + " + ".join(parts)
                    others = [f"{c}({n})" for c, n, _ in deco["candidates"][1:3]]
                    if others:
                        detail += f" / 他の候補: {'、'.join(others)}"
            out.append(
                self.make_finding(
                    receipt,
                    f"未コード化傷病名「{d.name or '(名称なし)'}」が使用されています",
                    target=d.name,
                    detail=detail,
                    suggestion="傷病名マスターの標準病名+修飾語への置き換えを検討してください。未コード化傷病名は審査で内容確認の対象になりやすく、支払基金も使用率の削減を求めています。",
                )
            )
        return out


class TenkiConsistencyRule(Rule):
    rule_id = "SY-007"
    name = "転帰の整合性"
    category = "傷病名"
    description = "死亡転帰が複数月続く等、転帰区分の不整合を点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        valid = {"", "1", "2", "3", "4"}
        for d in receipt.diseases:
            if d.tenki not in valid:
                out.append(
                    self.make_finding(
                        receipt,
                        f"傷病名「{d.display_name}」の転帰区分が不正です(値: {d.tenki})",
                        target=d.display_name,
                        detail="1:継続 2:治ゆ 3:死亡 4:中止(転医)",
                    )
                )
        # 死亡転帰があるのに他の傷病が全て継続扱い等の粗い矛盾は縦覧側で扱う
        return out


class TooManyDiseasesRule(Rule):
    rule_id = "SY-008"
    name = "傷病名数の過多"
    category = "傷病名"
    description = f"傷病名が{DISEASE_COUNT_WARN}件を超えるレセプトを検出(レセプト病名の疑い)"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        n = len(receipt.diseases)
        if n > DISEASE_COUNT_WARN:
            return [
                self.make_finding(
                    receipt,
                    f"傷病名が{n}件記録されています",
                    suggestion="治癒・中止済みの傷病名の整理を検討してください。傷病名の多いレセプトは「レセプト病名」を疑われ、審査で重点的に確認されます。",
                )
            ]
        return []


class SuspectedCuredRule(Rule):
    rule_id = "SY-009"
    name = "疑い病名への「治ゆ」転帰"
    category = "傷病名"
    description = "疑い病名に転帰「治ゆ」が付いている場合を検出(否定された疑いは「中止」が適切)"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        for d in receipt.diseases:
            if d.is_suspected and d.tenki == "2":
                out.append(
                    self.make_finding(
                        receipt,
                        f"疑い病名「{d.display_name}」の転帰が「治ゆ」になっています",
                        target=d.display_name,
                        suggestion="検査等で疑いが否定された場合の転帰は「中止」が適切です(個別指導の指摘事項:「治癒とするべきところ中止としている」等、転帰の誤りは指摘対象になります)。",
                    )
                )
        return out


RULES = [
    SuspectedDiseaseRule(),
    AcuteDiseaseLongRule(),
    DuplicateDiseaseRule(),
    MainDiseaseRule(),
    NoDiseaseRule(),
    UncodedDiseaseRule(),
    TenkiConsistencyRule(),
    TooManyDiseasesRule(),
    SuspectedCuredRule(),
]
FILE_RULES = []
