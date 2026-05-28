from __future__ import annotations

import csv
import json
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_JAPANESE_BOOLEAN_VALUES = {
    "1": "true",
    "0": "false",
    "true": "true",
    "false": "false",
    "TRUE": "true",
    "FALSE": "false",
    "はい": "true",
    "いいえ": "false",
    "有": "true",
    "無": "false",
    "有り": "true",
    "無し": "false",
    "あり": "true",
    "なし": "false",
    "○": "true",
    "×": "false",
    "対象": "true",
    "対象外": "false",
    "算定": "true",
    "非算定": "false",
}

_JAPANESE_BOOLEAN_VALUE_MAPS = {
    field_name: _JAPANESE_BOOLEAN_VALUES
    for field_name in (
        "is_outpatient",
        "information_communication_equipment",
        "same_day_second_department",
        "same_day_revisit",
        "large_hospital_no_referral",
        "refill_prescription",
        "special_pharmacy_relationship",
        "gargle_only",
        "specific_disease_prescription_management",
        "specific_disease_prescription_management_already_billed_same_month",
        "anti_malignant_tumor_prescription_management",
        "anti_malignant_tumor_prescription_management_already_billed_same_month",
        "infant",
        "drip_infusion_outpatient_other",
        "biologic_add_on",
        "narcotic_add_on",
        "precision_continuous_infusion_add_on",
        "head",
        "joint_use",
        "contrast",
        "electronic_image_management",
        "diagnostic_management_add_on",
        "remote_diagnostic_management_add_on",
        "dpc_claim",
        "already_billed_lab_management_same_month",
        "already_billed_outpatient_rapid_lab_items_same_day",
        "outpatient_rapid_lab_same_day_result_explained",
        "outpatient_rapid_lab_written_information_provided",
        "outpatient_rapid_lab_result_based_care_provided",
        "suppress_all_judgement_fees",
        "judgement_history_complete",
        "lab_management_history_complete",
        "collection_fee_history_complete",
        "outpatient_rapid_lab_history_complete",
    )
}


