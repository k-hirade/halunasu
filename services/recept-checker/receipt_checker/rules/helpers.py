"""ルール実装の共有ヘルパー"""

from __future__ import annotations

import datetime
from typing import Optional

from ..models import Receipt


def patient_age_years(receipt: Receipt) -> Optional[float]:
    """診療年月初日時点の年齢(歳、小数)"""
    b = receipt.birthdate_as_date()
    s = receipt.shinryo_ym_as_date()
    if not b or not s:
        return None
    return max((s - b).days / 365.25, 0.0)


def sex_matches(row_sex: str, patient_sex: str) -> bool:
    """チェックマスタの性別(0:共通 1:男 2:女)と患者性別(1/2)の照合"""
    row_sex = (row_sex or "0").strip() or "0"
    if row_sex == "0":
        return True
    return row_sex == patient_sex


def age_matches(age_min, age_max, age: Optional[float]) -> bool:
    """チェックマスタの年齢範囲([XXX.XX]、000.00〜999.99)と患者年齢の照合"""
    if age is None:
        return True  # 年齢不明なら通す(形式エラーは別ルールが指摘)
    if age_min is not None and age_min > 0 and age < age_min:
        return False
    if age_max is not None and age_max < 999 and age > age_max:
        return False
    return True


def disease_codes_of(receipt: Receipt, include_suspected: bool = True) -> set:
    """レセプトの傷病名コード集合"""
    out = set()
    for d in receipt.diseases:
        if not d.code or d.is_uncoded:
            continue
        if not include_suspected and d.is_suspected:
            continue
        out.add(d.code)
    return out


def suspected_only_codes(receipt: Receipt) -> set:
    """疑い病名としてのみ登録されている傷病名コード"""
    confirmed = disease_codes_of(receipt, include_suspected=False)
    all_codes = disease_codes_of(receipt, include_suspected=True)
    return all_codes - confirmed


def days_of_code(receipt: Receipt, code: str) -> set:
    """指定コードの算定日(1〜31)の集合(全行合算)"""
    days = set()
    for it in receipt.items:
        if it.code == code:
            days.update(it.days_used)
    return days


def total_count_of_code(receipt: Receipt, code: str) -> int:
    """指定コードの合計算定回数(全行合算)"""
    return sum(it.total_count for it in receipt.items if it.code == code)


def week_of_day(receipt: Receipt, day: int) -> Optional[datetime.date]:
    """診療月の日(1〜31)→ その日が属する週の日曜日の日付(週の識別キー)。

    診療報酬の「1週間につき」は日曜〜土曜の暦週で数えるため、
    ISO週(月曜起算)ではなく日曜起算でキーを作る。
    """
    base = receipt.shinryo_ym_as_date()
    if not base:
        return None
    try:
        d = datetime.date(base.year, base.month, day)
    except ValueError:
        return None
    return d - datetime.timedelta(days=(d.weekday() + 1) % 7)


def format_days(days) -> str:
    return "、".join(f"{d}日" for d in sorted(days))


# 算定日情報が記録されているか(日単位の判定が可能か)
def has_day_info(receipt: Receipt) -> bool:
    return any(it.day_counts for it in receipt.items)
