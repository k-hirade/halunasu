"""クレーム明細の決定論的な自動整合。

3つの汎用機構を提供する(いずれもマスタ/電子点数表のデータ駆動で、個別コード実装を持たない):

1. 年齢条件つき注加算の自動付与 (apply_notification_age_addons)
   マスタの注加算コード/通番(chu_addon_code/seq)と年齢条件(age_min/max_code)を使い、
   親項目が明細に立ったとき年齢条件を満たす注加算を自動付与する。
2. 電子点数表による確定側整合 (apply_electronic_consistency)
   背反(併算定不可)・回数上限超過・包括対象の劣後行を「合計から除外した要確認行」へ降格する。
   行は削除しない(利用者が採用し直せる)。
3. 年齢範囲ガード (apply_age_range_guard)
   患者年齢がマスタの年齢範囲外の行を降格する(誤確定防止)。

降格された行は excluded_from_total=True となり、エンジン合計・レセ案合計に入らない。
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import replace
from datetime import date

from medical_fee_calculation.claim_models import (
    CalculationLine,
    CalculationMessage,
    ClaimItemStatus,
)
from medical_fee_calculation.electronic_rules import ElectronicRuleResult

# 自動付与・降格の対象とする「合計に入っている」状態。
_COUNTED_STATUSES = {
    ClaimItemStatus.CONFIRMED,
    ClaimItemStatus.CANDIDATE,
    ClaimItemStatus.NEEDS_REVIEW,
}


# ---------------------------------------------------------------------------
# 1. 年齢条件つき注加算
# ---------------------------------------------------------------------------

def apply_notification_age_addons(
    conn: sqlite3.Connection,
    lines: tuple[CalculationLine, ...],
    *,
    patient_age_years: int | None,
    service_date: date,
    source_id: int | None = None,
) -> tuple[tuple[CalculationLine, ...], tuple[CalculationMessage, ...]]:
    """年齢条件を満たす注加算を親項目に対して自動付与する。

    v1の適用条件(保守的):
    - 患者年齢が既知
    - 加算行の年齢条件が数値コード(週齢・日齢等の特殊コードは対象外)で、範囲が非自明
    - 加算行に施設基準コードが無い(届出依存の加算は自動付与しない)
    同一親・同一年齢帯に複数候補がある場合は上限年齢が最も小さい(最も特定的な)ものを選ぶ。
    """

    if patient_age_years is None or not lines:
        return (), ()

    parent_lines = [
        line for line in lines
        if line.code and line.status in _COUNTED_STATUSES and not line.excluded_from_total
    ]
    if not parent_lines:
        return (), ()

    existing_codes = {line.code for line in lines if line.code}
    added: list[CalculationLine] = []
    messages: list[CalculationMessage] = []
    service_date_text = service_date.isoformat()
    source_sql = "AND source_id = ?" if source_id is not None else ""

    for parent in parent_lines:
        # 親子関係はマスタの注加算コード(グループ)/通番で結線する。
        # 通番0=親項目、通番1以上=その注に規定された加算メンバー。
        # 区分番号だけのグルーピングは「乳幼児時間外加算」等の選択・置換関係の
        # 兄弟行を加算と誤認し過大算定になるため使わない。
        group = conn.execute(
            f"""
            SELECT chu_addon_code, chu_addon_seq
            FROM medical_procedures
            WHERE code = ? {source_sql}
            LIMIT 1
            """,
            (parent.code, *((source_id,) if source_id is not None else ())),
        ).fetchone()
        addon_group = str(group["chu_addon_code"] or "").strip() if group else ""
        if not addon_group or addon_group == "0":
            continue
        parent_seq = str(group["chu_addon_seq"] or "0").strip() or "0"
        if parent_seq != "0":
            continue  # 親項目(通番0)のみを起点にする
        candidates = conn.execute(
            f"""
            SELECT code, short_name, points, age_min_code, age_max_code, facility_standard_codes
            FROM medical_procedures
            WHERE chu_addon_code = ?
              AND COALESCE(chu_addon_seq, '0') NOT IN ('', '0')
              AND (effective_from IS NULL OR effective_from <= ?)
              AND (effective_to IS NULL OR effective_to >= ?)
              {source_sql}
            ORDER BY code
            """,
            (
                addon_group,
                service_date_text, service_date_text,
                *((source_id,) if source_id is not None else ()),
            ),
        ).fetchall()

        eligible = []
        for row in candidates:
            code = str(row["code"] or "")
            if not code or code in existing_codes or code == parent.code:
                continue
            age_range = _numeric_age_range(row["age_min_code"], row["age_max_code"])
            if age_range is None:
                continue  # 年齢条件なし/特殊コード → v1では自動付与しない
            age_min, age_max = age_range
            if not (age_min <= patient_age_years < age_max):
                continue
            standards = str(row["facility_standard_codes"] or "").strip()
            if standards and standards not in ("[]", ""):
                continue  # 届出依存の加算は自動付与しない
            eligible.append((age_max, row))

        if not eligible:
            continue
        # 最も特定的(上限年齢が小さい)加算を1つだけ付与する。
        eligible.sort(key=lambda item: item[0])
        _age_max, row = eligible[0]
        code = str(row["code"])
        existing_codes.add(code)
        added.append(
            CalculationLine(
                code=code,
                name=str(row["short_name"] or ""),
                points=float(row["points"] or 0),
                quantity=parent.quantity,
                status=parent.status,
                reason=(
                    f"注加算の自動付与: {parent.name}(患者{patient_age_years}歳)の年齢条件を満たすため付与しました"
                ),
                source="notification_age_addon",
                excluded_from_total=parent.excluded_from_total,
            )
        )
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=code,
                message=(
                    f"注加算自動付与: {row['short_name']}を{parent.name}へ年齢条件(患者{patient_age_years}歳)により自動付与しました。実施内容を確認してください。"
                ),
                source="notification_age_addon",
            )
        )

    return tuple(added), tuple(messages)


def _numeric_age_range(age_min_code: object, age_max_code: object) -> tuple[int, int] | None:
    """数値の年齢コードだけを扱う。'00'は「条件なし」。特殊コード(AA=日齢等)はNone。"""
    min_text = str(age_min_code or "").strip()
    max_text = str(age_max_code or "").strip()
    if max_text in ("", "00", "0") and min_text in ("", "00", "0"):
        return None
    try:
        age_min = int(min_text) if min_text not in ("", "00", "0") else 0
        age_max = int(max_text) if max_text not in ("", "00", "0") else 200
    except ValueError:
        return None
    return (age_min, age_max)


# ---------------------------------------------------------------------------
# 2. 電子点数表による確定側整合(背反・回数・包括)
# ---------------------------------------------------------------------------

def apply_electronic_consistency(
    lines: tuple[CalculationLine, ...],
    electronic_rules: ElectronicRuleResult,
) -> tuple[tuple[CalculationLine, ...], tuple[CalculationMessage, ...]]:
    """背反・回数超過・包括の劣後行を合計から除外した要確認行へ降格する。

    - 背反(同日): rule_kind '1'=①を算定(②を降格) / '2'=②を算定(①を降格) /
      '3'=いずれか一方(点数が低い側を降格)。両コードが本クレームに存在する場合のみ。
    - 回数上限超過: 履歴により上限到達済みのコードの行を降格。
    - 包括: 基本項目が存在する場合、包括対象行を降格。
    行削除はしない(利用者は要確認行を確認のうえ採用し直せる)。
    """

    if not lines:
        return lines, ()

    adjusted = list(lines)
    messages: list[CalculationMessage] = []
    index_by_code: dict[str, list[int]] = {}
    for index, line in enumerate(adjusted):
        if line.code:
            index_by_code.setdefault(line.code, []).append(index)

    def counted(code: str) -> int | None:
        for index in index_by_code.get(code, []):
            line = adjusted[index]
            if line.status in _COUNTED_STATUSES and not line.excluded_from_total:
                return index
        return None

    def demote(index: int, reason: str, source: str) -> None:
        line = adjusted[index]
        adjusted[index] = replace(
            line,
            status=ClaimItemStatus.NEEDS_REVIEW,
            review_required=True,
            excluded_from_total=True,
            reason=reason,
        )
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=line.code,
                message=reason,
                source=source,
            )
        )

    # 背反(同一クレーム内で確定できる「同時」「同日」スコープのみ。
    # 同月・同週背反は履歴の完全性に依存するため警告に留める)
    # 特例区分=1(条件次第で併算定可。同日・同時で9,824件)は条件を機械評価できないため
    # 自動降格せず、既存の警告のみに委ねる。
    for hit in sorted(electronic_rules.exclusions, key=lambda h: (h.base_code, h.excluded_code)):
        if hit.scope not in ("same_day", "simultaneous") or hit.matched_from != "current":
            continue
        if str(getattr(hit, "special_condition", "0") or "0") == "1":
            continue
        base_index = counted(hit.base_code)
        excluded_index = counted(hit.excluded_code)
        if base_index is None or excluded_index is None:
            continue
        if hit.rule_kind == "1":
            loser = excluded_index
        elif hit.rule_kind == "2":
            loser = base_index
        else:
            loser = (
                excluded_index
                if adjusted[excluded_index].total_points <= adjusted[base_index].total_points
                else base_index
            )
        survivor = base_index if loser == excluded_index else excluded_index
        demote(
            loser,
            f"併算定不可(背反)のため合計から除外: {adjusted[survivor].name}と同日に算定できません。"
            "別部位・別傷病等の要件を満たす場合は確認のうえ採用してください。",
            "electronic_exclusion_consistency",
        )

    # 回数上限超過。set形式の履歴は原則警告に留めるが、「最低1回」という下限だけで
    # 超過を確定できる場合は自動降格する。
    for breach in electronic_rules.frequency_limit_breaches:
        if not breach.limit_exceeded_certain:
            continue
        index = counted(breach.procedure_code)
        if index is None:
            continue
        current_quantity = float(breach.current_quantity or 0)
        current_quantity_text = (
            str(int(current_quantity))
            if current_quantity.is_integer()
            else str(current_quantity)
        )
        history_occurrences = float(breach.history_occurrences or 0)
        history_occurrences_text = (
            str(int(history_occurrences))
            if history_occurrences.is_integer()
            else str(history_occurrences)
        )
        if not breach.occurrence_count_known:
            history_occurrences_text += "以上"
        demote(
            index,
            f"算定回数上限のため合計から除外: {breach.procedure_name}は{breach.limit_name}の"
            f"上限{breach.limit_count}回を超えます(期間内履歴{history_occurrences_text}回・"
            f"当該請求{current_quantity_text}回、直近: {breach.matched_service_date or '同一期間内'})。"
            "要件を満たす場合は確認のうえ採用してください。",
            "electronic_frequency_consistency",
        )

    # 包括(基本項目が本クレームに存在する場合、包括対象を除外)
    # applicability=1(特例あり=条件次第で別算定可。2,156件)は自動降格せず警告のみ。
    for hit in sorted(electronic_rules.bundles, key=lambda h: (h.base_code, h.bundled_code)):
        if str(hit.applicability or "0") == "1":
            continue
        base_index = counted(hit.base_code)
        bundled_index = counted(hit.bundled_code)
        if base_index is None or bundled_index is None or base_index == bundled_index:
            continue
        demote(
            bundled_index,
            f"包括のため合計から除外: {hit.bundled_name}は{hit.base_name}に包括されます。"
            "別に算定できる要件を満たす場合は確認のうえ採用してください。",
            "electronic_bundle_consistency",
        )

    return tuple(adjusted), tuple(messages)


# ---------------------------------------------------------------------------
# きざみ点数(時間・数量刻み)
# ---------------------------------------------------------------------------

def kizami_total_points(base_points: float, quantity: float, *, kizami_min: float, kizami_max: float, kizami_unit: float, kizami_points: float) -> float:
    """きざみ点数を計算する: 下限超過分を単位毎に加点(上限まで)。

    例: 人工呼吸 302点、30分超300分まで30分毎+50点 → 90分なら 302 + 2×50 = 402点。
    """
    if kizami_unit <= 0 or quantity <= kizami_min:
        return base_points
    capped = min(quantity, kizami_max) if 0 < kizami_max < 99999999 else quantity
    steps = math.ceil((capped - kizami_min) / kizami_unit)
    return base_points + steps * kizami_points


def apply_kizami_evaluation(
    conn: sqlite3.Connection,
    lines: tuple[CalculationLine, ...],
    *,
    kizami_quantities: dict[str, float] | None = None,
    source_id: int | None = None,
) -> tuple[tuple[CalculationLine, ...], tuple[CalculationMessage, ...]]:
    """きざみ(時間・数量刻み)項目を評価する。

    - 数量(kizami_quantities: {コード: 分・回等})が与えられた項目は点数を再計算する。
    - 数量が無い項目は「きざみ未評価」の確認メッセージを出す(静かな過少算定を防ぐ)。
    """

    codes = sorted({line.code for line in lines if line.code})
    if not codes:
        return lines, ()
    placeholders = ",".join("?" for _ in codes)
    source_sql = "AND source_id = ?" if source_id is not None else ""
    rows = conn.execute(
        f"""
        SELECT code, short_name, kizami_min, kizami_max, kizami_unit, kizami_points
        FROM medical_procedures
        WHERE code IN ({placeholders}) AND kizami_flag = '1' {source_sql}
        """,
        (*codes, *((source_id,) if source_id is not None else ())),
    ).fetchall()
    if not rows:
        return lines, ()

    kizami_by_code = {str(r["code"]): r for r in rows}
    quantities = kizami_quantities or {}
    adjusted = list(lines)
    messages: list[CalculationMessage] = []
    notified: set[str] = set()
    for index, line in enumerate(adjusted):
        row = kizami_by_code.get(line.code or "")
        if row is None or line.excluded_from_total or line.status not in _COUNTED_STATUSES:
            continue
        unit = float(row["kizami_unit"] or 0)
        step_points = float(row["kizami_points"] or 0)
        lower = float(row["kizami_min"] or 0)
        upper = float(row["kizami_max"] or 0)
        quantity = quantities.get(line.code)
        if quantity is not None and unit > 0:
            total = kizami_total_points(
                line.points, float(quantity),
                kizami_min=lower, kizami_max=upper, kizami_unit=unit, kizami_points=step_points,
            )
            if total != line.total_points:
                adjusted[index] = replace(
                    line,
                    calculated_total_points=total,
                    reason=(
                        f"きざみ点数を適用: 数量{quantity}に対し{lower}超{unit}毎に+{step_points}点"
                        f"(基本{line.points}点→{total}点)"
                    ),
                )
                messages.append(
                    CalculationMessage(
                        status=ClaimItemStatus.NEEDS_REVIEW,
                        code=line.code,
                        message=f"きざみ点数適用: {row['short_name']}を数量{quantity}で{total}点に再計算しました。数量の根拠を確認してください。",
                        source="kizami_evaluation",
                    )
                )
        elif unit > 0 and line.code not in notified:
            notified.add(line.code)
            upper_label = f"上限{upper}" if 0 < upper < 99999999 else "上限なし"
            messages.append(
                CalculationMessage(
                    status=ClaimItemStatus.NEEDS_REVIEW,
                    code=line.code,
                    message=(
                        f"きざみ未評価: {row['short_name']}は{lower}超{unit}毎に+{step_points}点({upper_label})の"
                        "きざみ算定があります。実施時間・数量を確認し、超過分の加点が必要か確認してください。"
                    ),
                    source="kizami_evaluation",
                )
            )
    return tuple(adjusted), tuple(messages)


# ---------------------------------------------------------------------------
# 3. 年齢範囲ガード
# ---------------------------------------------------------------------------

def apply_age_range_guard(
    conn: sqlite3.Connection,
    lines: tuple[CalculationLine, ...],
    *,
    patient_age_years: int | None,
    source_id: int | None = None,
) -> tuple[tuple[CalculationLine, ...], tuple[CalculationMessage, ...]]:
    """患者年齢がマスタの年齢範囲外の行を降格する(数値コードのみ判定)。"""

    if patient_age_years is None or not lines:
        return lines, ()

    codes = sorted({line.code for line in lines if line.code})
    if not codes:
        return lines, ()
    placeholders = ",".join("?" for _ in codes)
    source_sql = "AND source_id = ?" if source_id is not None else ""
    rows = conn.execute(
        f"""
        SELECT code, short_name, age_min_code, age_max_code
        FROM medical_procedures
        WHERE code IN ({placeholders}) {source_sql}
        """,
        (*codes, *((source_id,) if source_id is not None else ())),
    ).fetchall()
    range_by_code: dict[str, tuple[int, int, str]] = {}
    for row in rows:
        age_range = _numeric_age_range(row["age_min_code"], row["age_max_code"])
        if age_range is not None:
            range_by_code[str(row["code"])] = (*age_range, str(row["short_name"] or ""))

    if not range_by_code:
        return lines, ()

    adjusted = list(lines)
    messages: list[CalculationMessage] = []
    for index, line in enumerate(adjusted):
        entry = range_by_code.get(line.code or "")
        if entry is None or line.excluded_from_total or line.status not in _COUNTED_STATUSES:
            continue
        age_min, age_max, name = entry
        if age_min <= patient_age_years < age_max:
            continue
        reason = (
            f"年齢条件外のため合計から除外: {name}は{_age_range_label(age_min, age_max)}が対象ですが、"
            f"患者は{patient_age_years}歳です。対象条件を満たす場合は確認のうえ採用してください。"
        )
        adjusted[index] = replace(
            line,
            status=ClaimItemStatus.NEEDS_REVIEW,
            review_required=True,
            excluded_from_total=True,
            reason=reason,
        )
        messages.append(
            CalculationMessage(
                status=ClaimItemStatus.NEEDS_REVIEW,
                code=line.code,
                message=reason,
                source="age_range_guard",
            )
        )
    return tuple(adjusted), tuple(messages)


def _age_range_label(age_min: int, age_max: int) -> str:
    if age_min > 0 and age_max < 200:
        return f"{age_min}歳以上{age_max}歳未満"
    if age_max < 200:
        return f"{age_max}歳未満"
    return f"{age_min}歳以上"