ORDER_CSV_COLUMN_PRESETS: dict[str, dict[str, Any]] = {
    "japanese": {
        "columns": {
            "レコードID": "record_id",
            "請求ID": "record_id",
            "受付ID": "record_id",
            "患者番号": "patient_id",
            "患者ID": "patient_id",
            "診療日": "service_date",
            "算定日": "service_date",
            "実施日": "service_date",
            "入院日": "admission_date",
            "退院日": "discharge_date",
            "地方厚生局": "regional_bureau",
            "厚生局": "regional_bureau",
            "医療機関コード": "medical_institution_code",
            "保険医療機関コード": "medical_institution_code",
            "入外": "is_outpatient",
            "明細種別": "item_kind",
            "種別": "item_kind",
            "オーダー種別": "item_kind",
            "診療行為コード": "code",
            "レセ電コード": "code",
            "コード": "code",
            "薬剤コード": "drug_code",
            "材料コード": "material_code",
            "コメントコード": "comment_code",
            "コメント文": "comment_text",
            "コメント内容": "comment_text",
            "数量": "quantity",
            "回数": "quantity",
            "総量": "total_quantity",
            "1日量": "quantity_per_day",
            "一日量": "quantity_per_day",
            "日数": "days",
            "投与日数": "days",
            "1回量": "dose_quantity",
            "一回量": "dose_quantity",
            "1日回数": "doses_per_day",
            "一日回数": "doses_per_day",
            "採取料入力": "collection_fee_inputs",
            "施設基準": "facility_standard_keys",
            "初再診区分": "fee_kind",
            "基本料区分": "fee_kind",
            "外来基本料区分": "outpatient_basic_fee_kind",
            "情報通信機器": "information_communication_equipment",
            "同日二科目": "same_day_second_department",
            "同日2科目": "same_day_second_department",
            "同日再診": "same_day_revisit",
            "紹介状なし": "large_hospital_no_referral",
            "大病院紹介なし": "large_hospital_no_referral",
            "院内院外": "delivery_kind",
            "投薬区分": "delivery_kind",
            "処方区分": "prescription_category",
            "調剤種別": "dispensing_kind",
            "調剤区分": "dispensing_kind",
            "調剤種別一覧": "dispensing_kinds",
            "リフィル": "refill_prescription",
            "特定保険薬局関係": "special_pharmacy_relationship",
            "含嗽薬のみ": "gargle_only",
            "うがい薬のみ": "gargle_only",
            "特定疾患処方管理加算": "specific_disease_prescription_management",
            "特定疾患処方管理加算同月算定済": "specific_disease_prescription_management_already_billed_same_month",
            "抗悪性腫瘍剤処方管理加算": "anti_malignant_tumor_prescription_management",
            "抗悪性腫瘍剤処方管理加算同月算定済": "anti_malignant_tumor_prescription_management_already_billed_same_month",
            "一般名処方加算": "generic_name_prescription_add_on",
            "注射経路": "route_kind",
            "注射投与経路": "injection_route_kind",
            "注射投与量": "dose_quantity",
            "投与回数": "administrations",
            "乳幼児": "infant",
            "点滴その他": "drip_infusion_outpatient_other",
            "生物学的製剤加算": "biologic_add_on",
            "麻薬加算": "narcotic_add_on",
            "精密持続点滴加算": "precision_continuous_infusion_add_on",
            "処置種別": "kind",
            "処置区分": "kind",
            "面積区分": "area_size",
            "画像種別": "kind",
            "撮影種別": "kind",
            "撮影方式": "acquisition_kind",
            "写真診断区分": "radiography_diagnostic_kind",
            "CT機器": "ct_equipment_kind",
            "CT装置": "ct_equipment_kind",
            "MRI機器": "mri_equipment_kind",
            "MRI装置": "mri_equipment_kind",
            "頭部": "head",
            "共同利用": "joint_use",
            "造影": "contrast",
            "電子画像管理": "electronic_image_management",
            "画像診断管理加算": "diagnostic_management_add_on",
            "画像診断管理": "diagnostic_management_add_on",
            "遠隔画像診断管理加算": "remote_diagnostic_management_add_on",
            "遠隔画像診断": "remote_diagnostic_management_add_on",
            "入院基本料コード": "basic_fee_code",
            "入院基本料日数": "basic_fee_days",
            "入院基本料施設基準": "inpatient_facility_standard_key",
            "病棟区分": "ward_kind",
            "入院基本料テーブルコード": "inpatient_basic_code",
            "DPC対象": "dpc_claim",
            "ＤＰＣ対象": "dpc_claim",
            "DPCコード": "dpc_code",
            "ＤＰＣコード": "dpc_code",
            "ICDコード": "icd_code",
            "ＩＣＤコード": "icd_code",
            "MDCコード": "mdc_code",
            "ＭＤＣコード": "mdc_code",
            "DPC分類コード": "classification_code",
            "分類コード": "classification_code",
            "主傷病": "main_diagnosis",
            "医療資源病名": "resource_diagnosis",
            "手術コード": "surgery_code",
            "DPC処置コード": "dpc_procedure_code",
            "副傷病": "comorbidity",
            "医療機関別係数": "hospital_coefficient",
            "病態等分類": "disease_state_classification",
            "年齢条件": "age_condition",
            "月齢条件": "month_age_condition",
            "体重条件": "weight_condition",
            "JCS条件": "jcs_condition",
            "BurnIndex条件": "burn_index_condition",
            "GAF条件": "gaf_condition",
            "妊娠週数条件": "pregnancy_weeks_condition",
            "分娩時出血量条件": "delivery_bleeding_amount_condition",
            "手術フラグ": "surgery_flag",
            "処置1フラグ": "surgery_procedure_1_flag",
            "処置２フラグ": "surgery_procedure_2_flag",
            "処置2フラグ": "surgery_procedure_2_flag",
            "定義副傷病フラグ": "defined_comorbidity_flag",
            "重症度年齢条件": "severity_age_condition",
            "重症度JCS条件": "severity_jcs_condition",
            "一側両側条件": "unilateral_bilateral_condition",
            "初回再手術条件": "first_reoperation_condition",
            "片眼両眼条件": "one_eye_both_eyes_condition",
            "片側両側条件": "one_side_both_sides_condition",
            "リハビリ条件": "rehabilitation_condition",
            "軽症重症条件": "mild_severe_condition",
            "発症前Rankin条件": "pre_onset_rankin_scale_condition",
            "A-DROP条件": "a_drop_score_condition",
            "転院条件": "transfer_from_other_hospital_ward_condition",
            "脳卒中発症時期条件": "stroke_onset_timing_condition",
            "ChildPugh条件": "child_pugh_classification_condition",
            "同日履歴": "same_day_history_codes",
            "同週履歴": "same_week_history_codes",
            "同月履歴": "same_month_history_codes",
            "同日算定済採取料": "already_billed_collection_fee_codes_same_day",
            "既算定判断料": "already_billed_judgement_groups",
            "包括判断料": "bundled_judgement_groups",
            "検体検査管理加算同月算定済": "already_billed_lab_management_same_month",
            "外来迅速検体検査同日算定済": "already_billed_outpatient_rapid_lab_items_same_day",
            "迅速検査対象項目数": "outpatient_rapid_lab_eligible_test_item_count",
            "当日結果説明": "outpatient_rapid_lab_same_day_result_explained",
            "文書提供": "outpatient_rapid_lab_written_information_provided",
            "結果に基づく診療": "outpatient_rapid_lab_result_based_care_provided",
            "全判断料抑制": "suppress_all_judgement_fees",
            "判断料履歴完全": "judgement_history_complete",
            "検体検査管理加算履歴完全": "lab_management_history_complete",
            "採取料履歴完全": "collection_fee_history_complete",
            "外来迅速検体検査履歴完全": "outpatient_rapid_lab_history_complete",
            "正解点数": "expected_total_points",
            "期待点数": "expected_total_points",
            "確定点数": "expected_total_points",
            "請求点数": "expected_total_points",
            "合計点数": "expected_total_points",
            "正解ステータス": "expected_status",
            "期待ステータス": "expected_status",
            "確定ステータス": "expected_status",
            "正解コード": "expected_candidate_codes",
            "期待コード": "expected_candidate_codes",
            "確定コード": "expected_candidate_codes",
            "請求コード": "expected_candidate_codes",
        },
        "values": {
            **_JAPANESE_BOOLEAN_VALUE_MAPS,
            "is_outpatient": {
                **_JAPANESE_BOOLEAN_VALUES,
                "外来": "true",
                "入院外": "true",
                "入院": "false",
            },
            "item_kind": {
                "診療行為": "procedure",
                "行為": "procedure",
                "薬剤": "drug",
                "投薬": "medication_order",
                "注射": "injection_order",
                "注射薬": "injection_drug",
                "材料": "material",
                "特定器材": "material",
                "コメント": "comment",
                "摘要": "comment",
                "採取料": "collection_fee",
                "同日履歴": "same_day_history",
                "同週履歴": "same_week_history",
                "同月履歴": "same_month_history",
                "施設基準": "facility_standard",
                "処置": "treatment",
                "画像": "imaging",
                "入院基本料": "inpatient_basic",
                "入院": "inpatient_basic",
                "DPC": "dpc",
                "ＤＰＣ": "dpc",
                "基本情報": "context",
                "オプション": "option",
                "条件": "option",
                "正解": "expected",
                "期待": "expected",
                "確定": "expected",
                "請求": "expected",
                "請求済": "expected",
            },
            "fee_kind": {
                "初診": "initial",
                "初診料": "initial",
                "再診": "revisit",
                "再診料": "revisit",
                "外来診療料": "outpatient_clinic",
            },
            "outpatient_basic_fee_kind": {
                "初診": "initial",
                "初診料": "initial",
                "再診": "revisit",
                "再診料": "revisit",
                "外来診療料": "outpatient_clinic",
            },
            "delivery_kind": {
                "院内": "in_house",
                "院内処方": "in_house",
                "院外": "outside_prescription",
                "院外処方": "outside_prescription",
            },
            "medication_delivery_kind": {
                "院内": "in_house",
                "院内処方": "in_house",
                "院外": "outside_prescription",
                "院外処方": "outside_prescription",
            },
            "prescription_category": {
                "その他": "other",
                "通常": "other",
                "7種類以上": "seven_or_more_internal_medicines",
                "七種類以上": "seven_or_more_internal_medicines",
                "向精神薬多剤": "psychotropic_polypharmacy",
                "向精神薬長期": "psychotropic_long_term",
            },
            "dispensing_kind": {
                "内服": "internal_or_prn",
                "頓服": "internal_or_prn",
                "内服又は頓服": "internal_or_prn",
                "外用": "external",
            },
            "dispensing_kinds": {
                "内服": "internal_or_prn",
                "頓服": "internal_or_prn",
                "内服又は頓服": "internal_or_prn",
                "外用": "external",
            },
            "generic_name_prescription_add_on": {
                "1": "generic_name_add_on_1",
                "2": "generic_name_add_on_2",
                "加算1": "generic_name_add_on_1",
                "加算2": "generic_name_add_on_2",
                "一般名処方加算1": "generic_name_add_on_1",
                "一般名処方加算2": "generic_name_add_on_2",
            },
            "route_kind": {
                "皮内皮下筋肉内": "intradermal_subcutaneous_intramuscular",
                "皮内": "intradermal_subcutaneous_intramuscular",
                "皮下": "intradermal_subcutaneous_intramuscular",
                "筋肉内": "intradermal_subcutaneous_intramuscular",
                "静脈内": "intravenous",
                "静注": "intravenous",
                "点滴": "drip_infusion",
                "点滴注射": "drip_infusion",
                "中心静脈": "central_venous",
                "関節腔内": "joint_cavity",
                "硝子体内": "vitreous",
            },
            "injection_route_kind": {
                "皮内皮下筋肉内": "intradermal_subcutaneous_intramuscular",
                "皮内": "intradermal_subcutaneous_intramuscular",
                "皮下": "intradermal_subcutaneous_intramuscular",
                "筋肉内": "intradermal_subcutaneous_intramuscular",
                "静脈内": "intravenous",
                "静注": "intravenous",
                "点滴": "drip_infusion",
                "点滴注射": "drip_infusion",
                "中心静脈": "central_venous",
                "関節腔内": "joint_cavity",
                "硝子体内": "vitreous",
            },
            "kind": {
                "創傷処置": "wound",
                "熱傷処置": "burn",
                "皮膚科軟膏処置": "dermatology_ointment",
                "消炎鎮痛等処置": "anti_inflammatory_manual",
                "消炎鎮痛等処置マッサージ等": "anti_inflammatory_manual",
                "消炎鎮痛等処置器具等": "anti_inflammatory_device",
                "消炎鎮痛等処置湿布": "anti_inflammatory_patch",
                "鼻腔栄養": "nasal_feeding",
                "留置カテーテル": "indwelling_urinary_catheter",
                "尿道拡張": "urethral_dilation_catheterization",
                "間歇導尿": "intermittent_catheterization",
                "膣洗浄": "vaginal_irrigation",
                "爪甲除去": "nail_removal",
                "単純撮影": "simple_radiography",
                "単純X線": "simple_radiography",
                "造影剤使用撮影": "contrast_radiography",
                "乳房撮影": "mammography",
                "マンモグラフィー": "mammography",
                "CT": "ct",
                "ＣＴ": "ct",
                "MRI": "mri",
                "ＭＲＩ": "mri",
            },
            "area_size": {
                "100cm2未満": "lt_100_cm2",
                "100平方センチメートル未満": "lt_100_cm2",
                "100cm2以上500cm2未満": "ge_100_lt_500_cm2",
                "100以上500未満": "ge_100_lt_500_cm2",
                "500cm2以上3000cm2未満": "ge_500_lt_3000_cm2",
                "500以上3000未満": "ge_500_lt_3000_cm2",
                "3000cm2以上6000cm2未満": "ge_3000_lt_6000_cm2",
                "3000以上6000未満": "ge_3000_lt_6000_cm2",
                "6000cm2以上": "ge_6000_cm2",
                "6000以上": "ge_6000_cm2",
            },
            "acquisition_kind": {
                "アナログ": "analog",
                "フィルム": "analog",
                "デジタル": "digital",
                "電子": "digital",
            },
            "radiography_diagnostic_kind": {
                "イ": "simple_i",
                "ロ": "simple_ro",
            },
            "ct_equipment_kind": {
                "その他": "other",
                "4列以上16列未満": "multislice_4_to_16",
                "16列以上64列未満": "multislice_16_to_64",
                "64列以上128列未満": "multislice_64_to_128",
                "128列以上": "multislice_128_or_more",
            },
            "mri_equipment_kind": {
                "その他": "other",
                "1.5T以上3T未満": "tesla_1_5_to_3",
                "1.5テスラ以上3テスラ未満": "tesla_1_5_to_3",
                "3T以上": "tesla_3_or_more",
                "3テスラ以上": "tesla_3_or_more",
            },
        },
    },
    "orca": {
        "columns": {
            "レコードID": "record_id",
            "請求ID": "record_id",
            "患者番号": "patient_id",
            "診療日": "service_date",
            "地方厚生局": "regional_bureau",
            "厚生局": "regional_bureau",
            "医療機関コード": "medical_institution_code",
            "保険医療機関コード": "medical_institution_code",
            "入外区分": "is_outpatient",
            "剤種": "item_kind",
            "診療種別": "item_kind",
            "診療行為コード": "code",
            "レセ電算コード": "code",
            "コメントコード": "comment_code",
            "コメント文": "comment_text",
            "コメント内容": "comment_text",
            "数量": "quantity",
            "回数": "quantity",
            "正解点数": "expected_total_points",
            "期待点数": "expected_total_points",
            "確定点数": "expected_total_points",
            "請求点数": "expected_total_points",
            "合計点数": "expected_total_points",
            "正解ステータス": "expected_status",
            "期待ステータス": "expected_status",
            "確定ステータス": "expected_status",
            "正解コード": "expected_candidate_codes",
            "期待コード": "expected_candidate_codes",
            "確定コード": "expected_candidate_codes",
            "請求コード": "expected_candidate_codes",
        },
        "values": {
            "is_outpatient": {
                "1": "true",
                "2": "false",
                "外来": "true",
                "入院": "false",
            },
            "item_kind": {
                "診療行為": "procedure",
                "検査": "procedure",
                "薬剤": "drug",
                "投薬": "medication_order",
                "注射": "injection_order",
                "材料": "material",
                "コメント": "comment",
                "摘要": "comment",
                "処置": "treatment",
                "画像": "imaging",
                "正解": "expected",
                "期待": "expected",
                "確定": "expected",
                "請求": "expected",
                "請求済": "expected",
            },
        },
    },
}


