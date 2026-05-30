from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum

from medical_fee_calculation.electronic_rules import ProcedureHistoryEvent
from medical_fee_calculation.hospital_profile import HospitalProfile


class ClaimItemStatus(str, Enum):
    CONFIRMED = "confirmed"
    CANDIDATE = "candidate"
    WARNING = "warning"
    BLOCKED = "blocked"
    NEEDS_REVIEW = "needs_review"


class OutpatientBasicFeeKind(str, Enum):
    INITIAL = "initial"
    REVISIT = "revisit"
    OUTPATIENT_CLINIC = "outpatient_clinic"


class MedicationDeliveryKind(str, Enum):
    IN_HOUSE = "in_house"
    OUTSIDE_PRESCRIPTION = "outside_prescription"


class MedicationDispensingKind(str, Enum):
    INTERNAL_OR_PRN = "internal_or_prn"
    EXTERNAL = "external"


class MedicationPrescriptionCategory(str, Enum):
    OTHER = "other"
    SEVEN_OR_MORE_INTERNAL_MEDICINES = "seven_or_more_internal_medicines"
    PSYCHOTROPIC_POLYPHARMACY = "psychotropic_polypharmacy"
    PSYCHOTROPIC_LONG_TERM = "psychotropic_long_term"


class GenericNamePrescriptionAddOnKind(str, Enum):
    ADD_ON_1 = "generic_name_add_on_1"
    ADD_ON_2 = "generic_name_add_on_2"


class InjectionRouteKind(str, Enum):
    INTRADERMAL_SUBCUTANEOUS_INTRAMUSCULAR = "intradermal_subcutaneous_intramuscular"
    INTRAVENOUS = "intravenous"
    DRIP_INFUSION = "drip_infusion"
    CENTRAL_VENOUS = "central_venous"
    JOINT_CAVITY = "joint_cavity"
    VITREOUS = "vitreous"


class TreatmentKind(str, Enum):
    WOUND = "wound"
    BURN = "burn"
    DERMATOLOGY_OINTMENT = "dermatology_ointment"
    ANTI_INFLAMMATORY_MANUAL = "anti_inflammatory_manual"
    ANTI_INFLAMMATORY_DEVICE = "anti_inflammatory_device"
    ANTI_INFLAMMATORY_PATCH = "anti_inflammatory_patch"
    NASAL_FEEDING = "nasal_feeding"
    INDWELLING_URINARY_CATHETER = "indwelling_urinary_catheter"
    URETHRAL_DILATION_CATHETERIZATION = "urethral_dilation_catheterization"
    INTERMITTENT_CATHETERIZATION = "intermittent_catheterization"
    VAGINAL_IRRIGATION = "vaginal_irrigation"
    NAIL_REMOVAL = "nail_removal"


class TreatmentAreaSizeKind(str, Enum):
    LT_100_CM2 = "lt_100_cm2"
    GE_100_LT_500_CM2 = "ge_100_lt_500_cm2"
    GE_500_LT_3000_CM2 = "ge_500_lt_3000_cm2"
    GE_3000_LT_6000_CM2 = "ge_3000_lt_6000_cm2"
    GE_6000_CM2 = "ge_6000_cm2"


class ImagingKind(str, Enum):
    SIMPLE_RADIOGRAPHY = "simple_radiography"
    CONTRAST_RADIOGRAPHY = "contrast_radiography"
    MAMMOGRAPHY = "mammography"
    CT = "ct"
    MRI = "mri"


class RadiographyDiagnosticKind(str, Enum):
    SIMPLE_I = "simple_i"
    SIMPLE_RO = "simple_ro"


class ImagingAcquisitionKind(str, Enum):
    ANALOG = "analog"
    DIGITAL = "digital"


class CTEquipmentKind(str, Enum):
    OTHER = "other"
    MULTISLICE_4_TO_16 = "multislice_4_to_16"
    MULTISLICE_16_TO_64 = "multislice_16_to_64"
    MULTISLICE_64_TO_128 = "multislice_64_to_128"
    MULTISLICE_128_OR_MORE = "multislice_128_or_more"


class MRIEquipmentKind(str, Enum):
    OTHER = "other"
    TESLA_1_5_TO_3 = "tesla_1_5_to_3"
    TESLA_3_OR_MORE = "tesla_3_or_more"


@dataclass(frozen=True)
class PatientContext:
    patient_id: str | None = None
    birth_date: date | None = None
    sex: str | None = None


@dataclass(frozen=True)
class EncounterContext:
    service_date: date
    medical_institution_code: str | None = None
    regional_bureau: str | None = None
    is_outpatient: bool = False
    admission_date: date | None = None
    discharge_date: date | None = None


