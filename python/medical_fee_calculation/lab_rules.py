from __future__ import annotations

import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import date

from medical_fee_calculation.facility_standard_dictionary import (
    FACILITY_STANDARD_RULE_BY_KEY,
    select_facility_standard_rule_key,
)


@dataclass(frozen=True)
class ClaimItem:
    code: str
    name: str
    points: float
    reason: str
    quantity: int = 1

    @property
    def total_points(self) -> float:
        return self.points * self.quantity


@dataclass(frozen=True)
class ReviewWarning:
    level: str
    reason: str


@dataclass(frozen=True)
class D026Context:
    service_date: date
    source_id: int | None = None
    already_present_judgement_groups: frozenset[str] = field(default_factory=frozenset)
    already_billed_judgement_groups: frozenset[str] = field(default_factory=frozenset)
    bundled_judgement_groups: frozenset[str] = field(default_factory=frozenset)
    suppress_all_judgement_fees: bool = False
    history_complete: bool = True


@dataclass(frozen=True)
class D026Result:
    claim_items: tuple[ClaimItem, ...]
    skipped_groups: dict[str, str]
    warnings: tuple[ReviewWarning, ...]


@dataclass(frozen=True)
class LabManagementContext:
    service_date: date
    facility_standard_keys: frozenset[str]
    source_id: int | None = None
    already_present_in_claim: bool = False
    already_billed_same_month: bool = False
    judgement_fee_present: bool = False
    history_complete: bool = True


@dataclass(frozen=True)
class LabManagementResult:
    claim_item: ClaimItem | None
    skipped_reason: str | None
    warnings: tuple[ReviewWarning, ...]


@dataclass(frozen=True)
class CollectionFeeContext:
    service_date: date
    collection_fee_inputs: tuple[str, ...] = ()
    source_id: int | None = None
    already_billed_same_day_codes: frozenset[str] = field(default_factory=frozenset)
    history_complete: bool = True


@dataclass(frozen=True)
class CollectionFeeResult:
    claim_items: tuple[ClaimItem, ...]
    skipped_inputs: dict[str, str]
    warnings: tuple[ReviewWarning, ...]


@dataclass(frozen=True)
class OutpatientRapidLabContext:
    service_date: date
    eligible_test_item_count: int = 0
    source_id: int | None = None
    is_outpatient: bool = False
    same_day_result_explained: bool = False
    written_information_provided: bool = False
    result_based_care_provided: bool = False
    already_present_in_claim: bool = False
    already_billed_same_day_count: int = 0
    history_complete: bool = True


@dataclass(frozen=True)
class OutpatientRapidLabResult:
    claim_item: ClaimItem | None
    skipped_reason: str | None
    eligible_item_count: int
    billed_item_count: int
    warnings: tuple[ReviewWarning, ...]
    eligible_tests: tuple["OutpatientRapidLabEligibleTest", ...] = ()
    comment_text: str | None = None


@dataclass(frozen=True)
class OutpatientRapidLabEligibleTest:
    code: str
    name: str


LAB_MANAGEMENT_FEE_BY_STANDARD = {
    "検Ⅰ": "160170170",
    "検Ⅱ": "160182770",
    "検Ⅲ": "160161610",
    "検Ⅳ": "160185770",
}

LAB_MANAGEMENT_FEE_BY_RULE_KEY = {
    "lab_management_1": "160170170",
    "lab_management_2": "160182770",
    "lab_management_3": "160161610",
    "lab_management_4": "160185770",
}

LAB_MANAGEMENT_STANDARD_PRIORITY = ("検Ⅳ", "検Ⅲ", "検Ⅱ", "検Ⅰ")

LAB_MANAGEMENT_RULE_PRIORITY = (
    "lab_management_4",
    "lab_management_3",
    "lab_management_2",
    "lab_management_1",
)

COLLECTION_FEE_CODE_BY_KEY = {
    "blood_venous": "160095710",
    "venous_blood": "160095710",
    "b_v": "160095710",
    "Ｂ－Ｖ": "160095710",
    "blood_capillary": "160095810",
    "capillary_blood": "160095810",
    "b_c": "160095810",
    "Ｂ－Ｃ": "160095810",
    "nasopharyngeal_swab": "160208510",
    "nasal_pharyngeal_swab": "160208510",
    "鼻腔・咽頭拭い液採取": "160208510",
    "gastric_duodenal_fluid": "160101010",
    "胃液・十二指腸液採取": "160101010",
    "thoracic_fluid": "160101110",
    "胸水採取": "160101110",
    "abdominal_fluid": "160145010",
    "腹水採取": "160145010",
    "arterial_blood": "160101210",
    "b_a": "160101210",
    "Ｂ－Ａ": "160101210",
}