_ORDER_CSV_KNOWN_TARGET_FIELDS = frozenset(
    {
        "record_id",
        "claim_id",
        "encounter_id",
        "patient_id",
        "birth_date",
        "sex",
        "service_date",
        "regional_bureau",
        "medical_institution_code",
        "is_outpatient",
        "admission_date",
        "discharge_date",
        "item_kind",
        "order_kind",
        "kind",
        "code",
        "procedure_code",
        "drug_code",
        "material_code",
        "comment_code",
        "comment_text",
        "text",
        "quantity",
        "total_quantity",
        "quantity_per_day",
        "days",
        "dose_quantity",
        "doses_per_day",
        "dispensing_kind",
        "dispensing_kinds",
        "administrations",
        "collection_fee_input",
        "collection_fee_inputs",
        "facility_standard_keys",
        "same_day_history_codes",
        "same_week_history_codes",
        "same_month_history_codes",
        "already_billed_collection_fee_codes_same_day",
        "already_billed_judgement_groups",
        "bundled_judgement_groups",
        "already_billed_lab_management_same_month",
        "already_billed_outpatient_rapid_lab_items_same_day",
        "outpatient_rapid_lab_eligible_test_item_count",
        "outpatient_rapid_lab_same_day_result_explained",
        "outpatient_rapid_lab_written_information_provided",
        "outpatient_rapid_lab_result_based_care_provided",
        "suppress_all_judgement_fees",
        "lab_management_facility_missing_policy",
        "fee_kind",
        "outpatient_basic_fee_kind",
        "information_communication_equipment",
        "same_day_second_department",
        "same_day_revisit",
        "large_hospital_no_referral",
        "delivery_kind",
        "medication_delivery_kind",
        "prescription_category",
        "refill_prescription",
        "special_pharmacy_relationship",
        "gargle_only",
        "specific_disease_prescription_management",
        "specific_disease_prescription_management_already_billed_same_month",
        "anti_malignant_tumor_prescription_management",
        "anti_malignant_tumor_prescription_management_already_billed_same_month",
        "generic_name_prescription_add_on",
        "route_kind",
        "injection_route_kind",
        "infant",
        "drip_infusion_outpatient_other",
        "biologic_add_on",
        "narcotic_add_on",
        "precision_continuous_infusion_add_on",
        "judgement_history_complete",
        "lab_management_history_complete",
        "collection_fee_history_complete",
        "outpatient_rapid_lab_history_complete",
        "area_size",
        "acquisition_kind",
        "radiography_diagnostic_kind",
        "ct_equipment_kind",
        "mri_equipment_kind",
        "head",
        "joint_use",
        "contrast",
        "electronic_image_management",
        "diagnostic_management_add_on",
        "remote_diagnostic_management_add_on",
        "basic_fee_code",
        "basic_fee_days",
        "inpatient_facility_standard_key",
        "ward_kind",
        "inpatient_basic_code",
        "dpc_claim",
        "dpc_code",
        "icd_code",
        "mdc_code",
        "classification_code",
        "main_diagnosis",
        "resource_diagnosis",
        "surgery_code",
        "dpc_procedure_code",
        "comorbidity",
        "hospital_coefficient",
        "disease_state_classification",
        "age_condition",
        "month_age_condition",
        "weight_condition",
        "jcs_condition",
        "burn_index_condition",
        "gaf_condition",
        "pregnancy_weeks_condition",
        "delivery_bleeding_amount_condition",
        "surgery_flag",
        "surgery_procedure_1_flag",
        "surgery_procedure_2_flag",
        "defined_comorbidity_flag",
        "severity_age_condition",
        "severity_jcs_condition",
        "unilateral_bilateral_condition",
        "first_reoperation_condition",
        "one_eye_both_eyes_condition",
        "one_side_both_sides_condition",
        "rehabilitation_condition",
        "mild_severe_condition",
        "pre_onset_rankin_scale_condition",
        "a_drop_score_condition",
        "transfer_from_other_hospital_ward_condition",
        "stroke_onset_timing_condition",
        "child_pugh_classification_condition",
        "expected_total_points",
        "gold_total_points",
        "billed_total_points",
        "expected_status",
        "gold_status",
        "expected_candidate_codes",
        "expected_candidate_code",
        "gold_candidate_codes",
        "gold_candidate_code",
        "billed_codes",
        "billed_code",
        "claim_codes",
        "claim_code",
    }
)

_ORDER_CSV_GOLD_TARGET_FIELDS = frozenset(
    {
        "expected_total_points",
        "gold_total_points",
        "billed_total_points",
        "expected_status",
        "gold_status",
        "expected_candidate_codes",
        "expected_candidate_code",
        "gold_candidate_codes",
        "gold_candidate_code",
        "billed_codes",
        "billed_code",
        "claim_codes",
        "claim_code",
    }
)

_ORDER_CSV_GOLD_TARGET_FIELD_ORDER = (
    "expected_total_points",
    "gold_total_points",
    "billed_total_points",
    "expected_status",
    "gold_status",
    "expected_candidate_codes",
    "expected_candidate_code",
    "gold_candidate_codes",
    "gold_candidate_code",
    "billed_codes",
    "billed_code",
    "claim_codes",
    "claim_code",
)

_ORDER_CSV_EXPECTED_KIND_VALUES = frozenset(
    {"expected", "gold", "billed", "claim", "confirmed_claim", "expected_code", "gold_code"}
)

_ORDER_CSV_RECORD_ID_FIELD_ORDER = ("record_id", "claim_id", "encounter_id")
_ORDER_CSV_COMPOSITE_RECORD_KEY_FIELD_ORDER = (
    "patient_id",
    "service_date",
    "regional_bureau",
    "medical_institution_code",
)
_ORDER_CSV_ITEM_KIND_FIELD_ORDER = ("item_kind", "order_kind", "kind")
_ORDER_CSV_CODE_FIELD_ORDER = (
    "code",
    "procedure_code",
    "drug_code",
    "material_code",
    "comment_code",
)


@dataclass(frozen=True)
class OrderCsvConversionResult:
    row_count: int
    record_count: int
    payloads: tuple[dict[str, Any], ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class OrderCsvColumnProfileColumn:
    source_name: str
    target_name: str
    non_empty_count: int
    raw_examples: tuple[str, ...] = ()
    mapped_examples: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_name": self.source_name,
            "target_name": self.target_name,
            "non_empty_count": self.non_empty_count,
            "raw_examples": list(self.raw_examples),
            "mapped_examples": list(self.mapped_examples),
        }


