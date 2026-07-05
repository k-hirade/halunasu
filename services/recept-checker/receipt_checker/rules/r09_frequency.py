"""R09: 算定回数チェック

日・週・月・初診時・入院中などの算定単位ごとの回数上限、
診療実日数との整合、初診料と再診料の同日算定を点検する。

データソース(優先順):
1. 医科電子点数表「算定回数テーブル」(算定単位コード別の上限回数)
2. 医科診療行為マスターの上限回数・実日数区分
3. 施設ルール masters/data/frequency_limits.csv

複数月単位(2月に1回等)の完全な判定は縦覧点検(R12)で行い、
ここでは当月内で判定可能な違反(当月内で既に上限超過)を検出する。
"""

from __future__ import annotations

from ..models import Receipt, Severity
from .base import CheckContext, Rule
from .helpers import week_of_day

PERIOD_LABEL = {
    "day": "1日",
    "week": "1週間",
    "month": "1月",
    "once": "初回のみ",
}

# 算定単位コード(電子点数表・付表1)のうち当月内で判定できるもの
# mode: day=日単位で確定判定 / week=暦週(日〜土)で判定 /
#       month=月合計で確定判定 / month_soft=月合計超過は参考指摘(WARNING)
#       (初診時・検査当り等は同月内に複数回の契機があり得るため確定扱いにしない)
UNIT_SINGLE_MONTH = {
    "121": ("日", "day"),
    "131": ("月", "month"),
    "138": ("週", "week"),
    "132": ("入院初日", "month_soft"),
    "133": ("入院中", "month_soft"),
    "134": ("退院時", "month_soft"),
    "135": ("初回", "month"),
    "159": ("初診時", "month_soft"),
    "150": ("検査当り", "month_soft"),
    "53": ("患者当り", "month"),
}
# 14日間のスライディングウィンドウで判定するもの
UNIT_TWO_WEEKS = {"142": "2週"}
# 複数月単位(当月内合計が上限を超えていれば確実に違反)
UNIT_MULTI_MONTH = {
    "143": "2月", "144": "3月", "145": "4月",
    "146": "6月", "147": "12月", "148": "5年", "161": "2年", "162": "年度",
}


def _aggregate(receipt: Receipt) -> dict:
    """コード別の合計回数・日別回数を集計"""
    totals: dict = {}
    for it in receipt.acts:
        if not it.code:
            continue
        t = totals.setdefault(it.code, {"count": 0, "days": {}, "item": it})
        t["count"] += it.total_count
        for d in it.days_used:
            per_day = it.day_counts[d - 1] if it.day_counts else it.count
            t["days"][d] = t["days"].get(d, 0) + per_day
    return totals