def _normalize_rapid_lab_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").upper()
    return (
        normalized.replace(" ", "")
        .replace("\u3000", "")
        .replace("－", "-")
        .replace("―", "-")
        .replace("‐", "-")
        .replace("‑", "-")
        .replace("−", "-")
    )


OUTPATIENT_RAPID_LAB_FEE_CODE = "160177770"
OUTPATIENT_RAPID_LAB_MAX_ITEMS_PER_DAY = 5
OUTPATIENT_RAPID_LAB_COMMENT_PREFIX = "検体検査名（外来迅速検体検査加算）；"

OUTPATIENT_RAPID_LAB_TARGET_NAMES_BY_SECTION = {
    "000": frozenset(
        {
            "尿中一般物質定性半定量検査",
        }
    ),
    "002": frozenset(
        {
            "尿沈渣(鏡検法)",
        }
    ),
    "003": frozenset(
        {
            "糞便中ヘモグロビン",
            "糞便中ヘモグロビン定性",
        }
    ),
    "005": frozenset(
        {
            "赤血球沈降速度(ESR)",
            "末梢血液一般検査",
            "ヘモグロビンA1C(HbA1C)",
        }
    ),
    "006": frozenset(
        {
            "プロトロンビン時間(PT)",
            "フィブリン・フィブリノゲン分解産物(FDP)定性",
            "フィブリン・フィブリノゲン分解産物(FDP)半定量",
            "フィブリン・フィブリノゲン分解産物(FDP)定量",
            "Dダイマー",
        }
    ),
    "007": frozenset(
        {
            "総ビリルビン",
            "総蛋白",
            "アルブミン(BCP改良法)",
            "アルブミン(BCP改良法・BCG法)",
            "尿素窒素",
            "クレアチニン",
            "尿酸",
            "アルカリホスファターゼ(ALP)",
            "コリンエステラーゼ(ChE)",
            "γ-グルタミルトランスフェラーゼ(γ-GT)",
            "中性脂肪",
            "ナトリウム及びクロール",
            "カリウム",
            "カルシウム",
            "グルコース",
            "乳酸デヒドロゲナーゼ(LD)",
            "クレアチンキナーゼ(CK)",
            "HDL-コレステロール",
            "総コレステロール",
            "アスパラギン酸アミノトランスフェラーゼ(AST)",
            "アラニンアミノトランスフェラーゼ(ALT)",
            "LDL-コレステロール",
            "グリコアルブミン",
        }
    ),
    "008": frozenset(
        {
            "甲状腺刺激ホルモン(TSH)",
            "遊離サイロキシン(FT4)",
            "遊離トリヨードサイロニン(FT3)",
        }
    ),
    "009": frozenset(
        {
            "癌胎児性抗原(CEA)",
            "α-フェトプロテイン(AFP)",
            "前立腺特異抗原(PSA)",
            "CA19-9",
        }
    ),
    "015": frozenset(
        {
            "C反応性蛋白(CRP)",
            "C反応性蛋白(CRP)定性",
        }
    ),
    "017": frozenset(
        {
            "細菌顕微鏡検査(その他のもの)",
        }
    ),
}

NORMALIZED_OUTPATIENT_RAPID_LAB_TARGET_NAMES_BY_SECTION = {
    section: frozenset(_normalize_rapid_lab_name(name) for name in names)
    for section, names in OUTPATIENT_RAPID_LAB_TARGET_NAMES_BY_SECTION.items()
}


def _service_date_filter(field_from: str, field_to: str) -> str:
    return f"({field_from} IS NULL OR {field_from} <= ?) AND ({field_to} IS NULL OR {field_to} >= ?)"


