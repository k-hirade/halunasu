from __future__ import annotations

import sqlite3
from pathlib import Path


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS master_sources (
    id INTEGER PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_version TEXT NOT NULL,
    published_at TEXT,
    url TEXT,
    raw_path TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    encoding TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    retrieved_at TEXT,
    imported_at TEXT NOT NULL,
    UNIQUE(source_type, source_version, checksum_sha256)
);

CREATE TABLE IF NOT EXISTS medical_procedures (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    short_name TEXT NOT NULL,
    base_name TEXT,
    points REAL NOT NULL,
    inout_applicability TEXT,
    outpatient_aggregate TEXT,
    inpatient_aggregate TEXT,
    bundle_lab_group TEXT,
    judgement_kind TEXT,
    judgement_group TEXT,
    specimen_comment_flag TEXT,
    facility_standard_codes TEXT,
    chapter TEXT,
    part TEXT,
    alpha_part TEXT,
    section TEXT,
    branch TEXT,
    item TEXT,
    notice_chapter TEXT,
    notice_part TEXT,
    notice_alpha_part TEXT,
    notice_section TEXT,
    notice_branch TEXT,
    notice_item TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, code)
);

CREATE INDEX IF NOT EXISTS idx_medical_procedures_code
    ON medical_procedures(code);

CREATE INDEX IF NOT EXISTS idx_medical_procedures_effective
    ON medical_procedures(source_id, effective_from, effective_to);

CREATE INDEX IF NOT EXISTS idx_medical_procedures_lab
    ON medical_procedures(source_id, chapter, part, section, branch, item);

CREATE INDEX IF NOT EXISTS idx_medical_procedures_judgement_group
    ON medical_procedures(source_id, judgement_kind, judgement_group);

CREATE TABLE IF NOT EXISTS drugs (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    kana TEXT,
    unit_code TEXT,
    unit_name TEXT,
    amount_kind TEXT,
    unit_amount_yen REAL NOT NULL,
    narcotic_psychotropic_flag TEXT,
    nerve_destroying_agent_flag TEXT,
    biologic_flag TEXT,
    generic_flag TEXT,
    dental_specific_drug_flag TEXT,
    contrast_agent_flag TEXT,
    injection_volume TEXT,
    listing_method_flag TEXT,
    product_related_code TEXT,
    dosage_form TEXT,
    changed_at TEXT,
    discontinued_at TEXT,
    reimbursement_code TEXT,
    publication_order TEXT,
    transitional_date TEXT,
    base_name TEXT,
    listed_at TEXT,
    generic_name_code TEXT,
    generic_prescription_text TEXT,
    generic_prescription_add_on_flag TEXT,
    anti_hiv_flag TEXT,
    long_listed_related_code TEXT,
    selective_treatment_flag TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, code)
);

CREATE INDEX IF NOT EXISTS idx_drugs_code
    ON drugs(code);

CREATE INDEX IF NOT EXISTS idx_drugs_effective
    ON drugs(source_id, changed_at, discontinued_at);

CREATE TABLE IF NOT EXISTS specific_materials (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    kana TEXT,
    unit_code TEXT,
    unit_name TEXT,
    amount_kind TEXT,
    unit_amount_yen REAL NOT NULL,
    age_addition_kind TEXT,
    min_age TEXT,
    max_age TEXT,
    oxygen_kind TEXT,
    material_kind TEXT,
    upper_price_flag TEXT,
    upper_points REAL,
    publication_order TEXT,
    discontinued_related_code TEXT,
    changed_at TEXT,
    transitional_date TEXT,
    discontinued_at TEXT,
    notification_table_no TEXT,
    notification_section_no TEXT,
    dpc_applicability TEXT,
    base_name TEXT,
    reprocessed_single_use_device_flag TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, code)
);

CREATE INDEX IF NOT EXISTS idx_specific_materials_code
    ON specific_materials(code);