@dataclass(frozen=True)
class OrderCsvColumnProfile:
    row_count: int
    column_count: int
    mapped_column_count: int
    unmapped_columns: tuple[str, ...]
    target_columns: dict[str, tuple[str, ...]]
    missing_required_fields: tuple[str, ...]
    has_gold_labels: bool
    columns: tuple[OrderCsvColumnProfileColumn, ...]
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "row_count": self.row_count,
            "column_count": self.column_count,
            "mapped_column_count": self.mapped_column_count,
            "unmapped_columns": list(self.unmapped_columns),
            "target_columns": {
                target_name: list(source_names)
                for target_name, source_names in self.target_columns.items()
            },
            "missing_required_fields": list(self.missing_required_fields),
            "has_gold_labels": self.has_gold_labels,
            "columns": [column.to_dict() for column in self.columns],
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class OrderCsvMappingContract:
    contract_id: str | None = None
    hospital_name: str | None = None
    regional_bureau: str | None = None
    medical_institution_code: str | None = None
    column_map_preset: str | None = None
    encoding: str | None = None
    required_target_fields: tuple[str, ...] = ()
    required_source_columns: tuple[str, ...] = ()
    allowed_unmapped_columns: tuple[str, ...] = ()
    require_gold_labels: bool = False
    minimum_row_count: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "contract_id": self.contract_id,
            "hospital_name": self.hospital_name,
            "regional_bureau": self.regional_bureau,
            "medical_institution_code": self.medical_institution_code,
            "column_map_preset": self.column_map_preset,
            "encoding": self.encoding,
            "required_target_fields": list(self.required_target_fields),
            "required_source_columns": list(self.required_source_columns),
            "allowed_unmapped_columns": list(self.allowed_unmapped_columns),
            "require_gold_labels": self.require_gold_labels,
            "minimum_row_count": self.minimum_row_count,
        }


@dataclass(frozen=True)
class OrderCsvContractCheck:
    name: str
    status: str
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class OrderCsvContractValidationResult:
    contract: OrderCsvMappingContract
    profile: OrderCsvColumnProfile
    checks: tuple[OrderCsvContractCheck, ...]

    @property
    def passed(self) -> bool:
        return all(check.status != "error" for check in self.checks)

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "contract": self.contract.to_dict(),
            "profile": self.profile.to_dict(),
            "checks": [check.to_dict() for check in self.checks],
        }


def convert_order_csv_to_claim_payloads(
    csv_path: str | Path,
    *,
    template_jsonl_path: str | Path | None = None,
    column_map_path: str | Path | None = None,
    column_map_preset: str | None = None,
    encoding: str = "utf-8",
) -> OrderCsvConversionResult:
    templates = _load_templates(template_jsonl_path)
    column_map = _load_column_map(
        column_map_path,
        column_map_preset=column_map_preset,
    )
    records: OrderedDict[str, dict[str, Any]] = OrderedDict()
    row_count = 0
    warnings: list[str] = []

    with Path(csv_path).open("r", encoding=encoding, newline="") as f:
        reader = csv.DictReader(f)
        for row_number, raw_row in enumerate(reader, start=2):
            row_count += 1
            row = _normalize_row(raw_row, column_map=column_map)
            record_id = _record_id(row)
            if record_id is None:
                warnings.append(f"row {row_number}: record key fields are incomplete")
                continue
            payload = records.get(record_id)
            if payload is None:
                payload = _base_payload(record_id, row, templates)
                records[record_id] = payload
            _merge_row_into_payload(payload, row, row_number, warnings)

    return OrderCsvConversionResult(
        row_count=row_count,
        record_count=len(records),
        payloads=tuple(records.values()),
        warnings=tuple(warnings),
    )


def profile_order_csv_columns(
    csv_path: str | Path,
    *,
    column_map_path: str | Path | None = None,
    column_map_preset: str | None = None,
    encoding: str = "utf-8",
    max_examples: int = 5,
) -> OrderCsvColumnProfile:
    column_map = _load_column_map(
        column_map_path,
        column_map_preset=column_map_preset,
    )
    source_to_target = column_map.get("columns") or {}
    value_maps = column_map.get("values") or {}

    with Path(csv_path).open("r", encoding=encoding, newline="") as f:
        reader = csv.DictReader(f)
        source_pairs = tuple(
            (str(name or ""), str(name or "").strip())
            for name in (reader.fieldnames or ())
            if str(name or "").strip()
        )
        column_stats: OrderedDict[str, dict[str, Any]] = OrderedDict()
        target_sources: OrderedDict[str, list[str]] = OrderedDict()

        for _raw_source_name, source_name in source_pairs:
            target_name = str(source_to_target.get(source_name, source_name)).strip()
            column_stats[source_name] = {
                "target_name": target_name,
                "non_empty_count": 0,
                "raw_examples": [],
                "mapped_examples": [],
            }
            target_sources.setdefault(target_name, []).append(source_name)

        row_count = 0
        for raw_row in reader:
            row_count += 1
            for raw_source_name, source_name in source_pairs:
                stats = column_stats[source_name]
                raw_value = str(raw_row.get(raw_source_name) or "").strip()
                if not raw_value:
                    continue
                stats["non_empty_count"] += 1
                _append_example(stats["raw_examples"], raw_value, max_examples)
                target_name = stats["target_name"]
                mapped_value = raw_value
                target_values = value_maps.get(target_name)
                if isinstance(target_values, dict) and raw_value in target_values:
                    mapped_value = str(target_values[raw_value])
                _append_example(stats["mapped_examples"], mapped_value, max_examples)

    target_columns = {
        target_name: tuple(source_names)
        for target_name, source_names in target_sources.items()
    }
    target_names = set(target_columns)
    missing_required_fields = _missing_order_csv_required_fields(target_names)
    unmapped_columns = tuple(
        source_name
        for source_name, stats in column_stats.items()
        if source_name == stats["target_name"] and source_name not in _ORDER_CSV_KNOWN_TARGET_FIELDS
    )
    warnings: list[str] = []
    if missing_required_fields:
        warnings.append("missing required fields: " + ", ".join(missing_required_fields))
    if unmapped_columns:
        warnings.append("unmapped columns: " + ", ".join(unmapped_columns))

    columns = tuple(
        OrderCsvColumnProfileColumn(
            source_name=source_name,
            target_name=str(stats["target_name"]),
            non_empty_count=int(stats["non_empty_count"]),
            raw_examples=tuple(stats["raw_examples"]),
            mapped_examples=tuple(stats["mapped_examples"]),
        )
        for source_name, stats in column_stats.items()
    )
    return OrderCsvColumnProfile(
        row_count=row_count,
        column_count=len(columns),
        mapped_column_count=sum(1 for column in columns if column.source_name != column.target_name),
        unmapped_columns=unmapped_columns,
        target_columns=target_columns,
        missing_required_fields=tuple(missing_required_fields),
        has_gold_labels=_has_order_csv_gold_labels(target_names, columns),
        columns=columns,
        warnings=tuple(warnings),
    )