@dataclass(frozen=True)
class MasterSourceContext:
    medical_procedure_source_id: int | None = None
    drug_source_id: int | None = None
    material_source_id: int | None = None
    electronic_fee_source_id: int | None = None
    dpc_electronic_table_source_id: int | None = None
    dpc_hospital_coefficient_source_id: int | None = None
    comment_source_id: int | None = None
    registry_source_id: int | None = None
    facility_source_id: int | None = None


@dataclass(frozen=True)
class ChargeInput:
    code: str
    quantity: float = 1.0


@dataclass(frozen=True)
class CommentInput:
    code: str | None = None
    text: str | None = None


@dataclass(frozen=True)
class MedicationOrder:
    drug_code: str
    total_quantity: float | None = None
    quantity_per_day: float | None = None
    days: int | None = None
    dose_quantity: float | None = None
    doses_per_day: float | None = None
    dispensing_kind: MedicationDispensingKind | None = None


@dataclass(frozen=True)
class InjectionOrder:
    drug_code: str
    total_quantity: float | None = None
    dose_quantity: float | None = None
    administrations: float = 1.0


@dataclass(frozen=True)
class TreatmentOrder:
    kind: TreatmentKind
    area_size: TreatmentAreaSizeKind | None = None


@dataclass(frozen=True)
class ImagingOrder:
    kind: ImagingKind
    acquisition_kind: ImagingAcquisitionKind | None = None
    radiography_diagnostic_kind: RadiographyDiagnosticKind | None = None
    ct_equipment_kind: CTEquipmentKind | None = None
    mri_equipment_kind: MRIEquipmentKind | None = None
    head: bool = False
    joint_use: bool = False
    contrast: bool = False
    electronic_image_management: bool = False
    diagnostic_management_add_on: bool = False
    remote_diagnostic_management_add_on: bool = False


@dataclass(frozen=True)
class ClaimHistoryContext:
    same_day_history_codes: frozenset[str] = field(default_factory=frozenset)
    same_week_history_codes: frozenset[str] = field(default_factory=frozenset)
    same_month_history_codes: frozenset[str] = field(default_factory=frozenset)
    procedure_history_events: tuple[ProcedureHistoryEvent, ...] = ()
    already_billed_judgement_groups: frozenset[str] = field(default_factory=frozenset)
    bundled_judgement_groups: frozenset[str] = field(default_factory=frozenset)
    already_billed_lab_management_same_month: bool = False
    already_billed_collection_fee_codes_same_day: frozenset[str] = field(default_factory=frozenset)
    already_billed_outpatient_rapid_lab_items_same_day: int = 0


@dataclass(frozen=True)
class LabOptionContext:
    collection_fee_inputs: tuple[str, ...] = ()
    outpatient_rapid_lab_eligible_test_item_count: int = 0
    outpatient_rapid_lab_same_day_result_explained: bool = False
    outpatient_rapid_lab_written_information_provided: bool = False
    outpatient_rapid_lab_result_based_care_provided: bool = False
    suppress_all_judgement_fees: bool = False
    lab_management_facility_missing_policy: str = "review"


@dataclass(frozen=True)
class OutpatientBasicFeeOptionContext:
    fee_kind: OutpatientBasicFeeKind | None = None
    information_communication_equipment: bool = False
    same_day_second_department: bool = False
    same_day_revisit: bool = False
    large_hospital_no_referral: bool = False


@dataclass(frozen=True)
class MedicationOptionContext:
    delivery_kind: MedicationDeliveryKind | None = None
    prescription_category: MedicationPrescriptionCategory = MedicationPrescriptionCategory.OTHER
    dispensing_kinds: tuple[MedicationDispensingKind, ...] = ()
    refill_prescription: bool = False
    special_pharmacy_relationship: bool = False
    gargle_only: bool = False
    specific_disease_prescription_management: bool = False
    specific_disease_prescription_management_already_billed_same_month: bool = False
    anti_malignant_tumor_prescription_management: bool = False
    anti_malignant_tumor_prescription_management_already_billed_same_month: bool = False
    generic_name_prescription_add_on: GenericNamePrescriptionAddOnKind | None = None


@dataclass(frozen=True)
class InjectionOptionContext:
    route_kind: InjectionRouteKind | None = None
    infant: bool = False
    drip_infusion_outpatient_other: bool = False
    biologic_add_on: bool = False
    narcotic_add_on: bool = False
    precision_continuous_infusion_add_on: bool = False


@dataclass(frozen=True)
class InpatientBasicFeeOptionContext:
    basic_fee_code: str | None = None
    basic_fee_days: int = 1
    facility_standard_key: str | None = None
    ward_kind: str | None = None
    inpatient_basic_code: str | None = None