class OfficialFrequencyRule(Rule):
    rule_id = "FQ-001"
    name = "算定回数制限の超過"
    category = "回数制限"
    description = "電子点数表の算定回数テーブル(日・週・月・初診時等)の上限超過を検出"
    default_severity = Severity.ERROR

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        totals = _aggregate(receipt)

        for code, t in totals.items():
            it = t["item"]
            name = it.display_name or code

            limits = official.kaisu_limits(code) if official else ()
            for unit_code, unit_name, max_count, tokurei in limits:
                if max_count is None or max_count <= 0:
                    continue
                sev = Severity.WARNING if tokurei == "1" else self.default_severity
                tokurei_note = "※特例条件あり(告示・通知を確認してください)。" if tokurei == "1" else ""

                if unit_code in UNIT_SINGLE_MONTH:
                    label, mode = UNIT_SINGLE_MONTH[unit_code]
                    if mode == "day":
                        for day, cnt in sorted(t["days"].items()):
                            if cnt > max_count:
                                out.append(
                                    self.make_finding(
                                        receipt,
                                        f"「{name}」が{day}日に{cnt}回算定されています(上限: 1日{max_count}回)",
                                        severity=sev,
                                        target=name,
                                        detail=f"電子点数表・算定回数テーブル(算定単位: {unit_name})。{tokurei_note}",
                                        suggestion="上限を超えた分は査定対象です。",
                                    )
                                )
                    elif mode == "week":
                        weeks: dict = {}
                        for day, cnt in t["days"].items():
                            wk = week_of_day(receipt, day)
                            if wk is not None:
                                weeks[wk] = weeks.get(wk, 0) + cnt
                        for _wk, cnt in weeks.items():
                            if cnt > max_count:
                                out.append(
                                    self.make_finding(
                                        receipt,
                                        f"「{name}」が同一週内に{cnt}回算定されています(上限: 週{max_count}回)",
                                        severity=Severity.WARNING,
                                        target=name,
                                        detail=f"電子点数表・算定回数テーブル。週の判定は暦週(月〜日)の近似です。{tokurei_note}",
                                    )
                                )
                        if not t["days"] and t["count"] > max_count:
                            out.append(
                                self.make_finding(
                                    receipt,
                                    f"「{name}」が月{t['count']}回算定されています(週{max_count}回制限)",
                                    severity=Severity.WARNING,
                                    target=name,
                                    detail=f"算定日情報がないため週単位の判定はできません。{tokurei_note}",
                                )
                            )
                    else:  # month / month_soft(月・初回・患者当り・初診時等)
                        if t["count"] > max_count:
                            soft = mode == "month_soft"
                            out.append(
                                self.make_finding(
                                    receipt,
                                    f"「{name}」が{t['count']}回算定されています(上限: {unit_name}{max_count}回)",
                                    severity=Severity.WARNING if soft else sev,
                                    target=name,
                                    detail=f"電子点数表・算定回数テーブル(算定単位: {unit_name})。"
                                           + ("算定単位の契機(初診・入院等)が同月内に複数あれば適法な場合があります。" if soft else "")
                                           + tokurei_note,
                                    suggestion="上限を超えた分は査定対象です。回数を確認してください。",
                                )
                            )
                elif unit_code in UNIT_TWO_WEEKS:
                    # 「2週間につき」: 任意の連続14日間の合計で判定
                    if t["days"]:
                        days_sorted = sorted(t["days"].items())
                        for i, (start_day, _c) in enumerate(days_sorted):
                            window_sum = sum(
                                c for d, c in days_sorted if start_day <= d < start_day + 14
                            )
                            if window_sum > max_count:
                                out.append(
                                    self.make_finding(
                                        receipt,
                                        f"「{name}」が14日間({start_day}日〜)に{window_sum}回算定されています(上限: 2週間に{max_count}回)",
                                        severity=Severity.WARNING,
                                        target=name,
                                        detail=f"電子点数表・算定回数テーブル(算定単位: 2週)。月をまたぐ通算は縦覧点検で確認されます。{tokurei_note}",
                                    )
                                )
                                break
                    elif t["count"] > max_count * 3:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"「{name}」が月{t['count']}回算定されています(2週間に{max_count}回制限)",
                                severity=Severity.WARNING,
                                target=name,
                                detail=f"算定日情報がないため2週間単位の判定はできません。{tokurei_note}",
                            )
                        )
                elif unit_code in UNIT_MULTI_MONTH:
                    label = UNIT_MULTI_MONTH[unit_code]
                    if t["count"] > max_count:
                        out.append(
                            self.make_finding(
                                receipt,
                                f"「{name}」が当月内に{t['count']}回算定されています(上限: {label}に{max_count}回)",
                                severity=sev,
                                target=name,
                                detail=f"当月内だけで{label}あたりの上限を超えています。過去月との通算は縦覧点検(LG-001)で確認されます。{tokurei_note}",
                                suggestion="縦覧点検の査定対象です。前回算定時期を確認してください。",
                            )
                        )

            # 基本マスターの上限回数(算定単位の明示なし)
            if official:
                m = official.act(code)
                if m and m.get("kaisu_limit") and t["count"] > m["kaisu_limit"]:
                    # 算定回数テーブルに同等の制限がある場合は重複指摘を避ける
                    if not any(mc and t["count"] > mc for _u, _n, mc, _t2 in limits):
                        out.append(
                            self.make_finding(
                                receipt,
                                f"「{name}」が{t['count']}回算定されています(マスター上限回数: {m['kaisu_limit']}回)",
                                severity=Severity.WARNING,
                                target=name,
                                detail="医科診療行為マスターの上限回数に基づく参考指摘です。",
                            )
                        )

            # 施設ルール(CSV)
            lim = ctx.masters.frequency_limits.get(code)
            if lim and lim.period in PERIOD_LABEL:
                if lim.period in ("month", "once") and t["count"] > lim.max_count:
                    label = "月" if lim.period == "month" else "初回のみ・"
                    out.append(
                        self.make_finding(
                            receipt,
                            f"「{name}」が月{t['count']}回算定されています(施設ルール上限: {label}{lim.max_count}回)",
                            target=name,
                            detail=lim.reason + ("※「初回のみ」の複数月判定は縦覧点検(LG-001)で行われます。" if lim.period == "once" else ""),
                        )
                    )
                elif lim.period == "day":
                    for day, cnt in t["days"].items():
                        if cnt > lim.max_count:
                            out.append(
                                self.make_finding(
                                    receipt,
                                    f"「{name}」が{day}日に{cnt}回算定されています(施設ルール上限: 1日{lim.max_count}回)",
                                    target=name,
                                    detail=lim.reason,
                                )
                            )
                elif lim.period == "week":
                    weeks: dict = {}
                    for day, cnt in t["days"].items():
                        wk = week_of_day(receipt, day)
                        if wk is not None:
                            weeks[wk] = weeks.get(wk, 0) + cnt
                    for _wk, cnt in weeks.items():
                        if cnt > lim.max_count:
                            out.append(
                                self.make_finding(
                                    receipt,
                                    f"「{name}」が同一週(日〜土)内に{cnt}回算定されています(施設ルール上限: 週{lim.max_count}回)",
                                    severity=Severity.WARNING,
                                    target=name,
                                    detail=lim.reason,
                                )
                            )
        return out