CREATE INDEX IF NOT EXISTS idx_specific_materials_effective
    ON specific_materials(source_id, changed_at, discontinued_at);

CREATE TABLE IF NOT EXISTS comments (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    comment_text TEXT NOT NULL,
    kana TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, code)
);

CREATE INDEX IF NOT EXISTS idx_comments_code
    ON comments(code);

CREATE TABLE IF NOT EXISTS comment_links (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    procedure_code TEXT NOT NULL,
    procedure_name TEXT,
    comment_code TEXT NOT NULL,
    comment_text TEXT,
    chapter TEXT,
    section TEXT,
    branch TEXT,
    requirement_kind TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_links_procedure_code
    ON comment_links(source_id, procedure_code);

CREATE INDEX IF NOT EXISTS idx_comment_links_comment_code
    ON comment_links(source_id, comment_code);

CREATE INDEX IF NOT EXISTS idx_comment_links_procedure_comment
    ON comment_links(source_id, procedure_code, comment_code);

CREATE TABLE IF NOT EXISTS electronic_aux_master (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    group_code TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, code)
);

CREATE TABLE IF NOT EXISTS electronic_bundles (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    bundle_group_code TEXT NOT NULL,
    procedure_code TEXT NOT NULL,
    procedure_name TEXT,
    applicability TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_electronic_bundles_group
    ON electronic_bundles(source_id, bundle_group_code);

CREATE INDEX IF NOT EXISTS idx_electronic_bundles_procedure_code
    ON electronic_bundles(source_id, procedure_code);

CREATE TABLE IF NOT EXISTS electronic_exclusions (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    exclusion_table TEXT NOT NULL,
    base_code TEXT NOT NULL,
    base_name TEXT,
    excluded_code TEXT NOT NULL,
    excluded_name TEXT,
    rule_kind TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_electronic_exclusions_base
    ON electronic_exclusions(source_id, exclusion_table, base_code);

CREATE INDEX IF NOT EXISTS idx_electronic_exclusions_excluded
    ON electronic_exclusions(source_id, exclusion_table, excluded_code);

CREATE INDEX IF NOT EXISTS idx_electronic_exclusions_base_pair
    ON electronic_exclusions(source_id, exclusion_table, base_code, excluded_code);

CREATE TABLE IF NOT EXISTS electronic_inpatient_basic (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    inpatient_basic_code TEXT NOT NULL,
    procedure_code TEXT NOT NULL,
    procedure_name TEXT,
    applicability TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_electronic_inpatient_basic_code
    ON electronic_inpatient_basic(source_id, inpatient_basic_code);

CREATE TABLE IF NOT EXISTS electronic_frequency_limits (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    procedure_code TEXT NOT NULL,
    procedure_name TEXT,
    limit_code TEXT NOT NULL,
    limit_name TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_electronic_frequency_limits_code
    ON electronic_frequency_limits(source_id, procedure_code);

CREATE INDEX IF NOT EXISTS idx_electronic_frequency_limits_code_limit
    ON electronic_frequency_limits(source_id, procedure_code, limit_code);

CREATE TABLE IF NOT EXISTS dpc_electronic_table_rows (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    workbook_file TEXT NOT NULL,
    sheet_name TEXT NOT NULL,
    sheet_index INTEGER NOT NULL,
    sheet_purpose TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, sheet_index, row_index)
);

CREATE INDEX IF NOT EXISTS idx_dpc_electronic_table_rows_sheet
    ON dpc_electronic_table_rows(source_id, sheet_purpose, sheet_index);

CREATE TABLE IF NOT EXISTS dpc_point_table (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    workbook_file TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    serial_number TEXT,
    dpc_code TEXT NOT NULL,
    diagnosis_name TEXT,
    surgery_name TEXT,
    surgery_procedure_1 TEXT,
    surgery_procedure_2 TEXT,
    defined_comorbidity TEXT,
    severity TEXT,
    period_1_days INTEGER,
    period_2_days INTEGER,
    period_3_days INTEGER,
    period_1_points INTEGER,
    period_2_points INTEGER,
    period_3_points INTEGER,
    change_category TEXT,
    effective_from TEXT,
    effective_to TEXT,
    updated_at TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_dpc_point_table_code
    ON dpc_point_table(source_id, dpc_code);

CREATE TABLE IF NOT EXISTS dpc_conversion_table (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    workbook_file TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    serial_number TEXT,
    dpc_code TEXT NOT NULL,
    inclusive_payment_flag TEXT,
    mdc_code TEXT,
    classification_code TEXT,
    disease_state_classification TEXT,
    age_condition TEXT,
    month_age_condition TEXT,
    weight_condition TEXT,
    jcs_condition TEXT,
    burn_index_condition TEXT,
    gaf_condition TEXT,
    pregnancy_weeks_condition TEXT,
    delivery_bleeding_amount_condition TEXT,
    surgery_flag TEXT,
    surgery_procedure_1_flag TEXT,
    surgery_procedure_2_flag TEXT,
    defined_comorbidity_flag TEXT,
    severity_age_condition TEXT,
    severity_jcs_condition TEXT,
    unilateral_bilateral_condition TEXT,
    first_reoperation_condition TEXT,
    one_eye_both_eyes_condition TEXT,
    one_side_both_sides_condition TEXT,
    rehabilitation_condition TEXT,
    mild_severe_condition TEXT,
    pre_onset_rankin_scale_condition TEXT,
    a_drop_score_condition TEXT,
    transfer_from_other_hospital_ward_condition TEXT,
    stroke_onset_timing_condition TEXT,
    child_pugh_classification_condition TEXT,
    change_category TEXT,
    effective_from TEXT,
    effective_to TEXT,
    updated_at TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_dpc_conversion_table_code
    ON dpc_conversion_table(source_id, dpc_code);

CREATE INDEX IF NOT EXISTS idx_dpc_conversion_table_mdc
    ON dpc_conversion_table(source_id, mdc_code, classification_code);

CREATE TABLE IF NOT EXISTS dpc_icd_table (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    workbook_file TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    mdc_code TEXT NOT NULL,
    classification_code TEXT NOT NULL,
    icd_name TEXT,
    icd_code TEXT NOT NULL,
    change_category TEXT,
    effective_from TEXT,
    effective_to TEXT,
    updated_at TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_dpc_icd_table_code
    ON dpc_icd_table(source_id, icd_code);

CREATE INDEX IF NOT EXISTS idx_dpc_icd_table_classification
    ON dpc_icd_table(source_id, mdc_code, classification_code);

CREATE TABLE IF NOT EXISTS dpc_surgery_table (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    workbook_file TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    mdc_code TEXT NOT NULL,
    classification_code TEXT NOT NULL,
    value_code TEXT,
    surgery_flag TEXT NOT NULL,
    age_birthweight_value TEXT,
    corresponding_code TEXT,
    surgery_1_name TEXT,
    surgery_1_code TEXT,
    surgery_2_name TEXT,
    surgery_2_code TEXT,
    surgery_3_name TEXT,
    surgery_3_code TEXT,
    surgery_4_name TEXT,
    surgery_4_code TEXT,
    surgery_5_name TEXT,
    surgery_5_code TEXT,
    change_category TEXT,
    effective_from TEXT,
    effective_to TEXT,
    updated_at TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_dpc_surgery_table_classification
    ON dpc_surgery_table(source_id, mdc_code, classification_code);

CREATE INDEX IF NOT EXISTS idx_dpc_surgery_table_flag
    ON dpc_surgery_table(source_id, mdc_code, classification_code, surgery_flag);

CREATE TABLE IF NOT EXISTS dpc_piecework_surgery_codes (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    workbook_file TEXT NOT NULL,
    row_index INTEGER NOT NULL,
    category_code TEXT,
    surgery_code TEXT,
    surgery_name TEXT,
    change_category TEXT,
    effective_from TEXT,
    effective_to TEXT,
    updated_at TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_dpc_piecework_surgery_codes_code
    ON dpc_piecework_surgery_codes(source_id, surgery_code);

CREATE TABLE IF NOT EXISTS dpc_hospital_coefficients (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    prefecture_name TEXT,
    medical_institution_code TEXT,
    institution_name TEXT NOT NULL,
    normalized_institution_name TEXT NOT NULL,
    hospital_group TEXT,
    base_coefficient REAL,
    functional_evaluation_coefficient_i REAL,
    functional_evaluation_coefficient_ii REAL,
    emergency_correction_coefficient REAL,
    mitigation_coefficient REAL,
    total_coefficient REAL NOT NULL,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_dpc_hospital_coefficients_code
    ON dpc_hospital_coefficients(source_id, medical_institution_code);

CREATE INDEX IF NOT EXISTS idx_dpc_hospital_coefficients_name
    ON dpc_hospital_coefficients(source_id, normalized_institution_name, prefecture_name);

CREATE TABLE IF NOT EXISTS hospital_registry (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    regional_bureau TEXT NOT NULL,
    prefecture_code TEXT,
    medical_institution_code TEXT NOT NULL,
    raw_medical_institution_code TEXT,
    institution_name TEXT NOT NULL,
    institution_type TEXT,
    postal_code TEXT,
    address TEXT,
    phone TEXT,
    founder TEXT,
    administrator TEXT,
    designated_from TEXT,
    status TEXT,
    bed_count_text TEXT,
    departments_text TEXT,
    raw_row_json TEXT NOT NULL,
    PRIMARY KEY(source_id, medical_institution_code)
);

CREATE INDEX IF NOT EXISTS idx_hospital_registry_code
    ON hospital_registry(medical_institution_code);

CREATE INDEX IF NOT EXISTS idx_hospital_registry_regional_code
    ON hospital_registry(regional_bureau, medical_institution_code);

CREATE TABLE IF NOT EXISTS hospital_facility_standards (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    regional_bureau TEXT NOT NULL,
    prefecture_code TEXT,
    prefecture_name TEXT,
    category TEXT,
    medical_institution_code TEXT NOT NULL,
    co_located_medical_institution_code TEXT,
    institution_symbol_number TEXT,
    institution_name TEXT NOT NULL,
    postal_code TEXT,
    address TEXT,
    phone TEXT,
    fax TEXT,
    bed_count_text TEXT,
    standard_name TEXT NOT NULL,
    standard_abbreviation TEXT,
    receipt_number TEXT,
    start_date TEXT,
    individual_effective_start_date TEXT,
    remarks_heading TEXT,
    remarks_data TEXT,
    municipality_code TEXT,
    municipality_name TEXT,
    type_code TEXT,
    type_name TEXT,
    raw_row_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hospital_facility_standards_code
    ON hospital_facility_standards(source_id, medical_institution_code);

CREATE INDEX IF NOT EXISTS idx_hospital_facility_standards_medical_code
    ON hospital_facility_standards(medical_institution_code);

CREATE INDEX IF NOT EXISTS idx_hospital_facility_standards_regional_code
    ON hospital_facility_standards(regional_bureau, medical_institution_code);

CREATE INDEX IF NOT EXISTS idx_hospital_facility_standards_abbrev
    ON hospital_facility_standards(source_id, standard_abbreviation);

CREATE INDEX IF NOT EXISTS idx_hfs_source_region_code_order
    ON hospital_facility_standards(
        source_id,
        regional_bureau,
        medical_institution_code,
        standard_abbreviation,
        standard_name,
        receipt_number,
        start_date
    );

CREATE INDEX IF NOT EXISTS idx_hospital_facility_standards_profile_lookup_no_source
    ON hospital_facility_standards(
        regional_bureau,
        medical_institution_code,
        standard_abbreviation,
        standard_name,
        receipt_number,
        start_date
    );

CREATE VIEW IF NOT EXISTS hospital_profile_facility_standards AS
SELECT
    medical_institution_code,
    standard_abbreviation,
    standard_name,
    receipt_number,
    start_date,
    source_id
FROM hospital_facility_standards;

CREATE VIEW IF NOT EXISTS lab_procedure_catalog AS
SELECT
    source_id,
    code,
    short_name,
    base_name,
    points,
    inout_applicability,
    outpatient_aggregate,
    inpatient_aggregate,
    bundle_lab_group,
    judgement_kind,
    judgement_group,
    specimen_comment_flag,
    facility_standard_codes,
    chapter,
    part,
    alpha_part,
    section,
    branch,
    item,
    effective_from,
    effective_to,
    CASE
        WHEN chapter = '2'
         AND part = '03'
         AND CAST(section AS INTEGER) BETWEEN 0 AND 24
         AND judgement_kind = '1'
        THEN 1 ELSE 0
    END AS is_lab_test,
    CASE
        WHEN chapter = '2'
         AND part = '03'
         AND section = '026'
         AND judgement_kind = '2'
        THEN 1 ELSE 0
    END AS is_judgement_fee,
    CASE
        WHEN chapter = '2'
         AND part = '03'
         AND section = '027'
        THEN 1 ELSE 0
    END AS is_basic_lab_judgement_fee,
    CASE
        WHEN chapter = '2'
         AND part = '03'
         AND CAST(section AS INTEGER) BETWEEN 400 AND 419
        THEN 1 ELSE 0
    END AS is_collection_fee
FROM medical_procedures;

CREATE VIEW IF NOT EXISTS lab_judgement_fee_map AS
SELECT
    source_id,
    judgement_group,
    code AS judgement_fee_code,
    short_name AS judgement_fee_name,
    base_name AS judgement_fee_base_name,
    points,
    effective_from,
    effective_to
FROM medical_procedures
WHERE chapter = '2'
  AND part = '03'
  AND section = '026'
  AND judgement_kind = '2'
  AND judgement_group IS NOT NULL
  AND judgement_group <> ''
  AND judgement_group <> '0';

-- ============================================================================
-- レセ点検マスタ(支払基金コンピュータチェックマスタ + 傷病名/修飾語)。
-- 算定本体では使わず、適応/禁忌/併用/病名整備の点検(fee-core claim-checks)が参照する。
-- スキーマは recept-checker(official_import.py)の実績スキーマを踏襲。
-- ============================================================================

CREATE TABLE IF NOT EXISTS diseases (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT,
    name_kana TEXT,
    exchange_code TEXT,
    icd10 TEXT,
    single_flag TEXT,
    effective_from TEXT,
    effective_to TEXT,
    raw_row_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_diseases_code ON diseases(code);
CREATE INDEX IF NOT EXISTS idx_diseases_name ON diseases(name);

CREATE TABLE IF NOT EXISTS disease_modifiers (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT,
    kubun TEXT
);
CREATE INDEX IF NOT EXISTS idx_disease_modifiers_code ON disease_modifiers(code);

CREATE TABLE IF NOT EXISTS cc_drug_indications (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    drug_code TEXT NOT NULL,
    disease_code TEXT,
    sex TEXT,
    age_min REAL,
    age_max REAL,
    check_kubun TEXT,
    max_dose REAL,
    max_days INTEGER,
    tekigi TEXT,
    ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_ind_drug ON cc_drug_indications(drug_code);

CREATE TABLE IF NOT EXISTS cc_drug_dose_groups (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    drug_code TEXT NOT NULL,
    dosage_form TEXT,
    unit TEXT,
    group_name TEXT,
    disease_code TEXT,
    sex TEXT,
    age_min REAL,
    age_max REAL,
    ingredient_amount REAL,
    target_flag TEXT,
    max_dose REAL,
    ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_dose_group_drug ON cc_drug_dose_groups(drug_code);
CREATE INDEX IF NOT EXISTS idx_cc_dose_group_name ON cc_drug_dose_groups(group_name);

CREATE TABLE IF NOT EXISTS cc_drug_contra_disease (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    drug_code TEXT NOT NULL,
    disease_code TEXT,
    ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_contra_drug ON cc_drug_contra_disease(drug_code);

CREATE TABLE IF NOT EXISTS cc_drug_interactions (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    drug_a TEXT NOT NULL,
    drug_b TEXT NOT NULL,
    ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_inter_a ON cc_drug_interactions(drug_a);
CREATE INDEX IF NOT EXISTS idx_cc_inter_b ON cc_drug_interactions(drug_b);

CREATE TABLE IF NOT EXISTS cc_act_indications (
    source_id INTEGER NOT NULL REFERENCES master_sources(id) ON DELETE CASCADE,
    act_code TEXT NOT NULL,
    disease_code TEXT,
    sex TEXT,
    age_min REAL,
    age_max REAL,
    nyugai TEXT,
    utagai TEXT,
    ref_range TEXT
);
CREATE INDEX IF NOT EXISTS idx_cc_act_code ON cc_act_indications(act_code);
CREATE INDEX IF NOT EXISTS idx_cc_act_indications_disease ON cc_act_indications(disease_code);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def initialize_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    _ensure_procedure_annotation_columns(conn)
    conn.commit()


# 医科診療行為マスタの機械可読構造(注加算・きざみ・年齢条件)をカラム化する。
# 位置は実データと公式レイアウトで検証済み:
#   raw[37]=注加算コード(グループ), raw[38]=注加算通番(0=親項目/1以上=注加算メンバー),
#   raw[29..33]=きざみ(識別/下限/上限/きざみ値/きざみ点数), raw[40..41]=年齢下限/上限コード。
# 注: 旧実装が使っていた raw[13] は注加算識別ではない(乳幼児時間外加算等の
# 「選択・置換」関係の行too含まれ、過大算定を生む)。注加算はコード/通番のみで結線する。
# 既存DBにも冪等に適用できるよう ALTER+json_extract バックフィルで行う(再取込不要)。
# バックフィルは行レベル(chu_addon_code IS NULL)で毎回実行し、
# 新sourceの取込後もカラムがNULLのまま沈黙停止しないようにする。
_PROCEDURE_ANNOTATION_COLUMNS = (
    ("chu_addon_code", "TEXT", "$[37]"),
    ("chu_addon_seq", "TEXT", "$[38]"),
    ("kizami_flag", "TEXT", "$[29]"),
    ("kizami_min", "REAL", "$[30]"),
    ("kizami_max", "REAL", "$[31]"),
    ("kizami_unit", "REAL", "$[32]"),
    ("kizami_points", "REAL", "$[33]"),
    ("age_min_code", "TEXT", "$[40]"),
    ("age_max_code", "TEXT", "$[41]"),
)


def _ensure_procedure_annotation_columns(conn: sqlite3.Connection) -> None:
    existing = {row[1] for row in conn.execute("PRAGMA table_info(medical_procedures)")}
    for name, col_type, _path in _PROCEDURE_ANNOTATION_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE medical_procedures ADD COLUMN {name} {col_type}")
    assignments = ", ".join(
        f"{name} = json_extract(raw_row_json, '{path}')"
        for name, _t, path in _PROCEDURE_ANNOTATION_COLUMNS
    )
    conn.execute(
        f"UPDATE medical_procedures SET {assignments} "
        "WHERE chu_addon_code IS NULL "
        "AND raw_row_json IS NOT NULL AND raw_row_json != '[]' AND raw_row_json != ''"
    )
