from __future__ import annotations

import csv
import html
import json
import os
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

from medical_fee_calculation.claim_models import (
    ChargeInput,
    CTEquipmentKind,
    ClaimContext,
    ClaimItemStatus,
    CalculationLine,
    CommentInput,
    DpcOptionContext,
    EncounterContext,
    GenericNamePrescriptionAddOnKind,
    ImagingAcquisitionKind,
    ImagingKind,
    ImagingOrder,
    InpatientBasicFeeOptionContext,
    InjectionOptionContext,
    InjectionOrder,
    InjectionRouteKind,
    LabOptionContext,
    MasterSourceContext,
    MedicationDeliveryKind,
    MedicationDispensingKind,
    MedicationOptionContext,
    MedicationOrder,
    MedicationPrescriptionCategory,
    MRIEquipmentKind,
    OutpatientBasicFeeKind,
    OutpatientBasicFeeOptionContext,
    PatientContext,
    RadiographyDiagnosticKind,
    TreatmentAreaSizeKind,
    TreatmentKind,
    TreatmentOrder,
)
from medical_fee_calculation.claim_batch import (
    claim_batch_audit_summary_rows,
    claim_batch_audit_summary_to_csv,
    claim_batch_audit_summary_to_json,
    claim_batch_results_to_markdown,
    gold_difference_classification_rows,
    gold_difference_classification_to_csv,
    gold_difference_classification_to_markdown,
    gold_improvement_action_plan_rows,
    gold_improvement_action_plan_to_csv,
    gold_improvement_action_plan_to_markdown,
    gold_improvement_backlog_rows,
    gold_improvement_backlog_to_csv,
    gold_improvement_backlog_to_markdown,
    gold_evaluation_results_to_csv,
    gold_evaluation_results_to_markdown,
    parse_claim_context_payload,
    run_gold_outpatient_lab_claim_evaluation,
    run_nationwide_outpatient_lab_smoke,
    run_outpatient_lab_claim_batch,
    run_outpatient_lab_claim_payloads,
)
from medical_fee_calculation.cli import main as cli_main
from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.order_csv_adapter import (
    build_order_csv_mapping_contract_template,
    convert_order_csv_to_claim_payloads,
    order_csv_contract_validation_to_markdown,
    order_csv_column_profile_to_markdown,
    order_csv_conversion_to_markdown,
    order_csv_payloads_to_jsonl,
    profile_order_csv_columns,
    validate_order_csv_mapping_contract,
)
from medical_fee_calculation.standard_build import (
    build_standard_master_db,
    prepare_standard_build_manifest,
    standard_build_manifest_preparation_to_markdown,
    standard_build_manifest_validation_to_markdown,
    standard_build_results_to_markdown,
    validate_standard_build_manifest,
)
from medical_fee_calculation.electronic_rules import (
    ElectronicRuleContext,
    ProcedureHistoryEvent,
    check_electronic_rules,
)
from medical_fee_calculation.hospital_importers import (
    import_hokkaido_facility_standards,
    import_hokkaido_hospital_registry,
    import_regional_facility_standards,
    import_regional_hospital_registry,
)
from medical_fee_calculation.hospital_batch import (
    build_hospital_claim_run_contexts,
    hospital_claim_run_contexts_to_markdown,
    hospital_profile_batch_results_to_markdown,
    smoke_hospital_run_targets,
)
from medical_fee_calculation.hospital_quality import (
    hospital_run_target_summary_to_markdown,
    hospital_run_targets_to_markdown,
    hospital_registry_quality_to_markdown,
    list_hospital_run_targets,
    list_unmatched_active_hospitals,
    summarize_hospital_run_targets,
    summarize_hospital_registry_quality,
    unmatched_active_hospitals_to_markdown,
)
from medical_fee_calculation.hospital_profile import FacilityStandard, HospitalProfile, get_hospital_profile
from medical_fee_calculation.facility_standard_dictionary import resolve_facility_standard_rule_key
from medical_fee_calculation.importers import (
    import_comment_links,
    import_comment_master,
    import_drug_master,
    import_electronic_fee_table,
    import_medical_procedure_master,
    import_specific_material_master,
)
from medical_fee_calculation.imaging_fees import calculate_imaging_fees
from medical_fee_calculation.injection_fees import calculate_injection_fees
from medical_fee_calculation.injection_orders import resolve_injection_order_inputs
from medical_fee_calculation.inpatient_fees import calculate_inpatient_fees
from medical_fee_calculation.lab_calculator import (
    LabCalculationContext,
    calculate_lab_claim,
    calculate_lab_claim_for_context,
    calculate_lab_claim_standardized,
)
from medical_fee_calculation.lab_rules import (
    CollectionFeeContext,
    D026Context,
    OutpatientRapidLabContext,
    add_collection_fees,
    add_d026_judgement_fees,
    add_outpatient_rapid_lab_fee,
    build_outpatient_rapid_lab_comment,
    find_outpatient_rapid_lab_eligible_tests,
)
from medical_fee_calculation.lab_rules import LabManagementContext, add_lab_management_fee
from medical_fee_calculation.medication_fees import calculate_medication_fees
from medical_fee_calculation.medication_orders import resolve_medication_order_inputs
from medical_fee_calculation.outpatient_basic import (
    calculate_outpatient_basic_fee,
    calculate_outpatient_management_add_on,
)
from medical_fee_calculation.procedure_resolver import (
    resolve_drug_lines,
    resolve_medical_procedure_lines,
    resolve_specific_material_lines,
)
from medical_fee_calculation.regional_manifest import (
    import_regional_manifest,
    regional_manifest_validation_to_markdown,
    validate_regional_manifest,
)
from medical_fee_calculation.regional_sources import list_regional_source_pages
from medical_fee_calculation.regional_smoke import (
    regional_smoke_results_to_markdown,
    run_regional_manifest_smoke,
)
from medical_fee_calculation.treatment_fees import calculate_treatment_fees


def procedure_row(
    *,
    code: str,
    name: str,
    points: str,
    section: str,
    item: str = "001",
    judgement_kind: str = "1",
    judgement_group: str = "1",
    base_name: str | None = None,
    chapter: str = "2",
    part: str = "03",
) -> list[str]:
    row = [""] * 150
    row[0] = "0"
    row[1] = "S"
    row[2] = code
    row[4] = name
    row[11] = points
    row[12] = "0"
    row[14] = "600"
    row[15] = "0"
    row[49] = judgement_kind
    row[50] = judgement_group
    row[60] = "0"
    row[65] = "600"
    row[84] = ""
    row[85] = ""
    row[86] = "20260601"
    row[87] = "99999999"
    row[89] = chapter
    row[90] = part
    row[91] = section
    row[92] = "00"
    row[93] = item
    row[94] = "0"
    row[95] = "00"
    row[96] = "000"
    row[97] = "00"
    row[98] = "00"
    row[112] = base_name or name
    return row


def drug_row(
    *,
    code: str,
    name: str,
    amount_yen: str,
    unit_name: str = "錠",
) -> list[str]:
    row = [""] * 42
    row[0] = "0"
    row[1] = "Y"
    row[2] = code
    row[4] = name
    row[6] = "ﾃｽﾄ"
    row[7] = "001"
    row[9] = unit_name
    row[10] = "1"
    row[11] = amount_yen
    row[13] = "0"
    row[14] = "0"
    row[15] = "0"
    row[16] = "1"
    row[18] = "0"
    row[19] = "0"
    row[20] = "0"
    row[21] = "0"
    row[22] = "0"
    row[27] = "1"
    row[29] = "20260601"
    row[30] = "99999999"
    row[31] = "123456789012"
    row[32] = "1"
    row[33] = "99999999"
    row[34] = name
    row[35] = "20260601"
    row[36] = "GENERIC00001"
    row[37] = "【般】テスト薬錠"
    row[38] = "1"
    row[39] = "0"
    row[40] = "0"
    row[41] = "0"
    return row


def specific_material_row(
    *,
    code: str,
    name: str,
    amount_yen: str,
    unit_name: str = "個",
) -> list[str]:
    row = [""] * 38
    row[0] = "0"
    row[1] = "T"
    row[2] = code
    row[4] = name
    row[6] = "ﾃｽﾄ"
    row[7] = "001"
    row[9] = unit_name
    row[10] = "1"
    row[11] = amount_yen
    row[13] = "0"
    row[14] = "00"
    row[15] = "99"
    row[20] = "0"
    row[21] = "1"
    row[22] = "0"
    row[23] = "0"
    row[25] = "1"
    row[26] = "0"
    row[27] = "20260601"
    row[28] = "99999999"
    row[29] = "99999999"
    row[30] = "01"
    row[31] = "001"
    row[32] = "0"
    row[36] = name
    row[37] = "0"
    return row


def fixed_row(length: int, values: dict[int, str]) -> list[str]:
    row = [""] * length
    for index, value in values.items():
        row[index] = value
    return row


def write_minimal_xlsx(path: Path, rows: list[list[str]]) -> None:
    sheet_rows = []
    for row_index, row in enumerate(rows, start=1):
        cells = []
        for column_index, value in enumerate(row):
            if value == "":
                continue
            ref = f"{column_name(column_index)}{row_index}"
            escaped = html.escape(value)
            cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escaped}</t></is></c>')
        sheet_rows.append(f'<row r="{row_index}">{"".join(cells)}</row>')

    worksheet = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(sheet_rows)}</sheetData>'
        "</worksheet>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        "</Types>"
    )
    with zipfile.ZipFile(path, "w") as workbook_zip:
        workbook_zip.writestr("[Content_Types].xml", content_types)
        workbook_zip.writestr("xl/workbook.xml", workbook)
        workbook_zip.writestr("xl/_rels/workbook.xml.rels", rels)
        workbook_zip.writestr("xl/worksheets/sheet1.xml", worksheet)


def column_name(index: int) -> str:
    name = ""
    value = index + 1
    while value:
        value, remainder = divmod(value - 1, 26)
        name = chr(ord("A") + remainder) + name
    return name


