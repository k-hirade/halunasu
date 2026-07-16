from __future__ import annotations

import math
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, timedelta


@dataclass(frozen=True)
class BundleHit:
    source_id: int
    base_code: str
    base_name: str
    bundle_group_code: str
    bundled_code: str
    bundled_name: str
    applicability: str


@dataclass(frozen=True)
class ExclusionHit:
    source_id: int
    scope: str
    base_code: str
    base_name: str
    excluded_code: str
    excluded_name: str
    rule_kind: str
    matched_from: str
    # 特例区分(raw[6])。'1'=特例あり(条件次第で併算定可)。特例ありは自動降格しない。
    special_condition: str = "0"


@dataclass(frozen=True)
class FrequencyLimitHit:
    source_id: int
    procedure_code: str
    procedure_name: str
    limit_code: str
    limit_name: str
    limit_count: int = 0


@dataclass(frozen=True)
class ProcedureHistoryEvent:
    procedure_code: str
    service_date: date
    quantity: float = 1.0


@dataclass(frozen=True)
class FrequencyLimitBreach:
    source_id: int
    procedure_code: str
    procedure_name: str
    limit_code: str
    limit_name: str
    scope: str
    matched_from: str
    matched_service_date: date | None = None
    limit_count: int = 0
    history_occurrences: float = 0.0
    current_quantity: float = 1.0
    occurrence_count_known: bool = True
    limit_exceeded_certain: bool = True


@dataclass(frozen=True)
class RequiredCommentHit:
    source_id: int
    procedure_code: str
    procedure_name: str
    comment_code: str
    comment_text: str
    requirement_kind: str