def add_d026_judgement_fees(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    context: D026Context,
) -> D026Result:
    """Return D026 judgement fees that should be added for lab procedure codes.

    This function does not mutate the database. It assumes the caller has already
    decided the input procedure codes are otherwise claimable.
    """

    if not procedure_codes:
        return D026Result(claim_items=(), skipped_groups={}, warnings=())

    service_date = context.service_date.isoformat()
    params: list[object] = [service_date, service_date]
    source_filter = ""
    if context.source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(context.source_id)

    placeholders = ",".join("?" for _ in procedure_codes)
    params.extend(procedure_codes)

    lab_rows = conn.execute(
        f"""
        SELECT DISTINCT judgement_group
        FROM lab_procedure_catalog
        WHERE {_service_date_filter("effective_from", "effective_to")}
          {source_filter}
          AND code IN ({placeholders})
          AND is_lab_test = 1
          AND judgement_kind = '1'
          AND judgement_group IS NOT NULL
          AND judgement_group <> ''
          AND judgement_group <> '0'
        ORDER BY CAST(judgement_group AS INTEGER)
        """,
        params,
    ).fetchall()

    candidate_groups = [str(row["judgement_group"]) for row in lab_rows]
    warnings: list[ReviewWarning] = []
    skipped: dict[str, str] = {}

    if not context.history_complete:
        warnings.append(
            ReviewWarning(
                level="review",
                reason="同一患者・同一月の判断料算定履歴が完全ではないため、月1回制限の確認が必要",
            )
        )

    if context.suppress_all_judgement_fees:
        return D026Result(
            claim_items=(),
            skipped_groups={group: "all_judgement_fees_suppressed" for group in candidate_groups},
            warnings=tuple(warnings),
        )

    claim_items: list[ClaimItem] = []
    for group in candidate_groups:
        if group in context.already_present_judgement_groups:
            skipped[group] = "already_present_in_claim"
            continue
        if group in context.already_billed_judgement_groups:
            skipped[group] = "already_billed_same_month"
            continue
        if group in context.bundled_judgement_groups:
            skipped[group] = "bundled_by_other_fee"
            continue

        map_params: list[object] = [group, service_date, service_date]
        map_source_filter = ""
        if context.source_id is not None:
            map_source_filter = "AND source_id = ?"
            map_params.append(context.source_id)

        fee = conn.execute(
            f"""
            SELECT judgement_fee_code, judgement_fee_name, points
            FROM lab_judgement_fee_map
            WHERE judgement_group = ?
              AND {_service_date_filter("effective_from", "effective_to")}
              {map_source_filter}
            ORDER BY source_id DESC
            LIMIT 1
            """,
            map_params,
        ).fetchone()

        if fee is None:
            skipped[group] = "judgement_fee_code_not_found"
            warnings.append(
                ReviewWarning(
                    level="review",
                    reason=f"D026判断料グループ {group} に対応する判断料コードが見つからない",
                )
            )
            continue

        claim_items.append(
            ClaimItem(
                code=str(fee["judgement_fee_code"]),
                name=str(fee["judgement_fee_name"]),
                points=float(fee["points"]),
                reason=f"D026検査判断料（区分{group}）を実施検査から自動候補化",
            )
        )

    return D026Result(
        claim_items=tuple(claim_items),
        skipped_groups=skipped,
        warnings=tuple(warnings),
    )


def add_lab_management_fee(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    context: LabManagementContext,
) -> LabManagementResult:
    """Return a lab management add-on candidate based on hospital facility standards.

    The caller should pass the claim codes after D026/D027 judgement fee handling.
    This function is conservative: it does not add the management fee unless a
    judgement fee is present in the claim or explicitly confirmed in context.
    """

    warnings: list[ReviewWarning] = []
    if not context.history_complete:
        warnings.append(
            ReviewWarning(
                level="review",
                reason="同一患者・同一月の検体検査管理加算算定履歴が完全ではないため、月1回制限の確認が必要",
            )
        )

    if context.already_present_in_claim:
        return LabManagementResult(
            claim_item=None,
            skipped_reason="already_present_in_claim",
            warnings=tuple(warnings),
        )

    if context.already_billed_same_month:
        return LabManagementResult(
            claim_item=None,
            skipped_reason="already_billed_same_month",
            warnings=tuple(warnings),
        )

    standard_key = _select_lab_management_standard(context.facility_standard_keys)
    if standard_key is None:
        return LabManagementResult(
            claim_item=None,
            skipped_reason="facility_standard_not_found",
            warnings=tuple(warnings),
        )

    judgement_fee_present = context.judgement_fee_present or _has_lab_judgement_fee(
        conn,
        procedure_codes,
        context.service_date,
        context.source_id,
    )
    if not judgement_fee_present:
        return LabManagementResult(
            claim_item=None,
            skipped_reason="judgement_fee_required",
            warnings=tuple(warnings),
        )

    procedure_code = LAB_MANAGEMENT_FEE_BY_RULE_KEY[standard_key]
    standard_name = FACILITY_STANDARD_RULE_BY_KEY[standard_key].display_name
    fee = _find_procedure(conn, procedure_code, context.service_date, context.source_id)
    if fee is None:
        warnings.append(
            ReviewWarning(
                level="review",
                reason=f"{standard_name} に対応する検体検査管理加算コード {procedure_code} が見つからない",
            )
        )
        return LabManagementResult(
            claim_item=None,
            skipped_reason="management_fee_code_not_found",
            warnings=tuple(warnings),
        )

    return LabManagementResult(
        claim_item=ClaimItem(
            code=str(fee["code"]),
            name=str(fee["short_name"]),
            points=float(fee["points"]),
            reason=f"Lab management fee for facility standard {standard_name}",
        ),
        skipped_reason=None,
        warnings=tuple(warnings),
    )