def load_order_csv_mapping_contract(contract_path: str | Path) -> OrderCsvMappingContract:
    data = json.loads(Path(contract_path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("order CSV mapping contract must be a JSON object")
    return OrderCsvMappingContract(
        contract_id=_optional_text(data.get("contract_id") or data.get("id")),
        hospital_name=_optional_text(data.get("hospital_name")),
        regional_bureau=_optional_text(data.get("regional_bureau")),
        medical_institution_code=_optional_text(data.get("medical_institution_code")),
        column_map_preset=_optional_text(data.get("column_map_preset")),
        encoding=_optional_text(data.get("encoding")),
        required_target_fields=_json_string_tuple(
            data.get("required_target_fields") or data.get("required_fields")
        ),
        required_source_columns=_json_string_tuple(data.get("required_source_columns")),
        allowed_unmapped_columns=_json_string_tuple(data.get("allowed_unmapped_columns")),
        require_gold_labels=bool(data.get("require_gold_labels", False)),
        minimum_row_count=_optional_int(data.get("minimum_row_count")),
    )


def validate_order_csv_mapping_contract(
    csv_path: str | Path,
    contract_path: str | Path,
    *,
    column_map_path: str | Path | None = None,
    column_map_preset: str | None = None,
    encoding: str | None = None,
) -> OrderCsvContractValidationResult:
    contract = load_order_csv_mapping_contract(contract_path)
    profile = profile_order_csv_columns(
        csv_path,
        column_map_path=column_map_path,
        column_map_preset=column_map_preset or contract.column_map_preset,
        encoding=encoding or contract.encoding or "utf-8",
    )
    return OrderCsvContractValidationResult(
        contract=contract,
        profile=profile,
        checks=tuple(_order_csv_contract_checks(profile, contract)),
    )


def build_order_csv_mapping_contract_template(
    csv_path: str | Path,
    *,
    column_map_path: str | Path | None = None,
    column_map_preset: str | None = None,
    encoding: str = "utf-8",
    contract_id: str | None = None,
    hospital_name: str | None = None,
    regional_bureau: str | None = None,
    medical_institution_code: str | None = None,
    require_gold_labels: bool | None = None,
    include_unmapped_columns: bool = True,
    minimum_row_count: int | None = 1,
) -> OrderCsvMappingContract:
    profile = profile_order_csv_columns(
        csv_path,
        column_map_path=column_map_path,
        column_map_preset=column_map_preset,
        encoding=encoding,
    )
    required_target_fields = _suggest_order_csv_required_target_fields(
        profile,
        require_gold_labels=bool(require_gold_labels),
    )
    return OrderCsvMappingContract(
        contract_id=contract_id,
        hospital_name=hospital_name,
        regional_bureau=regional_bureau,
        medical_institution_code=medical_institution_code,
        column_map_preset=column_map_preset,
        encoding=encoding,
        required_target_fields=required_target_fields,
        required_source_columns=_source_columns_for_target_fields(profile, required_target_fields),
        allowed_unmapped_columns=profile.unmapped_columns if include_unmapped_columns else (),
        require_gold_labels=profile.has_gold_labels if require_gold_labels is None else require_gold_labels,
        minimum_row_count=minimum_row_count,
    )


def order_csv_payloads_to_jsonl(payloads: tuple[dict[str, Any], ...] | list[dict[str, Any]]) -> str:
    output = "\n".join(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        for payload in payloads
    )
    if output:
        output += "\n"
    return output


def order_csv_column_profile_to_markdown(profile: OrderCsvColumnProfile) -> str:
    lines = [
        "# Order CSV Column Profile",
        "",
        f"Input rows: {profile.row_count}",
        f"Input columns: {profile.column_count}",
        f"Mapped columns: {profile.mapped_column_count}",
        f"Unmapped columns: {len(profile.unmapped_columns)}",
        f"Gold label fields: {'present' if profile.has_gold_labels else 'missing'}",
        f"Warnings: {len(profile.warnings)}",
        "",
        "## Required Field Check",
        "",
        "| Check | Status | Detail |",
        "| --- | --- | --- |",
    ]
    checks = (
        (
            "record key",
            "record_id or patient_id + service_date + regional_bureau + medical_institution_code",
        ),
        ("item kind", "item_kind"),
        ("order code", "code / procedure_code / drug_code / material_code / comment_code"),
        ("gold labels", "expected_total_points / expected_status / expected_candidate_codes"),
    )
    missing = set(profile.missing_required_fields)
    for check_name, detail in checks:
        if check_name == "gold labels":
            status = "ok" if profile.has_gold_labels else "missing"
        else:
            status = "missing" if detail in missing else "ok"
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(check_name),
                    status,
                    _escape_markdown_table_cell(detail),
                )
            )
            + " |"
        )

    if profile.unmapped_columns:
        lines.extend(("", "## Unmapped Columns", "", "| Source column |", "| --- |"))
        for source_name in profile.unmapped_columns:
            lines.append(f"| {_escape_markdown_table_cell(source_name)} |")

    lines.extend(
        (
            "",
            "## Columns",
            "",
            "| Source column | Target field | Non-empty | Raw examples | Mapped examples |",
            "| --- | --- | ---: | --- | --- |",
        )
    )
    for column in profile.columns:
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(column.source_name),
                    _escape_markdown_table_cell(column.target_name),
                    str(column.non_empty_count),
                    _escape_markdown_table_cell(", ".join(column.raw_examples)),
                    _escape_markdown_table_cell(", ".join(column.mapped_examples)),
                )
            )
            + " |"
        )

    if profile.warnings:
        lines.extend(("", "## Warnings", "", "| Warning |", "| --- |"))
        for warning in profile.warnings:
            lines.append(f"| {_escape_markdown_table_cell(warning)} |")

    return "\n".join(lines)


def order_csv_contract_validation_to_markdown(result: OrderCsvContractValidationResult) -> str:
    contract = result.contract
    profile = result.profile
    lines = [
        "# Order CSV Mapping Contract Validation",
        "",
        f"Passed: {'yes' if result.passed else 'no'}",
        f"Contract ID: {contract.contract_id or ''}",
        f"Hospital: {contract.hospital_name or ''}",
        f"Regional bureau: {contract.regional_bureau or ''}",
        f"Medical institution code: {contract.medical_institution_code or ''}",
        f"Column map preset: {contract.column_map_preset or ''}",
        f"Input rows: {profile.row_count}",
        f"Input columns: {profile.column_count}",
        "",
        "## Checks",
        "",
        "| Check | Status | Detail |",
        "| --- | --- | --- |",
    ]
    for check in result.checks:
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(check.name),
                    check.status,
                    _escape_markdown_table_cell(check.detail),
                )
            )
            + " |"
        )

    lines.extend(
        (
            "",
            "## Column Mapping",
            "",
            "| Source column | Target field | Non-empty | Raw examples | Mapped examples |",
            "| --- | --- | ---: | --- | --- |",
        )
    )
    for column in profile.columns:
        lines.append(
            "| "
            + " | ".join(
                (
                    _escape_markdown_table_cell(column.source_name),
                    _escape_markdown_table_cell(column.target_name),
                    str(column.non_empty_count),
                    _escape_markdown_table_cell(", ".join(column.raw_examples)),
                    _escape_markdown_table_cell(", ".join(column.mapped_examples)),
                )
            )
            + " |"
        )
    return "\n".join(lines)


def order_csv_conversion_to_markdown(result: OrderCsvConversionResult) -> str:
    lines = [
        "# Order CSV Conversion",
        "",
        f"Input rows: {result.row_count}",
        f"Output records: {result.record_count}",
        f"Warnings: {len(result.warnings)}",
    ]
    if result.warnings:
        lines.extend(("", "| Warning |", "| --- |"))
        for warning in result.warnings:
            lines.append(f"| {_escape_markdown_table_cell(warning)} |")
    return "\n".join(lines)


def list_order_csv_column_map_presets() -> tuple[str, ...]:
    return tuple(sorted(ORDER_CSV_COLUMN_PRESETS))


def _base_payload(
    record_id: str,
    row: dict[str, str],
    templates: dict[tuple[str, str, str], dict[str, Any]],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "record_id": record_id,
        "patient": {},
        "encounter": {},
        "procedure_codes": [],
        "drug_inputs": [],
        "medication_orders": [],
        "injection_drug_inputs": [],
        "injection_orders": [],
        "treatment_orders": [],
        "imaging_orders": [],
        "material_inputs": [],
        "comment_inputs": [],
        "history": {},
        "lab_options": {},
        "inpatient_basic": {},
        "dpc": {},
    }
    template = _template_for_row(row, record_id, templates)
    if template is not None:
        payload["claim_context_template"] = template

    _set_if_present(payload["patient"], "patient_id", row.get("patient_id"))
    _set_if_present(payload["patient"], "birth_date", row.get("birth_date"))
    _set_if_present(payload["patient"], "sex", row.get("sex"))

    encounter = payload["encounter"]
    _set_if_present(encounter, "service_date", row.get("service_date"))
    _set_if_present(encounter, "regional_bureau", row.get("regional_bureau"))
    _set_if_present(encounter, "medical_institution_code", row.get("medical_institution_code"))
    _set_if_present(encounter, "is_outpatient", row.get("is_outpatient"))
    _set_if_present(encounter, "admission_date", row.get("admission_date"))
    _set_if_present(encounter, "discharge_date", row.get("discharge_date"))

    return payload


