"""既存レセ(UKE/レセコンCSV)取込のブリッジAPI(stdin JSON → stdout JSON)。

fee-api(Node)から `python3 -m medical_fee_calculation.baseline_api` で呼び出す。
入力payload:
  {
    "op": "parse_uke" | "parse_csv",
    "text": "<UKE or CSV テキスト>",
    "claim_month": "YYYY-MM",            # parse_uke 必須 / parse_csv は default に使用
    "uke_layout": {...},                  # 任意: UkeLayout の上書き
    "column_map": {...},                  # parse_csv 任意
    "only_medical_institution_code": "",  # parse_csv 任意
    "code_map": {...}                      # 任意
  }
出力:
  { "baselineClaims": [ { "patientId", "claimMonth", "lines": [ {code,name,points,count} ], "totalPoints", "actualDays" } ] }
"""

from __future__ import annotations

import base64
import json
import sys
from dataclasses import asdict

from medical_fee_calculation.baseline_adapter import UkeLayout, parse_receipt_csv, parse_uke


def _claim_to_dict(claim) -> dict:
    return {
        "patientId": claim.patient_id,
        "claimMonth": claim.claim_month,
        "totalPoints": claim.total_points,
        "actualDays": claim.actual_days,
        # 点検(適応/禁忌/算定もれ)向け属性。UKE以外の経路では空のことがある。
        "sex": getattr(claim, "sex", "") or "",
        "birthDate": getattr(claim, "birth_date", "") or "",
        "receiptType": getattr(claim, "receipt_type", "") or "",
        "diseases": [
            {
                "code": d.code,
                "name": d.name,
                "startDate": d.start_date,
                "tenki": d.tenki,
                "suspected": d.suspected,
                "isMain": d.is_main,
            }
            for d in (getattr(claim, "diseases", ()) or ())
        ],
        "lines": [
            {"code": line.code, "name": line.name, "points": line.points, "count": line.count}
            for line in claim.lines
        ],
    }


def parse_baseline(payload: dict) -> dict:
    op = str(payload.get("op") or "").strip()
    text = _decode_text(payload)
    code_map = payload.get("code_map") if isinstance(payload.get("code_map"), dict) else None

    if op == "parse_uke":
        claim_month = str(payload.get("claim_month") or "").strip()
        if not claim_month:
            raise ValueError("claim_month is required for parse_uke")
        layout_overrides = payload.get("uke_layout") if isinstance(payload.get("uke_layout"), dict) else {}
        layout = UkeLayout(**{**asdict(UkeLayout()), **_coerce_layout(layout_overrides)}) if layout_overrides else UkeLayout()
        claims = parse_uke(text, claim_month=claim_month, layout=layout, code_map=code_map)
    elif op == "parse_csv":
        claims = parse_receipt_csv(
            text,
            column_map=payload.get("column_map") if isinstance(payload.get("column_map"), dict) else None,
            only_claim_month=payload.get("only_claim_month") or None,
            only_medical_institution_code=payload.get("only_medical_institution_code") or None,
            default_claim_month=payload.get("claim_month") or None,
            code_map=code_map,
        )
    else:
        raise ValueError(f"unknown op: {op!r}")

    return {"baselineClaims": [_claim_to_dict(claim) for claim in claims]}


def _decode_text(payload: dict) -> str:
    encoded = str(payload.get("content_base64") or payload.get("baselineContentBase64") or "").strip()
    if not encoded:
        return str(payload.get("text") or "")

    raw = base64.b64decode(encoded, validate=True)
    encoding = _normalize_encoding(payload.get("encoding") or payload.get("baseline_encoding") or "auto")
    candidates = [encoding] if encoding != "auto" else ["utf-8-sig", "cp932", "shift_jis"]
    last_error: UnicodeDecodeError | None = None
    for candidate in candidates:
        try:
            return raw.decode(candidate)
        except UnicodeDecodeError as exc:
            last_error = exc
    raise ValueError("baseline content could not be decoded") from last_error


def _normalize_encoding(value) -> str:
    normalized = str(value or "auto").strip().lower().replace("_", "-")
    aliases = {
        "": "auto",
        "auto": "auto",
        "utf8": "utf-8-sig",
        "utf-8": "utf-8-sig",
        "utf-8-sig": "utf-8-sig",
        "cp932": "cp932",
        "ms932": "cp932",
        "sjis": "shift_jis",
        "shiftjis": "shift_jis",
        "shift-jis": "shift_jis",
    }
    if normalized not in aliases:
        raise ValueError(f"unsupported encoding: {value!r}")
    return aliases[normalized]


def _coerce_layout(overrides: dict) -> dict:
    coerced = dict(overrides)
    if "line_records" in coerced and not isinstance(coerced["line_records"], frozenset):
        coerced["line_records"] = frozenset(coerced["line_records"])
    return coerced


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = parse_baseline(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc

    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