class ImporterAndD026Test(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "test.sqlite"
        self.csv_path = Path(self.tmp.name) / "s_ALL_test.csv"

        rows = [
            procedure_row(
                code="111000110",
                name="初診料",
                points="291.00",
                chapter="1",
                part="01",
                section="000",
                item="001",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="112007410",
                name="再診料",
                points="76.00",
                chapter="1",
                part="01",
                section="001",
                item="000",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="112011010",
                name="外来管理加算",
                points="52.00",
                chapter="1",
                part="01",
                section="001",
                item="001",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="112011310",
                name="外来診療料",
                points="77.00",
                chapter="1",
                part="01",
                section="002",
                item="000",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="112024210",
                name="再診料（情報通信機器）",
                points="76.00",
                chapter="1",
                part="01",
                section="001",
                item="000",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="120000710",
                name="調剤料（内服薬・浸煎薬・屯服薬）",
                points="11.00",
                section="000",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120001010",
                name="調剤料（外用薬）",
                points="8.00",
                section="000",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120001210",
                name="処方料（その他）",
                points="42.00",
                section="100",
                item="003",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120002610",
                name="処方料（７種類以上内服薬）",
                points="29.00",
                section="100",
                item="002",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120002910",
                name="処方箋料（リフィル以外・その他）",
                points="60.00",
                section="400",
                item="003",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120003370",
                name="抗悪性腫瘍剤処方管理加算（処方料）",
                points="70.00",
                section="100",
                item="007",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120003470",
                name="抗悪性腫瘍剤処方管理加算（処方箋料）",
                points="70.00",
                section="400",
                item="008",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120003570",
                name="一般名処方加算２（処方箋料）",
                points="6.00",
                section="400",
                item="009",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120004270",
                name="一般名処方加算１（処方箋料）",
                points="8.00",
                section="400",
                item="009",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120005610",
                name="特定疾患処方管理加算（処方料）",
                points="56.00",
                section="100",
                item="006",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120005710",
                name="特定疾患処方管理加算（処方箋料）",
                points="56.00",
                section="400",
                item="007",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="120006510",
                name="処方箋料（リフィル処方箋・その他・特定保険薬局）",
                points="42.00",
                section="400",
                item="011",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="05",
            ),
            procedure_row(
                code="130000110",
                name="生物学的製剤注射加算",
                points="15.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="06",
            ),
            procedure_row(
                code="130000310",
                name="麻薬注射加算",
                points="5.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="06",
            ),
            procedure_row(
                code="130000510",
                name="皮内、皮下及び筋肉内注射",
                points="25.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="06",
            ),
            procedure_row(
                code="130003510",
                name="静脈内注射",
                points="37.00",
                section="001",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="06",
            ),
            procedure_row(
                code="130003810",
                name="点滴注射",
                points="102.00",
                section="004",
                item="002",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="06",
            ),
            procedure_row(
                code="130009310",
                name="点滴注射（その他）（入院外）",
                points="53.00",
                section="004",
                item="003",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="06",
            ),
            procedure_row(
                code="140000610",
                name="創傷処置（１００ｃｍ２未満）",
                points="52.00",
                section="000",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140000710",
                name="創傷処置（１００ｃｍ２以上５００ｃｍ２未満）",
                points="60.00",
                section="000",
                item="002",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140032110",
                name="熱傷処置（１００ｃｍ２以上５００ｃｍ２未満）",
                points="147.00",
                section="001",
                item="002",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140011610",
                name="皮膚科軟膏処置（１００ｃｍ２以上５００ｃｍ２未満）",
                points="55.00",
                section="053",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140029610",
                name="消炎鎮痛等処置（マッサージ等の手技による療法）",
                points="35.00",
                section="119",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140040310",
                name="消炎鎮痛等処置（器具等による療法）",
                points="35.00",
                section="119",
                item="002",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140002210",
                name="消炎鎮痛等処置（湿布処置）",
                points="35.00",
                section="119",
                item="003",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140023210",
                name="鼻腔栄養",
                points="60.00",
                section="120",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140013810",
                name="留置カテーテル設置",
                points="40.00",
                section="063",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="140032750",
                name="爪甲除去",
                points="80.00",
                section="001",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="09",
            ),
            procedure_row(
                code="170000210",
                name="電子画像管理加算（単純撮影）",
                points="57.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170000410",
                name="単純撮影（イ）の写真診断",
                points="85.00",
                section="001",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170025210",
                name="画像診断管理加算１（写真診断）",
                points="70.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170027910",
                name="単純撮影（デジタル撮影）",
                points="68.00",
                section="002",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170011710",
                name="ＣＴ撮影（イからニまで以外）",
                points="560.00",
                section="200",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170025510",
                name="画像診断管理加算１（コンピューター断層診断）",
                points="70.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170025710",
                name="画像診断管理加算２（コンピューター断層診断）",
                points="175.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170026310",
                name="遠隔画像診断管理加算２（コンピューター断層診断）",
                points="175.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170012070",
                name="造影剤使用加算（ＣＴ）",
                points="500.00",
                section="200",
                item="003",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170028810",
                name="電子画像管理加算（コンピューター断層診断料）",
                points="120.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170033510",
                name="ＭＲＩ撮影（３テスラ以上の機器）（その他）",
                points="1700.00",
                section="202",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="170020470",
                name="造影剤使用加算（ＭＲＩ）",
                points="250.00",
                section="202",
                item="005",
                judgement_kind="0",
                judgement_group="0",
                chapter="2",
                part="04",
            ),
            procedure_row(
                code="190117710",
                name="急性期一般入院料１",
                points="1688.00",
                section="001",
                item="001",
                judgement_kind="0",
                judgement_group="0",
                chapter="1",
                part="02",
            ),
            procedure_row(
                code="160000410",
                name="尿蛋白",
                points="7.00",
                section="001",
                judgement_group="1",
            ),
            procedure_row(
                code="160008010",
                name="末梢血液一般検査",
                points="21.00",
                section="005",
                item="005",
                judgement_group="2",
            ),
            procedure_row(
                code="160061710",
                name="尿・糞便等検査判断料",
                points="34.00",
                section="026",
                item="001",
                judgement_kind="2",
                judgement_group="1",
            ),
            procedure_row(
                code="160061810",
                name="血液学的検査判断料",
                points="125.00",
                section="026",
                item="003",
                judgement_kind="2",
                judgement_group="2",
            ),
            procedure_row(
                code="160000310",
                name="尿一般",
                points="26.00",
                section="000",
                item="000",
                judgement_group="0",
                base_name="尿中一般物質定性半定量検査",
            ),
            procedure_row(
                code="160005510",
                name="糞便塗抹",
                points="20.00",
                section="003",
                item="002",
                judgement_group="1",
                base_name="糞便塗抹顕微鏡検査（虫卵、脂肪及び消化状況観察を含む。）",
            ),
            procedure_row(
                code="160010010",
                name="ＨｂＡ１ｃ",
                points="49.00",
                section="005",
                item="009",
                judgement_group="2",
                base_name="ヘモグロビンＡ１ｃ（ＨｂＡ１ｃ）",
            ),
            procedure_row(
                code="160031710",
                name="ＴＳＨ",
                points="98.00",
                section="008",
                item="006",
                judgement_group="4",
                base_name="甲状腺刺激ホルモン（ＴＳＨ）",
            ),
            procedure_row(
                code="160057710",
                name="Ｓ－Ｍ",
                points="67.00",
                section="017",
                item="003",
                judgement_group="6",
                base_name="細菌顕微鏡検査（その他のもの）",
            ),
            procedure_row(
                code="160170170",
                name="検体検査管理加算（１）",
                points="40.00",
                section="026",
                item="008",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="160182770",
                name="検体検査管理加算（２）",
                points="100.00",
                section="026",
                item="008",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="160161610",
                name="検体検査管理加算（３）",
                points="330.00",
                section="026",
                item="008",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="160185770",
                name="検体検査管理加算（４）",
                points="550.00",
                section="026",
                item="008",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="160095710",
                name="Ｂ－Ｖ",
                points="40.00",
                section="400",
                item="001",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="160095810",
                name="Ｂ－Ｃ",
                points="6.00",
                section="400",
                item="002",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="160208510",
                name="鼻腔・咽頭拭い液採取",
                points="25.00",
                section="419",
                item="006",
                judgement_kind="0",
                judgement_group="0",
            ),
            procedure_row(
                code="160177770",
                name="外来迅速検体検査加算",
                points="10.00",
                section="000",
                item="000",
                judgement_kind="0",
                judgement_group="0",
            ),
        ]
        with self.csv_path.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(rows)

        self.conn = connect(self.db_path)
        initialize_schema(self.conn)
        result = import_medical_procedure_master(
            self.conn,
            self.csv_path,
            source_version="test-2026-06-01",
            published_at="2026-06-01",
        )
        self.source_id = result.source_id

        self.drug_csv_path = Path(self.tmp.name) / "y_ALL_test.csv"
        with self.drug_csv_path.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(
                [
                    drug_row(
                        code="620000001",
                        name="テスト薬錠１０ｍｇ",
                        amount_yen="100.00",
                    ),
                    drug_row(
                        code="620000002",
                        name="１５円薬",
                        amount_yen="15.00",
                    ),
                    drug_row(
                        code="620000003",
                        name="２５．１円薬",
                        amount_yen="25.10",
                    ),
                ]
            )
        drug_result = import_drug_master(
            self.conn,
            self.drug_csv_path,
            source_version="test-drug-2026-06-01",
            published_at="2026-06-01",
        )
        self.drug_source_id = drug_result.source_id

        self.material_csv_path = Path(self.tmp.name) / "t_ALL_test.csv"
        with self.material_csv_path.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(
                [
                    specific_material_row(
                        code="710000001",
                        name="テスト特定器材",
                        amount_yen="1500.00",
                    ),
                    specific_material_row(
                        code="710000002",
                        name="１５円材料",
                        amount_yen="15.00",
                    ),
                ]
            )
        material_result = import_specific_material_master(
            self.conn,
            self.material_csv_path,
            source_version="test-material-2026-06-01",
            published_at="2026-06-01",
        )
        self.material_source_id = material_result.source_id

    def tearDown(self) -> None:
        self.conn.close()

    def test_importer_creates_lab_views(self) -> None:
        row = self.conn.execute(
            """
            SELECT code, is_lab_test, judgement_group
            FROM lab_procedure_catalog
            WHERE code = '160000410'
            """
        ).fetchone()

        self.assertIsNotNone(row)
        self.assertEqual(row["is_lab_test"], 1)
        self.assertEqual(row["judgement_group"], "1")

        fee = self.conn.execute(
            """
            SELECT judgement_fee_code, points
            FROM lab_judgement_fee_map
            WHERE judgement_group = '1'
            """
        ).fetchone()

        self.assertEqual(fee["judgement_fee_code"], "160061710")
        self.assertEqual(fee["points"], 34.0)

    def test_importer_creates_drug_and_specific_material_rows(self) -> None:
        drug = self.conn.execute(
            """
            SELECT code, name, unit_amount_yen, base_name
            FROM drugs
            WHERE source_id = ?
              AND code = '620000001'
            """,
            (self.drug_source_id,),
        ).fetchone()
        material = self.conn.execute(
            """
            SELECT code, name, unit_amount_yen, base_name
            FROM specific_materials
            WHERE source_id = ?
              AND code = '710000001'
            """,
            (self.material_source_id,),
        ).fetchone()

        self.assertEqual(drug["name"], "テスト薬錠１０ｍｇ")
        self.assertEqual(drug["unit_amount_yen"], 100.0)
        self.assertEqual(material["name"], "テスト特定器材")
        self.assertEqual(material["unit_amount_yen"], 1500.0)

    def test_calculate_outpatient_basic_fee_adds_initial_candidate(self) -> None:
        result = calculate_outpatient_basic_fee(
            self.conn,
            (),
            date(2026, 6, 3),
            OutpatientBasicFeeOptionContext(fee_kind=OutpatientBasicFeeKind.INITIAL),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["111000110"])
        self.assertEqual(result.lines[0].status, ClaimItemStatus.CANDIDATE)
        self.assertEqual(result.lines[0].total_points, 291.0)
        self.assertEqual(result.messages, ())

    def test_calculate_outpatient_basic_fee_selects_online_revisit(self) -> None:
        result = calculate_outpatient_basic_fee(
            self.conn,
            (),
            date(2026, 6, 3),
            OutpatientBasicFeeOptionContext(
                fee_kind=OutpatientBasicFeeKind.REVISIT,
                information_communication_equipment=True,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["112024210"])

    def test_calculate_outpatient_basic_fee_skips_when_already_present(self) -> None:
        result = calculate_outpatient_basic_fee(
            self.conn,
            ("111000110",),
            date(2026, 6, 3),
            OutpatientBasicFeeOptionContext(fee_kind=OutpatientBasicFeeKind.INITIAL),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)
        self.assertEqual(result.messages[0].code, "111000110")

    def test_calculate_outpatient_management_add_on_for_revisit_management_explanation(self) -> None:
        result = calculate_outpatient_management_add_on(
            self.conn,
            (),
            date(2026, 6, 3),
            OutpatientBasicFeeOptionContext(
                fee_kind=OutpatientBasicFeeKind.REVISIT,
                management_explanation_performed=True,
            ),
            is_outpatient=True,
            existing_lines=(
                CalculationLine(
                    code="112007410",
                    name="再診料",
                    points=76.0,
                    quantity=1,
                    status=ClaimItemStatus.CANDIDATE,
                    reason="revisit",
                    source="outpatient_basic_fee",
                ),
            ),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["112011010"])
        self.assertEqual(result.lines[0].total_points, 52.0)

    def test_calculate_outpatient_management_add_on_skips_when_lab_is_present(self) -> None:
        result = calculate_outpatient_management_add_on(
            self.conn,
            (),
            date(2026, 6, 3),
            OutpatientBasicFeeOptionContext(
                fee_kind=OutpatientBasicFeeKind.REVISIT,
                management_explanation_performed=True,
            ),
            is_outpatient=True,
            existing_lines=(
                CalculationLine(
                    code="112007410",
                    name="再診料",
                    points=76.0,
                    quantity=1,
                    status=ClaimItemStatus.CANDIDATE,
                    reason="revisit",
                    source="outpatient_basic_fee",
                ),
                CalculationLine(
                    code="160000410",
                    name="検査",
                    points=10.0,
                    quantity=1,
                    status=ClaimItemStatus.CANDIDATE,
                    reason="lab",
                    source="d026",
                ),
            ),
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())

    def test_calculate_medication_fees_adds_in_house_dispensing_and_prescription_fee(self) -> None:
        result = calculate_medication_fees(
            self.conn,
            (),
            (ChargeInput(code="620000001", quantity=2),),
            date(2026, 6, 3),
            MedicationOptionContext(
                delivery_kind=MedicationDeliveryKind.IN_HOUSE,
                dispensing_kinds=(MedicationDispensingKind.INTERNAL_OR_PRN,),
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["120000710", "120001210"])
        self.assertEqual([line.total_points for line in result.lines], [11.0, 42.0])
        self.assertEqual(result.messages, ())

    def test_calculate_medication_fees_adds_outside_prescription_fee_variant(self) -> None:
        result = calculate_medication_fees(
            self.conn,
            (),
            (),
            date(2026, 6, 3),
            MedicationOptionContext(
                delivery_kind=MedicationDeliveryKind.OUTSIDE_PRESCRIPTION,
                refill_prescription=True,
                special_pharmacy_relationship=True,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["120006510"])

    def test_calculate_medication_fees_adds_in_house_management_add_ons(self) -> None:
        result = calculate_medication_fees(
            self.conn,
            (),
            (ChargeInput(code="620000001", quantity=2),),
            date(2026, 6, 3),
            MedicationOptionContext(
                delivery_kind=MedicationDeliveryKind.IN_HOUSE,
                dispensing_kinds=(MedicationDispensingKind.INTERNAL_OR_PRN,),
                specific_disease_prescription_management=True,
                anti_malignant_tumor_prescription_management=True,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual(
            [line.code for line in result.lines],
            ["120000710", "120001210", "120005610", "120003370"],
        )
        self.assertEqual([line.total_points for line in result.lines], [11.0, 42.0, 56.0, 70.0])

    def test_calculate_medication_fees_adds_outside_prescription_add_ons(self) -> None:
        result = calculate_medication_fees(
            self.conn,
            (),
            (),
            date(2026, 6, 3),
            MedicationOptionContext(
                delivery_kind=MedicationDeliveryKind.OUTSIDE_PRESCRIPTION,
                specific_disease_prescription_management=True,
                anti_malignant_tumor_prescription_management=True,
                generic_name_prescription_add_on=GenericNamePrescriptionAddOnKind.ADD_ON_1,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual(
            [line.code for line in result.lines],
            ["120002910", "120005710", "120003470", "120004270"],
        )
        self.assertEqual([line.total_points for line in result.lines], [60.0, 56.0, 70.0, 8.0])

    def test_calculate_medication_fees_blocks_monthly_management_add_on(self) -> None:
        result = calculate_medication_fees(
            self.conn,
            (),
            (),
            date(2026, 6, 3),
            MedicationOptionContext(
                delivery_kind=MedicationDeliveryKind.OUTSIDE_PRESCRIPTION,
                specific_disease_prescription_management=True,
                specific_disease_prescription_management_already_billed_same_month=True,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["120002910"])
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)
        self.assertEqual(result.messages[0].code, "120005710")

    def test_calculate_medication_fees_warns_generic_name_add_on_for_in_house(self) -> None:
        result = calculate_medication_fees(
            self.conn,
            (),
            (ChargeInput(code="620000001", quantity=1),),
            date(2026, 6, 3),
            MedicationOptionContext(
                delivery_kind=MedicationDeliveryKind.IN_HOUSE,
                generic_name_prescription_add_on=GenericNamePrescriptionAddOnKind.ADD_ON_2,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["120001210"])
        self.assertEqual(len(result.messages), 2)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)

    def test_calculate_medication_fees_skips_gargle_only(self) -> None:
        result = calculate_medication_fees(
            self.conn,
            (),
            (ChargeInput(code="620000001", quantity=1),),
            date(2026, 6, 3),
            MedicationOptionContext(
                delivery_kind=MedicationDeliveryKind.IN_HOUSE,
                gargle_only=True,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)

    def test_resolve_injection_order_inputs_calculates_total_quantity(self) -> None:
        result = resolve_injection_order_inputs(
            (
                InjectionOrder(drug_code="620000001", dose_quantity=1.5, administrations=2),
                InjectionOrder(drug_code="620000001", total_quantity=1),
            )
        )

        self.assertEqual(result.charge_inputs, (ChargeInput(code="620000001", quantity=4.0),))
        self.assertEqual(result.messages, ())

    def test_resolve_injection_order_inputs_warns_when_quantity_is_missing(self) -> None:
        result = resolve_injection_order_inputs((InjectionOrder(drug_code="620000001"),))

        self.assertEqual(result.charge_inputs, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)

    def test_calculate_injection_fees_adds_intravenous_and_add_ons(self) -> None:
        result = calculate_injection_fees(
            self.conn,
            (),
            date(2026, 6, 3),
            InjectionOptionContext(
                route_kind=InjectionRouteKind.INTRAVENOUS,
                biologic_add_on=True,
                narcotic_add_on=True,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["130003510", "130000110", "130000310"])
        self.assertEqual([line.total_points for line in result.lines], [37.0, 15.0, 5.0])
        self.assertEqual(result.messages, ())

    def test_calculate_injection_fees_selects_outpatient_drip_other(self) -> None:
        result = calculate_injection_fees(
            self.conn,
            (),
            date(2026, 6, 3),
            InjectionOptionContext(
                route_kind=InjectionRouteKind.DRIP_INFUSION,
                drip_infusion_outpatient_other=True,
            ),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["130009310"])

    def test_calculate_injection_fees_skips_when_already_present(self) -> None:
        result = calculate_injection_fees(
            self.conn,
            ("130003510",),
            date(2026, 6, 3),
            InjectionOptionContext(route_kind=InjectionRouteKind.INTRAVENOUS),
            is_outpatient=True,
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)
        self.assertEqual(result.messages[0].code, "130003510")

    def test_calculate_injection_fees_blocks_inpatient_intravenous_route_fee(self) -> None:
        result = calculate_injection_fees(
            self.conn,
            (),
            date(2026, 6, 3),
            InjectionOptionContext(route_kind=InjectionRouteKind.INTRAVENOUS),
            is_outpatient=False,
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)
        self.assertEqual(result.messages[0].code, "130003510")

    def test_calculate_treatment_fees_adds_area_and_simple_treatments(self) -> None:
        result = calculate_treatment_fees(
            self.conn,
            (),
            (
                TreatmentOrder(
                    kind=TreatmentKind.WOUND,
                    area_size=TreatmentAreaSizeKind.LT_100_CM2,
                ),
                TreatmentOrder(kind=TreatmentKind.NAIL_REMOVAL),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["140000610", "140032750"])
        self.assertEqual([line.total_points for line in result.lines], [52.0, 80.0])
        self.assertEqual(result.messages, ())

    def test_calculate_treatment_fees_warns_when_area_size_is_missing(self) -> None:
        result = calculate_treatment_fees(
            self.conn,
            (),
            (TreatmentOrder(kind=TreatmentKind.WOUND),),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)

    def test_calculate_treatment_fees_skips_when_already_present(self) -> None:
        result = calculate_treatment_fees(
            self.conn,
            ("140000610",),
            (
                TreatmentOrder(
                    kind=TreatmentKind.WOUND,
                    area_size=TreatmentAreaSizeKind.LT_100_CM2,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)
        self.assertEqual(result.messages[0].code, "140000610")

    def test_calculate_treatment_fees_skips_duplicate_order(self) -> None:
        result = calculate_treatment_fees(
            self.conn,
            (),
            (
                TreatmentOrder(
                    kind=TreatmentKind.WOUND,
                    area_size=TreatmentAreaSizeKind.LT_100_CM2,
                ),
                TreatmentOrder(
                    kind=TreatmentKind.WOUND,
                    area_size=TreatmentAreaSizeKind.LT_100_CM2,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["140000610"])
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)
        self.assertEqual(result.messages[0].code, "140000610")

    def test_calculate_imaging_fees_adds_simple_radiography(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (
                ImagingOrder(
                    kind=ImagingKind.SIMPLE_RADIOGRAPHY,
                    acquisition_kind=ImagingAcquisitionKind.DIGITAL,
                    radiography_diagnostic_kind=RadiographyDiagnosticKind.SIMPLE_I,
                    electronic_image_management=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["170000410", "170027910", "170000210"])
        self.assertEqual([line.total_points for line in result.lines], [85.0, 68.0, 57.0])
        self.assertEqual(result.messages, ())

    def test_calculate_imaging_fees_applies_simple_radiography_projection_decrement(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (
                ImagingOrder(
                    kind=ImagingKind.SIMPLE_RADIOGRAPHY,
                    acquisition_kind=ImagingAcquisitionKind.DIGITAL,
                    radiography_diagnostic_kind=RadiographyDiagnosticKind.SIMPLE_I,
                    projection_count=2,
                    electronic_image_management=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["170000410", "170027910", "170000210"])
        self.assertEqual([line.quantity for line in result.lines], [2.0, 2.0, 1.0])
        self.assertEqual([line.total_points for line in result.lines], [128.0, 102.0, 57.0])
        self.assertEqual(result.messages, ())

    def test_calculate_imaging_fees_adds_ct_with_contrast(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (
                ImagingOrder(
                    kind=ImagingKind.CT,
                    ct_equipment_kind=CTEquipmentKind.OTHER,
                    contrast=True,
                    electronic_image_management=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["170011710", "170012070", "170028810"])
        self.assertEqual([line.total_points for line in result.lines], [560.0, 500.0, 120.0])
        self.assertEqual(result.messages, ())

    def test_calculate_imaging_fees_adds_ct_management_from_facility_standard(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (
                ImagingOrder(
                    kind=ImagingKind.CT,
                    ct_equipment_kind=CTEquipmentKind.OTHER,
                    diagnostic_management_add_on=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
            facility_standard_keys=frozenset({"画２"}),
        )

        self.assertEqual([line.code for line in result.lines], ["170011710", "170025710"])
        self.assertEqual([line.total_points for line in result.lines], [560.0, 175.0])
        self.assertEqual(result.messages, ())

    def test_calculate_imaging_fees_requires_management_facility_standard(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (
                ImagingOrder(
                    kind=ImagingKind.CT,
                    ct_equipment_kind=CTEquipmentKind.OTHER,
                    diagnostic_management_add_on=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["170011710"])
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)
        self.assertIn("画1-画4", result.messages[0].message)

    def test_calculate_imaging_fees_adds_remote_management_from_facility_standard(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (
                ImagingOrder(
                    kind=ImagingKind.CT,
                    ct_equipment_kind=CTEquipmentKind.OTHER,
                    remote_diagnostic_management_add_on=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
            facility_standard_keys=frozenset({"画２", "遠画"}),
        )

        self.assertEqual([line.code for line in result.lines], ["170011710", "170026310"])
        self.assertEqual(result.messages, ())

    def test_calculate_imaging_fees_adds_mri_with_contrast(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (
                ImagingOrder(
                    kind=ImagingKind.MRI,
                    mri_equipment_kind=MRIEquipmentKind.TESLA_3_OR_MORE,
                    contrast=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["170033510", "170020470"])
        self.assertEqual([line.total_points for line in result.lines], [1700.0, 250.0])
        self.assertEqual(result.messages, ())

    def test_calculate_imaging_fees_warns_when_required_fields_are_missing(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            (),
            (ImagingOrder(kind=ImagingKind.CT, contrast=True),),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)

    def test_calculate_imaging_fees_skips_when_already_present(self) -> None:
        result = calculate_imaging_fees(
            self.conn,
            ("170000410",),
            (
                ImagingOrder(
                    kind=ImagingKind.SIMPLE_RADIOGRAPHY,
                    acquisition_kind=ImagingAcquisitionKind.DIGITAL,
                    radiography_diagnostic_kind=RadiographyDiagnosticKind.SIMPLE_I,
                    electronic_image_management=True,
                ),
            ),
            date(2026, 6, 3),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["170027910", "170000210"])
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.BLOCKED)
        self.assertEqual(result.messages[0].code, "170000410")

    def test_calculate_inpatient_fees_adds_basic_fee_candidate(self) -> None:
        result = calculate_inpatient_fees(
            self.conn,
            (),
            date(2026, 6, 3),
            InpatientBasicFeeOptionContext(
                basic_fee_code="190117710",
                basic_fee_days=2,
                facility_standard_key="一般入院",
            ),
            DpcOptionContext(),
            is_outpatient=False,
            facility_standard_keys=frozenset({"一般入院"}),
            source_id=self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["190117710"])
        self.assertEqual(result.lines[0].quantity, 2.0)
        self.assertEqual(result.lines[0].total_points, 3376.0)
        self.assertEqual(result.messages, ())

    def test_calculate_inpatient_fees_requires_facility_standard(self) -> None:
        result = calculate_inpatient_fees(
            self.conn,
            (),
            date(2026, 6, 3),
            InpatientBasicFeeOptionContext(
                basic_fee_code="190117710",
                facility_standard_key="一般入院",
            ),
            DpcOptionContext(),
            is_outpatient=False,
            facility_standard_keys=frozenset(),
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)
        self.assertEqual(result.messages[0].source, "inpatient_basic_fee")

    def test_calculate_inpatient_fees_routes_dpc_to_review(self) -> None:
        result = calculate_inpatient_fees(
            self.conn,
            (),
            date(2026, 6, 3),
            InpatientBasicFeeOptionContext(),
            DpcOptionContext(dpc_claim=True, dpc_code="040080xx99x0xx"),
            is_outpatient=False,
            source_id=self.source_id,
        )

        self.assertEqual(result.lines, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)
        self.assertEqual(result.messages[0].source, "dpc_claim")

    def test_resolve_medication_order_inputs_calculates_total_quantity(self) -> None:
        result = resolve_medication_order_inputs(
            (
                MedicationOrder(
                    drug_code="620000001",
                    quantity_per_day=2,
                    days=7,
                    dispensing_kind=MedicationDispensingKind.INTERNAL_OR_PRN,
                ),
                MedicationOrder(
                    drug_code="620000001",
                    dose_quantity=1,
                    doses_per_day=3,
                    days=2,
                    dispensing_kind=MedicationDispensingKind.INTERNAL_OR_PRN,
                ),
                MedicationOrder(
                    drug_code="620000002",
                    total_quantity=1,
                    dispensing_kind=MedicationDispensingKind.EXTERNAL,
                ),
            )
        )

        self.assertEqual(
            result.charge_inputs,
            (
                ChargeInput(code="620000001", quantity=20.0),
                ChargeInput(code="620000002", quantity=1.0),
            ),
        )
        self.assertEqual(
            result.dispensing_kinds,
            (MedicationDispensingKind.INTERNAL_OR_PRN, MedicationDispensingKind.EXTERNAL),
        )
        self.assertEqual(result.messages, ())

    def test_resolve_medication_order_inputs_warns_when_quantity_is_missing(self) -> None:
        result = resolve_medication_order_inputs((MedicationOrder(drug_code="620000001"),))

        self.assertEqual(result.charge_inputs, ())
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)
        self.assertEqual(result.messages[0].code, "620000001")

    def test_add_d026_judgement_fees(self) -> None:
        result = add_d026_judgement_fees(
            self.conn,
            ["160000410", "160008010"],
            D026Context(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
            ),
        )

        self.assertEqual([item.code for item in result.claim_items], ["160061710", "160061810"])
        self.assertEqual(result.skipped_groups, {})
        self.assertEqual(result.warnings, ())

    def test_add_d026_skips_already_billed_group(self) -> None:
        result = add_d026_judgement_fees(
            self.conn,
            ["160000410", "160008010"],
            D026Context(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                already_billed_judgement_groups=frozenset({"1"}),
            ),
        )

        self.assertEqual([item.code for item in result.claim_items], ["160061810"])
        self.assertEqual(result.skipped_groups["1"], "already_billed_same_month")

    def test_add_d026_warns_when_history_is_incomplete(self) -> None:
        result = add_d026_judgement_fees(
            self.conn,
            ["160000410"],
            D026Context(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                history_complete=False,
            ),
        )

        self.assertEqual([item.code for item in result.claim_items], ["160061710"])
        self.assertEqual(len(result.warnings), 1)

    def test_add_lab_management_fee_uses_facility_standard(self) -> None:
        result = add_lab_management_fee(
            self.conn,
            ["160000410", "160061710"],
            LabManagementContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                facility_standard_keys=frozenset({"検Ⅰ", "検Ⅱ"}),
            ),
        )

        self.assertIsNone(result.skipped_reason)
        self.assertIsNotNone(result.claim_item)
        self.assertEqual(result.claim_item.code, "160182770")
        self.assertEqual(result.claim_item.points, 100.0)

    def test_facility_standard_dictionary_resolves_core_abbreviations(self) -> None:
        self.assertEqual(resolve_facility_standard_rule_key("検2"), "lab_management_2")
        self.assertEqual(resolve_facility_standard_rule_key("画２"), "image_diagnostic_management_2")
        self.assertEqual(resolve_facility_standard_rule_key("遠画"), "remote_image_diagnostic")
        self.assertEqual(
            resolve_facility_standard_rule_key("一般入院"),
            "general_ward_basic_inpatient",
        )

    def test_add_lab_management_fee_accepts_normalized_facility_standard_alias(self) -> None:
        result = add_lab_management_fee(
            self.conn,
            ["160000410", "160061710"],
            LabManagementContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                facility_standard_keys=frozenset({"検2"}),
            ),
        )

        self.assertIsNone(result.skipped_reason)
        self.assertIsNotNone(result.claim_item)
        self.assertEqual(result.claim_item.code, "160182770")

    def test_add_lab_management_fee_requires_judgement_fee(self) -> None:
        result = add_lab_management_fee(
            self.conn,
            ["160000410"],
            LabManagementContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                facility_standard_keys=frozenset({"検Ⅱ"}),
            ),
        )

        self.assertIsNone(result.claim_item)
        self.assertEqual(result.skipped_reason, "judgement_fee_required")

    def test_add_lab_management_fee_skips_when_already_billed(self) -> None:
        result = add_lab_management_fee(
            self.conn,
            ["160000410", "160061710"],
            LabManagementContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                facility_standard_keys=frozenset({"検Ⅳ"}),
                already_billed_same_month=True,
            ),
        )

        self.assertIsNone(result.claim_item)
        self.assertEqual(result.skipped_reason, "already_billed_same_month")

    def test_add_collection_fees_uses_explicit_collection_inputs(self) -> None:
        result = add_collection_fees(
            self.conn,
            ["160000410"],
            CollectionFeeContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                collection_fee_inputs=("blood_venous", "nasopharyngeal_swab"),
            ),
        )

        self.assertEqual([item.code for item in result.claim_items], ["160095710", "160208510"])
        self.assertEqual([item.points for item in result.claim_items], [40.0, 25.0])
        self.assertEqual(result.skipped_inputs, {})
        self.assertEqual(result.warnings, ())

    def test_add_collection_fees_skips_existing_and_same_day_billed_codes(self) -> None:
        result = add_collection_fees(
            self.conn,
            ["160000410", "160095710"],
            CollectionFeeContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                collection_fee_inputs=("blood_venous", "blood_capillary"),
                already_billed_same_day_codes=frozenset({"160095810"}),
            ),
        )

        self.assertEqual(result.claim_items, ())
        self.assertEqual(result.skipped_inputs["blood_venous"], "already_present_in_claim")
        self.assertEqual(result.skipped_inputs["blood_capillary"], "already_billed_same_day")

    def test_find_outpatient_rapid_lab_eligible_tests_uses_official_target_list(self) -> None:
        result = find_outpatient_rapid_lab_eligible_tests(
            self.conn,
            ["160000310", "160000410", "160005510", "160008010", "160010010", "160057710"],
            date(2026, 6, 3),
            self.source_id,
        )

        self.assertEqual(
            [(item.code, item.name) for item in result],
            [
                ("160000310", "尿中一般物質定性半定量検査"),
                ("160008010", "末梢血液一般検査"),
                ("160010010", "ヘモグロビンＡ１ｃ（ＨｂＡ１ｃ）"),
                ("160057710", "細菌顕微鏡検査（その他のもの）"),
            ],
        )

    def test_build_outpatient_rapid_lab_comment(self) -> None:
        eligible_tests = find_outpatient_rapid_lab_eligible_tests(
            self.conn,
            ["160000310", "160008010"],
            date(2026, 6, 3),
            self.source_id,
        )

        self.assertEqual(
            build_outpatient_rapid_lab_comment(eligible_tests, 2),
            "検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査、末梢血液一般検査",
        )

    def test_add_outpatient_rapid_lab_fee_uses_confirmed_item_count(self) -> None:
        result = add_outpatient_rapid_lab_fee(
            self.conn,
            ["160000310", "160008010"],
            OutpatientRapidLabContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                is_outpatient=True,
                same_day_result_explained=True,
                written_information_provided=True,
                result_based_care_provided=True,
            ),
        )

        self.assertIsNone(result.skipped_reason)
        self.assertIsNotNone(result.claim_item)
        self.assertEqual(result.claim_item.code, "160177770")
        self.assertEqual(result.claim_item.points, 10.0)
        self.assertEqual(result.claim_item.quantity, 2)
        self.assertEqual(result.claim_item.total_points, 20.0)
        self.assertEqual(result.eligible_item_count, 2)
        self.assertEqual(result.comment_text, "検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査、末梢血液一般検査")

    def test_add_outpatient_rapid_lab_fee_caps_daily_limit(self) -> None:
        result = add_outpatient_rapid_lab_fee(
            self.conn,
            ["160000410"],
            OutpatientRapidLabContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                is_outpatient=True,
                eligible_test_item_count=4,
                already_billed_same_day_count=3,
                same_day_result_explained=True,
                written_information_provided=True,
                result_based_care_provided=True,
            ),
        )

        self.assertIsNotNone(result.claim_item)
        self.assertEqual(result.claim_item.quantity, 2)
        self.assertEqual(result.billed_item_count, 2)
        self.assertEqual(len(result.warnings), 1)

    def test_add_outpatient_rapid_lab_fee_requires_same_day_facts(self) -> None:
        result = add_outpatient_rapid_lab_fee(
            self.conn,
            ["160000410"],
            OutpatientRapidLabContext(
                service_date=date(2026, 6, 3),
                source_id=self.source_id,
                is_outpatient=True,
                eligible_test_item_count=1,
            ),
        )

        self.assertIsNone(result.claim_item)
        self.assertEqual(result.skipped_reason, "same_day_result_explanation_and_document_required")

    def test_calculate_lab_claim_adds_candidates_and_comment_advisories(self) -> None:
        comment_links_csv = Path(self.tmp.name) / "comment_links.csv"
        with comment_links_csv.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(
                [
                    fixed_row(
                        30,
                        {
                            3: "D",
                            5: "160182770",
                            7: "検体検査管理加算（２）",
                            8: "830100111",
                            10: "検体検査管理加算コメント；",
                            11: "20260601",
                            12: "99999999",
                            13: "00",
                        },
                    ),
                    fixed_row(
                        30,
                        {
                            3: "D",
                            5: "160177770",
                            7: "外来迅速検体検査加算",
                            8: "830100111",
                            10: "検体検査名（外来迅速検体検査加算）；",
                            11: "20260601",
                            12: "99999999",
                            13: "00",
                        },
                    ),
                ]
            )
        comment_result = import_comment_links(
            self.conn,
            comment_links_csv,
            source_version="test-comment-links-for-lab",
            published_at="2026-06-01",
        )
        profile = HospitalProfile(
            medical_institution_code="0112489",
            institution_name="医療法人 愛全病院",
            institution_type="病院",
            status="現存",
            bed_count_text="一般 231",
            departments_text="内科",
            facility_standards=(
                FacilityStandard(
                    standard_abbreviation="検Ⅱ",
                    standard_name="検体検査管理加算（２）",
                    receipt_number="第100号",
                    start_date="2024-06-01",
                ),
            ),
            warnings=(),
        )

        result = calculate_lab_claim(
            self.conn,
            ["160000410", "160000310"],
            LabCalculationContext(
                service_date=date(2026, 6, 3),
                medical_procedure_source_id=self.source_id,
                comment_source_id=comment_result.source_id,
                hospital_profile=profile,
                collection_fee_inputs=("blood_venous",),
                is_outpatient=True,
                outpatient_rapid_lab_same_day_result_explained=True,
                outpatient_rapid_lab_written_information_provided=True,
                outpatient_rapid_lab_result_based_care_provided=True,
            ),
        )

        self.assertEqual(
            [item.code for item in result.claim_items],
            ["160061710", "160182770", "160095710", "160177770"],
        )
        self.assertEqual(
            result.candidate_procedure_codes,
            ("160000410", "160000310", "160061710", "160182770", "160095710", "160177770"),
        )
        self.assertEqual(result.d026.skipped_groups, {})
        self.assertIsNone(result.lab_management.skipped_reason)
        self.assertEqual(result.collection_fees.skipped_inputs, {})
        self.assertIsNone(result.outpatient_rapid_lab.skipped_reason)
        self.assertEqual(result.outpatient_rapid_lab.billed_item_count, 1)
        self.assertEqual(
            result.outpatient_rapid_lab.comment_text,
            "検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査",
        )
        self.assertEqual(len(result.electronic_rules.required_comments), 2)
        self.assertEqual(
            {hit.procedure_code for hit in result.electronic_rules.required_comments},
            {"160182770", "160177770"},
        )
        self.assertEqual(result.warnings, ())

    def test_comment_inputs_fulfill_required_comment_messages(self) -> None:
        comment_links_csv = Path(self.tmp.name) / "comment_links_fulfilled.csv"
        with comment_links_csv.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(
                [
                    fixed_row(
                        30,
                        {
                            3: "D",
                            5: "160177770",
                            7: "外来迅速検体検査加算",
                            8: "830100111",
                            10: "検体検査名（外来迅速検体検査加算）；",
                            11: "20260601",
                            12: "99999999",
                            13: "00",
                        },
                    ),
                    fixed_row(
                        30,
                        {
                            3: "D",
                            5: "160177770",
                            7: "外来迅速検体検査加算",
                            8: "820100129",
                            10: "引き続き入院",
                            11: "20260601",
                            12: "99999999",
                            13: "00",
                        },
                    ),
                ]
            )
        comment_result = import_comment_links(
            self.conn,
            comment_links_csv,
            source_version="test-comment-links-fulfilled",
            published_at="2026-06-01",
        )

        result = calculate_lab_claim(
            self.conn,
            ["160000410", "160000310"],
            LabCalculationContext(
                service_date=date(2026, 6, 3),
                medical_procedure_source_id=self.source_id,
                comment_source_id=comment_result.source_id,
                facility_standard_keys=frozenset({"検Ⅱ"}),
                collection_fee_inputs=("blood_venous",),
                is_outpatient=True,
                outpatient_rapid_lab_same_day_result_explained=True,
                outpatient_rapid_lab_written_information_provided=True,
                outpatient_rapid_lab_result_based_care_provided=True,
                comment_inputs=(
                    CommentInput(code="820100129"),
                    CommentInput(text="検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査"),
                ),
            ),
        )
        calculation_result = result.to_calculation_result()

        self.assertEqual(len(result.electronic_rules.required_comments), 2)
        self.assertNotIn("comment", {message.source for message in calculation_result.messages})

    def test_calculate_lab_claim_does_not_duplicate_existing_d026(self) -> None:
        result = calculate_lab_claim(
            self.conn,
            ["160000410", "160061710"],
            LabCalculationContext(
                service_date=date(2026, 6, 3),
                medical_procedure_source_id=self.source_id,
                facility_standard_keys=frozenset({"検Ⅱ"}),
            ),
        )

        self.assertEqual([item.code for item in result.claim_items], ["160182770"])
        self.assertEqual(result.d026.skipped_groups["1"], "already_present_in_claim")
        self.assertEqual(
            result.candidate_procedure_codes,
            ("160000410", "160061710", "160182770"),
        )

    def test_calculate_lab_claim_warns_on_frequency_limit_breach(self) -> None:
        frequency_csv = Path(self.tmp.name) / "frequency_limits.csv"
        with frequency_csv.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(
                [
                    fixed_row(
                        14,
                        {
                            1: "160095710",
                            2: "Ｂ－Ｖ",
                            3: "121",
                            4: "日",
                            12: "20260601",
                            13: "99999999",
                        },
                    )
                ]
            )
        electronic_result = import_electronic_fee_table(
            self.conn,
            {"frequency_limits": frequency_csv},
            source_version="test-frequency-breach",
            published_at="2026-06-01",
        )

        result = calculate_lab_claim(
            self.conn,
            ["160000410"],
            LabCalculationContext(
                service_date=date(2026, 6, 3),
                medical_procedure_source_id=self.source_id,
                electronic_fee_source_id=electronic_result.source_id,
                facility_standard_keys=frozenset({"検Ⅱ"}),
                collection_fee_inputs=("blood_venous",),
                same_day_history_codes=frozenset({"160095710"}),
            ),
        )

        self.assertEqual([item.code for item in result.claim_items], ["160061710", "160182770", "160095710"])
        self.assertEqual(len(result.electronic_rules.frequency_limit_breaches), 1)
        self.assertEqual(result.electronic_rules.frequency_limit_breaches[0].procedure_code, "160095710")
        self.assertEqual(len(result.warnings), 1)
        self.assertIn("frequency_limit_breach", result.warnings[0].reason)

    def test_calculate_lab_claim_warns_without_hospital_profile(self) -> None:
        result = calculate_lab_claim(
            self.conn,
            ["160000410"],
            LabCalculationContext(
                service_date=date(2026, 6, 3),
                medical_procedure_source_id=self.source_id,
            ),
        )

        self.assertEqual([item.code for item in result.claim_items], ["160061710"])
        self.assertEqual(result.lab_management.skipped_reason, "facility_standard_not_found")
        self.assertEqual(len(result.warnings), 1)
        self.assertIn("hospital_profile_missing", result.warnings[0].reason)

    def test_calculate_lab_claim_propagates_default_run_profile_warning(self) -> None:
        profile = HospitalProfile(
            medical_institution_code="0440004",
            institution_name="大阪大学歯学部附属病院",
            institution_type="病院",
            status="現存",
            bed_count_text="一般 40",
            departments_text="歯科",
            facility_standards=(
                FacilityStandard(
                    standard_abbreviation="検Ⅰ",
                    standard_name="検体検査管理加算（１）",
                    receipt_number="第201号",
                    start_date="2024-06-01",
                ),
            ),
            warnings=("default_medical_run_excluded: dental_hospital_scope_review",),
            default_run_classification="dental_hospital_scope_review",
            default_run_recommended_action="exclude_from_default_medical_run",
            included_in_default_medical_run=False,
        )

        result = calculate_lab_claim(
            self.conn,
            ["160000410"],
            LabCalculationContext(
                service_date=date(2026, 6, 3),
                medical_procedure_source_id=self.source_id,
                hospital_profile=profile,
            ),
        )

        self.assertIn("検Ⅰ", profile.facility_standard_keys)
        self.assertTrue(
            any(
                warning.reason
                == (
                    "hospital_profile_warning: default_medical_run_excluded: "
                    "dental_hospital_scope_review"
                )
                for warning in result.warnings
            )
        )

    def test_calculate_lab_claim_from_common_context_returns_standardized_result(self) -> None:
        profile = HospitalProfile(
            medical_institution_code="0112489",
            institution_name="医療法人 愛全病院",
            institution_type="病院",
            status="現存",
            bed_count_text="一般 231",
            departments_text="内科",
            facility_standards=(
                FacilityStandard(
                    standard_abbreviation="検Ⅱ",
                    standard_name="検体検査管理加算（２）",
                    receipt_number="第100号",
                    start_date="2024-06-01",
                ),
            ),
            warnings=(),
        )
        claim_context = ClaimContext(
            patient=PatientContext(patient_id="patient-1"),
            encounter=EncounterContext(
                service_date=date(2026, 6, 3),
                medical_institution_code="0112489",
                is_outpatient=True,
            ),
            procedure_codes=("160000410", "160000310"),
            medication_orders=(
                MedicationOrder(
                    drug_code="620000001",
                    quantity_per_day=1,
                    days=2,
                    dispensing_kind=MedicationDispensingKind.INTERNAL_OR_PRN,
                ),
            ),
            injection_orders=(InjectionOrder(drug_code="620000003", total_quantity=1),),
            treatment_orders=(
                TreatmentOrder(
                    kind=TreatmentKind.WOUND,
                    area_size=TreatmentAreaSizeKind.LT_100_CM2,
                ),
            ),
            imaging_orders=(
                ImagingOrder(
                    kind=ImagingKind.SIMPLE_RADIOGRAPHY,
                    acquisition_kind=ImagingAcquisitionKind.DIGITAL,
                    radiography_diagnostic_kind=RadiographyDiagnosticKind.SIMPLE_I,
                    electronic_image_management=True,
                ),
            ),
            material_inputs=(ChargeInput(code="710000001", quantity=1),),
            master_sources=MasterSourceContext(
                medical_procedure_source_id=self.source_id,
                drug_source_id=self.drug_source_id,
                material_source_id=self.material_source_id,
            ),
            hospital_profile=profile,
            lab_options=LabOptionContext(
                collection_fee_inputs=("blood_venous",),
                outpatient_rapid_lab_same_day_result_explained=True,
                outpatient_rapid_lab_written_information_provided=True,
                outpatient_rapid_lab_result_based_care_provided=True,
            ),
            outpatient_basic=OutpatientBasicFeeOptionContext(fee_kind=OutpatientBasicFeeKind.INITIAL),
            medication=MedicationOptionContext(delivery_kind=MedicationDeliveryKind.IN_HOUSE),
            injection=InjectionOptionContext(route_kind=InjectionRouteKind.INTRAVENOUS),
        )

        detailed = calculate_lab_claim_for_context(self.conn, claim_context)
        standardized = calculate_lab_claim_standardized(self.conn, claim_context)

        self.assertEqual(
            [item.code for item in detailed.claim_items],
            ["160061710", "160182770", "160095710", "160177770"],
        )
        self.assertEqual(
            [line.code for line in standardized.lines],
            [
                "160000410",
                "160000310",
                "620000001",
                "620000003",
                "710000001",
                "111000110",
                "120000710",
                "120001210",
                "130003510",
                "140000610",
                "170000410",
                "170027910",
                "170000210",
                "160061710",
                "160182770",
                "160095710",
                "160177770",
            ],
        )
        self.assertEqual(
            [line.status for line in standardized.lines],
            [
                ClaimItemStatus.NEEDS_REVIEW,
                ClaimItemStatus.NEEDS_REVIEW,
                ClaimItemStatus.CONFIRMED,
                ClaimItemStatus.CONFIRMED,
                ClaimItemStatus.CONFIRMED,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
                ClaimItemStatus.CANDIDATE,
            ],
        )
        self.assertEqual(
            standardized.candidate_codes,
            (
                "160000410",
                "160000310",
                "620000001",
                "620000003",
                "710000001",
                "111000110",
                "120000710",
                "120001210",
                "130003510",
                "140000610",
                "170000410",
                "170027910",
                "170000210",
                "160061710",
                "160182770",
                "160095710",
                "160177770",
            ),
        )
        self.assertEqual(standardized.total_candidate_points, 827.0)
        self.assertEqual(standardized.total_confirmed_points, 173.0)
        self.assertEqual(standardized.total_points, 1033.0)
        self.assertEqual(standardized.messages, ())

    def test_standardized_claim_skips_medication_drug_charges_for_outside_prescription(self) -> None:
        claim_context = ClaimContext(
            patient=PatientContext(patient_id="patient-1"),
            encounter=EncounterContext(
                service_date=date(2026, 6, 3),
                medical_institution_code="0112489",
                is_outpatient=True,
            ),
            procedure_codes=(),
            drug_inputs=(ChargeInput(code="620000001", quantity=1),),
            medication_orders=(
                MedicationOrder(
                    drug_code="620000002",
                    quantity_per_day=1,
                    days=2,
                    dispensing_kind=MedicationDispensingKind.INTERNAL_OR_PRN,
                ),
            ),
            master_sources=MasterSourceContext(
                medical_procedure_source_id=self.source_id,
                drug_source_id=self.drug_source_id,
                material_source_id=self.material_source_id,
            ),
            medication=MedicationOptionContext(delivery_kind=MedicationDeliveryKind.OUTSIDE_PRESCRIPTION),
        )

        standardized = calculate_lab_claim_standardized(self.conn, claim_context)
        line_codes = [line.code for line in standardized.lines]

        self.assertIn("120002910", line_codes)
        self.assertNotIn("620000001", line_codes)
        self.assertNotIn("620000002", line_codes)
        self.assertTrue(any(
            message.source == "medication_order"
            and "outside prescription" in message.message
            for message in standardized.messages
        ))

    def test_claim_batch_runs_outpatient_lab_context_jsonl(self) -> None:
        input_path = Path(self.tmp.name) / "claim_batch.jsonl"
        input_path.write_text(
            json.dumps(
                {
                    "record_id": "case-1",
                    "claim_context_template": {
                        "patient": {"patient_id": None},
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    },
                    "patient": {"patient_id": "patient-1"},
                    "procedure_codes": ["160000410", "160000310"],
                    "lab_options": {
                        "collection_fee_inputs": ["blood_venous"],
                        "outpatient_rapid_lab_same_day_result_explained": True,
                        "outpatient_rapid_lab_written_information_provided": True,
                        "outpatient_rapid_lab_result_based_care_provided": True,
                    },
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        results = run_outpatient_lab_claim_batch(self.conn, input_path)
        report = claim_batch_results_to_markdown(results)
        result = results[0]

        self.assertEqual(result.status, "ok")
        self.assertEqual(result.patient_id, "patient-1")
        self.assertEqual(result.regional_bureau, "tohoku")
        self.assertIsNotNone(result.result)
        self.assertEqual(
            [line.code for line in result.result.lines],
            ["160000410", "160000310", "160061710", "160182770", "160095710", "160177770"],
        )
        self.assertEqual(result.result.messages, ())
        self.assertIn("| ok | 1 |", report)
        self.assertIn("Total records: 1", report)

    def test_gold_evaluation_compares_expected_points_and_codes(self) -> None:
        input_path = Path(self.tmp.name) / "gold_claim_batch.jsonl"
        input_path.write_text(
            json.dumps(
                {
                    "record_id": "gold-1",
                    "claim_context_template": {
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    },
                    "patient": {"patient_id": "patient-1"},
                    "procedure_codes": ["160000410", "160000310"],
                    "lab_options": {
                        "collection_fee_inputs": ["blood_venous"],
                        "outpatient_rapid_lab_same_day_result_explained": True,
                        "outpatient_rapid_lab_written_information_provided": True,
                        "outpatient_rapid_lab_result_based_care_provided": True,
                    },
                    "expected": {
                        "total_points": 217,
                        "status": "ok",
                        "candidate_codes": [
                            "160000410",
                            "160000310",
                            "160061710",
                            "160182770",
                            "160095710",
                            "160177770",
                        ],
                    },
                },
                ensure_ascii=False,
            )
            + "\n"
            + json.dumps(
                {
                    "record_id": "gold-2",
                    "encounter": {
                        "service_date": "2026-06-03",
                        "is_outpatient": True,
                    },
                    "procedure_codes": ["160000410"],
                    "expected_total_points": 999,
                },
                ensure_ascii=False,
            )
            + "\n"
            + json.dumps(
                {
                    "record_id": "gold-3",
                    "claim_context_template": {
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    },
                    "patient": {"patient_id": "patient-3"},
                    "procedure_codes": ["160000410", "160000310"],
                    "lab_options": {
                        "collection_fee_inputs": ["blood_venous"],
                        "outpatient_rapid_lab_same_day_result_explained": True,
                        "outpatient_rapid_lab_written_information_provided": True,
                        "outpatient_rapid_lab_result_based_care_provided": True,
                    },
                    "expected": {
                        "total_points": 999,
                        "status": "ok",
                        "candidate_codes": ["999999999"],
                    },
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        results = run_gold_outpatient_lab_claim_evaluation(self.conn, input_path)
        report = gold_evaluation_results_to_markdown(results)
        csv_output = gold_evaluation_results_to_csv(results)
        classification_rows = gold_difference_classification_rows(results)
        classification_report = gold_difference_classification_to_markdown(results)
        classification_csv = gold_difference_classification_to_csv(results)
        backlog_rows = gold_improvement_backlog_rows(results)
        backlog_report = gold_improvement_backlog_to_markdown(results)
        backlog_csv = gold_improvement_backlog_to_csv(results)
        action_plan_rows = gold_improvement_action_plan_rows(results)
        action_plan_report = gold_improvement_action_plan_to_markdown(results)
        action_plan_csv = gold_improvement_action_plan_to_csv(results)

        self.assertEqual(results[0].overall_verdict, "match")
        self.assertEqual(results[0].point_verdict, "match")
        self.assertEqual(results[0].code_verdict, "match")
        self.assertEqual(results[1].overall_verdict, "needs_review")
        self.assertEqual(results[2].overall_verdict, "under")
        self.assertIn("| match | 1 |", report)
        self.assertIn("| needs_review | 1 |", report)
        self.assertIn("gold-1", csv_output)
        self.assertIn("gold-2", csv_output)
        self.assertEqual(classification_rows[0]["classification"], "match")
        self.assertEqual(classification_rows[1]["classification"], "facility_standard_input")
        self.assertEqual(classification_rows[2]["classification"], "under_claim_missing_code")
        self.assertIn("# Gold Difference Classification", classification_report)
        self.assertIn("| calculation_logic_or_mapping | 1 |", classification_report)
        self.assertIn("recommended_action", classification_csv)
        self.assertEqual(backlog_rows[0]["priority"], "high")
        self.assertEqual(backlog_rows[0]["classification"], "under_claim_missing_code")
        self.assertIn("# Gold Improvement Backlog", backlog_report)
        self.assertIn("Backlog items: 2", backlog_report)
        self.assertIn("sample_records", backlog_csv)
        self.assertEqual(action_plan_rows[0]["rank"], 1)
        self.assertEqual(action_plan_rows[0]["owner"], "calculation_logic")
        self.assertIn("acceptance_gate", action_plan_csv)
        self.assertIn("# Gold Improvement Action Plan", action_plan_report)

    def test_gold_evaluation_covers_outpatient_cross_domain_claim_context(self) -> None:
        input_path = Path(self.tmp.name) / "gold_cross_domain_claim_batch.jsonl"
        expected_codes = [
            "160000410",
            "160000310",
            "620000001",
            "620000003",
            "710000001",
            "111000110",
            "120000710",
            "120001210",
            "130003510",
            "140000610",
            "170000410",
            "170027910",
            "170000210",
            "160061710",
            "160182770",
            "160095710",
            "160177770",
        ]
        input_path.write_text(
            json.dumps(
                {
                    "record_id": "gold-cross-domain-1",
                    "encounter": {
                        "service_date": "2026-06-03",
                        "medical_institution_code": "0112489",
                        "is_outpatient": True,
                    },
                    "procedure_codes": ["160000410", "160000310"],
                    "medication_orders": [
                        {
                            "drug_code": "620000001",
                            "quantity_per_day": 1,
                            "days": 2,
                            "dispensing_kind": "internal_or_prn",
                        }
                    ],
                    "injection_orders": [{"drug_code": "620000003", "total_quantity": 1}],
                    "treatment_orders": [{"kind": "wound", "area_size": "lt_100_cm2"}],
                    "imaging_orders": [
                        {
                            "kind": "simple_radiography",
                            "acquisition_kind": "digital",
                            "radiography_diagnostic_kind": "simple_i",
                            "electronic_image_management": True,
                        }
                    ],
                    "material_inputs": [{"code": "710000001", "quantity": 1}],
                    "master_sources": {
                        "medical_procedure_source_id": self.source_id,
                        "drug_source_id": self.drug_source_id,
                        "material_source_id": self.material_source_id,
                    },
                    "facility_standard_keys": ["検Ⅱ"],
                    "lab_options": {
                        "collection_fee_inputs": ["blood_venous"],
                        "outpatient_rapid_lab_same_day_result_explained": True,
                        "outpatient_rapid_lab_written_information_provided": True,
                        "outpatient_rapid_lab_result_based_care_provided": True,
                    },
                    "outpatient_basic": {"fee_kind": "initial"},
                    "medication": {"delivery_kind": "in_house"},
                    "injection": {"route_kind": "intravenous"},
                    "expected": {
                        "status": "ok",
                        "total_points": 1033,
                        "candidate_codes": expected_codes,
                    },
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        results = run_gold_outpatient_lab_claim_evaluation(self.conn, input_path)

        self.assertEqual(results[0].overall_verdict, "match")
        self.assertEqual(results[0].actual_total_points, 1033.0)
        self.assertEqual(results[0].actual_candidate_codes, tuple(expected_codes))

    def test_gold_difference_classification_covers_outpatient_domain_sources(self) -> None:
        input_path = Path(self.tmp.name) / "gold_outpatient_domain_source_claim_batch.jsonl"
        base_payload = {
            "encounter": {
                "service_date": "2026-06-03",
                "medical_institution_code": "04,1000,1",
                "is_outpatient": True,
            },
            "master_sources": {
                "medical_procedure_source_id": self.source_id,
                "drug_source_id": self.drug_source_id,
                "material_source_id": self.material_source_id,
            },
            "expected": {"status": "ok"},
        }
        payloads = [
            {
                **base_payload,
                "record_id": "gold-outpatient-basic-review",
                "outpatient_basic": {"fee_kind": "initial", "same_day_revisit": True},
            },
            {
                **base_payload,
                "record_id": "gold-medication-review",
                "medication_orders": [{"drug_code": "620000001"}],
            },
            {
                **base_payload,
                "record_id": "gold-injection-review",
                "injection_orders": [{"drug_code": "620000001"}],
            },
            {
                **base_payload,
                "record_id": "gold-treatment-review",
                "treatment_orders": [{"kind": "wound"}],
            },
            {
                **base_payload,
                "record_id": "gold-imaging-review",
                "imaging_orders": [{"kind": "simple_radiography"}],
            },
        ]
        input_path.write_text(
            "".join(json.dumps(payload, ensure_ascii=False) + "\n" for payload in payloads),
            encoding="utf-8",
        )

        results = run_gold_outpatient_lab_claim_evaluation(self.conn, input_path)
        classification_rows = {
            row["record_id"]: row for row in gold_difference_classification_rows(results)
        }

        self.assertEqual(
            classification_rows["gold-outpatient-basic-review"]["classification"],
            "outpatient_basic_input",
        )
        self.assertEqual(
            classification_rows["gold-medication-review"]["classification"],
            "medication_input",
        )
        self.assertEqual(
            classification_rows["gold-injection-review"]["classification"],
            "injection_input",
        )
        self.assertEqual(
            classification_rows["gold-treatment-review"]["classification"],
            "treatment_input",
        )
        self.assertEqual(
            classification_rows["gold-imaging-review"]["classification"],
            "imaging_input",
        )
        self.assertEqual(
            classification_rows["gold-outpatient-basic-review"]["feedback_target"],
            "input_contract",
        )
        self.assertEqual(
            classification_rows["gold-medication-review"]["feedback_target"],
            "input_contract_or_calculation_logic",
        )

    def test_gold_evaluation_treats_expected_dpc_review_as_match(self) -> None:
        input_path = Path(self.tmp.name) / "gold_inpatient_expected_review_claim_batch.jsonl"
        payload = {
            "record_id": "gold-dpc-expected-review",
            "encounter": {
                "service_date": "2026-06-03",
                "regional_bureau": "tohoku",
                "medical_institution_code": "04,1000,1",
                "is_outpatient": False,
                "admission_date": "2026-06-01",
            },
            "master_sources": {"medical_procedure_source_id": self.source_id},
            "facility_standard_keys": ["一般入院"],
            "dpc": {
                "dpc_claim": True,
                "dpc_code": "040080xx99x0xx",
                "hospital_coefficient": 1.2345,
            },
            "expected": {"status": "needs_review"},
        }
        input_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")

        results = run_gold_outpatient_lab_claim_evaluation(self.conn, input_path)
        classification_rows = gold_difference_classification_rows(results)

        self.assertEqual(results[0].batch_result.status, "needs_review")
        self.assertEqual(results[0].overall_verdict, "match")
        self.assertEqual(classification_rows[0]["classification"], "match")

    def test_gold_difference_classification_covers_inpatient_and_dpc_sources(self) -> None:
        input_path = Path(self.tmp.name) / "gold_inpatient_source_claim_batch.jsonl"
        base_payload = {
            "encounter": {
                "service_date": "2026-06-03",
                "regional_bureau": "tohoku",
                "medical_institution_code": "04,1000,1",
                "is_outpatient": False,
                "admission_date": "2026-06-01",
            },
            "master_sources": {"medical_procedure_source_id": self.source_id},
            "expected": {"status": "ok"},
        }
        payloads = [
            {
                **base_payload,
                "record_id": "gold-inpatient-basic-review",
                "inpatient_basic": {
                    "basic_fee_code": "190117710",
                    "basic_fee_days": 1,
                    "facility_standard_key": "一般入院",
                },
            },
            {
                **base_payload,
                "record_id": "gold-dpc-review",
                "facility_standard_keys": ["一般入院"],
                "dpc": {
                    "dpc_claim": True,
                    "dpc_code": "040080xx99x0xx",
                    "hospital_coefficient": 1.2345,
                },
            },
        ]
        input_path.write_text(
            "".join(json.dumps(payload, ensure_ascii=False) + "\n" for payload in payloads),
            encoding="utf-8",
        )

        results = run_gold_outpatient_lab_claim_evaluation(self.conn, input_path)
        classification_rows = {
            row["record_id"]: row for row in gold_difference_classification_rows(results)
        }

        self.assertEqual(
            classification_rows["gold-inpatient-basic-review"]["classification"],
            "inpatient_input",
        )
        self.assertEqual(
            classification_rows["gold-dpc-review"]["classification"],
            "dpc_input",
        )
        self.assertEqual(
            classification_rows["gold-inpatient-basic-review"]["priority"],
            "high",
        )
        self.assertEqual(
            classification_rows["gold-dpc-review"]["feedback_target"],
            "input_contract_or_calculation_logic",
        )

    def test_parse_claim_context_payload_supports_full_order_schema(self) -> None:
        claim_context = parse_claim_context_payload(
            {
                "record_id": "case-2",
                "encounter": {
                    "service_date": "2026-06-03",
                    "medical_institution_code": "04,1000,1",
                },
                "procedure_codes": "160000410,160000310",
                "drug_inputs": [{"code": "620000001", "quantity": "2"}],
                "medication_orders": [
                    {
                        "drug_code": "620000002",
                        "quantity_per_day": 1,
                        "days": 3,
                        "dispensing_kind": "internal_or_prn",
                    }
                ],
                "injection_orders": [{"drug_code": "620000003", "total_quantity": 1}],
                "treatment_orders": [{"kind": "wound", "area_size": "lt_100_cm2"}],
                "imaging_orders": [
                    {
                        "kind": "simple_radiography",
                        "acquisition_kind": "digital",
                        "radiography_diagnostic_kind": "simple_i",
                        "electronic_image_management": True,
                    }
                ],
                "material_inputs": [{"code": "710000001", "quantity": 1}],
                "comment_inputs": [
                    {"comment_code": "830100111"},
                    {"comment_text": "検体検査名（外来迅速検体検査加算）；尿一般"},
                ],
                "lab_options": {"lab_management_facility_missing_policy": "ignore"},
                "outpatient_basic": {"fee_kind": "initial"},
                "medication": {"delivery_kind": "in_house"},
                "injection": {"route_kind": "intravenous"},
                "inpatient_basic": {
                    "basic_fee_code": "190117710",
                    "basic_fee_days": 2,
                    "facility_standard_key": "一般入院",
                },
                "dpc": {
                    "dpc_claim": True,
                    "dpc_code": "040080xx99x0xx",
                    "hospital_coefficient": 1.2345,
                },
            },
            default_master_sources=MasterSourceContext(medical_procedure_source_id=self.source_id),
        )

        self.assertEqual(claim_context.encounter.service_date, date(2026, 6, 3))
        self.assertTrue(claim_context.encounter.is_outpatient)
        self.assertEqual(claim_context.procedure_codes, ("160000410", "160000310"))
        self.assertEqual(claim_context.drug_inputs, (ChargeInput(code="620000001", quantity=2.0),))
        self.assertEqual(claim_context.medication_orders[0].dispensing_kind, MedicationDispensingKind.INTERNAL_OR_PRN)
        self.assertEqual(claim_context.treatment_orders[0].kind, TreatmentKind.WOUND)
        self.assertEqual(claim_context.imaging_orders[0].acquisition_kind, ImagingAcquisitionKind.DIGITAL)
        self.assertEqual(claim_context.comment_inputs[0], CommentInput(code="830100111"))
        self.assertEqual(
            claim_context.comment_inputs[1],
            CommentInput(text="検体検査名（外来迅速検体検査加算）；尿一般"),
        )
        self.assertEqual(claim_context.lab_options.lab_management_facility_missing_policy, "ignore")
        self.assertEqual(claim_context.outpatient_basic.fee_kind, OutpatientBasicFeeKind.INITIAL)
        self.assertEqual(claim_context.medication.delivery_kind, MedicationDeliveryKind.IN_HOUSE)
        self.assertEqual(claim_context.injection.route_kind, InjectionRouteKind.INTRAVENOUS)
        self.assertEqual(claim_context.inpatient_basic.basic_fee_code, "190117710")
        self.assertEqual(claim_context.inpatient_basic.basic_fee_days, 2)
        self.assertEqual(claim_context.dpc.dpc_code, "040080xx99x0xx")
        self.assertEqual(claim_context.dpc.hospital_coefficient, 1.2345)

    def test_claim_batch_keeps_invalid_rows_as_errors(self) -> None:
        input_path = Path(self.tmp.name) / "claim_batch_error.jsonl"
        input_path.write_text(
            json.dumps({"record_id": "missing-date", "procedure_codes": ["160000410"]})
            + "\n",
            encoding="utf-8",
        )

        results = run_outpatient_lab_claim_batch(self.conn, input_path)

        self.assertEqual(results[0].status, "error")
        self.assertIn("encounter.service_date is required", results[0].error)

    def test_claim_batch_runs_inpatient_basic_context_jsonl(self) -> None:
        input_path = Path(self.tmp.name) / "inpatient_claim_batch.jsonl"
        input_path.write_text(
            json.dumps(
                {
                    "record_id": "inpatient-1",
                    "encounter": {
                        "service_date": "2026-06-03",
                        "regional_bureau": "tohoku",
                        "medical_institution_code": "04,1000,1",
                        "is_outpatient": False,
                        "admission_date": "2026-06-02",
                    },
                    "patient": {"patient_id": "patient-inpatient-1"},
                    "facility_standard_keys": ["一般入院"],
                    "inpatient_basic": {
                        "basic_fee_code": "190117710",
                        "basic_fee_days": 2,
                        "facility_standard_key": "一般入院",
                    },
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        results = run_outpatient_lab_claim_batch(self.conn, input_path)

        self.assertEqual(results[0].status, "ok")
        self.assertIsNotNone(results[0].result)
        self.assertEqual([line.code for line in results[0].result.lines], ["190117710"])
        self.assertEqual(results[0].result.total_points, 3376.0)

    def test_claim_batch_markdown_summarizes_review_sources(self) -> None:
        input_path = Path(self.tmp.name) / "claim_batch_review.jsonl"
        input_path.write_text(
            json.dumps(
                {
                    "record_id": "review-1",
                    "encounter": {
                        "service_date": "2026-06-03",
                        "regional_bureau": "tohoku",
                        "medical_institution_code": "0410001",
                        "is_outpatient": True,
                    },
                    "procedure_codes": ["160000410"],
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        results = run_outpatient_lab_claim_batch(self.conn, input_path)
        report = claim_batch_results_to_markdown(results)
        audit_rows = claim_batch_audit_summary_rows(results)
        audit_csv = claim_batch_audit_summary_to_csv(audit_rows)
        audit_json = claim_batch_audit_summary_to_json(audit_rows)

        self.assertEqual(results[0].status, "needs_review")
        self.assertIn("| lab_management | blocked | 1 |", report)
        self.assertIn("| lab_warning | needs_review | 2 |", report)
        self.assertIn("| tohoku | needs_review | 1 |", report)
        self.assertIn("| tohoku | lab_management | blocked | 1 |", report)
        self.assertIn("| tohoku | 0410001 | lab_management | blocked | 1 |", report)
        self.assertIn("hospital_registry_not_found", report)
        self.assertIn("facility_standards_not_found", report)
        self.assertIn("lab_management:1, lab_warning:2", report)
        self.assertIn("bureau_message_source_status,tohoku,,", audit_csv)
        self.assertIn("hospital_message_source_status,tohoku,0410001,", audit_csv)
        self.assertIn("facility_standard_message_source_status,,,none", audit_csv)
        self.assertIn('"scope": "facility_standard_status"', audit_json)

    def test_run_nationwide_outpatient_lab_smoke_uses_hospital_profiles(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "registry_nationwide_smoke.xlsx"
        facility_xlsx = Path(self.tmp.name) / "facility_nationwide_smoke.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "施設基準あり病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "2",
                    "04,2000,2",
                    "施設基準なし病院",
                    "〒980－0001仙台市青葉区サンプル２",
                    "022-000-0001",
                    "医療法人 サンプル会",
                    "青葉 次郎",
                    "平30. 4. 1",
                    "一般 50",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        write_minimal_xlsx(
            facility_xlsx,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0410001",
                    "",
                    "",
                    "施設基準あり病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        import_regional_hospital_registry(
            self.conn,
            registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        import_regional_facility_standards(
            self.conn,
            facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )

        results = run_nationwide_outpatient_lab_smoke(
            self.conn,
            service_date=date(2026, 6, 1),
            procedure_codes=("160000410", "160000310"),
            collection_fee_inputs=("blood_venous",),
        )
        report = claim_batch_results_to_markdown(results)

        self.assertEqual(len(results), 2)
        self.assertNotEqual(results[0].status, "error")
        self.assertEqual(results[0].regional_bureau, "tohoku")
        self.assertEqual(results[0].medical_institution_code, "0410001")
        self.assertIsNotNone(results[0].result)
        self.assertIn("160095710", results[0].result.candidate_codes)
        self.assertEqual(results[1].status, "ok")
        self.assertNotIn("facility_standard_not_found", report)
        self.assertIn("Total records: 2", report)

        audit_results = run_nationwide_outpatient_lab_smoke(
            self.conn,
            service_date=date(2026, 6, 1),
            procedure_codes=("160000410", "160000310"),
            collection_fee_inputs=("blood_venous",),
            lab_management_facility_missing_policy="review",
        )
        audit_report = claim_batch_results_to_markdown(audit_results)

        self.assertEqual(audit_results[1].status, "needs_review")
        self.assertIn("facility_standard_not_found", audit_report)

    def test_order_csv_adapter_groups_rows_into_claim_payloads(self) -> None:
        csv_path = Path(self.tmp.name) / "orders.csv"
        template_path = Path(self.tmp.name) / "templates.jsonl"
        template_path.write_text(
            json.dumps(
                {
                    "claim_context_template": {
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    }
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "record_id",
                    "patient_id",
                    "service_date",
                    "regional_bureau",
                    "medical_institution_code",
                    "item_kind",
                    "code",
                    "comment_code",
                    "comment_text",
                    "quantity",
                    "collection_fee_inputs",
                    "outpatient_rapid_lab_same_day_result_explained",
                    "outpatient_rapid_lab_written_information_provided",
                    "outpatient_rapid_lab_result_based_care_provided",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "record_id": "case-1",
                    "patient_id": "patient-1",
                    "service_date": "2026-06-03",
                    "regional_bureau": "tohoku",
                    "medical_institution_code": "04,1000,1",
                    "item_kind": "procedure",
                    "code": "160000410",
                    "collection_fee_inputs": "blood_venous",
                    "outpatient_rapid_lab_same_day_result_explained": "true",
                    "outpatient_rapid_lab_written_information_provided": "true",
                    "outpatient_rapid_lab_result_based_care_provided": "true",
                }
            )
            writer.writerow(
                {
                    "record_id": "case-1",
                    "patient_id": "patient-1",
                    "service_date": "2026-06-03",
                    "regional_bureau": "tohoku",
                    "medical_institution_code": "04,1000,1",
                    "item_kind": "procedure",
                    "code": "160000310",
                }
            )
            writer.writerow(
                {
                    "record_id": "case-1",
                    "patient_id": "patient-1",
                    "service_date": "2026-06-03",
                    "regional_bureau": "tohoku",
                    "medical_institution_code": "04,1000,1",
                    "item_kind": "drug",
                    "code": "620000001",
                    "quantity": "2",
                }
            )
            writer.writerow(
                {
                    "record_id": "case-1",
                    "patient_id": "patient-1",
                    "service_date": "2026-06-03",
                    "regional_bureau": "tohoku",
                    "medical_institution_code": "04,1000,1",
                    "item_kind": "comment",
                    "comment_code": "830100111",
                    "comment_text": "検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査",
                }
            )

        conversion = convert_order_csv_to_claim_payloads(
            csv_path,
            template_jsonl_path=template_path,
        )
        jsonl = order_csv_payloads_to_jsonl(conversion.payloads)
        report = order_csv_conversion_to_markdown(conversion)
        payload = conversion.payloads[0]
        claim_context = parse_claim_context_payload(
            payload,
            default_master_sources=MasterSourceContext(medical_procedure_source_id=self.source_id),
        )

        self.assertEqual(conversion.row_count, 4)
        self.assertEqual(conversion.record_count, 1)
        self.assertEqual(payload["claim_context_template"]["facility_standard_keys"], ["検Ⅱ"])
        self.assertEqual(payload["patient"]["patient_id"], "patient-1")
        self.assertEqual(payload["procedure_codes"], ["160000410", "160000310"])
        self.assertEqual(payload["drug_inputs"], [{"code": "620000001", "quantity": "2"}])
        self.assertEqual(
            payload["comment_inputs"],
            [
                {
                    "code": "830100111",
                    "text": "検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査",
                }
            ],
        )
        self.assertEqual(payload["lab_options"]["collection_fee_inputs"], ["blood_venous"])
        self.assertEqual(claim_context.procedure_codes, ("160000410", "160000310"))
        self.assertEqual(claim_context.comment_inputs[0].code, "830100111")
        self.assertIn('"record_id":"case-1"', jsonl)
        self.assertIn("Output records: 1", report)

    def test_run_outpatient_lab_claim_payloads_accepts_converted_order_csv(self) -> None:
        csv_path = Path(self.tmp.name) / "orders_for_direct_batch.csv"
        template_path = Path(self.tmp.name) / "templates_for_direct_batch.jsonl"
        template_path.write_text(
            json.dumps(
                {
                    "claim_context_template": {
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    }
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "record_id",
                    "patient_id",
                    "service_date",
                    "regional_bureau",
                    "medical_institution_code",
                    "item_kind",
                    "code",
                    "comment_code",
                    "collection_fee_inputs",
                    "outpatient_rapid_lab_same_day_result_explained",
                    "outpatient_rapid_lab_written_information_provided",
                    "outpatient_rapid_lab_result_based_care_provided",
                ],
            )
            writer.writeheader()
            base_row = {
                "record_id": "case-direct-1",
                "patient_id": "patient-direct-1",
                "service_date": "2026-06-03",
                "regional_bureau": "tohoku",
                "medical_institution_code": "04,1000,1",
                "outpatient_rapid_lab_same_day_result_explained": "true",
                "outpatient_rapid_lab_written_information_provided": "true",
                "outpatient_rapid_lab_result_based_care_provided": "true",
            }
            writer.writerow(
                {
                    **base_row,
                    "item_kind": "procedure",
                    "code": "160000410",
                    "collection_fee_inputs": "blood_venous",
                }
            )
            writer.writerow({**base_row, "item_kind": "procedure", "code": "160000310"})
            writer.writerow({**base_row, "item_kind": "comment", "comment_code": "820100129"})
            writer.writerow({**base_row, "item_kind": "comment", "comment_code": "830100111"})

        conversion = convert_order_csv_to_claim_payloads(
            csv_path,
            template_jsonl_path=template_path,
        )
        results = run_outpatient_lab_claim_payloads(self.conn, conversion.payloads)

        self.assertEqual(conversion.record_count, 1)
        self.assertEqual(results[0].status, "ok")
        self.assertIsNotNone(results[0].result)
        self.assertEqual(results[0].result.messages, ())
        self.assertIn("160177770", results[0].result.candidate_codes)

    def test_order_csv_adapter_maps_japanese_orca_columns(self) -> None:
        csv_path = Path(self.tmp.name) / "orca_orders.csv"
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "入外区分",
                    "剤種",
                    "診療行為コード",
                    "数量",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "患者番号": "patient-1",
                    "診療日": "2026-06-03",
                    "地方厚生局": "tohoku",
                    "医療機関コード": "04,1000,1",
                    "入外区分": "1",
                    "剤種": "検査",
                    "診療行為コード": "160000410",
                    "数量": "1",
                }
            )

        conversion = convert_order_csv_to_claim_payloads(
            csv_path,
            column_map_preset="orca",
        )
        payload = conversion.payloads[0]

        self.assertEqual(conversion.warnings, ())
        self.assertEqual(payload["patient"]["patient_id"], "patient-1")
        self.assertEqual(payload["encounter"]["is_outpatient"], "true")
        self.assertEqual(payload["procedure_codes"], ["160000410"])

    def test_order_csv_adapter_maps_japanese_mixed_outpatient_columns(self) -> None:
        csv_path = Path(self.tmp.name) / "mixed_outpatient_orders.csv"
        converted_path = Path(self.tmp.name) / "mixed_outpatient_orders.jsonl"
        batch_output = Path(self.tmp.name) / "mixed_outpatient_batch.md"
        csv_batch_output = Path(self.tmp.name) / "mixed_outpatient_csv_batch.md"
        conversion_report_output = Path(self.tmp.name) / "mixed_outpatient_conversion.md"
        fieldnames = [
            "レコードID",
            "患者番号",
            "診療日",
            "地方厚生局",
            "医療機関コード",
            "入外",
            "明細種別",
            "診療行為コード",
            "薬剤コード",
            "材料コード",
            "コメントコード",
            "コメント文",
            "数量",
            "総量",
            "1日量",
            "日数",
            "1回量",
            "1日回数",
            "投与回数",
            "採取料入力",
            "施設基準",
            "初再診区分",
            "院内院外",
            "処方区分",
            "調剤種別",
            "注射経路",
            "生物学的製剤加算",
            "処置種別",
            "面積区分",
            "画像種別",
            "撮影方式",
            "写真診断区分",
            "電子画像管理",
            "当日結果説明",
            "文書提供",
            "結果に基づく診療",
        ]
        base_row = {
            "レコードID": "mixed-outpatient-1",
            "患者番号": "patient-mixed-1",
            "診療日": "2026-06-03",
            "地方厚生局": "tohoku",
            "医療機関コード": "04,1000,1",
            "入外": "外来",
        }
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "基本情報",
                    "施設基準": "検Ⅱ",
                    "初再診区分": "初診",
                    "院内院外": "院内",
                    "処方区分": "その他",
                    "注射経路": "静脈内",
                    "生物学的製剤加算": "あり",
                    "当日結果説明": "あり",
                    "文書提供": "あり",
                    "結果に基づく診療": "あり",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "採取料入力": "blood_venous",
                }
            )
            writer.writerow({**base_row, "明細種別": "診療行為", "診療行為コード": "160000310"})
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "投薬",
                    "薬剤コード": "620000001",
                    "1日量": "2",
                    "日数": "5",
                    "調剤種別": "内服",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "注射",
                    "薬剤コード": "620000002",
                    "1回量": "1",
                    "投与回数": "2",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "材料",
                    "材料コード": "710000002",
                    "数量": "1",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "処置",
                    "処置種別": "創傷処置",
                    "面積区分": "100cm2未満",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "画像",
                    "画像種別": "単純撮影",
                    "撮影方式": "デジタル",
                    "写真診断区分": "イ",
                    "電子画像管理": "あり",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "コメント",
                    "コメントコード": "820100129",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "コメント",
                    "コメントコード": "830100111",
                    "コメント文": "検体検査名（外来迅速検体検査加算）；尿中一般物質定性半定量検査",
                }
            )

        conversion = convert_order_csv_to_claim_payloads(
            csv_path,
            column_map_preset="japanese",
        )
        payload = conversion.payloads[0]
        claim_context = parse_claim_context_payload(
            payload,
            default_master_sources=MasterSourceContext(
                medical_procedure_source_id=self.source_id,
                drug_source_id=self.drug_source_id,
                material_source_id=self.material_source_id,
            ),
        )
        results = run_outpatient_lab_claim_payloads(self.conn, conversion.payloads)
        converted_path.write_text(order_csv_payloads_to_jsonl(conversion.payloads), encoding="utf-8")

        self.assertEqual(conversion.warnings, ())
        self.assertEqual(payload["outpatient_basic"]["fee_kind"], "initial")
        self.assertEqual(payload["medication"]["delivery_kind"], "in_house")
        self.assertEqual(payload["injection"]["route_kind"], "intravenous")
        self.assertEqual(payload["injection"]["biologic_add_on"], "true")
        self.assertEqual(
            payload["medication_orders"],
            [
                {
                    "drug_code": "620000001",
                    "quantity_per_day": "2",
                    "days": "5",
                    "dispensing_kind": "internal_or_prn",
                }
            ],
        )
        self.assertEqual(
            payload["injection_orders"],
            [{"drug_code": "620000002", "dose_quantity": "1", "administrations": "2"}],
        )
        self.assertEqual(
            payload["treatment_orders"],
            [{"kind": "wound", "area_size": "lt_100_cm2"}],
        )
        self.assertEqual(
            payload["imaging_orders"],
            [
                {
                    "kind": "simple_radiography",
                    "acquisition_kind": "digital",
                    "radiography_diagnostic_kind": "simple_i",
                    "electronic_image_management": "true",
                }
            ],
        )
        self.assertEqual(claim_context.outpatient_basic.fee_kind, OutpatientBasicFeeKind.INITIAL)
        self.assertEqual(claim_context.medication.delivery_kind, MedicationDeliveryKind.IN_HOUSE)
        self.assertEqual(
            claim_context.medication_orders[0].dispensing_kind,
            MedicationDispensingKind.INTERNAL_OR_PRN,
        )
        self.assertEqual(claim_context.injection.route_kind, InjectionRouteKind.INTRAVENOUS)
        self.assertEqual(claim_context.treatment_orders[0].kind, TreatmentKind.WOUND)
        self.assertEqual(
            claim_context.treatment_orders[0].area_size,
            TreatmentAreaSizeKind.LT_100_CM2,
        )
        self.assertEqual(claim_context.imaging_orders[0].kind, ImagingKind.SIMPLE_RADIOGRAPHY)
        self.assertEqual(
            claim_context.imaging_orders[0].acquisition_kind,
            ImagingAcquisitionKind.DIGITAL,
        )
        self.assertEqual(
            claim_context.imaging_orders[0].radiography_diagnostic_kind,
            RadiographyDiagnosticKind.SIMPLE_I,
        )
        self.assertEqual(results[0].status, "ok")
        self.assertIn("111000110", results[0].result.candidate_codes)
        self.assertIn("120000710", results[0].result.candidate_codes)
        self.assertIn("130003510", results[0].result.candidate_codes)
        self.assertIn("130000110", results[0].result.candidate_codes)
        self.assertIn("140000610", results[0].result.candidate_codes)
        self.assertIn("170000410", results[0].result.candidate_codes)
        self.assertIn("170027910", results[0].result.candidate_codes)
        self.assertIn("170000210", results[0].result.candidate_codes)

        cli_main(
            [
                "run-outpatient-claim-batch",
                "--db",
                str(self.db_path),
                "--input",
                str(converted_path),
                "--output",
                str(batch_output),
            ]
        )
        cli_main(
            [
                "run-order-csv-outpatient-claim-batch",
                "--db",
                str(self.db_path),
                "--csv",
                str(csv_path),
                "--column-map-preset",
                "japanese",
                "--output",
                str(csv_batch_output),
                "--converted-output",
                str(Path(self.tmp.name) / "mixed_outpatient_csv_batch.jsonl"),
                "--conversion-report-output",
                str(conversion_report_output),
            ]
        )

        self.assertIn("Total records: 1", batch_output.read_text(encoding="utf-8"))
        self.assertIn("| ok | 1 |", csv_batch_output.read_text(encoding="utf-8"))
        self.assertIn("Warnings: 0", conversion_report_output.read_text(encoding="utf-8"))

    def test_order_csv_adapter_maps_japanese_inpatient_and_dpc_columns(self) -> None:
        csv_path = Path(self.tmp.name) / "inpatient_orders.csv"
        fieldnames = [
            "レコードID",
            "患者番号",
            "診療日",
            "入院日",
            "地方厚生局",
            "医療機関コード",
            "入外",
            "明細種別",
            "診療行為コード",
            "施設基準",
            "入院基本料コード",
            "入院基本料日数",
            "入院基本料施設基準",
            "DPC対象",
            "DPCコード",
            "医療機関別係数",
        ]
        base_row = {
            "レコードID": "inpatient-csv-1",
            "患者番号": "patient-inpatient-1",
            "診療日": "2026-06-03",
            "入院日": "2026-06-02",
            "地方厚生局": "tohoku",
            "医療機関コード": "04,1000,1",
            "入外": "入院",
            "施設基準": "一般入院",
        }
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "入院基本料",
                    "入院基本料コード": "190117710",
                    "入院基本料日数": "2",
                    "入院基本料施設基準": "一般入院",
                }
            )
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "DPC",
                    "DPC対象": "あり",
                    "DPCコード": "040080xx99x0xx",
                    "医療機関別係数": "1.2345",
                }
            )

        conversion = convert_order_csv_to_claim_payloads(csv_path, column_map_preset="japanese")
        claim_context = parse_claim_context_payload(
            conversion.payloads[0],
            default_master_sources=MasterSourceContext(medical_procedure_source_id=self.source_id),
        )

        self.assertFalse(claim_context.encounter.is_outpatient)
        self.assertEqual(claim_context.encounter.admission_date, date(2026, 6, 2))
        self.assertEqual(claim_context.inpatient_basic.basic_fee_code, "190117710")
        self.assertEqual(claim_context.inpatient_basic.basic_fee_days, 2)
        self.assertEqual(claim_context.inpatient_basic.facility_standard_key, "一般入院")
        self.assertTrue(claim_context.dpc.dpc_claim)
        self.assertEqual(claim_context.dpc.dpc_code, "040080xx99x0xx")
        self.assertEqual(claim_context.dpc.hospital_coefficient, 1.2345)

    def test_order_csv_column_profile_reports_mapping_and_gold_fields(self) -> None:
        csv_path = Path(self.tmp.name) / "orders_profile.csv"
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "レコードID",
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "明細種別",
                    "診療行為コード",
                    "正解点数",
                    "正解コード",
                    "院内メモ",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "レコードID": "profile-1",
                    "患者番号": "patient-1",
                    "診療日": "2026-06-03",
                    "地方厚生局": "tohoku",
                    "医療機関コード": "04,1000,1",
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "正解点数": "217",
                    "正解コード": "160000410,160000310",
                    "院内メモ": "profile-note",
                }
            )
            writer.writerow(
                {
                    "レコードID": "profile-1",
                    "患者番号": "patient-1",
                    "診療日": "2026-06-03",
                    "地方厚生局": "tohoku",
                    "医療機関コード": "04,1000,1",
                    "明細種別": "正解",
                    "診療行為コード": "160061710",
                    "院内メモ": "reviewed",
                }
            )

        profile = profile_order_csv_columns(csv_path, column_map_preset="japanese")
        markdown = order_csv_column_profile_to_markdown(profile)
        profile_data = profile.to_dict()

        self.assertEqual(profile.row_count, 2)
        self.assertEqual(profile.missing_required_fields, ())
        self.assertTrue(profile.has_gold_labels)
        self.assertEqual(profile.target_columns["record_id"], ("レコードID",))
        self.assertEqual(profile.target_columns["expected_total_points"], ("正解点数",))
        self.assertEqual(profile.unmapped_columns, ("院内メモ",))
        self.assertIn("expected", profile_data["columns"][5]["mapped_examples"])
        self.assertIn("Gold label fields: present", markdown)
        self.assertIn("院内メモ", markdown)

    def test_order_csv_mapping_contract_validates_required_and_unmapped_columns(self) -> None:
        csv_path = Path(self.tmp.name) / "orders_contract.csv"
        contract_path = Path(self.tmp.name) / "orders_contract.json"
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "レコードID",
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "明細種別",
                    "診療行為コード",
                    "正解点数",
                    "正解コード",
                    "院内メモ",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "レコードID": "contract-1",
                    "患者番号": "patient-1",
                    "診療日": "2026-06-03",
                    "地方厚生局": "tohoku",
                    "医療機関コード": "04,1000,1",
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "正解点数": "217",
                    "正解コード": "160000410,160000310",
                    "院内メモ": "allowed note",
                }
            )
        contract_path.write_text(
            json.dumps(
                {
                    "contract_id": "tohoku-0410001-v1",
                    "hospital_name": "東北テスト病院",
                    "regional_bureau": "tohoku",
                    "medical_institution_code": "0410001",
                    "column_map_preset": "japanese",
                    "required_target_fields": [
                        "record_id",
                        "patient_id",
                        "service_date",
                        "regional_bureau",
                        "medical_institution_code",
                        "item_kind",
                        "code",
                        "expected_total_points",
                        "expected_candidate_codes",
                    ],
                    "required_source_columns": ["レコードID", "診療行為コード"],
                    "allowed_unmapped_columns": ["院内メモ"],
                    "require_gold_labels": True,
                    "minimum_row_count": 1,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        result = validate_order_csv_mapping_contract(csv_path, contract_path)
        markdown = order_csv_contract_validation_to_markdown(result)

        self.assertTrue(result.passed)
        self.assertEqual({check.status for check in result.checks}, {"ok"})
        self.assertIn("Passed: yes", markdown)
        self.assertIn("院内メモ", markdown)

        strict_contract_path = Path(self.tmp.name) / "strict_orders_contract.json"
        strict_contract_path.write_text(
            json.dumps(
                {
                    "column_map_preset": "japanese",
                    "required_target_fields": ["record_id", "patient_id", "service_date"],
                    "require_gold_labels": True,
                    "minimum_row_count": 2,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        strict_result = validate_order_csv_mapping_contract(csv_path, strict_contract_path)

        self.assertFalse(strict_result.passed)
        self.assertIn("minimum row count", [check.name for check in strict_result.checks])
        self.assertIn("unmapped columns", [check.name for check in strict_result.checks])

    def test_order_csv_contract_template_generation_from_profile(self) -> None:
        csv_path = Path(self.tmp.name) / "orders_contract_template.csv"
        output_path = Path(self.tmp.name) / "generated_contract.json"
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "レコードID",
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "明細種別",
                    "診療行為コード",
                    "正解点数",
                    "正解コード",
                    "院内メモ",
                ],
            )
            writer.writeheader()
            writer.writerow(
                {
                    "レコードID": "template-1",
                    "患者番号": "patient-1",
                    "診療日": "2026-06-03",
                    "地方厚生局": "tohoku",
                    "医療機関コード": "04,1000,1",
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "正解点数": "217",
                    "正解コード": "160000410,160000310",
                    "院内メモ": "allowed note",
                }
            )

        contract = build_order_csv_mapping_contract_template(
            csv_path,
            column_map_preset="japanese",
            contract_id="generated-template-v1",
            hospital_name="東北テスト病院",
            regional_bureau="tohoku",
            medical_institution_code="0410001",
        )

        self.assertEqual(contract.contract_id, "generated-template-v1")
        self.assertTrue(contract.require_gold_labels)
        self.assertEqual(contract.allowed_unmapped_columns, ("院内メモ",))
        self.assertEqual(
            contract.required_target_fields,
            (
                "record_id",
                "patient_id",
                "service_date",
                "regional_bureau",
                "medical_institution_code",
                "item_kind",
                "code",
                "expected_total_points",
                "expected_candidate_codes",
            ),
        )
        self.assertEqual(
            contract.required_source_columns,
            (
                "レコードID",
                "患者番号",
                "診療日",
                "地方厚生局",
                "医療機関コード",
                "明細種別",
                "診療行為コード",
                "正解点数",
                "正解コード",
            ),
        )

        cli_main(
            [
                "generate-order-csv-contract-template",
                "--csv",
                str(csv_path),
                "--column-map-preset",
                "japanese",
                "--contract-id",
                "generated-template-v1",
                "--hospital-name",
                "東北テスト病院",
                "--regional-bureau",
                "tohoku",
                "--medical-institution-code",
                "0410001",
                "--output",
                str(output_path),
            ]
        )
        generated = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(generated["contract_id"], "generated-template-v1")
        self.assertEqual(generated["allowed_unmapped_columns"], ["院内メモ"])
        self.assertEqual(generated["column_map_preset"], "japanese")

    def test_order_csv_claim_pipeline_runs_contract_batch_and_gold_outputs(self) -> None:
        csv_path = Path(self.tmp.name) / "orders_pipeline.csv"
        contract_path = Path(self.tmp.name) / "orders_pipeline_contract.json"
        template_path = Path(self.tmp.name) / "orders_pipeline_templates.jsonl"
        profile_output = Path(self.tmp.name) / "pipeline-profile.md"
        contract_output = Path(self.tmp.name) / "pipeline-contract.md"
        converted_output = Path(self.tmp.name) / "pipeline-converted.jsonl"
        conversion_output = Path(self.tmp.name) / "pipeline-conversion.md"
        batch_output = Path(self.tmp.name) / "pipeline-batch.md"
        audit_output = Path(self.tmp.name) / "pipeline-audit.csv"
        gold_output = Path(self.tmp.name) / "pipeline-gold.md"
        gold_classification_output = Path(self.tmp.name) / "pipeline-gold-classification.md"
        gold_backlog_output = Path(self.tmp.name) / "pipeline-gold-backlog.md"
        template_path.write_text(
            json.dumps(
                {
                    "claim_context_template": {
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    }
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "レコードID",
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "明細種別",
                    "診療行為コード",
                    "採取料入力",
                    "outpatient_rapid_lab_same_day_result_explained",
                    "outpatient_rapid_lab_written_information_provided",
                    "outpatient_rapid_lab_result_based_care_provided",
                    "正解点数",
                    "正解ステータス",
                    "正解コード",
                    "院内メモ",
                ],
            )
            writer.writeheader()
            base_row = {
                "レコードID": "pipeline-1",
                "患者番号": "patient-pipeline-1",
                "診療日": "2026-06-03",
                "地方厚生局": "tohoku",
                "医療機関コード": "04,1000,1",
                "outpatient_rapid_lab_same_day_result_explained": "true",
                "outpatient_rapid_lab_written_information_provided": "true",
                "outpatient_rapid_lab_result_based_care_provided": "true",
                "院内メモ": "allowed note",
            }
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "採取料入力": "blood_venous",
                    "正解点数": "217",
                    "正解ステータス": "ok",
                    "正解コード": "160000410,160000310,160061710,160182770,160095710,160177770",
                }
            )
            writer.writerow({**base_row, "明細種別": "診療行為", "診療行為コード": "160000310"})
        contract_path.write_text(
            json.dumps(
                {
                    "contract_id": "pipeline-contract-v1",
                    "column_map_preset": "japanese",
                    "required_target_fields": [
                        "record_id",
                        "patient_id",
                        "service_date",
                        "regional_bureau",
                        "medical_institution_code",
                        "item_kind",
                        "code",
                        "expected_total_points",
                        "expected_status",
                        "expected_candidate_codes",
                    ],
                    "allowed_unmapped_columns": ["院内メモ"],
                    "require_gold_labels": True,
                    "minimum_row_count": 1,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        cli_main(
            [
                "run-order-csv-claim-pipeline",
                "--db",
                str(self.db_path),
                "--csv",
                str(csv_path),
                "--contract",
                str(contract_path),
                "--template-jsonl",
                str(template_path),
                "--profile-output",
                str(profile_output),
                "--contract-output",
                str(contract_output),
                "--converted-output",
                str(converted_output),
                "--conversion-report-output",
                str(conversion_output),
                "--output",
                str(batch_output),
                "--audit-output",
                str(audit_output),
                "--gold-output",
                str(gold_output),
                "--gold-classification-output",
                str(gold_classification_output),
                "--gold-backlog-output",
                str(gold_backlog_output),
                "--fail-on-contract-error",
                "--fail-on-error",
                "--fail-on-mismatch",
            ]
        )

        self.assertIn("Gold label fields: present", profile_output.read_text(encoding="utf-8"))
        self.assertIn("Passed: yes", contract_output.read_text(encoding="utf-8"))
        self.assertIn('"record_id":"pipeline-1"', converted_output.read_text(encoding="utf-8"))
        self.assertIn("Warnings: 0", conversion_output.read_text(encoding="utf-8"))
        self.assertIn("Total records: 1", batch_output.read_text(encoding="utf-8"))
        self.assertIn("message_source", audit_output.read_text(encoding="utf-8"))
        self.assertIn("match", gold_output.read_text(encoding="utf-8"))
        self.assertIn("Gold Difference Classification", gold_classification_output.read_text(encoding="utf-8"))
        self.assertIn("| match | 1 |", gold_classification_output.read_text(encoding="utf-8"))
        self.assertIn("Gold Improvement Backlog", gold_backlog_output.read_text(encoding="utf-8"))
        self.assertIn("No improvement backlog items.", gold_backlog_output.read_text(encoding="utf-8"))

    def test_order_csv_claim_pipeline_batch_runs_manifest_entries(self) -> None:
        batch_root = Path(self.tmp.name) / "pipeline_batch"
        inputs_dir = batch_root / "inputs"
        contracts_dir = batch_root / "contracts"
        outputs_dir = batch_root / "outputs"
        inputs_dir.mkdir(parents=True)
        contracts_dir.mkdir(parents=True)
        csv_path = inputs_dir / "orders.csv"
        contract_path = contracts_dir / "hospital-order-contract.json"
        template_path = inputs_dir / "templates.jsonl"
        manifest_path = batch_root / "manifest.json"
        summary_output = outputs_dir / "summary.md"
        template_path.write_text(
            json.dumps(
                {
                    "claim_context_template": {
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    }
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "レコードID",
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "明細種別",
                    "診療行為コード",
                    "採取料入力",
                    "outpatient_rapid_lab_same_day_result_explained",
                    "outpatient_rapid_lab_written_information_provided",
                    "outpatient_rapid_lab_result_based_care_provided",
                    "正解点数",
                    "正解ステータス",
                    "正解コード",
                    "院内メモ",
                ],
            )
            writer.writeheader()
            base_row = {
                "レコードID": "batch-1",
                "患者番号": "patient-batch-1",
                "診療日": "2026-06-03",
                "地方厚生局": "tohoku",
                "医療機関コード": "04,1000,1",
                "outpatient_rapid_lab_same_day_result_explained": "true",
                "outpatient_rapid_lab_written_information_provided": "true",
                "outpatient_rapid_lab_result_based_care_provided": "true",
                "院内メモ": "allowed note",
            }
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "採取料入力": "blood_venous",
                    "正解点数": "217",
                    "正解ステータス": "ok",
                    "正解コード": "160000410,160000310,160061710,160182770,160095710,160177770",
                }
            )
            writer.writerow({**base_row, "明細種別": "診療行為", "診療行為コード": "160000310"})
        contract_path.write_text(
            json.dumps(
                {
                    "contract_id": "batch-contract-v1",
                    "column_map_preset": "japanese",
                    "required_target_fields": [
                        "record_id",
                        "patient_id",
                        "service_date",
                        "regional_bureau",
                        "medical_institution_code",
                        "item_kind",
                        "code",
                        "expected_total_points",
                        "expected_status",
                        "expected_candidate_codes",
                    ],
                    "allowed_unmapped_columns": ["院内メモ"],
                    "require_gold_labels": True,
                    "minimum_row_count": 1,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "id": "hospital-a",
                            "csv": "inputs/orders.csv",
                            "contract": "contracts/hospital-order-contract.json",
                            "template_jsonl": "inputs/templates.jsonl",
                            "evaluate_gold": True,
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        manifest_validation_output = outputs_dir / "manifest-validation.md"
        cli_main(
            [
                "validate-order-csv-pipeline-manifest",
                "--manifest",
                str(manifest_path),
                "--output",
                str(manifest_validation_output),
                "--fail-on-error",
            ]
        )
        manifest_validation = manifest_validation_output.read_text(encoding="utf-8")

        self.assertIn("# Order CSV Pipeline Manifest Validation", manifest_validation)
        self.assertIn("Ready: yes", manifest_validation)
        self.assertIn("| hospital-a | ok | yes | yes | yes | yes | yes | 2 | yes |  |", manifest_validation)

        cli_main(
            [
                "run-order-csv-claim-pipeline-batch",
                "--db",
                str(self.db_path),
                "--manifest",
                str(manifest_path),
                "--output-root",
                str(outputs_dir),
                "--output",
                str(summary_output),
                "--fail-on-contract-error",
                "--fail-on-error",
                "--fail-on-mismatch",
                "--fail-on-batch-error",
            ]
        )

        entry_dir = outputs_dir / "hospital-a"
        summary = summary_output.read_text(encoding="utf-8")

        self.assertIn("Entries: 1", summary)
        self.assertIn("Gold mismatches: 0", summary)
        self.assertIn("Gold classification actions: 0", summary)
        self.assertIn("| hospital-a | ok |  | pass | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |  |  |", summary)
        self.assertIn("## Gold Classification Counts", summary)
        self.assertIn("| match | 1 |", summary)
        self.assertIn("Passed: yes", (entry_dir / "contract-validation.md").read_text(encoding="utf-8"))
        self.assertIn("Total records: 1", (entry_dir / "claim-results.md").read_text(encoding="utf-8"))
        self.assertIn("match", (entry_dir / "gold-evaluation.md").read_text(encoding="utf-8"))
        self.assertIn(
            "Gold Difference Classification",
            (entry_dir / "gold-classification.md").read_text(encoding="utf-8"),
        )
        self.assertIn(
            "Gold Improvement Backlog",
            (entry_dir / "gold-backlog.md").read_text(encoding="utf-8"),
        )
        self.assertTrue((entry_dir / "converted.jsonl").exists())

        csv_summary_output = outputs_dir / "summary.csv"
        cli_main(
            [
                "run-order-csv-claim-pipeline-batch",
                "--db",
                str(self.db_path),
                "--manifest",
                str(manifest_path),
                "--output-root",
                str(outputs_dir / "csv-run"),
                "--summary-format",
                "csv",
                "--output",
                str(csv_summary_output),
                "--fail-on-contract-error",
                "--fail-on-error",
                "--fail-on-mismatch",
                "--fail-on-batch-error",
            ]
        )
        csv_summary = csv_summary_output.read_text(encoding="utf-8")

        self.assertIn(
            "entry_id,status,attention_reasons,contract_status,conversion_warning_count",
            csv_summary,
        )
        self.assertIn("gold_classification_action_count", csv_summary)
        self.assertIn("hospital-a,ok,,pass,0,1,0,0,1,0,0,0,", csv_summary)

        strict_contract_path = contracts_dir / "strict-hospital-order-contract.json"
        strict_contract_path.write_text(
            json.dumps(
                {
                    "contract_id": "strict-batch-contract-v1",
                    "column_map_preset": "japanese",
                    "required_target_fields": ["record_id", "missing_target_field"],
                    "require_gold_labels": True,
                    "minimum_row_count": 1,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        review_manifest_path = batch_root / "review_manifest.json"
        review_manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "id": "hospital-needs-review",
                            "csv": "inputs/orders.csv",
                            "contract": "contracts/strict-hospital-order-contract.json",
                            "template_jsonl": "inputs/templates.jsonl",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        review_index_output = outputs_dir / "review-index.md"
        cli_main(
            [
                "run-order-csv-claim-pipeline-batch",
                "--db",
                str(self.db_path),
                "--manifest",
                str(review_manifest_path),
                "--output-root",
                str(outputs_dir / "review-run"),
                "--output",
                str(outputs_dir / "review-summary.md"),
                "--review-index-output",
                str(review_index_output),
            ]
        )
        review_index = review_index_output.read_text(encoding="utf-8")

        self.assertIn("Entries needing review: 1", review_index)
        self.assertIn("## contract_failed", review_index)
        self.assertIn("hospital-needs-review", review_index)
        self.assertIn("contract-validation.md", review_index)

        backlog_csv_path = inputs_dir / "orders_missing_comments.csv"
        with backlog_csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "レコードID",
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "明細種別",
                    "診療行為コード",
                    "採取料入力",
                    "outpatient_rapid_lab_same_day_result_explained",
                    "outpatient_rapid_lab_written_information_provided",
                    "outpatient_rapid_lab_result_based_care_provided",
                    "正解点数",
                    "正解ステータス",
                    "正解コード",
                    "院内メモ",
                ],
            )
            writer.writeheader()
            backlog_base_row = {
                "レコードID": "batch-missing-comments-1",
                "患者番号": "patient-batch-missing-comments-1",
                "診療日": "2026-06-03",
                "地方厚生局": "tohoku",
                "医療機関コード": "04,1000,1",
                "outpatient_rapid_lab_same_day_result_explained": "true",
                "outpatient_rapid_lab_written_information_provided": "true",
                "outpatient_rapid_lab_result_based_care_provided": "true",
                "院内メモ": "allowed note",
            }
            writer.writerow(
                {
                    **backlog_base_row,
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "採取料入力": "blood_venous",
                    "正解点数": "999",
                    "正解ステータス": "ok",
                    "正解コード": "999999999",
                }
            )
            writer.writerow(
                {**backlog_base_row, "明細種別": "診療行為", "診療行為コード": "160000310"}
            )
            writer.writerow({**backlog_base_row, "明細種別": "施設基準", "診療行為コード": "検Ⅱ"})
        backlog_manifest_path = batch_root / "backlog_manifest.json"
        backlog_manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "id": "hospital-missing-comments",
                            "csv": "inputs/orders_missing_comments.csv",
                            "contract": "contracts/hospital-order-contract.json",
                            "template_jsonl": "inputs/templates.jsonl",
                            "evaluate_gold": True,
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        backlog_summary_output = outputs_dir / "backlog-summary.md"
        backlog_review_index_output = outputs_dir / "backlog-review-index.md"
        cli_main(
            [
                "run-order-csv-claim-pipeline-batch",
                "--db",
                str(self.db_path),
                "--manifest",
                str(backlog_manifest_path),
                "--output-root",
                str(outputs_dir / "backlog-run"),
                "--output",
                str(backlog_summary_output),
                "--review-index-output",
                str(backlog_review_index_output),
            ]
        )
        backlog_summary = backlog_summary_output.read_text(encoding="utf-8")
        backlog_entry_dir = outputs_dir / "backlog-run" / "hospital-missing-comments"
        backlog_report = (backlog_entry_dir / "gold-backlog.md").read_text(encoding="utf-8")
        backlog_review_index = backlog_review_index_output.read_text(encoding="utf-8")

        self.assertIn("Needs attention: 1", backlog_summary)
        self.assertIn("| under_claim_missing_code | 1 |", backlog_summary)
        self.assertIn("| calculation_logic_or_mapping | 1 |", backlog_summary)
        self.assertIn("under_claim_missing_code", backlog_report)
        self.assertIn("add or map the missing expected fee code candidates", backlog_report)
        self.assertIn("gold-backlog.md", backlog_review_index)

    def test_order_csv_adapter_maps_gold_expected_columns(self) -> None:
        csv_path = Path(self.tmp.name) / "orders_with_gold.csv"
        template_path = Path(self.tmp.name) / "templates_for_gold_orders.jsonl"
        gold_jsonl_path = Path(self.tmp.name) / "converted_gold_orders.jsonl"
        template_path.write_text(
            json.dumps(
                {
                    "claim_context_template": {
                        "encounter": {
                            "service_date": "2026-06-03",
                            "regional_bureau": "tohoku",
                            "medical_institution_code": "04,1000,1",
                            "is_outpatient": True,
                        },
                        "procedure_codes": [],
                        "facility_standard_keys": ["検Ⅱ"],
                    }
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "レコードID",
                    "患者番号",
                    "診療日",
                    "地方厚生局",
                    "医療機関コード",
                    "明細種別",
                    "診療行為コード",
                    "採取料入力",
                    "outpatient_rapid_lab_same_day_result_explained",
                    "outpatient_rapid_lab_written_information_provided",
                    "outpatient_rapid_lab_result_based_care_provided",
                    "正解点数",
                    "正解ステータス",
                    "正解コード",
                ],
            )
            writer.writeheader()
            base_row = {
                "レコードID": "gold-csv-1",
                "患者番号": "patient-gold-1",
                "診療日": "2026-06-03",
                "地方厚生局": "tohoku",
                "医療機関コード": "04,1000,1",
                "outpatient_rapid_lab_same_day_result_explained": "true",
                "outpatient_rapid_lab_written_information_provided": "true",
                "outpatient_rapid_lab_result_based_care_provided": "true",
            }
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "診療行為",
                    "診療行為コード": "160000410",
                    "採取料入力": "blood_venous",
                    "正解点数": "217",
                    "正解ステータス": "ok",
                    "正解コード": "160000410,160000310,160061710",
                }
            )
            writer.writerow({**base_row, "明細種別": "診療行為", "診療行為コード": "160000310"})
            writer.writerow(
                {
                    **base_row,
                    "明細種別": "正解",
                    "正解コード": "160182770,160095710",
                }
            )
            writer.writerow({**base_row, "明細種別": "正解", "診療行為コード": "160177770"})

        conversion = convert_order_csv_to_claim_payloads(
            csv_path,
            template_jsonl_path=template_path,
            column_map_preset="japanese",
        )
        payload = conversion.payloads[0]
        gold_jsonl_path.write_text(order_csv_payloads_to_jsonl(conversion.payloads), encoding="utf-8")
        results = run_gold_outpatient_lab_claim_evaluation(self.conn, gold_jsonl_path)

        self.assertEqual(conversion.warnings, ())
        self.assertEqual(payload["expected"]["total_points"], "217")
        self.assertEqual(payload["expected"]["status"], "ok")
        self.assertEqual(
            payload["expected"]["candidate_codes"],
            [
                "160000410",
                "160000310",
                "160061710",
                "160182770",
                "160095710",
                "160177770",
            ],
        )
        self.assertEqual(results[0].overall_verdict, "match")

    def test_standard_master_build_imports_manifest_entries(self) -> None:
        manifest_path = Path(self.tmp.name) / "standard_build_manifest.json"
        db_path = Path(self.tmp.name) / "standard_build.sqlite"
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "medical_procedure_master",
                            "path": str(self.csv_path),
                            "source_version": "build-procedure",
                            "published_at": "2026-06-01",
                        },
                        {
                            "kind": "drug_master",
                            "path": str(self.drug_csv_path),
                            "source_version": "build-drug",
                            "published_at": "2026-06-01",
                        },
                        {
                            "kind": "specific_material_master",
                            "path": str(self.material_csv_path),
                            "source_version": "build-material",
                            "published_at": "2026-06-01",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        build_conn = connect(db_path)
        initialize_schema(build_conn)
        self.addCleanup(build_conn.close)

        results = build_standard_master_db(build_conn, manifest_path)
        report = standard_build_results_to_markdown(results)
        source_types = {
            row["source_type"]
            for row in build_conn.execute("SELECT source_type FROM master_sources").fetchall()
        }

        self.assertEqual([result.status for result in results], ["ok", "ok", "ok"])
        self.assertEqual(
            source_types,
            {"medical_procedure_master", "drug_master", "specific_material_master"},
        )
        self.assertIn("| ok | 3 |", report)

    def test_prepare_standard_build_manifest_extracts_zips_and_finds_sources(self) -> None:
        raw_root = Path(self.tmp.name) / "raw" / "ssk"
        procedure_zip = raw_root / "medical_procedure_master" / "2026-06-01" / "s_ALL20260601.zip"
        drug_zip = raw_root / "drug_master" / "2026-06-01" / "y_r07_ALL20260601.zip"
        material_dir = raw_root / "specific_material_master" / "2026-06-01"
        electronic_dir = raw_root / "electronic_fee_table" / "2026-06-01"
        regional_manifest = Path(self.tmp.name) / "regional_manifest.json"
        procedure_zip.parent.mkdir(parents=True)
        drug_zip.parent.mkdir(parents=True)
        material_dir.mkdir(parents=True)
        electronic_dir.mkdir(parents=True)
        with zipfile.ZipFile(procedure_zip, "w") as archive:
            archive.write(self.csv_path, arcname="s_ALL20260601.csv")
        with zipfile.ZipFile(drug_zip, "w") as archive:
            archive.write(self.drug_csv_path, arcname="y_r07_ALL20260601.csv")
        (material_dir / "t_ALL20260601.csv").write_bytes(self.material_csv_path.read_bytes())
        for filename in (
            "01補助マスターテーブル.csv",
            "02包括テーブル.csv",
            "03-1背反テーブル1.csv",
            "05算定回数テーブル.csv",
        ):
            (electronic_dir / filename).write_text("", encoding="cp932")
        regional_manifest.write_text('{"entries":[]}', encoding="utf-8")

        preparation = prepare_standard_build_manifest(
            raw_root,
            source_version="2026-06-01",
            published_at="2026-06-01",
            regional_manifest=regional_manifest,
        )
        report = standard_build_manifest_preparation_to_markdown(preparation)
        entries = preparation.manifest["entries"]
        kinds = [entry["kind"] for entry in entries]
        electronic = next(entry for entry in entries if entry["kind"] == "medical_electronic_fee_table")

        self.assertIn("medical_procedure_master", kinds)
        self.assertIn("drug_master", kinds)
        self.assertIn("specific_material_master", kinds)
        self.assertIn("medical_electronic_fee_table", kinds)
        self.assertIn("regional_manifest", kinds)
        self.assertTrue(any(path.endswith("s_ALL20260601.csv") for path in preparation.extracted_files))
        self.assertEqual(electronic["csv_paths"]["aux_master"], str(electronic_dir / "01補助マスターテーブル.csv"))
        self.assertIn("comment_master", preparation.missing_kinds)
        self.assertIn("Manifest entries: 5", report)

    def test_validate_standard_build_manifest_reports_missing_inputs(self) -> None:
        manifest_path = Path(self.tmp.name) / "standard_build_manifest_validation.json"
        output_path = Path(self.tmp.name) / "standard_build_manifest_validation.md"
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "medical_procedure_master",
                            "path": str(self.csv_path),
                            "source_version": "2026-06-01",
                        },
                        {
                            "kind": "drug_master",
                            "path": str(Path(self.tmp.name) / "missing_drug.csv"),
                            "source_version": "2026-06-01",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        result = validate_standard_build_manifest(manifest_path)
        report = standard_build_manifest_validation_to_markdown(result)
        cli_main(
            [
                "validate-standard-master-build-manifest",
                "--manifest",
                str(manifest_path),
                "--output",
                str(output_path),
            ]
        )
        cli_report = output_path.read_text(encoding="utf-8")

        self.assertFalse(result.ready)
        self.assertIn("comment_master", result.missing_kinds)
        self.assertIn("medical_electronic_fee_table", result.missing_kinds)
        self.assertIn("| error | 2 | drug_master |", report)
        self.assertIn("path not found", cli_report)
        self.assertIn("Ready: no", cli_report)

    def test_validate_standard_build_manifest_accepts_complete_manifest(self) -> None:
        manifest_path = Path(self.tmp.name) / "standard_build_manifest_complete.json"
        output_path = Path(self.tmp.name) / "standard_build_manifest_complete.json.out"
        regional_manifest = Path(self.tmp.name) / "regional_manifest_complete.json"
        comment_path = Path(self.tmp.name) / "comment_master.csv"
        comment_link_path = Path(self.tmp.name) / "comment_links.csv"
        electronic_path = Path(self.tmp.name) / "electronic_aux.csv"
        regional_manifest.write_text('{"entries":[]}', encoding="utf-8")
        comment_path.write_text("", encoding="utf-8")
        comment_link_path.write_text("", encoding="utf-8")
        electronic_path.write_text("", encoding="utf-8")
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "medical_procedure_master",
                            "path": str(self.csv_path),
                            "source_version": "2026-06-01",
                        },
                        {
                            "kind": "drug_master",
                            "path": str(self.drug_csv_path),
                            "source_version": "2026-06-01",
                        },
                        {
                            "kind": "specific_material_master",
                            "path": str(self.material_csv_path),
                            "source_version": "2026-06-01",
                        },
                        {
                            "kind": "comment_master",
                            "path": str(comment_path),
                            "source_version": "2026-06-01",
                        },
                        {
                            "kind": "comment_related_table",
                            "path": str(comment_link_path),
                            "source_version": "2026-06-01",
                        },
                        {
                            "kind": "medical_electronic_fee_table",
                            "source_version": "2026-06-01",
                            "csv_paths": {"aux_master": str(electronic_path)},
                        },
                        {
                            "kind": "regional_manifest",
                            "path": str(regional_manifest),
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        result = validate_standard_build_manifest(manifest_path)

        self.assertTrue(result.ready)
        self.assertEqual(result.error_count, 0)
        cli_main(
            [
                "validate-standard-master-build-manifest",
                "--manifest",
                str(manifest_path),
                "--format",
                "json",
                "--output",
                str(output_path),
                "--fail-on-error",
            ]
        )
        self.assertTrue(json.loads(output_path.read_text(encoding="utf-8"))["ready"])

    def test_calculate_lab_claim_for_context_resolves_profile_with_regional_bureau(self) -> None:
        tohoku_registry_xlsx = Path(self.tmp.name) / "claim_tohoku_registry.xlsx"
        tokai_registry_xlsx = Path(self.tmp.name) / "claim_tokai_registry.xlsx"
        tohoku_facility_xlsx = Path(self.tmp.name) / "claim_tohoku_facility.xlsx"
        write_minimal_xlsx(
            tohoku_registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "東北同一コード病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        write_minimal_xlsx(
            tokai_registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "東海同一コード診療所",
                    "〒460－0000名古屋市中区サンプル１",
                    "052-000-0000",
                    "医療法人 サンプル会",
                    "中部 太郎",
                    "平30. 4. 1",
                    "内科",
                    "診療所",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        write_minimal_xlsx(
            tohoku_facility_xlsx,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0410001",
                    "",
                    "",
                    "東北同一コード病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        import_regional_hospital_registry(
            self.conn,
            tohoku_registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01-tohoku",
        )
        import_regional_hospital_registry(
            self.conn,
            tokai_registry_xlsx,
            regional_bureau="tokai_hokuriku",
            source_version="2026-05-01-tokai",
        )
        import_regional_facility_standards(
            self.conn,
            tohoku_facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01-tohoku",
        )
        claim_context = ClaimContext(
            patient=PatientContext(patient_id="patient-duplicate-code"),
            encounter=EncounterContext(
                service_date=date(2026, 6, 3),
                medical_institution_code="04,1000,1",
                regional_bureau="tohoku",
                is_outpatient=True,
            ),
            procedure_codes=("160000410",),
            master_sources=MasterSourceContext(medical_procedure_source_id=self.source_id),
        )

        result = calculate_lab_claim_for_context(self.conn, claim_context)

        self.assertEqual(
            [item.code for item in result.claim_items],
            ["160061710", "160182770"],
        )
        self.assertEqual(result.warnings, ())

    def test_resolve_medical_procedure_lines_warns_missing_code(self) -> None:
        result = resolve_medical_procedure_lines(
            self.conn,
            ("160000410", "999999999"),
            date(2026, 6, 3),
            self.source_id,
        )

        self.assertEqual([line.code for line in result.lines], ["160000410"])
        self.assertEqual(result.lines[0].status, ClaimItemStatus.NEEDS_REVIEW)
        self.assertEqual(result.lines[0].coverage_scope, "master_lookup_only")
        self.assertEqual(result.lines[0].support_level, "review_required")
        self.assertTrue(result.lines[0].review_required)
        self.assertEqual(len(result.messages), 1)
        self.assertEqual(result.messages[0].status, ClaimItemStatus.NEEDS_REVIEW)
        self.assertEqual(result.messages[0].code, "999999999")

    def test_resolve_drug_and_specific_material_lines(self) -> None:
        drug = resolve_drug_lines(
            self.conn,
            (
                ChargeInput(code="620000001", quantity=1.5),
                ChargeInput(code="620000001", quantity=0.5),
                ChargeInput(code="620000002", quantity=1),
                ChargeInput(code="620000003", quantity=1),
            ),
            date(2026, 6, 3),
            self.drug_source_id,
        )
        material = resolve_specific_material_lines(
            self.conn,
            (
                ChargeInput(code="710000001", quantity=2),
                ChargeInput(code="710000002", quantity=1),
            ),
            date(2026, 6, 3),
            self.material_source_id,
        )

        self.assertEqual(len(drug.lines), 3)
        self.assertEqual(drug.lines[0].quantity, 2.0)
        self.assertEqual(drug.lines[0].points, 10.0)
        self.assertEqual(drug.lines[0].total_points, 20.0)
        self.assertEqual(drug.lines[1].total_points, 0.0)
        self.assertEqual(drug.lines[2].total_points, 3.0)
        self.assertEqual(material.lines[0].points, 150.0)
        self.assertEqual(material.lines[0].total_points, 300.0)
        self.assertEqual(material.lines[1].points, 1.5)
        self.assertEqual(material.lines[1].total_points, 2.0)


class CommentAndElectronicFeeImporterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "test.sqlite"
        self.conn = connect(self.db_path)
        initialize_schema(self.conn)

    def tearDown(self) -> None:
        self.conn.close()

    def write_csv(self, name: str, rows: list[list[str]]) -> Path:
        path = Path(self.tmp.name) / name
        with path.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(rows)
        return path

    def test_import_comment_master_and_links(self) -> None:
        comment_csv = self.write_csv(
            "comments.csv",
            [
                fixed_row(
                    30,
                    {
                        0: "0",
                        1: "C",
                        2: "8",
                        3: "30",
                        4: "100111",
                        6: "検体検査名（外来迅速検体検査加算）；",
                        8: "ｹﾝﾀｲｹﾝｻﾒｲ",
                        20: "20200401",
                        21: "99999999",
                        22: "830100111",
                    },
                )
            ],
        )
        link_csv = self.write_csv(
            "comment_links.csv",
            [
                fixed_row(
                    30,
                    {
                        0: "3",
                        1: "1",
                        2: "0248",
                        3: "D",
                        4: "01",
                        5: "160177770",
                        7: "外来迅速検体検査加算",
                        8: "830100111",
                        10: "検体検査名（外来迅速検体検査加算）；",
                        11: "20260601",
                        12: "99999999",
                        13: "00",
                    },
                )
            ],
        )

        comment_result = import_comment_master(
            self.conn,
            comment_csv,
            source_version="test-comments",
            published_at="2026-05-07",
        )
        link_result = import_comment_links(
            self.conn,
            link_csv,
            source_version="test-comment-links",
            published_at="2026-05-15",
        )

        comment = self.conn.execute(
            "SELECT comment_text FROM comments WHERE source_id = ? AND code = ?",
            (comment_result.source_id, "830100111"),
        ).fetchone()
        link = self.conn.execute(
            """
            SELECT procedure_code, comment_code, effective_from
            FROM comment_links
            WHERE source_id = ?
            """,
            (link_result.source_id,),
        ).fetchone()

        self.assertEqual(comment["comment_text"], "検体検査名（外来迅速検体検査加算）；")
        self.assertEqual(link["procedure_code"], "160177770")
        self.assertEqual(link["comment_code"], "830100111")
        self.assertEqual(link["effective_from"], "2026-06-01")

    def test_import_electronic_fee_table(self) -> None:
        aux_csv = self.write_csv(
            "aux.csv",
            [
                fixed_row(
                    27,
                    {
                        1: "160177770",
                        2: "外来迅速検体検査加算",
                        4: "A100001",
                        25: "20100401",
                        26: "99999999",
                    },
                )
            ],
        )
        bundle_csv = self.write_csv(
            "bundle.csv",
            [
                ["0", "A100001", "160177770", "外来迅速検体検査加算", "0", "20100401", "99999999"]
            ],
        )
        exclusion_csv = self.write_csv(
            "exclusion.csv",
            [
                [
                    "0",
                    "111000110",
                    "初診料",
                    "113008610",
                    "退院時共同指導料１",
                    "2",
                    "0",
                    "0",
                    "20100401",
                    "99999999",
                ]
            ],
        )
        frequency_csv = self.write_csv(
            "frequency.csv",
            [
                fixed_row(
                    14,
                    {
                        1: "111000110",
                        2: "初診料",
                        3: "159",
                        4: "初診時",
                        12: "20180401",
                        13: "99999999",
                    },
                )
            ],
        )

        result = import_electronic_fee_table(
            self.conn,
            {
                "aux_master": aux_csv,
                "bundles": bundle_csv,
                "exclusions_day": exclusion_csv,
                "frequency_limits": frequency_csv,
            },
            source_version="test-electronic-fee",
            published_at="2026-05-01",
        )

        counts = {
            table: self.conn.execute(
                f"SELECT count(*) AS count FROM {table} WHERE source_id = ?",
                (result.source_id,),
            ).fetchone()["count"]
            for table in (
                "electronic_aux_master",
                "electronic_bundles",
                "electronic_exclusions",
                "electronic_frequency_limits",
            )
        }

        self.assertEqual(result.row_count, 4)
        self.assertEqual(
            counts,
            {
                "electronic_aux_master": 1,
                "electronic_bundles": 1,
                "electronic_exclusions": 1,
                "electronic_frequency_limits": 1,
            },
        )


class ElectronicRuleCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "test.sqlite"
        self.conn = connect(self.db_path)
        initialize_schema(self.conn)

        self.aux_csv = self.write_csv(
            "aux.csv",
            [
                fixed_row(
                    27,
                    {
                        1: "900000001",
                        2: "包括元",
                        4: "G000001",
                        25: "20260601",
                        26: "99999999",
                    },
                ),
                fixed_row(
                    27,
                    {
                        1: "900000005",
                        2: "回数制限あり",
                        4: "0",
                        25: "20260601",
                        26: "99999999",
                    },
                ),
            ],
        )
        self.bundle_csv = self.write_csv(
            "bundle.csv",
            [
                ["0", "G000001", "900000002", "包括対象", "0", "20260601", "99999999"],
            ],
        )
        self.exclusion_day_csv = self.write_csv(
            "exclusion_day.csv",
            [
                [
                    "0",
                    "900000003",
                    "背反元",
                    "900000004",
                    "背反対象",
                    "2",
                    "0",
                    "0",
                    "20260601",
                    "99999999",
                ]
            ],
        )
        self.frequency_csv = self.write_csv(
            "frequency.csv",
            [
                fixed_row(
                    14,
                    {
                        1: "900000005",
                        2: "回数制限あり",
                        3: "121",
                        4: "日",
                        12: "20260601",
                        13: "99999999",
                    },
                ),
                fixed_row(
                    14,
                    {
                        1: "900000006",
                        2: "３月制限あり",
                        3: "144",
                        4: "３月",
                        12: "20260601",
                        13: "99999999",
                    },
                ),
            ],
        )
        electronic_result = import_electronic_fee_table(
            self.conn,
            {
                "aux_master": self.aux_csv,
                "bundles": self.bundle_csv,
                "exclusions_day": self.exclusion_day_csv,
                "frequency_limits": self.frequency_csv,
            },
            source_version="test-electronic-rules",
            published_at="2026-06-01",
        )
        self.electronic_source_id = electronic_result.source_id

        comment_links_csv = self.write_csv(
            "comment_links.csv",
            [
                fixed_row(
                    30,
                    {
                        3: "D",
                        5: "900000001",
                        7: "包括元",
                        8: "830000001",
                        10: "コメント必須；",
                        11: "20260601",
                        12: "99999999",
                        13: "00",
                    },
                )
            ],
        )
        comment_result = import_comment_links(
            self.conn,
            comment_links_csv,
            source_version="test-comment-rules",
            published_at="2026-06-01",
        )
        self.comment_source_id = comment_result.source_id

    def tearDown(self) -> None:
        self.conn.close()

    def write_csv(self, name: str, rows: list[list[str]]) -> Path:
        path = Path(self.tmp.name) / name
        with path.open("w", encoding="cp932", newline="") as f:
            csv.writer(f).writerows(rows)
        return path

    def test_check_electronic_rules_detects_advisory_hits(self) -> None:
        result = check_electronic_rules(
            self.conn,
            ["900000001", "900000002", "900000004", "900000005", "900000006"],
            ElectronicRuleContext(
                service_date=date(2026, 6, 3),
                source_id=self.electronic_source_id,
                comment_source_id=self.comment_source_id,
                same_day_history_codes=frozenset({"900000003", "900000005"}),
                procedure_history_events=(
                    ProcedureHistoryEvent(
                        procedure_code="900000006",
                        service_date=date(2026, 4, 10),
                    ),
                ),
            ),
        )

        self.assertEqual(len(result.bundles), 1)
        self.assertEqual(result.bundles[0].base_code, "900000001")
        self.assertEqual(result.bundles[0].bundled_code, "900000002")

        self.assertEqual(len(result.exclusions), 1)
        self.assertEqual(result.exclusions[0].scope, "same_day")
        self.assertEqual(result.exclusions[0].matched_from, "base_in_same_day_history")

        self.assertEqual(len(result.frequency_limits), 2)
        self.assertEqual(
            {limit.procedure_code for limit in result.frequency_limits},
            {"900000005", "900000006"},
        )
        self.assertEqual(len(result.frequency_limit_breaches), 2)
        self.assertEqual(
            {breach.procedure_code for breach in result.frequency_limit_breaches},
            {"900000005", "900000006"},
        )
        dated_breach = next(
            breach for breach in result.frequency_limit_breaches if breach.procedure_code == "900000006"
        )
        self.assertEqual(dated_breach.scope, "within_3_months")
        self.assertEqual(dated_breach.matched_service_date, date(2026, 4, 10))

        self.assertEqual(len(result.required_comments), 1)
        self.assertEqual(result.required_comments[0].comment_code, "830000001")


class HokkaidoHospitalImporterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = Path(self.tmp.name) / "test.sqlite"
        self.conn = connect(self.db_path)
        initialize_schema(self.conn)

    def tearDown(self) -> None:
        self.conn.close()

    def test_import_hokkaido_facility_standards(self) -> None:
        xlsx_path = Path(self.tmp.name) / "facility.xlsx"
        write_minimal_xlsx(
            xlsx_path,
            [
                ["[令和８年５月１日 現在 ]"],
                [""],
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "01",
                    "北海道",
                    "医科",
                    "0112489",
                    "",
                    "",
                    "医療法人 愛全病院",
                    "005-0813",
                    "札幌市南区川沿１３条２丁目１番３８号",
                    "011-571-5670",
                    "",
                    "療養 206／一般 231",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第100号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )

        result = import_hokkaido_facility_standards(
            self.conn,
            xlsx_path,
            source_version="2026-05-01",
            published_at="2026-05-11",
        )
        row = self.conn.execute(
            """
            SELECT medical_institution_code, standard_abbreviation, start_date
            FROM hospital_facility_standards
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["medical_institution_code"], "0112489")
        self.assertEqual(row["standard_abbreviation"], "検Ⅱ")
        self.assertEqual(row["start_date"], "2024-06-01")

    def test_import_regional_facility_standards_uses_requested_bureau(self) -> None:
        xlsx_path = Path(self.tmp.name) / "regional_facility.xlsx"
        write_minimal_xlsx(
            xlsx_path,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0412345",
                    "",
                    "",
                    "東北サンプル病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )

        result = import_regional_facility_standards(
            self.conn,
            xlsx_path,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        row = self.conn.execute(
            """
            SELECT regional_bureau, medical_institution_code, standard_abbreviation
            FROM hospital_facility_standards
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()
        source = self.conn.execute(
            """
            SELECT source_type
            FROM master_sources
            WHERE id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["regional_bureau"], "tohoku")
        self.assertEqual(row["medical_institution_code"], "0412345")
        self.assertEqual(row["standard_abbreviation"], "検Ⅱ")
        self.assertEqual(source["source_type"], "tohoku_facility_standards_medical")

    def test_import_regional_facility_standards_reads_zip_of_workbooks(self) -> None:
        header = [
            "項番",
            "都道府県コード",
            "都道府県名",
            "区分",
            "医療機関番号",
            "併設医療機関番号",
            "医療機関記号番号",
            "医療機関名称",
            "医療機関所在地（郵便番号）",
            "医療機関所在地（住所）",
            "電話番号",
            "FAX番号",
            "病床数",
            "受理届出名称",
            "受理記号",
            "受理番号",
            "算定開始年月日",
            "個別有効開始年月日",
            "備考（見出し）",
            "備考（データ）",
            "市町村コード",
            "市町村名",
            "種別コード",
            "種別",
        ]
        miyagi_xlsx = Path(self.tmp.name) / "miyagi_facility.xlsx"
        fukushima_xlsx = Path(self.tmp.name) / "fukushima_facility.xlsx"
        write_minimal_xlsx(
            miyagi_xlsx,
            [
                header,
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0412345",
                    "",
                    "",
                    "宮城サンプル病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        write_minimal_xlsx(
            fukushima_xlsx,
            [
                header,
                [
                    "1",
                    "07",
                    "福島県",
                    "医科",
                    "0712345",
                    "",
                    "",
                    "福島サンプル病院",
                    "960-0000",
                    "福島市サンプル１",
                    "024-000-0000",
                    "",
                    "一般 120",
                    "検体検査管理加算（１）",
                    "検Ⅰ",
                    "第201号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        zip_path = Path(self.tmp.name) / "tohoku_facility.zip"
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.write(miyagi_xlsx, "miyagi/facility.xlsx")
            archive.write(fukushima_xlsx, "fukushima/facility.xlsx")

        result = import_regional_facility_standards(
            self.conn,
            zip_path,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        rows = self.conn.execute(
            """
            SELECT medical_institution_code, standard_abbreviation
            FROM hospital_facility_standards
            WHERE source_id = ?
            ORDER BY medical_institution_code
            """,
            (result.source_id,),
        ).fetchall()
        source = self.conn.execute(
            """
            SELECT encoding
            FROM master_sources
            WHERE id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 2)
        self.assertEqual([row["medical_institution_code"] for row in rows], ["0412345", "0712345"])
        self.assertEqual([row["standard_abbreviation"] for row in rows], ["検Ⅱ", "検Ⅰ"])
        self.assertEqual(source["encoding"], "zip+xlsx")

    def test_import_regional_facility_standards_accepts_compact_inpatient_layout(self) -> None:
        xlsx_path = Path(self.tmp.name) / "compact_facility.xlsx"
        write_minimal_xlsx(
            xlsx_path,
            [
                ["[令和 8年 5月 1日 現在 医科]"],
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "受理届出名称",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                ],
                [
                    "1",
                    "27",
                    "大阪府",
                    "一般病棟入院基本料",
                    "5015158",
                    "",
                    "",
                    "医療法人徳洲会 恵生会病院",
                    "579-8036",
                    "東大阪市鷹殿町２０番２９号",
                    "072-000-0000",
                    "",
                    "一般 96",
                    "一般入院",
                    "第1号",
                    "令和 6年10月 1日",
                    "",
                    "区分:",
                    "急性期一般入院料１",
                ],
            ],
        )

        result = import_regional_facility_standards(
            self.conn,
            xlsx_path,
            regional_bureau="kinki",
            source_version="2026-05-01",
        )
        row = self.conn.execute(
            """
            SELECT category, medical_institution_code, standard_name, standard_abbreviation, remarks_heading
            FROM hospital_facility_standards
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["category"], "医科")
        self.assertEqual(row["medical_institution_code"], "5015158")
        self.assertEqual(row["standard_name"], "一般病棟入院基本料")
        self.assertEqual(row["standard_abbreviation"], "一般入院")
        self.assertEqual(row["remarks_heading"], "区分:")

    def test_import_hokkaido_hospital_registry(self) -> None:
        xlsx_path = Path(self.tmp.name) / "registry.xlsx"
        write_minimal_xlsx(
            xlsx_path,
            [
                ["コード内容別医療機関一覧表"],
                [""],
                [
                    "1",
                    "01,1248,9",
                    "医療法人 愛全病院",
                    "〒005－0813札幌市南区川沿１３条２丁目１番３８号",
                    "011-571-5670",
                    "医療法人 愛全会",
                    "松原 泉",
                    "昭47. 3. 1",
                    "療養 206",
                    "病院",
                ],
                ["", "", "", "", "常 勤: 19", "", "", "新規", "一般 231", "療養病床"],
                ["", "", "", "", "(医 18)", "", "", "令5. 3. 1", "内 消化器内科 循環器内科", "現存"],
            ],
        )

        result = import_hokkaido_hospital_registry(
            self.conn,
            xlsx_path,
            source_version="2026-05-01",
            published_at="2026-05-11",
        )
        row = self.conn.execute(
            """
            SELECT medical_institution_code, postal_code, designated_from, status, bed_count_text, departments_text
            FROM hospital_registry
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["medical_institution_code"], "0112489")
        self.assertEqual(row["postal_code"], "005-0813")
        self.assertEqual(row["designated_from"], "1972-03-01")
        self.assertEqual(row["status"], "現存")
        self.assertIn("一般 231", row["bed_count_text"])
        self.assertIn("消化器内科", row["departments_text"])

    def test_import_regional_hospital_registry_uses_requested_bureau(self) -> None:
        xlsx_path = Path(self.tmp.name) / "regional_registry.xlsx"
        write_minimal_xlsx(
            xlsx_path,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1234,5",
                    "東北サンプル病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科 外科", "現存"],
            ],
        )

        result = import_regional_hospital_registry(
            self.conn,
            xlsx_path,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        row = self.conn.execute(
            """
            SELECT regional_bureau, medical_institution_code, postal_code, designated_from, status
            FROM hospital_registry
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()
        source = self.conn.execute(
            """
            SELECT source_type
            FROM master_sources
            WHERE id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["regional_bureau"], "tohoku")
        self.assertEqual(row["medical_institution_code"], "0412345")
        self.assertEqual(row["postal_code"], "980-0000")
        self.assertEqual(row["designated_from"], "2018-04-01")
        self.assertEqual(row["status"], "現存")
        self.assertEqual(source["source_type"], "tohoku_hospital_registry")

    def test_import_regional_hospital_registry_accepts_regional_code_formats(self) -> None:
        xlsx_path = Path(self.tmp.name) / "regional_code_formats.xlsx"
        write_minimal_xlsx(
            xlsx_path,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "01-1024-3",
                    "東北ハイフン病院",
                    "〒030－0000青森市サンプル１",
                    "017-000-0000",
                    "医療法人 サンプル会",
                    "青森 太郎",
                    "昭44. 8. 1",
                    "一般 37",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "2",
                    "021,003,9",
                    "九州カンマ診療所",
                    "〒812－0000福岡市サンプル１",
                    "092-000-0000",
                    "医療法人 サンプル会",
                    "福岡 太郎",
                    "平14. 6. 1",
                    "内科",
                    "診療所",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "3",
                    "01・1430・3",
                    "熊本中点病院",
                    "〒862－0000熊本市サンプル１",
                    "096-000-0000",
                    "医療法人 サンプル会",
                    "熊本 太郎",
                    "平4. 8. 31",
                    "精神 120",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "精神科", "現存"],
            ],
        )

        result = import_regional_hospital_registry(
            self.conn,
            xlsx_path,
            regional_bureau="kyushu",
            source_version="2026-05-01",
        )
        rows = self.conn.execute(
            """
            SELECT medical_institution_code, institution_name
            FROM hospital_registry
            WHERE source_id = ?
            ORDER BY medical_institution_code
            """,
            (result.source_id,),
        ).fetchall()

        self.assertEqual(result.row_count, 3)
        self.assertEqual(
            [(row["medical_institution_code"], row["institution_name"]) for row in rows],
            [
                ("0110243", "東北ハイフン病院"),
                ("0114303", "熊本中点病院"),
                ("0210039", "九州カンマ診療所"),
            ],
        )

    def test_import_regional_hospital_registry_keeps_start_row_departments_out_of_beds(self) -> None:
        xlsx_path = Path(self.tmp.name) / "start_row_departments.xlsx"
        write_minimal_xlsx(
            xlsx_path,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "27,0070,2",
                    "ふかいクリニック",
                    "〒599－0000堺市中区サンプル１",
                    "072-000-0000",
                    "医療法人 サンプル会",
                    "大阪 太郎",
                    "平30. 4. 1",
                    "内 精",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "", "現存"],
            ],
        )

        result = import_regional_hospital_registry(
            self.conn,
            xlsx_path,
            regional_bureau="kinki",
            source_version="2026-05-01",
        )
        row = self.conn.execute(
            """
            SELECT bed_count_text, departments_text
            FROM hospital_registry
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["bed_count_text"], "")
        self.assertEqual(row["departments_text"], "内 精")

    def test_import_regional_hospital_registry_reads_zip_of_workbooks(self) -> None:
        miyagi_xlsx = Path(self.tmp.name) / "miyagi_registry.xlsx"
        fukushima_xlsx = Path(self.tmp.name) / "fukushima_registry.xlsx"
        write_minimal_xlsx(
            miyagi_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1234,5",
                    "宮城サンプル病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科 外科", "現存"],
            ],
        )
        write_minimal_xlsx(
            fukushima_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "07,1234,5",
                    "福島サンプル病院",
                    "〒960－0000福島市サンプル１",
                    "024-000-0000",
                    "医療法人 サンプル会",
                    "福島 太郎",
                    "平30. 4. 1",
                    "一般 120",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        zip_path = Path(self.tmp.name) / "tohoku_registry.zip"
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.write(miyagi_xlsx, "miyagi/registry.xlsx")
            archive.write(fukushima_xlsx, "fukushima/registry.xlsx")

        result = import_regional_hospital_registry(
            self.conn,
            zip_path,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        rows = self.conn.execute(
            """
            SELECT medical_institution_code, institution_name, postal_code
            FROM hospital_registry
            WHERE source_id = ?
            ORDER BY medical_institution_code
            """,
            (result.source_id,),
        ).fetchall()
        source = self.conn.execute(
            """
            SELECT encoding
            FROM master_sources
            WHERE id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 2)
        self.assertEqual([row["medical_institution_code"] for row in rows], ["0412345", "0712345"])
        self.assertEqual([row["postal_code"] for row in rows], ["980-0000", "960-0000"])
        self.assertEqual(source["encoding"], "zip+xlsx")

    def test_import_regional_hospital_registry_skips_dental_and_pharmacy_workbooks(self) -> None:
        medical_xlsx = Path(self.tmp.name) / "medical_registry.xlsx"
        dental_xlsx = Path(self.tmp.name) / "dental_registry.xlsx"
        pharmacy_xlsx = Path(self.tmp.name) / "pharmacy_registry.xlsx"
        for xlsx_path, category, code, name, institution_type in (
            (medical_xlsx, "医科", "40,1003,9", "福岡医科病院", "病院"),
            (dental_xlsx, "歯科", "40,3001,7", "福岡歯科医院", "診療所"),
            (pharmacy_xlsx, "薬局", "40,4000,6", "福岡薬局", "薬局"),
        ):
            write_minimal_xlsx(
                xlsx_path,
                [
                    [""],
                    ["コード内容別医療機関一覧表", "[福岡県]"],
                    [""],
                    [f"[令和 8年 5月 1日現在 {category} 現存/休止]"],
                    [""],
                    [
                        "1",
                        code,
                        name,
                        "〒812－0000福岡市サンプル１",
                        "092-000-0000",
                        "医療法人 サンプル会",
                        "福岡 太郎",
                        "令4. 5. 1",
                        "内科",
                        institution_type,
                    ],
                    ["", "", "", "", "", "", "", "", "内科", "現存"],
                ],
            )
        zip_path = Path(self.tmp.name) / "kyushu_registry.zip"
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.write(medical_xlsx, "r8_05_fukuoka_ika_02.xlsx")
            archive.write(dental_xlsx, "r8_05_fukuoka_shika_02.xlsx")
            archive.write(pharmacy_xlsx, "r8_05_fukuoka_yakkyoku_02.xlsx")

        result = import_regional_hospital_registry(
            self.conn,
            zip_path,
            regional_bureau="kyushu",
            source_version="2026-05-01",
        )
        row = self.conn.execute(
            """
            SELECT medical_institution_code, institution_name, institution_type
            FROM hospital_registry
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["medical_institution_code"], "4010039")
        self.assertEqual(row["institution_name"], "福岡医科病院")
        self.assertEqual(row["institution_type"], "病院")

    def test_import_regional_hospital_registry_deduplicates_codes_within_source(self) -> None:
        first_xlsx = Path(self.tmp.name) / "first_registry.xlsx"
        duplicate_xlsx = Path(self.tmp.name) / "duplicate_registry.xlsx"
        for xlsx_path, name in ((first_xlsx, "先勝ち病院"), (duplicate_xlsx, "重複病院")):
            write_minimal_xlsx(
                xlsx_path,
                [
                    ["コード内容別医療機関一覧表"],
                    [
                        "1",
                        "13,1234,5",
                        name,
                        "〒100－0000東京都千代田区サンプル１",
                        "03-0000-0000",
                        "医療法人 サンプル会",
                        "東京 太郎",
                        "平30. 4. 1",
                        "一般 100",
                        "病院",
                    ],
                    ["", "", "", "", "", "", "", "", "内科", "現存"],
                ],
            )
        zip_path = Path(self.tmp.name) / "kanto_registry.zip"
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.write(first_xlsx, "tokyo/first.xlsx")
            archive.write(duplicate_xlsx, "tokyo/duplicate.xlsx")

        result = import_regional_hospital_registry(
            self.conn,
            zip_path,
            regional_bureau="kanto_shinetsu",
            source_version="2026-05-01",
        )
        row = self.conn.execute(
            """
            SELECT medical_institution_code, institution_name
            FROM hospital_registry
            WHERE source_id = ?
            """,
            (result.source_id,),
        ).fetchone()

        self.assertEqual(result.row_count, 1)
        self.assertEqual(row["medical_institution_code"], "1312345")
        self.assertEqual(row["institution_name"], "重複病院")

    def test_import_regional_manifest_imports_multiple_source_kinds(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "regional_registry.xlsx"
        facility_xlsx = Path(self.tmp.name) / "regional_facility.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1234,5",
                    "東北サンプル病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科 外科", "現存"],
            ],
        )
        write_minimal_xlsx(
            facility_xlsx,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0412345",
                    "",
                    "",
                    "東北サンプル病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        manifest_path = Path(self.tmp.name) / "regional_manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "hospital_registry",
                            "regional_bureau": "tohoku",
                            "path": registry_xlsx.name,
                            "source_version": "2026-05-01",
                        },
                        {
                            "kind": "facility_standards",
                            "regional_bureau": "tohoku",
                            "path": facility_xlsx.name,
                            "source_version": "2026-05-01",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        results = import_regional_manifest(self.conn, manifest_path)
        registry_count = self.conn.execute("SELECT COUNT(*) AS count FROM hospital_registry").fetchone()
        facility_count = self.conn.execute("SELECT COUNT(*) AS count FROM hospital_facility_standards").fetchone()

        self.assertEqual([result.kind for result in results], ["hospital_registry", "facility_standards"])
        self.assertEqual([result.row_count for result in results], [1, 1])
        self.assertEqual(registry_count["count"], 1)
        self.assertEqual(facility_count["count"], 1)

    def test_import_regional_manifest_resolves_generated_cwd_relative_paths(self) -> None:
        root = Path(self.tmp.name) / "root"
        registry_xlsx = (
            root
            / "data"
            / "raw"
            / "kouseikyoku"
            / "hokkaido"
            / "2026-05-01"
            / "hospital_registry"
            / "registry.xlsx"
        )
        registry_xlsx.parent.mkdir(parents=True)
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "01,1234,5",
                    "北海道サンプル病院",
                    "〒060－0000札幌市中央区サンプル１",
                    "011-000-0000",
                    "医療法人 サンプル会",
                    "札幌 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科 外科", "現存"],
            ],
        )
        manifest_path = root / "data" / "raw" / "kouseikyoku" / "regional_manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "hospital_registry",
                            "regional_bureau": "hokkaido",
                            "path": "data/raw/kouseikyoku/hokkaido/2026-05-01/hospital_registry/registry.xlsx",
                            "source_version": "2026-05-01",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        previous_cwd = Path.cwd()
        os.chdir(root)
        try:
            results = import_regional_manifest(self.conn, manifest_path)
        finally:
            os.chdir(previous_cwd)

        self.assertEqual(results[0].row_count, 1)

    def test_validate_regional_manifest_reports_missing_paths_and_coverage(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "regional_registry_validation.xlsx"
        output_path = Path(self.tmp.name) / "regional_manifest_validation.md"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1234,5",
                    "東北サンプル病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
            ],
        )
        manifest_path = Path(self.tmp.name) / "regional_manifest_validation.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "hospital_registry",
                            "regional_bureau": "tohoku",
                            "path": registry_xlsx.name,
                            "source_version": "2026-05-01",
                        },
                        {
                            "kind": "facility_standards",
                            "regional_bureau": "tohoku",
                            "path": "missing_facility.xlsx",
                            "source_version": "2026-05-01",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        result = validate_regional_manifest(manifest_path)
        report = regional_manifest_validation_to_markdown(result)
        cli_main(
            [
                "validate-regional-manifest",
                "--manifest",
                str(manifest_path),
                "--output",
                str(output_path),
            ]
        )
        cli_report = output_path.read_text(encoding="utf-8")

        self.assertFalse(result.ready)
        self.assertIn("hokkaido:facility_standards", result.missing_pairs)
        self.assertIn("path not found", report)
        self.assertIn("| error | 2 | tohoku | facility_standards |", report)
        self.assertIn("Ready: no", cli_report)

    def test_validate_regional_manifest_accepts_full_coverage(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "regional_registry_full_validation.xlsx"
        facility_xlsx = Path(self.tmp.name) / "regional_facility_full_validation.xlsx"
        output_path = Path(self.tmp.name) / "regional_manifest_full_validation.json"
        write_minimal_xlsx(registry_xlsx, [["コード内容別医療機関一覧表"]])
        write_minimal_xlsx(facility_xlsx, [["項番"]])
        entries = []
        for regional_bureau in (
            "chugoku_shikoku",
            "hokkaido",
            "kanto_shinetsu",
            "kinki",
            "kyushu",
            "shikoku",
            "tohoku",
            "tokai_hokuriku",
        ):
            entries.append(
                {
                    "kind": "hospital_registry",
                    "regional_bureau": regional_bureau,
                    "path": str(registry_xlsx),
                    "source_version": "2026-05-01",
                }
            )
            entries.append(
                {
                    "kind": "facility_standards",
                    "regional_bureau": regional_bureau,
                    "path": str(facility_xlsx),
                    "source_version": "2026-05-01",
                }
            )
        manifest_path = Path(self.tmp.name) / "regional_manifest_full_validation.json"
        manifest_path.write_text(json.dumps({"entries": entries}, ensure_ascii=False), encoding="utf-8")

        result = validate_regional_manifest(manifest_path)
        cli_main(
            [
                "validate-regional-manifest",
                "--manifest",
                str(manifest_path),
                "--format",
                "json",
                "--output",
                str(output_path),
                "--fail-on-error",
            ]
        )
        cli_result = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertTrue(result.ready)
        self.assertEqual(result.error_count, 0)
        self.assertEqual(cli_result["entry_count"], 16)
        self.assertTrue(cli_result["ready"])

    def test_run_regional_manifest_smoke_reports_success_and_failure(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "regional_registry.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1234,5",
                    "東北サンプル病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科 外科", "現存"],
            ],
        )
        manifest_path = Path(self.tmp.name) / "regional_manifest_smoke.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "entries": [
                        {
                            "kind": "hospital_registry",
                            "regional_bureau": "tohoku",
                            "path": registry_xlsx.name,
                            "source_version": "2026-05-01",
                        },
                        {
                            "kind": "facility_standards",
                            "regional_bureau": "tohoku",
                            "path": "missing_facility.xlsx",
                            "source_version": "2026-05-01",
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        results = run_regional_manifest_smoke(self.conn, manifest_path)
        report = regional_smoke_results_to_markdown(results)

        self.assertEqual([result.status for result in results], ["ok", "failed"])
        self.assertEqual(results[0].row_count, 1)
        self.assertIn("FileNotFoundError", results[1].error or "")
        self.assertIn("Total entries: 2", report)
        self.assertIn("Non-OK: 1", report)

    def test_summarize_hospital_registry_quality_counts_hospitals_and_facility_coverage(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "registry_quality.xlsx"
        facility_xlsx = Path(self.tmp.name) / "facility_quality.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "施設基準あり病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "2",
                    "04,2000,2",
                    "施設基準なし病院",
                    "〒980－0001仙台市青葉区サンプル２",
                    "022-000-0001",
                    "医療法人 サンプル会",
                    "青葉 次郎",
                    "平30. 4. 1",
                    "一般 50",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "3",
                    "04,3000,3",
                    "施設基準あり診療所",
                    "〒980－0002仙台市青葉区サンプル３",
                    "022-000-0002",
                    "医療法人 サンプル会",
                    "青葉 三郎",
                    "平30. 4. 1",
                    "内科",
                    "診療所",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        header = [
            "項番",
            "都道府県コード",
            "都道府県名",
            "区分",
            "医療機関番号",
            "併設医療機関番号",
            "医療機関記号番号",
            "医療機関名称",
            "医療機関所在地（郵便番号）",
            "医療機関所在地（住所）",
            "電話番号",
            "FAX番号",
            "病床数",
            "受理届出名称",
            "受理記号",
            "受理番号",
            "算定開始年月日",
            "個別有効開始年月日",
            "備考（見出し）",
            "備考（データ）",
            "市町村コード",
            "市町村名",
            "種別コード",
            "種別",
        ]
        write_minimal_xlsx(
            facility_xlsx,
            [
                header,
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0410001",
                    "",
                    "",
                    "施設基準あり病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
                [
                    "2",
                    "04",
                    "宮城県",
                    "医科",
                    "0430003",
                    "",
                    "",
                    "施設基準あり診療所",
                    "980-0002",
                    "仙台市青葉区サンプル３",
                    "022-000-0002",
                    "",
                    "",
                    "検体検査管理加算（１）",
                    "検Ⅰ",
                    "第201号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        import_regional_hospital_registry(
            self.conn,
            registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        import_regional_facility_standards(
            self.conn,
            facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )

        summaries = summarize_hospital_registry_quality(self.conn)
        report = hospital_registry_quality_to_markdown(summaries)

        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0].regional_bureau, "tohoku")
        self.assertEqual(summaries[0].registry_rows, 3)
        self.assertEqual(summaries[0].hospital_rows, 2)
        self.assertEqual(summaries[0].active_hospital_rows, 2)
        self.assertEqual(summaries[0].facility_standard_institution_count, 2)
        self.assertEqual(summaries[0].active_hospital_with_facility_standard_count, 1)
        self.assertEqual(summaries[0].active_hospital_without_facility_standard_count, 1)
        self.assertIn("| total | 3 | 2 | 2 | 2 | 1 | 1 |", report)

        unmatched = list_unmatched_active_hospitals(self.conn)
        unmatched_report = unmatched_active_hospitals_to_markdown(unmatched)

        self.assertEqual(len(unmatched), 1)
        self.assertEqual(unmatched[0].medical_institution_code, "0420002")
        self.assertEqual(unmatched[0].institution_name, "施設基準なし病院")
        self.assertEqual(unmatched[0].same_bureau_name_match_count, 0)
        self.assertEqual(unmatched[0].classification, "facility_standards_missing")
        self.assertEqual(unmatched[0].recommended_action, "include_with_facility_warning")
        self.assertIn(
            (
                "| tohoku | 0420002 | 施設基準なし病院 | 一般 50 | "
                "facility_standards_missing | include_with_facility_warning | 0 |"
            ),
            unmatched_report,
        )
        self.assertIn("Total: 1", unmatched_report)

    def test_hospital_run_targets_include_warnings_and_exclude_scope_reviews(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "registry_run_targets.xlsx"
        facility_xlsx = Path(self.tmp.name) / "facility_run_targets.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "施設基準あり病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "2",
                    "04,2000,2",
                    "施設基準なし病院",
                    "〒980－0001仙台市青葉区サンプル２",
                    "022-000-0001",
                    "医療法人 サンプル会",
                    "青葉 次郎",
                    "平30. 4. 1",
                    "一般 50",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "3",
                    "04,3000,3",
                    "ふかいクリニック",
                    "〒980－0002仙台市青葉区サンプル３",
                    "022-000-0002",
                    "医療法人 サンプル会",
                    "青葉 三郎",
                    "平30. 4. 1",
                    "内科",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "4",
                    "04,4000,4",
                    "大阪大学歯学部附属病院",
                    "〒980－0003仙台市青葉区サンプル４",
                    "022-000-0003",
                    "国立大学法人 サンプル大学",
                    "青葉 四郎",
                    "平30. 4. 1",
                    "一般 40",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "歯科", "現存"],
            ],
        )
        header = [
            "項番",
            "都道府県コード",
            "都道府県名",
            "区分",
            "医療機関番号",
            "併設医療機関番号",
            "医療機関記号番号",
            "医療機関名称",
            "医療機関所在地（郵便番号）",
            "医療機関所在地（住所）",
            "電話番号",
            "FAX番号",
            "病床数",
            "受理届出名称",
            "受理記号",
            "受理番号",
            "算定開始年月日",
            "個別有効開始年月日",
            "備考（見出し）",
            "備考（データ）",
            "市町村コード",
            "市町村名",
            "種別コード",
            "種別",
        ]
        write_minimal_xlsx(
            facility_xlsx,
            [
                header,
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0410001",
                    "",
                    "",
                    "施設基準あり病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
                [
                    "2",
                    "04",
                    "宮城県",
                    "医科",
                    "0440004",
                    "",
                    "",
                    "大阪大学歯学部附属病院",
                    "980-0003",
                    "仙台市青葉区サンプル４",
                    "022-000-0003",
                    "",
                    "一般 40",
                    "検体検査管理加算（１）",
                    "検Ⅰ",
                    "第201号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        import_regional_hospital_registry(
            self.conn,
            registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        import_regional_facility_standards(
            self.conn,
            facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )

        default_targets = list_hospital_run_targets(self.conn)
        all_targets = list_hospital_run_targets(self.conn, include_excluded=True)
        summaries = summarize_hospital_run_targets(self.conn)
        target_report = hospital_run_targets_to_markdown(all_targets)
        summary_report = hospital_run_target_summary_to_markdown(summaries)

        self.assertEqual(
            [target.medical_institution_code for target in default_targets],
            ["0410001", "0420002"],
        )
        self.assertEqual(len(all_targets), 4)
        by_code = {target.medical_institution_code: target for target in all_targets}
        self.assertEqual(by_code["0410001"].classification, "facility_standards_matched")
        self.assertEqual(by_code["0410001"].recommended_action, "include")
        self.assertEqual(by_code["0410001"].facility_standard_count, 1)
        self.assertEqual(by_code["0420002"].classification, "facility_standards_missing")
        self.assertEqual(by_code["0420002"].recommended_action, "include_with_facility_warning")
        self.assertEqual(by_code["0420002"].warnings, ("facility_standards_not_found",))
        self.assertFalse(by_code["0430003"].included_in_default_run)
        self.assertEqual(by_code["0430003"].classification, "clinic_named_registry_review")
        self.assertFalse(by_code["0440004"].included_in_default_run)
        self.assertEqual(by_code["0440004"].classification, "dental_hospital_scope_review")
        self.assertEqual(by_code["0440004"].facility_standard_count, 1)
        self.assertIn("| yes | facility_standards_matched | include | 1 |", summary_report)
        self.assertIn(
            "| yes | facility_standards_missing | include_with_facility_warning | 1 |",
            summary_report,
        )
        self.assertIn("Default run targets: 2", summary_report)
        self.assertIn("| no | tohoku | 0430003 | ふかいクリニック |", target_report)
        self.assertIn("Default run targets: 2", target_report)

    def test_smoke_hospital_run_targets_resolves_profiles_for_batch(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "registry_batch_targets.xlsx"
        facility_xlsx = Path(self.tmp.name) / "facility_batch_targets.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "施設基準あり病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "2",
                    "04,2000,2",
                    "施設基準なし病院",
                    "〒980－0001仙台市青葉区サンプル２",
                    "022-000-0001",
                    "医療法人 サンプル会",
                    "青葉 次郎",
                    "平30. 4. 1",
                    "一般 50",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "3",
                    "04,4000,4",
                    "大阪大学歯学部附属病院",
                    "〒980－0003仙台市青葉区サンプル４",
                    "022-000-0003",
                    "国立大学法人 サンプル大学",
                    "青葉 四郎",
                    "平30. 4. 1",
                    "一般 40",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "歯科", "現存"],
            ],
        )
        header = [
            "項番",
            "都道府県コード",
            "都道府県名",
            "区分",
            "医療機関番号",
            "併設医療機関番号",
            "医療機関記号番号",
            "医療機関名称",
            "医療機関所在地（郵便番号）",
            "医療機関所在地（住所）",
            "電話番号",
            "FAX番号",
            "病床数",
            "受理届出名称",
            "受理記号",
            "受理番号",
            "算定開始年月日",
            "個別有効開始年月日",
            "備考（見出し）",
            "備考（データ）",
            "市町村コード",
            "市町村名",
            "種別コード",
            "種別",
        ]
        write_minimal_xlsx(
            facility_xlsx,
            [
                header,
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0410001",
                    "",
                    "",
                    "施設基準あり病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
                [
                    "2",
                    "04",
                    "宮城県",
                    "医科",
                    "0440004",
                    "",
                    "",
                    "大阪大学歯学部附属病院",
                    "980-0003",
                    "仙台市青葉区サンプル４",
                    "022-000-0003",
                    "",
                    "一般 40",
                    "検体検査管理加算（１）",
                    "検Ⅰ",
                    "第201号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        import_regional_hospital_registry(
            self.conn,
            registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        import_regional_facility_standards(
            self.conn,
            facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )

        default_results = smoke_hospital_run_targets(
            self.conn,
            service_date=date(2026, 6, 1),
        )
        all_results = smoke_hospital_run_targets(
            self.conn,
            service_date=date(2026, 6, 1),
            include_excluded=True,
        )
        report = hospital_profile_batch_results_to_markdown(default_results)

        self.assertEqual([result.status for result in default_results], ["ok", "ok"])
        self.assertEqual(
            [result.medical_institution_code for result in default_results],
            ["0410001", "0420002"],
        )
        self.assertEqual(default_results[0].profile_facility_standard_count, 1)
        self.assertEqual(default_results[1].warnings, ("facility_standards_not_found",))
        self.assertEqual(len(all_results), 3)
        self.assertEqual(all_results[2].profile_classification, "dental_hospital_scope_review")
        self.assertFalse(all_results[2].profile_included_in_default_medical_run)
        self.assertIn("Total targets: 2", report)
        self.assertIn("Rows with warnings: 1", report)

    def test_build_hospital_claim_run_contexts_exports_claim_templates(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "registry_claim_contexts.xlsx"
        facility_xlsx = Path(self.tmp.name) / "facility_claim_contexts.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "施設基準あり病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "2",
                    "04,2000,2",
                    "施設基準なし病院",
                    "〒980－0001仙台市青葉区サンプル２",
                    "022-000-0001",
                    "医療法人 サンプル会",
                    "青葉 次郎",
                    "平30. 4. 1",
                    "一般 50",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        write_minimal_xlsx(
            facility_xlsx,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0410001",
                    "",
                    "",
                    "施設基準あり病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        import_regional_hospital_registry(
            self.conn,
            registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )
        import_regional_facility_standards(
            self.conn,
            facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01",
        )

        contexts = build_hospital_claim_run_contexts(
            self.conn,
            service_date=date(2026, 6, 1),
        )
        report = hospital_claim_run_contexts_to_markdown(contexts)
        first = contexts[0].to_dict()
        claim_context = contexts[0].to_claim_context(
            procedure_codes=("160000410",),
            patient_id="patient-1",
            master_sources=MasterSourceContext(medical_procedure_source_id=123),
        )

        self.assertEqual(len(contexts), 2)
        self.assertEqual(contexts[0].regional_bureau, "tohoku")
        self.assertEqual(contexts[0].medical_institution_code, "0410001")
        self.assertEqual(contexts[0].facility_standard_keys, ("検Ⅱ",))
        self.assertEqual(contexts[1].warnings, ("facility_standards_not_found",))
        self.assertEqual(
            first["claim_context_template"]["encounter"]["regional_bureau"],
            "tohoku",
        )
        self.assertEqual(first["claim_context_template"]["facility_standard_keys"], ["検Ⅱ"])
        self.assertEqual(claim_context.encounter.regional_bureau, "tohoku")
        self.assertEqual(claim_context.procedure_codes, ("160000410",))
        self.assertEqual(claim_context.patient.patient_id, "patient-1")
        self.assertEqual(claim_context.master_sources.medical_procedure_source_id, 123)
        self.assertEqual(claim_context.facility_standard_keys, frozenset({"検Ⅱ"}))
        self.assertIn("| facility_standards_matched | 1 |", report)
        self.assertIn("Rows with warnings: 1", report)

    def test_regional_source_pages_cover_all_bureaus_and_kinds(self) -> None:
        pages = list_regional_source_pages()
        pairs = {(page.regional_bureau, page.kind) for page in pages}

        self.assertEqual(len(pages), 16)
        for bureau in (
            "hokkaido",
            "tohoku",
            "kanto_shinetsu",
            "tokai_hokuriku",
            "kinki",
            "chugoku_shikoku",
            "shikoku",
            "kyushu",
        ):
            self.assertIn((bureau, "hospital_registry"), pairs)
            self.assertIn((bureau, "facility_standards"), pairs)

        kyushu_facility = next(
            page
            for page in pages
            if page.regional_bureau == "kyushu" and page.kind == "facility_standards"
        )
        self.assertIn("index_00007.html", kyushu_facility.url)

    def test_get_hospital_profile(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "registry.xlsx"
        facility_xlsx = Path(self.tmp.name) / "facility.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "01,1248,9",
                    "医療法人 愛全病院",
                    "〒005－0813札幌市南区川沿１３条２丁目１番３８号",
                    "011-571-5670",
                    "医療法人 愛全会",
                    "松原 泉",
                    "昭47. 3. 1",
                    "療養 206",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "一般 231", "現存"],
            ],
        )
        write_minimal_xlsx(
            facility_xlsx,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "01",
                    "北海道",
                    "医科",
                    "0112489",
                    "",
                    "",
                    "医療法人 愛全病院",
                    "005-0813",
                    "札幌市南区川沿１３条２丁目１番３８号",
                    "011-571-5670",
                    "",
                    "療養 206／一般 231",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第100号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )

        registry_result = import_hokkaido_hospital_registry(
            self.conn,
            registry_xlsx,
            source_version="2026-05-01-registry",
        )
        facility_result = import_hokkaido_facility_standards(
            self.conn,
            facility_xlsx,
            source_version="2026-05-01-facility",
        )

        profile = get_hospital_profile(
            self.conn,
            "01,1248,9",
            date(2026, 6, 1),
            registry_source_id=registry_result.source_id,
            facility_source_id=facility_result.source_id,
        )

        self.assertEqual(profile.medical_institution_code, "0112489")
        self.assertEqual(profile.institution_name, "医療法人 愛全病院")
        self.assertIn("検Ⅱ", profile.facility_standard_keys)
        self.assertEqual(profile.warnings, ())
        self.assertEqual(profile.default_run_classification, "facility_standards_matched")
        self.assertEqual(profile.default_run_recommended_action, "include")
        self.assertTrue(profile.included_in_default_medical_run)

    def test_get_hospital_profile_marks_default_run_scope(self) -> None:
        registry_xlsx = Path(self.tmp.name) / "profile_scope_registry.xlsx"
        facility_xlsx = Path(self.tmp.name) / "profile_scope_facility.xlsx"
        write_minimal_xlsx(
            registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,2000,2",
                    "施設基準なし病院",
                    "〒980－0001仙台市青葉区サンプル２",
                    "022-000-0001",
                    "医療法人 サンプル会",
                    "青葉 次郎",
                    "平30. 4. 1",
                    "一般 50",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
                [
                    "2",
                    "04,4000,4",
                    "大阪大学歯学部附属病院",
                    "〒980－0003仙台市青葉区サンプル４",
                    "022-000-0003",
                    "国立大学法人 サンプル大学",
                    "青葉 四郎",
                    "平30. 4. 1",
                    "一般 40",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "歯科", "現存"],
            ],
        )
        write_minimal_xlsx(
            facility_xlsx,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0440004",
                    "",
                    "",
                    "大阪大学歯学部附属病院",
                    "980-0003",
                    "仙台市青葉区サンプル４",
                    "022-000-0003",
                    "",
                    "一般 40",
                    "検体検査管理加算（１）",
                    "検Ⅰ",
                    "第201号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        registry_result = import_regional_hospital_registry(
            self.conn,
            registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01-registry",
        )
        facility_result = import_regional_facility_standards(
            self.conn,
            facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01-facility",
        )

        warning_profile = get_hospital_profile(
            self.conn,
            "04,2000,2",
            date(2026, 6, 1),
            registry_source_id=registry_result.source_id,
            facility_source_id=facility_result.source_id,
        )
        excluded_profile = get_hospital_profile(
            self.conn,
            "04,4000,4",
            date(2026, 6, 1),
            registry_source_id=registry_result.source_id,
            facility_source_id=facility_result.source_id,
        )

        self.assertEqual(warning_profile.default_run_classification, "facility_standards_missing")
        self.assertEqual(
            warning_profile.default_run_recommended_action,
            "include_with_facility_warning",
        )
        self.assertTrue(warning_profile.included_in_default_medical_run)
        self.assertEqual(warning_profile.warnings, ("facility_standards_not_found",))
        self.assertEqual(excluded_profile.default_run_classification, "dental_hospital_scope_review")
        self.assertEqual(
            excluded_profile.default_run_recommended_action,
            "exclude_from_default_medical_run",
        )
        self.assertFalse(excluded_profile.included_in_default_medical_run)
        self.assertIn("検Ⅰ", excluded_profile.facility_standard_keys)
        self.assertEqual(
            excluded_profile.warnings,
            ("default_medical_run_excluded: dental_hospital_scope_review",),
        )

    def test_get_hospital_profile_can_disambiguate_duplicate_codes_by_bureau(self) -> None:
        tohoku_registry_xlsx = Path(self.tmp.name) / "tohoku_duplicate_registry.xlsx"
        tokai_registry_xlsx = Path(self.tmp.name) / "tokai_duplicate_registry.xlsx"
        tohoku_facility_xlsx = Path(self.tmp.name) / "tohoku_duplicate_facility.xlsx"
        write_minimal_xlsx(
            tohoku_registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "東北同一コード病院",
                    "〒980－0000仙台市青葉区サンプル１",
                    "022-000-0000",
                    "医療法人 サンプル会",
                    "青葉 太郎",
                    "平30. 4. 1",
                    "一般 100",
                    "病院",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        write_minimal_xlsx(
            tokai_registry_xlsx,
            [
                ["コード内容別医療機関一覧表"],
                [
                    "1",
                    "04,1000,1",
                    "東海同一コード診療所",
                    "〒460－0000名古屋市中区サンプル１",
                    "052-000-0000",
                    "医療法人 サンプル会",
                    "中部 太郎",
                    "平30. 4. 1",
                    "内科",
                    "診療所",
                ],
                ["", "", "", "", "", "", "", "", "内科", "現存"],
            ],
        )
        write_minimal_xlsx(
            tohoku_facility_xlsx,
            [
                [
                    "項番",
                    "都道府県コード",
                    "都道府県名",
                    "区分",
                    "医療機関番号",
                    "併設医療機関番号",
                    "医療機関記号番号",
                    "医療機関名称",
                    "医療機関所在地（郵便番号）",
                    "医療機関所在地（住所）",
                    "電話番号",
                    "FAX番号",
                    "病床数",
                    "受理届出名称",
                    "受理記号",
                    "受理番号",
                    "算定開始年月日",
                    "個別有効開始年月日",
                    "備考（見出し）",
                    "備考（データ）",
                    "市町村コード",
                    "市町村名",
                    "種別コード",
                    "種別",
                ],
                [
                    "1",
                    "04",
                    "宮城県",
                    "医科",
                    "0410001",
                    "",
                    "",
                    "東北同一コード病院",
                    "980-0000",
                    "仙台市青葉区サンプル１",
                    "022-000-0000",
                    "",
                    "一般 100",
                    "検体検査管理加算（２）",
                    "検Ⅱ",
                    "第200号",
                    "令和 6年 6月 1日",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                    "",
                ],
            ],
        )
        import_regional_hospital_registry(
            self.conn,
            tohoku_registry_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01-tohoku",
        )
        import_regional_hospital_registry(
            self.conn,
            tokai_registry_xlsx,
            regional_bureau="tokai_hokuriku",
            source_version="2026-05-01-tokai",
        )
        import_regional_facility_standards(
            self.conn,
            tohoku_facility_xlsx,
            regional_bureau="tohoku",
            source_version="2026-05-01-tohoku",
        )

        tohoku_profile = get_hospital_profile(
            self.conn,
            "04,1000,1",
            date(2026, 6, 1),
            regional_bureau="tohoku",
        )
        tokai_profile = get_hospital_profile(
            self.conn,
            "04,1000,1",
            date(2026, 6, 1),
            regional_bureau="tokai_hokuriku",
        )

        self.assertEqual(tohoku_profile.institution_name, "東北同一コード病院")
        self.assertEqual(tohoku_profile.default_run_classification, "facility_standards_matched")
        self.assertIn("検Ⅱ", tohoku_profile.facility_standard_keys)
        self.assertEqual(tokai_profile.institution_name, "東海同一コード診療所")
        self.assertEqual(tokai_profile.default_run_classification, "registry_scope_review")
        self.assertEqual(tokai_profile.facility_standards, ())


if __name__ == "__main__":
    unittest.main()