def _merge_row_into_payload(
    payload: dict[str, Any],
    row: dict[str, str],
    row_number: int,
    warnings: list[str],
) -> None:
    _merge_scalar_context(payload, row)
    _merge_list_context(payload, row)
    _merge_expected_context(payload, row)

    kind = _item_kind(row)
    code = _first_present(row, ("code", "procedure_code", "drug_code", "material_code"))
    quantity = _first_present(row, ("quantity", "total_quantity"))

    if kind in {"", "context", "option", "options"}:
        return
    if kind in {"expected", "gold", "billed", "claim", "confirmed_claim", "expected_code", "gold_code"}:
        if _append_expected_codes(payload, row) == 0:
            _append_unique(_list_field(payload.setdefault("expected", {}), "candidate_codes"), code)
        return
    if kind in {"procedure", "medical_procedure", "procedure_code"}:
        _append_unique(payload["procedure_codes"], code)
        return
    if kind in {"drug", "drug_input"}:
        _append_object(payload["drug_inputs"], {"code": code, "quantity": quantity or "1"})
        return
    if kind in {"medication", "medication_order"}:
        _append_object(
            payload["medication_orders"],
            _compact(
                {
                    "drug_code": _first_present(row, ("drug_code", "code")),
                    "total_quantity": row.get("total_quantity"),
                    "quantity_per_day": row.get("quantity_per_day"),
                    "days": row.get("days"),
                    "dose_quantity": row.get("dose_quantity"),
                    "doses_per_day": row.get("doses_per_day"),
                    "dispensing_kind": row.get("dispensing_kind"),
                }
            ),
        )
        return
    if kind in {"injection_drug", "injection_drug_input"}:
        _append_object(payload["injection_drug_inputs"], {"code": code, "quantity": quantity or "1"})
        return
    if kind in {"injection", "injection_order"}:
        _append_object(
            payload["injection_orders"],
            _compact(
                {
                    "drug_code": _first_present(row, ("drug_code", "code")),
                    "total_quantity": row.get("total_quantity"),
                    "dose_quantity": row.get("dose_quantity"),
                    "administrations": row.get("administrations"),
                }
            ),
        )
        return
    if kind in {"material", "specific_material", "material_input"}:
        _append_object(payload["material_inputs"], {"code": code, "quantity": quantity or "1"})
        return
    if kind in {"comment", "comment_input", "required_comment"}:
        _append_object(
            payload["comment_inputs"],
            _compact(
                {
                    "code": _first_present(row, ("comment_code", "code")),
                    "text": _first_present(row, ("comment_text", "text")),
                }
            ),
        )
        return
    if kind in {"collection_fee", "collection"}:
        _append_unique(
            _list_field(payload["lab_options"], "collection_fee_inputs"),
            _first_present(row, ("collection_fee_input", "collection_fee_inputs", "code")),
        )
        return
    if kind in {"same_day_history", "history_same_day"}:
        _append_unique(_list_field(payload["history"], "same_day_history_codes"), code)
        return
    if kind in {"same_week_history", "history_same_week"}:
        _append_unique(_list_field(payload["history"], "same_week_history_codes"), code)
        return
    if kind in {"same_month_history", "history_same_month"}:
        _append_unique(_list_field(payload["history"], "same_month_history_codes"), code)
        return
    if kind in {"judgement_history", "already_billed_judgement_group"}:
        _append_unique(_list_field(payload["history"], "already_billed_judgement_groups"), code)
        return
    if kind in {"bundled_judgement", "bundled_judgement_group"}:
        _append_unique(_list_field(payload["history"], "bundled_judgement_groups"), code)
        return
    if kind in {"facility_standard", "facility_standard_key"}:
        _append_unique(_list_field(payload, "facility_standard_keys"), code)
        return
    if kind in {"treatment", "treatment_order"}:
        _append_object(
            payload["treatment_orders"],
            _compact({"kind": row.get("kind") or code, "area_size": row.get("area_size")}),
        )
        return
    if kind in {"imaging", "imaging_order"}:
        _append_object(
            payload["imaging_orders"],
            _compact(
                {
                    "kind": row.get("kind") or code,
                    "acquisition_kind": row.get("acquisition_kind"),
                    "radiography_diagnostic_kind": row.get("radiography_diagnostic_kind"),
                    "ct_equipment_kind": row.get("ct_equipment_kind"),
                    "mri_equipment_kind": row.get("mri_equipment_kind"),
                    "head": row.get("head"),
                    "joint_use": row.get("joint_use"),
                    "contrast": row.get("contrast"),
                    "electronic_image_management": row.get("electronic_image_management"),
                    "diagnostic_management_add_on": row.get("diagnostic_management_add_on"),
                    "remote_diagnostic_management_add_on": row.get(
                        "remote_diagnostic_management_add_on"
                    ),
                }
            ),
        )
        return
    if kind in {"inpatient", "inpatient_basic", "inpatient_basic_fee"}:
        _merge_section_scalars(
            payload,
            "inpatient_basic",
            row,
            (
                "basic_fee_code",
                "basic_fee_days",
                "ward_kind",
                "inpatient_basic_code",
            ),
        )
        if row.get("inpatient_facility_standard_key"):
            payload.setdefault("inpatient_basic", {})["facility_standard_key"] = row[
                "inpatient_facility_standard_key"
            ]
        if code and not payload.setdefault("inpatient_basic", {}).get("basic_fee_code"):
            payload["inpatient_basic"]["basic_fee_code"] = code
        return
    if kind in {"dpc", "dpc_claim"}:
        _merge_section_scalars(
            payload,
            "dpc",
            row,
            (
                "dpc_claim",
                "dpc_code",
                "icd_code",
                "mdc_code",
                "classification_code",
                "main_diagnosis",
                "resource_diagnosis",
                "surgery_code",
                "comorbidity",
                "hospital_coefficient",
                "disease_state_classification",
                "age_condition",
                "month_age_condition",
                "weight_condition",
                "jcs_condition",
                "burn_index_condition",
                "gaf_condition",
                "pregnancy_weeks_condition",
                "delivery_bleeding_amount_condition",
                "surgery_flag",
                "surgery_procedure_1_flag",
                "surgery_procedure_2_flag",
                "defined_comorbidity_flag",
                "severity_age_condition",
                "severity_jcs_condition",
                "unilateral_bilateral_condition",
                "first_reoperation_condition",
                "one_eye_both_eyes_condition",
                "one_side_both_sides_condition",
                "rehabilitation_condition",
                "mild_severe_condition",
                "pre_onset_rankin_scale_condition",
                "a_drop_score_condition",
                "transfer_from_other_hospital_ward_condition",
                "stroke_onset_timing_condition",
                "child_pugh_classification_condition",
            ),
        )
        if row.get("dpc_procedure_code"):
            payload.setdefault("dpc", {})["procedure_code"] = row["dpc_procedure_code"]
        return

    warnings.append(f"row {row_number}: unsupported item_kind {kind}")


def _merge_scalar_context(payload: dict[str, Any], row: dict[str, str]) -> None:
    _set_if_present(payload["patient"], "patient_id", row.get("patient_id"))
    _set_if_present(payload["patient"], "birth_date", row.get("birth_date"))
    _set_if_present(payload["patient"], "sex", row.get("sex"))

    encounter = payload["encounter"]
    _set_if_present(encounter, "service_date", row.get("service_date"))
    _set_if_present(encounter, "regional_bureau", row.get("regional_bureau"))
    _set_if_present(encounter, "medical_institution_code", row.get("medical_institution_code"))
    _set_if_present(encounter, "is_outpatient", row.get("is_outpatient"))
    _set_if_present(encounter, "admission_date", row.get("admission_date"))
    _set_if_present(encounter, "discharge_date", row.get("discharge_date"))

    _merge_section_scalars(
        payload,
        "lab_options",
        row,
        (
            "outpatient_rapid_lab_eligible_test_item_count",
            "outpatient_rapid_lab_same_day_result_explained",
            "outpatient_rapid_lab_written_information_provided",
            "outpatient_rapid_lab_result_based_care_provided",
            "suppress_all_judgement_fees",
            "lab_management_facility_missing_policy",
        ),
    )
    _merge_section_scalars(
        payload,
        "history",
        row,
        (
            "already_billed_lab_management_same_month",
            "already_billed_outpatient_rapid_lab_items_same_day",
        ),
    )
    _merge_section_scalars(
        payload,
        "outpatient_basic",
        row,
        (
            "fee_kind",
            "information_communication_equipment",
            "same_day_second_department",
            "same_day_revisit",
            "large_hospital_no_referral",
        ),
    )
    if row.get("outpatient_basic_fee_kind"):
        payload.setdefault("outpatient_basic", {})["fee_kind"] = row["outpatient_basic_fee_kind"]
    _merge_section_scalars(
        payload,
        "medication",
        row,
        (
            "delivery_kind",
            "prescription_category",
            "refill_prescription",
            "special_pharmacy_relationship",
            "gargle_only",
            "specific_disease_prescription_management",
            "specific_disease_prescription_management_already_billed_same_month",
            "anti_malignant_tumor_prescription_management",
            "anti_malignant_tumor_prescription_management_already_billed_same_month",
            "generic_name_prescription_add_on",
        ),
    )
    if row.get("medication_delivery_kind"):
        payload.setdefault("medication", {})["delivery_kind"] = row["medication_delivery_kind"]
    _merge_section_scalars(
        payload,
        "injection",
        row,
        (
            "route_kind",
            "infant",
            "drip_infusion_outpatient_other",
            "biologic_add_on",
            "narcotic_add_on",
            "precision_continuous_infusion_add_on",
        ),
    )
    if row.get("injection_route_kind"):
        payload.setdefault("injection", {})["route_kind"] = row["injection_route_kind"]
    _merge_section_scalars(
        payload,
        "inpatient_basic",
        row,
        (
            "basic_fee_code",
            "basic_fee_days",
            "ward_kind",
            "inpatient_basic_code",
        ),
    )
    if row.get("inpatient_facility_standard_key"):
        payload.setdefault("inpatient_basic", {})["facility_standard_key"] = row[
            "inpatient_facility_standard_key"
        ]
    _merge_section_scalars(
        payload,
        "dpc",
        row,
        (
            "dpc_claim",
            "dpc_code",
            "icd_code",
            "mdc_code",
            "classification_code",
            "main_diagnosis",
            "resource_diagnosis",
            "surgery_code",
            "comorbidity",
            "hospital_coefficient",
            "disease_state_classification",
            "age_condition",
            "month_age_condition",
            "weight_condition",
            "jcs_condition",
            "burn_index_condition",
            "gaf_condition",
            "pregnancy_weeks_condition",
            "delivery_bleeding_amount_condition",
            "surgery_flag",
            "surgery_procedure_1_flag",
            "surgery_procedure_2_flag",
            "defined_comorbidity_flag",
            "severity_age_condition",
            "severity_jcs_condition",
            "unilateral_bilateral_condition",
            "first_reoperation_condition",
            "one_eye_both_eyes_condition",
            "one_side_both_sides_condition",
            "rehabilitation_condition",
            "mild_severe_condition",
            "pre_onset_rankin_scale_condition",
            "a_drop_score_condition",
            "transfer_from_other_hospital_ward_condition",
            "stroke_onset_timing_condition",
            "child_pugh_classification_condition",
        ),
    )
    if row.get("dpc_procedure_code"):
        payload.setdefault("dpc", {})["procedure_code"] = row["dpc_procedure_code"]
    _merge_section_scalars(
        payload,
        "data_completeness",
        row,
        (
            "judgement_history_complete",
            "lab_management_history_complete",
            "collection_fee_history_complete",
            "outpatient_rapid_lab_history_complete",
        ),
    )


