"""R06: 用量・投与日数チェック

1日最大用量の超過、投与日数制限(新薬14日・向精神薬30日/90日等)、
同一成分の合算過量、湿布薬の枚数制限を点検する。

データソース(優先順):
1. 支払基金チェックマスタ「医薬品適応関連マスタ」の最大投与量・最長投与日数
   (医薬品×傷病名×性別×年齢の粒度)および「投与量グループマスタ」
   (同一成分横断の合算上限) — masters.db
2. 施設ルール masters/data/iyakuhin.csv の max_daily_dose / days_limit

使用量の解釈(レセ電記録仕様):
  内服(21)の剤 … 使用量 = 1日分の量、回数 = 投与日数
  屯服(22) … 使用量 = 1回分の量、回数 = 回数
  外用(23)・注射(31〜33) … 使用量 = 1回(1剤)分の量
"""

from __future__ import annotations

from ..codes import CHUSHA_SHIKIBETSU, TOYAKU_SHIKIBETSU
from ..models import Receipt, Severity
from .base import CheckContext, Rule
from .helpers import age_matches, patient_age_years, sex_matches

# 湿布薬: 1処方あたり63枚制限(令和4年度改定で70枚→63枚)
SHIPPU_MONTHLY_LIMIT = 63
SHIPPU_KEYWORDS = ["湿布", "パップ", "テープ(鎮痛消炎", "鎮痛消炎テープ", "鎮痛消炎パップ"]

NAIFUKU = "21"
TONPUKU = "22"


def _daily_quantity(it) -> float | None:
    """1日量の推定(過大評価を避けるため保守的に判定する)。

    レセ電の記録仕様では、投薬の算定日情報は「処方した日」にその剤の回数
    (内服=投与日数、屯服=投与回数の全量)が記録されるため、
    「使用量 × 日別回数」は1日服用量ではなく処方全量になってしまう。
    そのため:
      内服(21)     … 使用量 = 1日量 → そのまま比較
      屯服(22)     … 使用量 = 1回量。1回量が1日上限を超えていれば確実に過量
      注射(31〜33) … 使用量 = 1回(1日)分 → そのまま比較
      外用(23)ほか … 使用量 = 投与総量のため1日量は不明 → 判定対象外
    """
    if it.quantity is None:
        return None
    if it.shinryo_shikibetsu in (NAIFUKU, TONPUKU) or it.shinryo_shikibetsu in CHUSHA_SHIKIBETSU:
        return it.quantity
    return None


def _applicable_dose_rows(rows, receipt, age, diseases):
    """患者条件(性別・年齢・傷病名)に該当する制限行に絞る"""
    out = []
    for disease_code, sex, age_min, age_max, check_kubun, max_dose, max_days, tekigi in rows:
        if check_kubun not in ("1", "2"):
            continue
        if not sex_matches(sex, receipt.sex):
            continue
        if not age_matches(age_min, age_max, age):
            continue
        if disease_code not in ("0000000", "0000001", "0000002", "0000003") and disease_code not in diseases:
            continue
        out.append((disease_code, check_kubun, max_dose, max_days, tekigi))
    return out


class DailyDoseRule(Rule):
    rule_id = "DO-001"
    name = "1日最大用量の超過"
    category = "用量・日数"
    description = "医薬品の1日量が支払基金チェックマスタの最大投与量を超えていないか点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        age = patient_age_years(receipt)
        diseases = {d.code for d in receipt.diseases if d.code}
        reported: set = set()

        for it in receipt.drugs:
            if not it.code or (it.code, it.line_no) in reported:
                continue
            daily = _daily_quantity(it)
            if daily is None:
                continue

            limit = None
            tekigi = ""
            unit = ""
            if official:
                rows = official.drug_dose_rules(it.code)
                applicable = [
                    r for r in _applicable_dose_rows(rows, receipt, age, diseases)
                    if r[2] is not None and r[2] < 99999.0
                ]
                if applicable:
                    # 最も緩い(大きい)上限を採用して過剰検知を防ぐ
                    best = max(applicable, key=lambda r: r[2])
                    limit = best[2]
                    tekigi = best[4]
                    m = official.drug(it.code)
                    unit = m["unit"] if m else ""
            if limit is None:
                m = ctx.masters.iyakuhin.get(it.code)
                if m and m.max_daily_dose is not None:
                    limit = m.max_daily_dose
                    unit = m.unit

            if limit is None or daily <= limit:
                continue
            reported.add((it.code, it.line_no))
            sev = Severity.INFO if tekigi == "01" else Severity.WARNING
            note = "(添付文書に「適宜増減」の記載があります)" if tekigi == "01" else ""
            out.append(
                self.make_finding(
                    receipt,
                    f"「{it.display_name}」の1日量 {daily:g}{unit} が最大投与量 {limit:g}{unit} を超えています{note}",
                    severity=sev,
                    target=it.display_name,
                    suggestion="用量の妥当性を確認してください。過量投与は査定事由B(過剰)の対象です。増量の医学的理由がある場合は症状詳記・コメントで説明してください。",
                )
            )
        return out