@dataclass(frozen=True)
class ElectronicRuleContext:
    service_date: date
    source_id: int | None = None
    comment_source_id: int | None = None
    same_day_history_codes: frozenset[str] = field(default_factory=frozenset)
    same_week_history_codes: frozenset[str] = field(default_factory=frozenset)
    same_month_history_codes: frozenset[str] = field(default_factory=frozenset)
    procedure_history_events: tuple[ProcedureHistoryEvent, ...] = ()
    current_code_quantities: Mapping[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class ElectronicRuleResult:
    bundles: tuple[BundleHit, ...]
    exclusions: tuple[ExclusionHit, ...]
    frequency_limits: tuple[FrequencyLimitHit, ...]
    frequency_limit_breaches: tuple[FrequencyLimitBreach, ...]
    required_comments: tuple[RequiredCommentHit, ...]


EXCLUSION_SCOPES = {
    "exclusions_day": "same_day",
    "exclusions_month": "same_month",
    "exclusions_simultaneous": "simultaneous",
    "exclusions_week": "same_week",
}

FREQUENCY_LIMIT_SCOPES = {
    "日": "same_day",
    "週": "same_week",
    "月": "same_month",
}

FREQUENCY_LIMIT_DAY_WINDOWS = {
    "日": 0,
    "２週": 14,
}

FREQUENCY_LIMIT_MONTH_WINDOWS = {
    "２月": 2,
    "３月": 3,
    "４月": 4,
    "６月": 6,
    "１２月": 12,
    "５年": 60,
}


def _service_date_filter(field_from: str, field_to: str) -> str:
    return f"({field_from} IS NULL OR {field_from} <= ?) AND ({field_to} IS NULL OR {field_to} >= ?)"


def _source_filter(source_id: int | None, alias: str = "") -> tuple[str, list[object]]:
    if source_id is None:
        return "", []
    prefix = f"{alias}." if alias else ""
    return f"AND {prefix}source_id = ?", [source_id]


def _placeholders(values: set[str] | frozenset[str]) -> str:
    if not values:
        raise ValueError("cannot build placeholders for an empty set")
    return ",".join("?" for _ in values)


def _history_for_scope(context: ElectronicRuleContext, table_name: str) -> frozenset[str]:
    if table_name == "exclusions_day":
        return context.same_day_history_codes
    if table_name == "exclusions_month":
        return context.same_month_history_codes
    if table_name == "exclusions_week":
        return context.same_week_history_codes
    return frozenset()


def check_electronic_rules(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    context: ElectronicRuleContext,
) -> ElectronicRuleResult:
    """Detect electronic fee table rules relevant to the given claim codes.

    The result is intentionally advisory. This function detects rule candidates
    from the electronic tables but does not remove or rewrite claim items.
    """

    current_codes = frozenset(code for code in procedure_codes if code)
    if not current_codes:
        return ElectronicRuleResult(
            bundles=(),
            exclusions=(),
            frequency_limits=(),
            frequency_limit_breaches=(),
            required_comments=(),
        )

    frequency_limits = _find_frequency_limits(conn, current_codes, context)
    return ElectronicRuleResult(
        bundles=_find_bundles(conn, current_codes, context),
        exclusions=_find_exclusions(conn, current_codes, context),
        frequency_limits=frequency_limits,
        frequency_limit_breaches=_find_frequency_limit_breaches(frequency_limits, context),
        required_comments=_find_required_comments(conn, current_codes, context),
    )


def _find_bundles(
    conn: sqlite3.Connection,
    current_codes: frozenset[str],
    context: ElectronicRuleContext,
) -> tuple[BundleHit, ...]:
    service_date = context.service_date.isoformat()
    source_sql, source_params = _source_filter(context.source_id, "a")
    code_list = sorted(current_codes)
    params: list[object] = [
        service_date,
        service_date,
        service_date,
        service_date,
        *source_params,
        *code_list,
        *code_list,
    ]

    rows = conn.execute(
        f"""
        SELECT
            a.source_id,
            a.code AS base_code,
            a.name AS base_name,
            a.group_code AS bundle_group_code,
            b.procedure_code AS bundled_code,
            b.procedure_name AS bundled_name,
            b.applicability
        FROM electronic_aux_master a
        JOIN electronic_bundles b
          ON b.source_id = a.source_id
         AND b.bundle_group_code = a.group_code
        WHERE {_service_date_filter("a.effective_from", "a.effective_to")}
          AND {_service_date_filter("b.effective_from", "b.effective_to")}
          {source_sql}
          AND a.code IN ({_placeholders(current_codes)})
          AND b.procedure_code IN ({_placeholders(current_codes)})
          AND b.procedure_code <> a.code
        ORDER BY a.code, b.procedure_code
        """,
        params,
    ).fetchall()

    return tuple(
        BundleHit(
            source_id=int(row["source_id"]),
            base_code=str(row["base_code"]),
            base_name=str(row["base_name"]),
            bundle_group_code=str(row["bundle_group_code"]),
            bundled_code=str(row["bundled_code"]),
            bundled_name=str(row["bundled_name"]),
            applicability=str(row["applicability"]),
        )
        for row in rows
    )


def _find_exclusions(
    conn: sqlite3.Connection,
    current_codes: frozenset[str],
    context: ElectronicRuleContext,
) -> tuple[ExclusionHit, ...]:
    hits: list[ExclusionHit] = []
    service_date = context.service_date.isoformat()
    source_sql, source_params = _source_filter(context.source_id)
    current_list = sorted(current_codes)

    for table_name, scope in EXCLUSION_SCOPES.items():
        history_codes = _history_for_scope(context, table_name)
        comparison_codes = current_codes | history_codes
        comparison_list = sorted(comparison_codes)

        rows = conn.execute(
            f"""
            SELECT
                source_id,
                exclusion_table,
                base_code,
                base_name,
                excluded_code,
                excluded_name,
                rule_kind,
                COALESCE(json_extract(raw_row_json, '$[6]'), '0') AS special_condition
            FROM electronic_exclusions
            WHERE {_service_date_filter("effective_from", "effective_to")}
              {source_sql}
              AND exclusion_table = ?
              AND (
                    (base_code IN ({_placeholders(current_codes)})
                     AND excluded_code IN ({_placeholders(comparison_codes)}))
                 OR (base_code IN ({_placeholders(comparison_codes)})
                     AND excluded_code IN ({_placeholders(current_codes)}))
              )
            ORDER BY base_code, excluded_code
            """,
            [service_date, service_date, *source_params, table_name, *current_list, *comparison_list, *comparison_list, *current_list],
        ).fetchall()

        for row in rows:
            base_current = row["base_code"] in current_codes
            excluded_current = row["excluded_code"] in current_codes
            if base_current and excluded_current:
                matched_from = "current"
            elif base_current:
                matched_from = f"excluded_in_{scope}_history"
            elif excluded_current:
                matched_from = f"base_in_{scope}_history"
            else:
                continue

            hits.append(
                ExclusionHit(
                    source_id=int(row["source_id"]),
                    scope=scope,
                    base_code=str(row["base_code"]),
                    base_name=str(row["base_name"]),
                    excluded_code=str(row["excluded_code"]),
                    excluded_name=str(row["excluded_name"]),
                    rule_kind=str(row["rule_kind"]),
                    matched_from=matched_from,
                    special_condition=str(row["special_condition"] or "0"),
                )
            )

    return tuple(hits)


def _find_frequency_limits(
    conn: sqlite3.Connection,
    current_codes: frozenset[str],
    context: ElectronicRuleContext,
) -> tuple[FrequencyLimitHit, ...]:
    service_date = context.service_date.isoformat()
    source_sql, source_params = _source_filter(context.source_id)
    code_list = sorted(current_codes)

    rows = conn.execute(
        f"""
        SELECT
            source_id,
            procedure_code,
            procedure_name,
            limit_code,
            limit_name,
            COALESCE(json_extract(raw_row_json, '$[5]'), '0') AS limit_count
        FROM electronic_frequency_limits
        WHERE {_service_date_filter("effective_from", "effective_to")}
          {source_sql}
          AND procedure_code IN ({_placeholders(current_codes)})
        ORDER BY procedure_code, limit_code
        """,
        [service_date, service_date, *source_params, *code_list],
    ).fetchall()

    return tuple(
        FrequencyLimitHit(
            source_id=int(row["source_id"]),
            procedure_code=str(row["procedure_code"]),
            procedure_name=str(row["procedure_name"]),
            limit_code=str(row["limit_code"]),
            limit_name=str(row["limit_name"]),
            limit_count=_parse_limit_count(row["limit_count"]),
        )
        for row in rows
    )


def _find_required_comments(
    conn: sqlite3.Connection,
    current_codes: frozenset[str],
    context: ElectronicRuleContext,
) -> tuple[RequiredCommentHit, ...]:
    service_date = context.service_date.isoformat()
    source_sql, source_params = _source_filter(context.comment_source_id)
    code_list = sorted(current_codes)

    rows = conn.execute(
        f"""
        SELECT
            source_id,
            procedure_code,
            procedure_name,
            comment_code,
            comment_text,
            requirement_kind
        FROM comment_links
        WHERE {_service_date_filter("effective_from", "effective_to")}
          {source_sql}
          AND procedure_code IN ({_placeholders(current_codes)})
        ORDER BY procedure_code, comment_code
        """,
        [service_date, service_date, *source_params, *code_list],
    ).fetchall()

    return tuple(
        RequiredCommentHit(
            source_id=int(row["source_id"]),
            procedure_code=str(row["procedure_code"]),
            procedure_name=str(row["procedure_name"]),
            comment_code=str(row["comment_code"]),
            comment_text=str(row["comment_text"]),
            requirement_kind=str(row["requirement_kind"]),
        )
        for row in rows
    )


def _find_frequency_limit_breaches(
    frequency_limits: tuple[FrequencyLimitHit, ...],
    context: ElectronicRuleContext,
) -> tuple[FrequencyLimitBreach, ...]:
    breaches: list[FrequencyLimitBreach] = []
    for limit in frequency_limits:
        matching_events = _matching_frequency_history_events(limit, context)
        history_occurrences = sum(
            _history_event_quantity(event)
            for event in matching_events
        )
        current_quantity = _current_code_quantity(limit.procedure_code, context)

        # procedure_history_events はコードx診療日で集約され、quantityにその日の
        # 算定回数合計を持つ。古いpayloadはquantity省略時に1回として後方互換で扱う。
        exact_breach = (
            limit.limit_count > 0
            and history_occurrences + current_quantity > limit.limit_count
        )
        if exact_breach:
            breaches.append(
                FrequencyLimitBreach(
                    source_id=limit.source_id,
                    procedure_code=limit.procedure_code,
                    procedure_name=limit.procedure_name,
                    limit_code=limit.limit_code,
                    limit_name=limit.limit_name,
                    scope=_frequency_limit_scope(limit.limit_name),
                    matched_from=(
                        "procedure_history_event"
                        if matching_events
                        else "current_claim_quantity"
                    ),
                    matched_service_date=(
                        max(event.service_date for event in matching_events)
                        if matching_events
                        else None
                    ),
                    limit_count=limit.limit_count,
                    history_occurrences=history_occurrences,
                    current_quantity=current_quantity,
                    occurrence_count_known=True,
                    limit_exceeded_certain=True,
                )
            )

        # 同じ期間のイベント履歴を数えられた場合と、現在数量だけで既に超過した場合は、
        # set形式の存在情報を重ねず二重警告を避ける。
        if not matching_events and not exact_breach:
            set_based_breach = _find_set_based_frequency_breach(limit, context)
            if set_based_breach is not None:
                breaches.append(set_based_breach)
    return tuple(_dedupe_frequency_breaches(breaches))


def _find_set_based_frequency_breach(
    limit: FrequencyLimitHit,
    context: ElectronicRuleContext,
) -> FrequencyLimitBreach | None:
    scope = FREQUENCY_LIMIT_SCOPES.get(limit.limit_name)
    if scope is None:
        return None

    history_codes = _history_codes_for_frequency_scope(context, scope)
    if limit.procedure_code not in history_codes:
        return None

    current_quantity = _current_code_quantity(limit.procedure_code, context)
    # set形式でも同一コードが最低1回あることは確定する。下限だけで上限超過する場合は
    # 履歴件数そのものが不明でも、安全に違反を確定できる。
    limit_exceeded_certain = (
        limit.limit_count > 0
        and 1.0 + current_quantity > limit.limit_count
    )

    return FrequencyLimitBreach(
        source_id=limit.source_id,
        procedure_code=limit.procedure_code,
        procedure_name=limit.procedure_name,
        limit_code=limit.limit_code,
        limit_name=limit.limit_name,
        scope=scope,
        matched_from=f"{scope}_history",
        limit_count=limit.limit_count,
        history_occurrences=1.0,
        current_quantity=current_quantity,
        occurrence_count_known=False,
        limit_exceeded_certain=limit_exceeded_certain,
    )


def _matching_frequency_history_events(
    limit: FrequencyLimitHit,
    context: ElectronicRuleContext,
) -> tuple[ProcedureHistoryEvent, ...]:
    matches: list[ProcedureHistoryEvent] = []
    for event in context.procedure_history_events:
        if event.procedure_code != limit.procedure_code:
            continue
        if _history_event_matches_frequency_limit(event.service_date, limit.limit_name, context.service_date):
            matches.append(event)
    return tuple(matches)


def _history_event_matches_frequency_limit(
    history_date: date,
    limit_name: str,
    service_date: date,
) -> bool:
    if history_date > service_date:
        return False

    if limit_name == "月":
        return history_date.year == service_date.year and history_date.month == service_date.month

    if limit_name == "週":
        return _sunday_week_start(history_date) == _sunday_week_start(service_date)

    day_window = FREQUENCY_LIMIT_DAY_WINDOWS.get(limit_name)
    if day_window is not None:
        return 0 <= (service_date - history_date).days <= day_window

    month_window = FREQUENCY_LIMIT_MONTH_WINDOWS.get(limit_name)
    if month_window is not None:
        return _add_months(service_date, -month_window) <= history_date <= service_date

    return False


def _sunday_week_start(value: date) -> date:
    """Return the Sunday starting the fee-table calendar week.

    厚生労働省「医科診療報酬点数表に関する事項＜通則＞」の、特段の定めがない
    「週」は日曜日から土曜日までとする定義に合わせる。履歴生成側のfee-apiも同じ
    境界を使う必要がある。
    """

    days_since_sunday = (value.weekday() + 1) % 7
    return value - timedelta(days=days_since_sunday)


def _parse_limit_count(value: object) -> int:
    try:
        parsed = int(str(value or "").strip() or "0")
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def _current_code_quantity(
    procedure_code: str,
    context: ElectronicRuleContext,
) -> float:
    if procedure_code not in context.current_code_quantities:
        return 1.0
    try:
        quantity = float(context.current_code_quantities[procedure_code])
    except (TypeError, ValueError):
        return 1.0
    return max(0.0, quantity)


def _history_event_quantity(event: ProcedureHistoryEvent) -> float:
    try:
        quantity = float(event.quantity)
    except (TypeError, ValueError):
        return 1.0
    if not math.isfinite(quantity) or quantity <= 0:
        return 1.0
    return quantity


def _frequency_limit_scope(limit_name: str) -> str:
    scope = FREQUENCY_LIMIT_SCOPES.get(limit_name)
    if scope is not None:
        return scope
    if limit_name in FREQUENCY_LIMIT_DAY_WINDOWS:
        return f"within_{FREQUENCY_LIMIT_DAY_WINDOWS[limit_name]}_days"
    if limit_name in FREQUENCY_LIMIT_MONTH_WINDOWS:
        months = FREQUENCY_LIMIT_MONTH_WINDOWS[limit_name]
        if months % 12 == 0:
            return f"within_{months // 12}_years"
        return f"within_{months}_months"
    return "unknown"


def _add_months(value: date, months: int) -> date:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, _days_in_month(year, month))
    return date(year, month, day)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    return (next_month - date(year, month, 1)).days


def _dedupe_frequency_breaches(
    breaches: list[FrequencyLimitBreach],
) -> tuple[FrequencyLimitBreach, ...]:
    seen: set[tuple[str, str, str, str, date | None]] = set()
    result: list[FrequencyLimitBreach] = []
    for breach in breaches:
        key = (
            breach.procedure_code,
            breach.limit_code,
            breach.scope,
            breach.matched_from,
            breach.matched_service_date,
        )
        if key in seen:
            continue
        seen.add(key)
        result.append(breach)
    return tuple(result)


def _history_codes_for_frequency_scope(
    context: ElectronicRuleContext,
    scope: str,
) -> frozenset[str]:
    if scope == "same_day":
        return context.same_day_history_codes
    if scope == "same_week":
        return context.same_week_history_codes
    if scope == "same_month":
        return context.same_month_history_codes
    return frozenset()