def _merge_list_context(payload: dict[str, Any], row: dict[str, str]) -> None:
    for field_name in ("procedure_codes", "facility_standard_keys"):
        for value in _split_values(row.get(field_name)):
            _append_unique(_list_field(payload, field_name), value)

    for field_name in (
        "collection_fee_inputs",
        "already_billed_collection_fee_codes_same_day",
    ):
        section = "lab_options" if field_name == "collection_fee_inputs" else "history"
        for value in _split_values(row.get(field_name)):
            _append_unique(_list_field(payload[section], field_name), value)

    for field_name in (
        "same_day_history_codes",
        "same_week_history_codes",
        "same_month_history_codes",
        "already_billed_judgement_groups",
        "bundled_judgement_groups",
    ):
        for value in _split_values(row.get(field_name)):
            _append_unique(_list_field(payload["history"], field_name), value)

    for value in _split_values(row.get("dispensing_kinds")):
        _append_unique(_list_field(payload.setdefault("medication", {}), "dispensing_kinds"), value)


def _missing_order_csv_required_fields(target_names: set[str]) -> list[str]:
    missing: list[str] = []
    has_explicit_record_id = "record_id" in target_names or "claim_id" in target_names or "encounter_id" in target_names
    has_composite_record_key = {
        "patient_id",
        "service_date",
        "regional_bureau",
        "medical_institution_code",
    }.issubset(target_names)
    if not has_explicit_record_id and not has_composite_record_key:
        missing.append("record_id or patient_id + service_date + regional_bureau + medical_institution_code")
    if not ({"item_kind", "order_kind", "kind"} & target_names):
        missing.append("item_kind")
    if not (
        {
            "code",
            "procedure_code",
            "drug_code",
            "material_code",
            "comment_code",
        }
        & target_names
    ):
        missing.append("code / procedure_code / drug_code / material_code / comment_code")
    return missing


def _has_order_csv_gold_labels(
    target_names: set[str],
    columns: tuple[OrderCsvColumnProfileColumn, ...],
) -> bool:
    if _ORDER_CSV_GOLD_TARGET_FIELDS & target_names:
        return True
    for column in columns:
        if column.target_name in {"item_kind", "order_kind", "kind"}:
            if _ORDER_CSV_EXPECTED_KIND_VALUES & set(column.mapped_examples):
                return True
    return False


def _append_example(values: list[str], value: str, max_examples: int) -> None:
    if len(values) >= max_examples:
        return
    if value not in values:
        values.append(value)


def _suggest_order_csv_required_target_fields(
    profile: OrderCsvColumnProfile,
    *,
    require_gold_labels: bool,
) -> tuple[str, ...]:
    target_names = set(profile.target_columns)
    required: list[str] = []
    for field_name in _ORDER_CSV_RECORD_ID_FIELD_ORDER:
        if field_name in target_names:
            required.append(field_name)
    for field_name in _ORDER_CSV_COMPOSITE_RECORD_KEY_FIELD_ORDER:
        if field_name in target_names:
            required.append(field_name)

    item_kind_field = _first_in_set(target_names, _ORDER_CSV_ITEM_KIND_FIELD_ORDER)
    if item_kind_field is not None:
        required.append(item_kind_field)

    for field_name in _ORDER_CSV_CODE_FIELD_ORDER:
        if field_name in target_names:
            required.append(field_name)

    if profile.has_gold_labels or require_gold_labels:
        for field_name in _ORDER_CSV_GOLD_TARGET_FIELD_ORDER:
            if field_name in target_names:
                required.append(field_name)

    return _dedupe_tuple(required)


def _source_columns_for_target_fields(
    profile: OrderCsvColumnProfile,
    target_fields: tuple[str, ...],
) -> tuple[str, ...]:
    source_columns: list[str] = []
    for target_field in target_fields:
        source_columns.extend(profile.target_columns.get(target_field, ()))
    return _dedupe_tuple(source_columns)


def _first_in_set(values: set[str], candidates: tuple[str, ...]) -> str | None:
    for candidate in candidates:
        if candidate in values:
            return candidate
    return None


def _dedupe_tuple(values: list[str]) -> tuple[str, ...]:
    result: list[str] = []
    for value in values:
        if value not in result:
            result.append(value)
    return tuple(result)


def _order_csv_contract_checks(
    profile: OrderCsvColumnProfile,
    contract: OrderCsvMappingContract,
) -> list[OrderCsvContractCheck]:
    checks: list[OrderCsvContractCheck] = []
    target_names = set(profile.target_columns)
    source_names = {column.source_name for column in profile.columns}

    if contract.minimum_row_count is not None:
        if profile.row_count < contract.minimum_row_count:
            checks.append(
                OrderCsvContractCheck(
                    name="minimum row count",
                    status="error",
                    detail=f"{profile.row_count} < {contract.minimum_row_count}",
                )
            )
        else:
            checks.append(
                OrderCsvContractCheck(
                    name="minimum row count",
                    status="ok",
                    detail=f"{profile.row_count} >= {contract.minimum_row_count}",
                )
            )

    if profile.missing_required_fields:
        checks.append(
            OrderCsvContractCheck(
                name="base required fields",
                status="error",
                detail=", ".join(profile.missing_required_fields),
            )
        )
    else:
        checks.append(
            OrderCsvContractCheck(
                name="base required fields",
                status="ok",
                detail="record key, item kind, and code field are present",
            )
        )

    missing_target_fields = tuple(
        field_name
        for field_name in contract.required_target_fields
        if field_name not in target_names
    )
    checks.append(
        OrderCsvContractCheck(
            name="required target fields",
            status="error" if missing_target_fields else "ok",
            detail=", ".join(missing_target_fields) if missing_target_fields else "all required target fields are present",
        )
    )

    missing_source_columns = tuple(
        source_name
        for source_name in contract.required_source_columns
        if source_name not in source_names
    )
    checks.append(
        OrderCsvContractCheck(
            name="required source columns",
            status="error" if missing_source_columns else "ok",
            detail=", ".join(missing_source_columns) if missing_source_columns else "all required source columns are present",
        )
    )

    if contract.require_gold_labels:
        checks.append(
            OrderCsvContractCheck(
                name="gold labels",
                status="ok" if profile.has_gold_labels else "error",
                detail="gold labels are present" if profile.has_gold_labels else "gold labels are required but missing",
            )
        )
    else:
        checks.append(
            OrderCsvContractCheck(
                name="gold labels",
                status="ok",
                detail="gold labels are present" if profile.has_gold_labels else "gold labels are not required",
            )
        )

    unexpected_unmapped = _unexpected_unmapped_columns(profile, contract)
    checks.append(
        OrderCsvContractCheck(
            name="unmapped columns",
            status="error" if unexpected_unmapped else "ok",
            detail=", ".join(unexpected_unmapped)
            if unexpected_unmapped
            else _allowed_unmapped_detail(profile, contract),
        )
    )
    return checks


def _unexpected_unmapped_columns(
    profile: OrderCsvColumnProfile,
    contract: OrderCsvMappingContract,
) -> tuple[str, ...]:
    allowed = set(contract.allowed_unmapped_columns)
    if "*" in allowed:
        return ()
    return tuple(column for column in profile.unmapped_columns if column not in allowed)


def _allowed_unmapped_detail(
    profile: OrderCsvColumnProfile,
    contract: OrderCsvMappingContract,
) -> str:
    if not profile.unmapped_columns:
        return "no unmapped columns"
    allowed = set(contract.allowed_unmapped_columns)
    if "*" in allowed:
        return "all unmapped columns are allowed by contract"
    return "unmapped columns are allowed: " + ", ".join(profile.unmapped_columns)