def add_collection_fees(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    context: CollectionFeeContext,
) -> CollectionFeeResult:
    """Return explicitly requested D400-D419 collection fee candidates.

    Collection fees are not inferred from lab test codes because specimen source
    and collection method are clinical facts. The caller must pass collection
    inputs such as an official procedure code or a supported key like
    ``blood_venous``.
    """

    warnings: list[ReviewWarning] = []
    skipped: dict[str, str] = {}
    if not context.history_complete:
        warnings.append(
            ReviewWarning(
                level="review",
                reason="同一患者・同一日の採取料算定履歴が完全ではないため、1日単位の制限確認が必要",
            )
        )

    current_codes = {str(code or "").strip() for code in procedure_codes if str(code or "").strip()}
    seen_candidate_codes: set[str] = set()
    claim_items: list[ClaimItem] = []

    for collection_input in context.collection_fee_inputs:
        input_value = str(collection_input or "").strip()
        if not input_value:
            continue

        procedure_code = _resolve_collection_fee_code(input_value)
        if procedure_code is None:
            skipped[input_value] = "unknown_collection_fee_input"
            warnings.append(
                ReviewWarning(
                    level="review",
                    reason=f"採取料入力 {input_value} を診療行為コードに変換できない",
                )
            )
            continue

        if procedure_code in seen_candidate_codes:
            skipped[input_value] = "duplicate_collection_fee_input"
            continue
        seen_candidate_codes.add(procedure_code)

        if procedure_code in current_codes:
            skipped[input_value] = "already_present_in_claim"
            continue

        if procedure_code in context.already_billed_same_day_codes:
            skipped[input_value] = "already_billed_same_day"
            continue

        fee = _find_collection_fee(conn, procedure_code, context.service_date, context.source_id)
        if fee is None:
            skipped[input_value] = "collection_fee_code_not_found"
            warnings.append(
                ReviewWarning(
                    level="review",
                    reason=f"採取料コード {procedure_code} がD400-D419の有効な診療行為として見つからない",
                )
            )
            continue

        claim_items.append(
            ClaimItem(
                code=str(fee["code"]),
                name=str(fee["short_name"]),
                points=float(fee["points"]),
                reason=f"検体採取料を採取方法（{input_value}）から自動候補化",
            )
        )

    return CollectionFeeResult(
        claim_items=tuple(claim_items),
        skipped_inputs=skipped,
        warnings=tuple(warnings),
    )


