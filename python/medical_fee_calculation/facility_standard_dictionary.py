from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class FacilityStandardRule:
    rule_key: str
    category: str
    display_name: str
    abbreviations: tuple[str, ...]
    aliases: tuple[str, ...] = ()
    priority: int = 0


FACILITY_STANDARD_RULES = (
    FacilityStandardRule(
        rule_key="lab_management_1",
        category="lab_management",
        display_name="検体検査管理加算1",
        abbreviations=("検Ⅰ",),
        aliases=("検I", "検1", "検１", "検体検査管理加算1", "検体検査管理加算Ⅰ"),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="lab_management_2",
        category="lab_management",
        display_name="検体検査管理加算2",
        abbreviations=("検Ⅱ",),
        aliases=("検II", "検2", "検２", "検体検査管理加算2", "検体検査管理加算Ⅱ"),
        priority=2,
    ),
    FacilityStandardRule(
        rule_key="lab_management_3",
        category="lab_management",
        display_name="検体検査管理加算3",
        abbreviations=("検Ⅲ",),
        aliases=("検III", "検3", "検３", "検体検査管理加算3", "検体検査管理加算Ⅲ"),
        priority=3,
    ),
    FacilityStandardRule(
        rule_key="lab_management_4",
        category="lab_management",
        display_name="検体検査管理加算4",
        abbreviations=("検Ⅳ",),
        aliases=("検IV", "検4", "検４", "検体検査管理加算4", "検体検査管理加算Ⅳ"),
        priority=4,
    ),
    FacilityStandardRule(
        rule_key="image_diagnostic_management_1",
        category="image_diagnostic_management",
        display_name="画像診断管理加算1",
        abbreviations=("画１",),
        aliases=("画1", "画像診断管理加算1", "画像診断管理加算１"),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="image_diagnostic_management_2",
        category="image_diagnostic_management",
        display_name="画像診断管理加算2",
        abbreviations=("画２",),
        aliases=("画2", "画像診断管理加算2", "画像診断管理加算２"),
        priority=2,
    ),
    FacilityStandardRule(
        rule_key="image_diagnostic_management_3",
        category="image_diagnostic_management",
        display_name="画像診断管理加算3",
        abbreviations=("画３",),
        aliases=("画3", "画像診断管理加算3", "画像診断管理加算３"),
        priority=3,
    ),
    FacilityStandardRule(
        rule_key="image_diagnostic_management_4",
        category="image_diagnostic_management",
        display_name="画像診断管理加算4",
        abbreviations=("画４",),
        aliases=("画4", "画像診断管理加算4", "画像診断管理加算４"),
        priority=4,
    ),
    FacilityStandardRule(
        rule_key="remote_image_diagnostic",
        category="remote_image_diagnostic",
        display_name="遠隔画像診断",
        abbreviations=("遠画",),
        aliases=("遠隔画像診断", "遠隔画像診断管理加算"),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="general_ward_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="一般病棟入院基本料",
        abbreviations=("一般入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="special_function_hospital_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="特定機能病院入院基本料",
        abbreviations=("特定入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="specialist_hospital_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="専門病院入院基本料",
        abbreviations=("専門入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="long_term_care_ward_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="療養病棟入院基本料",
        abbreviations=("療養入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="psychiatric_ward_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="精神病棟入院基本料",
        abbreviations=("精神入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="tuberculosis_ward_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="結核病棟入院基本料",
        abbreviations=("結核入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="disability_ward_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="障害者施設等入院基本料",
        abbreviations=("障害入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="clinic_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="有床診療所入院基本料",
        abbreviations=("診入院",),
        priority=1,
    ),
    FacilityStandardRule(
        rule_key="clinic_long_term_care_basic_inpatient",
        category="inpatient_basic_fee",
        display_name="有床診療所療養病床入院基本料",
        abbreviations=("診療養入院",),
        priority=1,
    ),
)


def normalize_facility_standard_value(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    return text.replace(" ", "").replace("\u3000", "")


def resolve_facility_standard_rule_key(value: object) -> str | None:
    return _FACILITY_STANDARD_RULE_LOOKUP.get(normalize_facility_standard_value(value))


def resolve_facility_standard_rule_keys(
    values: Iterable[object],
    *,
    category: str | None = None,
) -> frozenset[str]:
    category_filter = str(category or "").strip()
    rule_keys: set[str] = set()
    for value in values:
        rule_key = resolve_facility_standard_rule_key(value)
        if rule_key is None:
            continue
        rule = FACILITY_STANDARD_RULE_BY_KEY[rule_key]
        if category_filter and rule.category != category_filter:
            continue
        rule_keys.add(rule_key)
    return frozenset(rule_keys)


def has_facility_standard_rule(values: Iterable[object], rule_key: str) -> bool:
    return str(rule_key or "").strip() in resolve_facility_standard_rule_keys(values)


def select_facility_standard_rule_key(
    values: Iterable[object],
    candidate_rule_keys: Iterable[str],
) -> str | None:
    candidates = {str(rule_key or "").strip() for rule_key in candidate_rule_keys}
    matched = [
        FACILITY_STANDARD_RULE_BY_KEY[rule_key]
        for rule_key in resolve_facility_standard_rule_keys(values)
        if rule_key in candidates
    ]
    if not matched:
        return None
    return max(matched, key=lambda rule: (rule.priority, rule.rule_key)).rule_key


def facility_standard_dictionary_rows() -> tuple[dict[str, object], ...]:
    return tuple(
        {
            "rule_key": rule.rule_key,
            "category": rule.category,
            "display_name": rule.display_name,
            "abbreviations": ",".join(rule.abbreviations),
            "aliases": ",".join(rule.aliases),
            "priority": rule.priority,
        }
        for rule in FACILITY_STANDARD_RULES
    )


FACILITY_STANDARD_RULE_BY_KEY = {rule.rule_key: rule for rule in FACILITY_STANDARD_RULES}

_FACILITY_STANDARD_RULE_LOOKUP: dict[str, str] = {}
for _rule in FACILITY_STANDARD_RULES:
    _FACILITY_STANDARD_RULE_LOOKUP[normalize_facility_standard_value(_rule.rule_key)] = _rule.rule_key
    _FACILITY_STANDARD_RULE_LOOKUP[
        normalize_facility_standard_value(_rule.display_name)
    ] = _rule.rule_key
    for _value in (*_rule.abbreviations, *_rule.aliases):
        _FACILITY_STANDARD_RULE_LOOKUP[normalize_facility_standard_value(_value)] = _rule.rule_key