def _merge_expected_context(payload: dict[str, Any], row: dict[str, str]) -> None:
    total_points = _first_present(
        row,
        ("expected_total_points", "gold_total_points", "billed_total_points"),
    )
    status = _first_present(row, ("expected_status", "gold_status"))
    if total_points is None and status is None:
        _append_expected_codes(payload, row)
        return
    expected = payload.setdefault("expected", {})
    _set_if_present(expected, "total_points", total_points)
    _set_if_present(expected, "status", status)
    _append_expected_codes(payload, row)


def _append_expected_codes(payload: dict[str, Any], row: dict[str, str]) -> int:
    values: list[str] = []
    for field_name in (
        "expected_candidate_codes",
        "expected_candidate_code",
        "gold_candidate_codes",
        "gold_candidate_code",
        "billed_codes",
        "billed_code",
        "claim_codes",
        "claim_code",
    ):
        values.extend(_split_values(row.get(field_name)))
    if not values:
        return 0
    expected = payload.setdefault("expected", {})
    target = _list_field(expected, "candidate_codes")
    before = len(target)
    for value in values:
        _append_unique(target, value)
    return len(target) - before


def _load_templates(template_jsonl_path: str | Path | None) -> dict[tuple[str, str, str], dict[str, Any]]:
    templates: dict[tuple[str, str, str], dict[str, Any]] = {}
    if template_jsonl_path is None:
        return templates
    with Path(template_jsonl_path).open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue
            payload = json.loads(stripped)
            if not isinstance(payload, dict):
                continue
            template = payload.get("claim_context_template") or payload.get("claim_context")
            if not isinstance(template, dict):
                continue
            record_id = _optional_text(payload.get("record_id") or payload.get("id") or payload.get("claim_id"))
            encounter = template.get("encounter") if isinstance(template.get("encounter"), dict) else {}
            regional_bureau = _optional_text(encounter.get("regional_bureau"))
            medical_institution_code = _optional_text(encounter.get("medical_institution_code"))
            service_date = _optional_text(encounter.get("service_date"))
            if record_id:
                templates[("record_id", record_id, "")] = template
            if regional_bureau and medical_institution_code:
                templates[("hospital", f"{regional_bureau}|{medical_institution_code}", service_date or "")] = template
                templates.setdefault(("hospital", f"{regional_bureau}|{medical_institution_code}", ""), template)
    return templates


def _template_for_row(
    row: dict[str, str],
    record_id: str,
    templates: dict[tuple[str, str, str], dict[str, Any]],
) -> dict[str, Any] | None:
    if ("record_id", record_id, "") in templates:
        return templates[("record_id", record_id, "")]
    regional_bureau = row.get("regional_bureau")
    medical_institution_code = row.get("medical_institution_code")
    if not regional_bureau or not medical_institution_code:
        return None
    hospital_key = f"{regional_bureau}|{medical_institution_code}"
    return (
        templates.get(("hospital", hospital_key, row.get("service_date", "")))
        or templates.get(("hospital", hospital_key, ""))
    )


def _load_column_map(
    column_map_path: str | Path | None,
    *,
    column_map_preset: str | None,
) -> dict[str, Any]:
    result: dict[str, Any] = {"columns": {}, "constants": {}, "values": {}}
    if column_map_preset is not None:
        preset = ORDER_CSV_COLUMN_PRESETS.get(column_map_preset)
        if preset is None:
            raise ValueError(f"unsupported order CSV column map preset: {column_map_preset}")
        result = _merge_column_maps(result, preset)
    if column_map_path is not None:
        loaded = json.loads(Path(column_map_path).read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("column map must be a JSON object")
        result = _merge_column_maps(result, loaded)
    return result


def _merge_column_maps(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    merged = {
        "columns": dict(base.get("columns") or {}),
        "constants": dict(base.get("constants") or {}),
        "values": {
            field: dict(values)
            for field, values in (base.get("values") or {}).items()
            if isinstance(values, dict)
        },
    }
    for source_name, target_name in (overlay.get("columns") or {}).items():
        merged["columns"][str(source_name)] = str(target_name)
    for target_name, value in (overlay.get("constants") or {}).items():
        merged["constants"][str(target_name)] = "" if value is None else str(value)
    for field_name, value_map in (overlay.get("values") or {}).items():
        if not isinstance(value_map, dict):
            raise ValueError(f"column map values for {field_name} must be an object")
        field_values = merged["values"].setdefault(str(field_name), {})
        for source_value, target_value in value_map.items():
            field_values[str(source_value)] = "" if target_value is None else str(target_value)
    return merged


def _normalize_row(
    raw_row: dict[str, str | None],
    *,
    column_map: dict[str, Any],
) -> dict[str, str]:
    columns = column_map.get("columns") or {}
    values = column_map.get("values") or {}
    normalized: dict[str, str] = {
        str(key or "").strip(): str(value or "").strip()
        for key, value in raw_row.items()
        if str(key or "").strip()
    }
    mapped: dict[str, str] = {}
    for key, value in normalized.items():
        target_key = str(columns.get(key, key)).strip()
        if not target_key:
            continue
        target_values = values.get(target_key)
        mapped_value = value
        if isinstance(target_values, dict) and value in target_values:
            mapped_value = str(target_values[value])
        if target_key not in mapped or mapped[target_key] == "":
            mapped[target_key] = mapped_value
    for key, value in (column_map.get("constants") or {}).items():
        mapped.setdefault(str(key), str(value))
    return mapped


def _record_id(row: dict[str, str]) -> str | None:
    explicit = _first_present(row, ("record_id", "claim_id", "encounter_id"))
    if explicit:
        return explicit
    parts = [
        row.get("patient_id", ""),
        row.get("service_date", ""),
        row.get("regional_bureau", ""),
        row.get("medical_institution_code", ""),
    ]
    if all(parts):
        return "|".join(parts)
    return None


def _item_kind(row: dict[str, str]) -> str:
    explicit = _first_present(row, ("item_kind", "order_kind"))
    if explicit:
        return explicit.lower()
    legacy_kind = row.get("kind", "").lower()
    if legacy_kind in {
        "procedure",
        "medical_procedure",
        "drug",
        "drug_input",
        "medication",
        "medication_order",
        "injection",
        "injection_order",
        "injection_drug",
        "material",
        "specific_material",
        "comment",
        "comment_input",
        "collection_fee",
        "same_day_history",
        "same_week_history",
        "same_month_history",
        "facility_standard",
        "treatment",
        "imaging",
        "expected",
        "gold",
        "billed",
        "claim",
        "confirmed_claim",
        "expected_code",
        "gold_code",
        "context",
        "option",
        "options",
    }:
        return legacy_kind
    if row.get("procedure_code"):
        return "procedure"
    if row.get("collection_fee_input") or row.get("collection_fee_inputs"):
        return "collection_fee"
    if row.get("material_code"):
        return "material"
    if row.get("drug_code"):
        return "drug"
    if row.get("comment_code") or row.get("comment_text"):
        return "comment"
    return ""


def _merge_section_scalars(
    payload: dict[str, Any],
    section_name: str,
    row: dict[str, str],
    field_names: tuple[str, ...],
) -> None:
    section = payload.setdefault(section_name, {})
    for field_name in field_names:
        _set_if_present(section, field_name, row.get(field_name))


def _list_field(payload: dict[str, Any], field_name: str) -> list[Any]:
    value = payload.get(field_name)
    if isinstance(value, list):
        return value
    if value in (None, ""):
        payload[field_name] = []
        return payload[field_name]
    payload[field_name] = list(_split_values(str(value)))
    return payload[field_name]


def _append_unique(values: list[Any], value: str | None) -> None:
    for split_value in _split_values(value):
        if split_value not in values:
            values.append(split_value)


def _append_object(values: list[Any], value: dict[str, Any]) -> None:
    compacted = _compact(value)
    if compacted:
        values.append(compacted)


def _compact(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item
        for key, item in value.items()
        if item is not None and str(item).strip() != ""
    }


def _set_if_present(payload: dict[str, Any], key: str, value: str | None) -> None:
    if value is not None and value != "":
        payload[key] = value


def _first_present(row: dict[str, str], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = row.get(key)
        if value:
            return value
    return None


def _split_values(value: str | None) -> tuple[str, ...]:
    if value is None:
        return ()
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    return int(value)


def _json_string_tuple(value: Any) -> tuple[str, ...]:
    if value is None or value == "":
        return ()
    if isinstance(value, str):
        return _split_values(value)
    if isinstance(value, list):
        return tuple(str(item).strip() for item in value if str(item).strip())
    raise ValueError("contract string-list fields must be strings or arrays")


def _escape_markdown_table_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")