class JitsuNissuOverRule(Rule):
    rule_id = "FQ-003"
    name = "診療実日数を超える算定回数"
    category = "回数制限"
    description = "算定回数が診療実日数に関係する項目(初診・再診等)で、回数が実日数を超えていないか点検"
    default_severity = Severity.WARNING

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        official = ctx.masters.official
        if not official:
            return out
        days = receipt.jitsu_nissu
        if not days:
            return out
        totals = _aggregate(receipt)
        for code, t in totals.items():
            m = official.act(code)
            if not m or m.get("jitsu_nissu") not in ("1", "2"):
                continue
            if t["count"] > days:
                out.append(
                    self.make_finding(
                        receipt,
                        f"「{t['item'].display_name}」の算定回数({t['count']}回)が診療実日数({days}日)を超えています",
                        target=t["item"].display_name,
                        detail="この項目は算定回数が診療実日数以下である必要があります(医科診療行為マスター・実日数区分)。",
                        suggestion="回数または実日数の誤りを確認してください。",
                    )
                )
        return out


class SameDayFirstAndRevisitRule(Rule):
    rule_id = "FQ-002"
    name = "初診料と再診料の同日算定"
    category = "回数制限"
    description = "初診料と再診料(外来診療料)が同日に算定されていないか点検"
    default_severity = Severity.ERROR

    # フォールバック用(公的マスターがない場合)。
    # 「同日再診料」「同一日複数科2科目」等は同日算定が制度上の前提のため含めない。
    FIRST_VISIT_CODES = {"111000110", "111012510", "111012710"}
    REVISIT_CODES = {"112007410", "112011310"}

    # 同日算定が前提・適法となる名称パターン
    _SAME_DAY_OK = ("同日", "同一日複数科", "２科目", "2科目", "電話等再診")

    def _classify(self, ctx: CheckContext, code: str) -> str:
        """コードを 初診料本体 / 再診料本体 / その他 に分類。

        「同日再診料」(初診に引き続く同日再診)や「同一日複数科受診時の2科目」は
        同日算定が制度上想定されたコードのため対象外とする。
        """
        official = ctx.masters.official
        if official:
            m = official.act(code)
            if not m:
                return ""
            kubun = m.get("kubun") or ""
            name = m.get("name") or ""
            if "加算" in name or any(p in name for p in self._SAME_DAY_OK):
                return ""
            if kubun == "A000" and "初診料" in name:
                return "first"
            if kubun in ("A001", "A002") and ("再診料" in name or "外来診療料" in name):
                return "revisit"
            return ""
        if code in self.FIRST_VISIT_CODES:
            return "first"
        if code in self.REVISIT_CODES:
            return "revisit"
        return ""

    def check(self, receipt: Receipt, ctx: CheckContext) -> list:
        out = []
        first_days, revisit_days = set(), set()
        has_first = has_revisit = False
        for it in receipt.acts:
            cls = self._classify(ctx, it.code)
            if cls == "first":
                has_first = True
                first_days.update(it.days_used)
            elif cls == "revisit":
                has_revisit = True
                revisit_days.update(it.days_used)
        if not (has_first and has_revisit):
            return out
        overlap = first_days & revisit_days
        if overlap:
            out.append(
                self.make_finding(
                    receipt,
                    f"初診料と再診料(外来診療料)が同日({'、'.join(str(d) for d in sorted(overlap))}日)に算定されています",
                    suggestion="初診に引き続く同日の再受診(症状増悪等)は再診料を算定できますが、同一の初診に対して初診料と再診料を重複算定することはできません。同日複数科受診の場合は2科目の点数(146点/38点)を使用してください。",
                )
            )
        elif not first_days and not revisit_days:
            out.append(
                self.make_finding(
                    receipt,
                    "初診料と再診料(外来診療料)が同月に算定されています(算定日情報がないため同日か確認できません)",
                    severity=Severity.WARNING,
                    suggestion="同日算定になっていないか確認してください。",
                )
            )
        return out


RULES = [OfficialFrequencyRule(), JitsuNissuOverRule(), SameDayFirstAndRevisitRule()]
FILE_RULES = []