class DaysLimitRule(Rule):
    rule_id = "DO-002"
    name = "投与日数制限の超過"
    category = "用量・日数"
    description = "新薬(14日)・向精神薬(30日/90日)等の最長投与日数を超えていないか点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        age = patient_age_years(receipt)
        diseases = {d.code for d in receipt.diseases if d.code}
        # 投与日数制限は「1回の処方につき」の限度のため、月内合算ではなく
        # 処方(算定日)単位で判定する。算定日情報の各日の値がその処方の投与日数。
        max_days_by_code: dict = {}
        for it in receipt.drugs:
            if it.shinryo_shikibetsu != NAIFUKU or not it.code:
                continue
            if it.day_counts:
                per_shohou = max((c for c in it.day_counts if c), default=0)
            else:
                per_shohou = it.total_count  # 日情報なし: 単一処方とみなす
            cur = max_days_by_code.setdefault(it.code, {"days": 0, "item": it})
            if per_shohou > cur["days"]:
                cur["days"] = per_shohou
                cur["item"] = it

        for code, agg in max_days_by_code.items():
            it = agg["item"]
            days = agg["days"]
            limit = None
            label = ""
            if official:
                rows = official.drug_dose_rules(code)
                applicable = [
                    r for r in _applicable_dose_rows(rows, receipt, age, diseases)
                    if r[3] is not None and r[3] < 999
                ]
                if applicable:
                    limit = max(r[3] for r in applicable)
                m = official.drug(code)
                if m:
                    label = {"1": "麻薬", "2": "毒薬", "3": "覚醒剤原料", "5": "向精神薬"}.get(m["mayaku"], "")
            if limit is None:
                m2 = ctx.masters.iyakuhin.get(code)
                if m2 and m2.days_limit is not None:
                    limit = m2.days_limit
                    label = label or m2.narcotic_class

            if limit is None or days <= limit:
                continue
            note = f"({label})" if label else ""
            out.append(
                self.make_finding(
                    receipt,
                    f"「{it.display_name}」{note}が1回の処方で{days}日分処方されています(最長投与日数: {limit}日)",
                    target=it.display_name,
                    suggestion="投与日数制限(1回の処方につき)を確認してください。新医薬品は薬価収載から1年間は原則14日分が限度、一部の向精神薬・麻薬は30日または90日が限度です(長期渡航等のやむを得ない事情は摘要欄に理由記載)。",
                )
            )
        return out


