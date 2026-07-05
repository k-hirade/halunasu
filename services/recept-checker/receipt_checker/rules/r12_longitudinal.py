"""R12: 縦覧点検(複数月チェック)

過去月のレセプト履歴(HistoryStore)と突合し、
複数月にまたがる算定ルール違反を点検する。
支払基金・国保連合会が平成24年から実施している縦覧点検に相当。

データソース:
1. 電子点数表「算定回数テーブル」の複数月単位(2月・3月・6月・12月・
   患者当り・初回等)の上限 — masters.db
2. 施設ルール masters/data/frequency_limits.csv(period=Nmonths)

履歴が保存されていない場合はスキップする(点検画面から履歴保存が可能)。
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule

# 初診料本体の判定(縦覧用の簡易セット。詳細判定はFQ-002と同じ分類関数)
FIRST_VISIT_CODES = {"111000110", "111011810", "111012510", "111012710"}

# 複数月単位の算定単位コード → 遡る月数(当月含む)
MULTI_MONTH_UNITS = {
    "143": ("2月", 2),
    "144": ("3月", 3),
    "145": ("4月", 4),
    "146": ("6月", 6),
    "147": ("12月", 12),
    "161": ("2年", 24),
    "148": ("5年", 60),
}
# 患者単位(過去全期間: 保存されている範囲で判定)
PATIENT_UNITS = {"53": "患者当り", "135": "初回", "151": "1疾患当り"}


def _past_count(past_months: list, code: str) -> tuple:
    """過去レセプトでの算定回数と算定月"""
    count = 0
    months = []
    for pm in past_months:
        for item in pm.get("items", []):
            if item.get("code") == code:
                count += item.get("count", 1)
                months.append(pm["shinryo_ym"])
    return count, sorted(set(months))


def _window_by_calendar(past_all: list, receipt: Receipt, span_months: int) -> list:
    """当月からカレンダー上でspan_months以内(当月含む)の過去レセプトに絞る。

    past_allは「履歴が存在する月」のみのリストのため、件数でスライスすると
    受診月に空きがある患者で実際より過去まで遡ってしまう。診療年月で絞る。
    """
    base = receipt.shinryo_ym_as_date()
    if not base:
        return []
    m0 = base.year * 12 + (base.month - 1) - (span_months - 1)
    floor_ym = f"{m0 // 12:04d}{m0 % 12 + 1:02d}"
    return [pm for pm in past_all if pm.get("shinryo_ym", "") >= floor_ym]


def _fmt_ym(ym: str) -> str:
    return f"{ym[:4]}年{int(ym[4:6])}月" if len(ym) == 6 else ym


class LongitudinalFrequencyRule(Rule):
    rule_id = "LG-001"
    name = "複数月にわたる回数制限超過(縦覧)"
    category = "縦覧点検"
    description = "「◯月に1回」「患者1人につき1回」等の制限を過去月の履歴と通算して点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        if ctx.history is None:
            return out
        official = ctx.masters.official
        facility = ctx.claim_file.facility.facility_code

        # 当月算定コードの集計
        current: dict = {}
        for it in receipt.acts:
            if it.code:
                current[it.code] = current.get(it.code, 0) + it.total_count
        if not current:
            return out

        past_all = ctx.history.past_months(facility, receipt, months_back=60)
        if not past_all:
            return out

        for code, cur_count in current.items():
            name = ctx.masters.act_name(code) or code

            # 電子点数表の複数月・患者単位制限
            limits = official.kaisu_limits(code) if official else ()
            for unit_code, unit_name, max_count, tokurei in limits:
                if max_count is None or max_count <= 0:
                    continue
                tokurei_note = "※特例条件あり(告示・通知を確認してください)。" if tokurei == "1" else ""

                if unit_code in MULTI_MONTH_UNITS:
                    label, span = MULTI_MONTH_UNITS[unit_code]
                    window = _window_by_calendar(past_all, receipt, span)
                    past_count, months = _past_count(window, code)
                    total = cur_count + past_count
                    if past_count > 0 and total > max_count:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"「{name}」が直近{label}で通算{total}回算定されています(上限: {label}に{max_count}回)",
                                target=name,
                                detail=f"過去の算定月: {'、'.join(_fmt_ym(m) for m in months)}。電子点数表・算定回数テーブル。{tokurei_note}",
                                suggestion="縦覧点検の査定対象です。前回算定月を確認してください。",
                            )
                        )
                elif unit_code in PATIENT_UNITS:
                    label = PATIENT_UNITS[unit_code]
                    past_count, months = _past_count(past_all, code)
                    total = cur_count + past_count
                    if past_count > 0 and total > max_count:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"「{name}」({label}{max_count}回)が過去にも算定されています(通算{total}回)",
                                target=name,
                                detail=f"過去の算定月: {'、'.join(_fmt_ym(m) for m in months)}。{tokurei_note}",
                                suggestion="患者1人あたりの回数制限を超えている可能性があります。縦覧点検の重点項目です。",
                            )
                        )

            # 施設ルール(period=Nmonths)
            lim = ctx.masters.frequency_limits.get(code)
            if lim and lim.period.endswith("months"):
                try:
                    span = int(lim.period.replace("months", ""))
                except ValueError:
                    continue
                window = _window_by_calendar(past_all, receipt, span)
                past_count, months = _past_count(window, code)
                total = cur_count + past_count
                if past_count > 0 and total > lim.max_count:
                    out.append(
                        self.make_finding(
                            receipt,
                            f"「{lim.name or name}」が直近{span}か月で{total}回算定されています(上限: {span}か月に{lim.max_count}回)",
                            target=lim.name or name,
                            detail=f"過去の算定月: {'、'.join(_fmt_ym(m) for m in months)}。{lim.reason}",
                            suggestion="縦覧点検で査定される可能性があります。",
                        )
                    )
        return out


class ReFirstVisitRule(Rule):
    rule_id = "LG-002"
    name = "短期間での初診料再算定(縦覧)"
    category = "縦覧点検"
    description = "前月以前に同一患者へ初診料を算定後、短期間で再び初診料を算定していないか点検"
    default_severity = Severity.WARNING

    LOOKBACK_MONTHS = 3

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        if ctx.history is None:
            return out
        current_first = [it for it in receipt.acts if it.code in FIRST_VISIT_CODES]
        if not current_first:
            return out
        past = ctx.history.past_months(
            ctx.claim_file.facility.facility_code, receipt,
            months_back=self.LOOKBACK_MONTHS,
        )
        for pm in past:
            for item in pm.get("items", []):
                if item.get("code") in FIRST_VISIT_CODES:
                    ym = pm["shinryo_ym"]
                    continuing = [
                        d for d in pm.get("diseases", [])
                        if d.get("tenki") in ("", "1")
                    ]
                    detail = ""
                    if continuing:
                        names = "、".join(d.get("name", "") for d in continuing[:3])
                        detail = f"前回レセプトで継続中(転帰未記録)の傷病: {names}"
                    out.append(
                        self.make_finding(
                            receipt,
                            f"{_fmt_ym(ym)}にも初診料が算定されています",
                            target="初診料",
                            detail=detail,
                            suggestion="前回の傷病が治ゆ・中止となった後の新たな受診であれば初診料を算定できますが、同一疾病の診療継続中は再診料での算定になります。縦覧点検の重点項目です。",
                        )
                    )
                    return out  # 1件指摘すれば十分
        return out


class SuspectedDiseaseCarryOverRule(Rule):
    rule_id = "LG-003"
    name = "疑い病名の複数月継続(縦覧)"
    category = "縦覧点検"
    description = "過去月から疑い病名が持ち越されたままになっていないか点検"
    default_severity = Severity.INFO

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        if ctx.history is None:
            return out
        past = ctx.history.past_months(
            ctx.claim_file.facility.facility_code, receipt, months_back=3
        )
        if not past:
            return out
        current_suspected = {
            d.code: d for d in receipt.diseases if d.is_suspected and d.code
        }
        if not current_suspected:
            return out
        for pm in past:
            for d in pm.get("diseases", []):
                code = d.get("code")
                if code in current_suspected and d.get("suspected"):
                    cur = current_suspected[code]
                    out.append(
                        self.make_finding(
                            receipt,
                            f"疑い病名「{cur.display_name}」が{_fmt_ym(pm['shinryo_ym'])}から継続しています",
                            target=cur.display_name,
                            suggestion="検査結果が出ているはずの疑い病名は、確定または中止(転帰)を記録してください。",
                        )
                    )
                    del current_suspected[code]
                    if not current_suspected:
                        return out
        return out


RULES = [
    LongitudinalFrequencyRule(),
    ReFirstVisitRule(),
    SuspectedDiseaseCarryOverRule(),
]
FILE_RULES = []