def add_outpatient_rapid_lab_fee(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    context: OutpatientRapidLabContext,
) -> OutpatientRapidLabResult:
    """Return an outpatient rapid specimen test add-on candidate.

    The add-on is not inferred from lab test codes alone. The caller must confirm
    the same-day explanation, written information, and result-based care facts,
    and provide the number of eligible test items.
    """

    warnings: list[ReviewWarning] = []
    eligible_tests = find_outpatient_rapid_lab_eligible_tests(
        conn,
        procedure_codes,
        context.service_date,
        context.source_id,
    )
    inferred_eligible_count = len(eligible_tests)
    explicit_eligible_count = max(0, context.eligible_test_item_count)
    eligible_count = explicit_eligible_count or inferred_eligible_count
    already_billed_count = max(0, context.already_billed_same_day_count)
    if explicit_eligible_count and inferred_eligible_count and explicit_eligible_count != inferred_eligible_count:
        warnings.append(
            ReviewWarning(
                level="review",
                reason=(
                    "外来迅速検体検査加算の明示対象項目数と"
                    f"診療行為コードから推定した対象項目数が不一致: "
                    f"explicit={explicit_eligible_count}, inferred={inferred_eligible_count}"
                ),
            )
        )

    if not context.history_complete:
        warnings.append(
            ReviewWarning(
                level="review",
                reason="同一患者・同一日の外来迅速検体検査加算算定履歴が完全ではないため、5項目上限の確認が必要",
            )
        )

    current_codes = {str(code or "").strip() for code in procedure_codes if str(code or "").strip()}
    if context.already_present_in_claim or OUTPATIENT_RAPID_LAB_FEE_CODE in current_codes:
        return OutpatientRapidLabResult(
            claim_item=None,
            skipped_reason="already_present_in_claim",
            eligible_item_count=eligible_count,
            billed_item_count=0,
            warnings=tuple(warnings),
            eligible_tests=eligible_tests,
        )

    if not context.is_outpatient:
        return OutpatientRapidLabResult(
            claim_item=None,
            skipped_reason="outpatient_required",
            eligible_item_count=eligible_count,
            billed_item_count=0,
            warnings=tuple(warnings),
            eligible_tests=eligible_tests,
        )

    if eligible_count == 0:
        return OutpatientRapidLabResult(
            claim_item=None,
            skipped_reason="eligible_test_item_count_required",
            eligible_item_count=eligible_count,
            billed_item_count=0,
            warnings=tuple(warnings),
            eligible_tests=eligible_tests,
        )

    if not (
        context.same_day_result_explained
        and context.written_information_provided
        and context.result_based_care_provided
    ):
        return OutpatientRapidLabResult(
            claim_item=None,
            skipped_reason="same_day_result_explanation_and_document_required",
            eligible_item_count=eligible_count,
            billed_item_count=0,
            warnings=tuple(warnings),
            eligible_tests=eligible_tests,
        )

    remaining_count = OUTPATIENT_RAPID_LAB_MAX_ITEMS_PER_DAY - already_billed_count
    if remaining_count <= 0:
        return OutpatientRapidLabResult(
            claim_item=None,
            skipped_reason="daily_limit_reached",
            eligible_item_count=eligible_count,
            billed_item_count=0,
            warnings=tuple(warnings),
            eligible_tests=eligible_tests,
        )

    billed_count = min(eligible_count, remaining_count)
    if eligible_count > remaining_count:
        warnings.append(
            ReviewWarning(
                level="review",
                reason=f"外来迅速検体検査加算は1日5項目上限のため {billed_count} 項目に制限",
            )
        )

    fee = _find_procedure(
        conn,
        OUTPATIENT_RAPID_LAB_FEE_CODE,
        context.service_date,
        context.source_id,
    )
    if fee is None:
        warnings.append(
            ReviewWarning(
                level="review",
                reason=f"外来迅速検体検査加算コード {OUTPATIENT_RAPID_LAB_FEE_CODE} が見つからない",
            )
        )
        return OutpatientRapidLabResult(
            claim_item=None,
            skipped_reason="rapid_lab_fee_code_not_found",
            eligible_item_count=eligible_count,
            billed_item_count=0,
            warnings=tuple(warnings),
            eligible_tests=eligible_tests,
        )

    comment_text = build_outpatient_rapid_lab_comment(eligible_tests, billed_count)
    return OutpatientRapidLabResult(
        claim_item=ClaimItem(
            code=str(fee["code"]),
            name=str(fee["short_name"]),
            points=float(fee["points"]),
            quantity=billed_count,
            reason=f"Outpatient rapid lab add-on for {billed_count} eligible items",
        ),
        skipped_reason=None,
        eligible_item_count=eligible_count,
        billed_item_count=billed_count,
        warnings=tuple(warnings),
        eligible_tests=eligible_tests,
        comment_text=comment_text,
    )