class GroupDoseRule(Rule):
    rule_id = "DO-004"
    name = "同一成分の合算過量"
    category = "用量・日数"
    description = "同一成分(投与量グループ)の複数銘柄合算で1日最大量を超えていないか点検(支払基金チェックマスタ)"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        age = patient_age_years(receipt)
        diseases = {d.code for d in receipt.diseases if d.code}

        # グループ名 -> {total(成分量), unit, limit, drugs}
        groups: dict = {}
        for it in receipt.drugs:
            if it.shinryo_shikibetsu != NAIFUKU or not it.code or it.quantity is None:
                continue
            rows = official.toyoryo_groups(it.code)
            for gname, unit, dcode, sex, amin, amax, kikaku, flag, max_dose in rows:
                if flag not in ("2", "3"):
                    continue  # グループ合算チェック対象外
                if not sex_matches(sex, receipt.sex) or not age_matches(amin, amax, age):
                    continue
                if dcode not in ("0000000",) and dcode not in diseases:
                    continue
                if not kikaku or not max_dose or max_dose >= 99999999.0:
                    continue
                g = groups.setdefault(gname, {"total": 0.0, "unit": unit, "limit": max_dose, "drugs": set(), "counted": set()})
                key = (it.code, it.line_no)
                if key in g["counted"]:
                    continue
                g["counted"].add(key)
                g["total"] += it.quantity * kikaku  # 使用量(薬価単位) × 規格値 = 成分量
                g["drugs"].add(it.display_name)
                g["limit"] = max(g["limit"], max_dose)

        for gname, g in groups.items():
            if len(g["counted"]) >= 1 and g["total"] > g["limit"]:
                out.append(
                    self.make_finding(
                        receipt,
                        f"{gname}の1日合算量 {g['total']:g}{g['unit']} が上限 {g['limit']:g}{g['unit']} を超えています",
                        target="、".join(sorted(g["drugs"])),
                        detail="同一成分の複数銘柄・複数規格を合算した評価です(支払基金チェックマスタ・投与量グループ)。",
                        suggestion="重複処方・過量になっていないか確認してください。",
                    )
                )
        return out


class ShippuLimitRule(Rule):
    rule_id = "DO-003"
    name = "湿布薬の枚数制限"
    category = "用量・日数"
    description = f"湿布薬が1月あたり{SHIPPU_MONTHLY_LIMIT}枚を超えて投与されていないか点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        if receipt.is_inpatient:
            return out  # 制限は外来のみ

        # 63枚制限は「1処方につき」のため、処方日(算定日)ごとに枚数を集計する
        per_day: dict = {}    # 処方日 -> 合計枚数
        no_day_total = 0.0    # 算定日情報のない行の枚数(1処方相当として扱う)
        names = []
        has_reason_comment = False
        for it in receipt.drugs:
            name = it.resolved_name or ctx.masters.drug_name(it.code) or it.display_name
            is_shippu = any(kw in name for kw in SHIPPU_KEYWORDS)
            if not is_shippu and it.shinryo_shikibetsu == "23":
                # 外用の貼付剤(テープ・パップ)を名称から推定
                if ("テープ" in name or "パップ" in name) and ("ロキソプロフェン" in name or "ジクロフェナク" in name or "インドメタシン" in name or "フェルビナク" in name or "ケトプロフェン" in name or "サリチル酸" in name):
                    is_shippu = True
            if not is_shippu or not it.quantity:
                continue
            names.append(name)
            for code, _ in it.comments:
                if code == "830000052":  # 63枚超過理由コメント
                    has_reason_comment = True
            if it.day_counts:
                # 外用の使用量=その処方の総量。算定日の値は調剤回数。
                for d in it.days_used:
                    per_day[d] = per_day.get(d, 0.0) + it.quantity * it.day_counts[d - 1]
            else:
                no_day_total += it.quantity * max(it.total_count, 1)

        if has_reason_comment:
            return out
        over_days = {d: total for d, total in per_day.items() if total > SHIPPU_MONTHLY_LIMIT}
        for d, total in sorted(over_days.items()):
            out.append(
                self.make_finding(
                    receipt,
                    f"{d}日の処方で湿布薬(貼付剤)が合計{total:.0f}枚投与されています(1処方{SHIPPU_MONTHLY_LIMIT}枚まで)",
                    target="、".join(sorted(set(names))),
                    suggestion=f"1処方につき{SHIPPU_MONTHLY_LIMIT}枚が限度です。医師が必要と判断した場合は理由をコメントコード830000052で記載してください。",
                )
            )
        if not over_days and no_day_total > SHIPPU_MONTHLY_LIMIT:
            out.append(
                self.make_finding(
                    receipt,
                    f"湿布薬(貼付剤)が{no_day_total:.0f}枚投与されています(1処方{SHIPPU_MONTHLY_LIMIT}枚まで。算定日情報がないため処方単位の判定は概算)",
                    target="、".join(sorted(set(names))),
                    suggestion=f"1処方につき{SHIPPU_MONTHLY_LIMIT}枚が限度です。複数回処方の合計であれば問題ありません。",
                )
            )
        return out


RULES = [DailyDoseRule(), DaysLimitRule(), GroupDoseRule(), ShippuLimitRule()]
FILE_RULES = []
