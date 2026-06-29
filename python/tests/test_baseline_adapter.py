import base64

from medical_fee_calculation.baseline_adapter import (
    UkeLayout,
    parse_receipt_csv,
    parse_uke,
)


UKE_SAMPLE = "\r\n".join([
    "IR,1,13,1,1234567,,西山病院,5 08 06",
    "RE,1,1112,患者A,1,3 50 06 15,30",
    "HO,01130012,キ,12345,,2,206,620",
    "SI,11,1,112007410,,73,2",
    "SI,11,1,113001810,,225,1",
    "RE,2,1112,患者B,2,3 40 01 02,30",
    "HO,01130012,ロ,67890,,1,73,220",
    "SI,11,1,112007410,,73,1",
]) + "\r\n"


def test_parse_uke_splits_receipts_and_lines():
    claims = parse_uke(UKE_SAMPLE, claim_month="2026-06")
    assert len(claims) == 2
    a = claims[0]
    assert a.patient_id == "患者A"
    assert a.claim_month == "2026-06"
    assert {line.code for line in a.lines} == {"112007410", "113001810"}
    revisit = next(line for line in a.lines if line.code == "112007410")
    assert revisit.points == 73 and revisit.count == 2
    assert a.total_points == 206  # HO points
    assert a.actual_days == 2  # HO days


def test_parse_uke_custom_layout_and_code_map():
    claims = parse_uke(UKE_SAMPLE, claim_month="2026-06", code_map={"112007410": "RE_VISIT"})
    codes = {line.code for claim in claims for line in claim.lines}
    assert "RE_VISIT" in codes
    assert "112007410" not in codes


CSV_SAMPLE = """pid,month,mic,santei_code,santei_name,ten,kaisu
patA,2026-06,1234567,112007410,再診料,73,2
patA,2026-06,1234567,113001810,特定疾患療養管理料,225,1
patB,2026-06,9999999,112007410,再診料,73,1
patC,2026-05,1234567,112007410,再診料,73,1
"""

CSV_MAP = {
    "patient_id": "pid",
    "claim_month": "month",
    "medical_institution_code": "mic",
    "code": "santei_code",
    "name": "santei_name",
    "points": "ten",
    "count": "kaisu",
}


def test_parse_receipt_csv_groups_by_patient_month():
    claims = parse_receipt_csv(CSV_SAMPLE, column_map=CSV_MAP)
    keyed = {(c.patient_id, c.claim_month): c for c in claims}
    assert ("patA", "2026-06") in keyed
    assert len(keyed[("patA", "2026-06")].lines) == 2


def test_parse_receipt_csv_scope_filters():
    claims = parse_receipt_csv(
        CSV_SAMPLE,
        column_map=CSV_MAP,
        only_claim_month="2026-06",
        only_medical_institution_code="1234567",
    )
    keys = {(c.patient_id, c.claim_month) for c in claims}
    # 他院(patB:9999999)と他月(patC:2026-05)は除外される
    assert keys == {("patA", "2026-06")}


def test_csv_to_diagnosis_endtoend():
    from medical_fee_calculation.baseline_diagnosis import ClaimLine, EngineClaim, diagnose_claim, CATEGORY_MISSING
    baseline = parse_receipt_csv(CSV_SAMPLE, column_map=CSV_MAP, only_claim_month="2026-06", only_medical_institution_code="1234567")[0]
    engine = EngineClaim(patient_id="patA", claim_month="2026-06", lines=(
        ClaimLine(code="112007410", name="再診料", points=73, count=2),
        ClaimLine(code="113001810", name="特定疾患療養管理料", points=225, count=1),
        ClaimLine(code="120002910", name="処方箋料", points=60, count=1),
    ))
    diag = diagnose_claim(baseline, engine)
    missing = {f.code for f in diag.findings_in(CATEGORY_MISSING)}
    assert "120002910" in missing  # 既存に無い処方箋料が算定もれ候補


def test_baseline_api_decodes_cp932_base64_csv():
    from medical_fee_calculation.baseline_api import parse_baseline
    csv_text = "patient_id,claim_month,code,name,points,count\npatA,2026-06,112007410,再診料,73,1\n"
    payload = {
        "op": "parse_csv",
        "content_base64": base64.b64encode(csv_text.encode("cp932")).decode("ascii"),
        "encoding": "auto",
        "claim_month": "2026-06",
        "only_claim_month": "2026-06",
    }

    result = parse_baseline(payload)

    assert result["baselineClaims"][0]["patientId"] == "patA"
    assert result["baselineClaims"][0]["lines"][0]["name"] == "再診料"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok: {name}")
    print("all baseline_adapter tests passed")