def find_outpatient_rapid_lab_eligible_tests(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    service_date: date,
    source_id: int | None,
) -> tuple[OutpatientRapidLabEligibleTest, ...]:
    if not procedure_codes:
        return ()

    normalized_codes = tuple(dict.fromkeys(str(code or "").strip() for code in procedure_codes if str(code or "").strip()))
    if not normalized_codes:
        return ()

    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)
    placeholders = ",".join("?" for _ in normalized_codes)
    params.extend(normalized_codes)

    rows = conn.execute(
        f"""
        SELECT code, short_name, base_name, section
        FROM lab_procedure_catalog
        WHERE {_service_date_filter("effective_from", "effective_to")}
          {source_filter}
          AND code IN ({placeholders})
          AND chapter = '2'
          AND part = '03'
        ORDER BY code
        """,
        params,
    ).fetchall()

    eligible_tests: list[OutpatientRapidLabEligibleTest] = []
    for row in rows:
        if not _is_outpatient_rapid_lab_target(row):
            continue
        eligible_tests.append(
            OutpatientRapidLabEligibleTest(
                code=str(row["code"]),
                name=str(row["base_name"] or row["short_name"]),
            )
        )
    return tuple(eligible_tests)


def build_outpatient_rapid_lab_comment(
    eligible_tests: tuple[OutpatientRapidLabEligibleTest, ...],
    billed_item_count: int,
) -> str | None:
    if not eligible_tests or billed_item_count <= 0:
        return None
    names = [test.name for test in eligible_tests[:billed_item_count]]
    if not names:
        return None
    return f"{OUTPATIENT_RAPID_LAB_COMMENT_PREFIX}{'、'.join(names)}"


def _select_lab_management_standard(facility_standard_keys: frozenset[str]) -> str | None:
    return select_facility_standard_rule_key(
        facility_standard_keys,
        LAB_MANAGEMENT_RULE_PRIORITY,
    )


def _has_lab_judgement_fee(
    conn: sqlite3.Connection,
    procedure_codes: list[str],
    service_date: date,
    source_id: int | None,
) -> bool:
    if not procedure_codes:
        return False

    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)
    placeholders = ",".join("?" for _ in procedure_codes)
    params.extend(procedure_codes)

    row = conn.execute(
        f"""
        SELECT 1
        FROM lab_procedure_catalog
        WHERE {_service_date_filter("effective_from", "effective_to")}
          {source_filter}
          AND code IN ({placeholders})
          AND (is_judgement_fee = 1 OR is_basic_lab_judgement_fee = 1)
        LIMIT 1
        """,
        params,
    ).fetchone()
    return row is not None


def _find_procedure(
    conn: sqlite3.Connection,
    procedure_code: str,
    service_date: date,
    source_id: int | None,
) -> sqlite3.Row | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, procedure_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    return conn.execute(
        f"""
        SELECT code, short_name, points
        FROM medical_procedures
        WHERE {_service_date_filter("effective_from", "effective_to")}
          AND code = ?
          {source_filter}
        ORDER BY source_id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _resolve_collection_fee_code(collection_input: str) -> str | None:
    if collection_input.isdecimal():
        return collection_input

    if collection_input in COLLECTION_FEE_CODE_BY_KEY:
        return COLLECTION_FEE_CODE_BY_KEY[collection_input]

    normalized = (
        collection_input.strip()
        .lower()
        .replace(" ", "_")
        .replace("-", "_")
        .replace("－", "_")
    )
    return COLLECTION_FEE_CODE_BY_KEY.get(normalized)


def _find_collection_fee(
    conn: sqlite3.Connection,
    procedure_code: str,
    service_date: date,
    source_id: int | None,
) -> sqlite3.Row | None:
    service_date_text = service_date.isoformat()
    params: list[object] = [service_date_text, service_date_text, procedure_code]
    source_filter = ""
    if source_id is not None:
        source_filter = "AND source_id = ?"
        params.append(source_id)

    return conn.execute(
        f"""
        SELECT code, short_name, points
        FROM lab_procedure_catalog
        WHERE {_service_date_filter("effective_from", "effective_to")}
          AND code = ?
          {source_filter}
          AND is_collection_fee = 1
        ORDER BY source_id DESC
        LIMIT 1
        """,
        params,
    ).fetchone()


def _is_outpatient_rapid_lab_target(row: sqlite3.Row) -> bool:
    section = str(row["section"] or "")
    target_names = NORMALIZED_OUTPATIENT_RAPID_LAB_TARGET_NAMES_BY_SECTION.get(section)
    if target_names is None:
        return False

    base_name = _normalize_rapid_lab_name(str(row["base_name"] or ""))
    short_name = _normalize_rapid_lab_name(str(row["short_name"] or ""))
    return base_name in target_names or short_name in target_names