@dataclass(frozen=True)
class DpcOptionContext:
    dpc_claim: bool = False
    dpc_code: str | None = None
    icd_code: str | None = None
    mdc_code: str | None = None
    classification_code: str | None = None
    main_diagnosis: str | None = None
    resource_diagnosis: str | None = None
    surgery_code: str | None = None
    procedure_code: str | None = None
    comorbidity: str | None = None
    hospital_coefficient: float | None = None
    disease_state_classification: str | None = None
    age_condition: str | None = None
    month_age_condition: str | None = None
    weight_condition: str | None = None
    jcs_condition: str | None = None
    burn_index_condition: str | None = None
    gaf_condition: str | None = None
    pregnancy_weeks_condition: str | None = None
    delivery_bleeding_amount_condition: str | None = None
    surgery_flag: str | None = None
    surgery_procedure_1_flag: str | None = None
    surgery_procedure_2_flag: str | None = None
    defined_comorbidity_flag: str | None = None
    severity_age_condition: str | None = None
    severity_jcs_condition: str | None = None
    unilateral_bilateral_condition: str | None = None
    first_reoperation_condition: str | None = None
    one_eye_both_eyes_condition: str | None = None
    one_side_both_sides_condition: str | None = None
    rehabilitation_condition: str | None = None
    mild_severe_condition: str | None = None
    pre_onset_rankin_scale_condition: str | None = None
    a_drop_score_condition: str | None = None
    transfer_from_other_hospital_ward_condition: str | None = None
    stroke_onset_timing_condition: str | None = None
    child_pugh_classification_condition: str | None = None


@dataclass(frozen=True)
class DataCompletenessContext:
    judgement_history_complete: bool = True
    lab_management_history_complete: bool = True
    collection_fee_history_complete: bool = True
    outpatient_rapid_lab_history_complete: bool = True


@dataclass(frozen=True)
class ClaimContext:
    encounter: EncounterContext
    procedure_codes: tuple[str, ...]
    drug_inputs: tuple[ChargeInput, ...] = ()
    medication_orders: tuple[MedicationOrder, ...] = ()
    injection_drug_inputs: tuple[ChargeInput, ...] = ()
    injection_orders: tuple[InjectionOrder, ...] = ()
    treatment_orders: tuple[TreatmentOrder, ...] = ()
    imaging_orders: tuple[ImagingOrder, ...] = ()
    material_inputs: tuple[ChargeInput, ...] = ()
    comment_inputs: tuple[CommentInput, ...] = ()
    patient: PatientContext = field(default_factory=PatientContext)
    master_sources: MasterSourceContext = field(default_factory=MasterSourceContext)
    history: ClaimHistoryContext = field(default_factory=ClaimHistoryContext)
    lab_options: LabOptionContext = field(default_factory=LabOptionContext)
    outpatient_basic: OutpatientBasicFeeOptionContext = field(default_factory=OutpatientBasicFeeOptionContext)
    medication: MedicationOptionContext = field(default_factory=MedicationOptionContext)
    injection: InjectionOptionContext = field(default_factory=InjectionOptionContext)
    inpatient_basic: InpatientBasicFeeOptionContext = field(default_factory=InpatientBasicFeeOptionContext)
    dpc: DpcOptionContext = field(default_factory=DpcOptionContext)
    data_completeness: DataCompletenessContext = field(default_factory=DataCompletenessContext)
    hospital_profile: HospitalProfile | None = None
    facility_standard_keys: frozenset[str] | None = None


@dataclass(frozen=True)
class CalculationMessage:
    status: ClaimItemStatus
    code: str | None
    message: str
    source: str


@dataclass(frozen=True)
class CalculationLine:
    code: str
    name: str
    points: float
    quantity: float
    status: ClaimItemStatus
    reason: str
    source: str
    calculated_total_points: float | None = None
    coverage_scope: str | None = None
    coverage_chapter: str | None = None
    support_level: str | None = None
    review_required: bool | None = None

    @property
    def total_points(self) -> float:
        if self.calculated_total_points is not None:
            return self.calculated_total_points
        return self.points * self.quantity


@dataclass(frozen=True)
class CalculationResult:
    input_codes: tuple[str, ...]
    lines: tuple[CalculationLine, ...]
    messages: tuple[CalculationMessage, ...] = ()

    @property
    def total_candidate_points(self) -> float:
        return sum(line.total_points for line in self.lines if line.status == ClaimItemStatus.CANDIDATE)

    @property
    def total_confirmed_points(self) -> float:
        return sum(line.total_points for line in self.lines if line.status == ClaimItemStatus.CONFIRMED)

    @property
    def total_points(self) -> float:
        return sum(line.total_points for line in self.lines)

    @property
    def candidate_codes(self) -> tuple[str, ...]:
        return _unique_codes((*self.input_codes, *(line.code for line in self.lines)))


def _unique_codes(codes: tuple[str, ...]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for code in codes:
        normalized = str(code or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return tuple(result)
