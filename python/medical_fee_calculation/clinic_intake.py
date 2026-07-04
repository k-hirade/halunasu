"""断片データ取込（患者/病名/処方/検体/処置/リハビリ 等の別ファイル → 患者×月の正規化claim）。

先方（PrimeKarte/ML-A）はカルテを統合出力できず、種別ごとに別CSVで出る。
これらを列マッピング（intake-map）で吸収し、点検（fee-core claim-checks）と
baseline-diff が食える「患者×月のclaim」へ束ねる。

出力（JSONL, 1行=1 claim）:
  { "patientKey": "...", "claimMonth": "2026-09", "sex": "1", "ageYears": 68,
    "isInpatient": false,
    "items":    [{ "code": "...", "name": "...", "recType": "SI|IY|TO", "date": "2026-09-03", "count": 1 }],
    "diseases": [{ "code": "...", "name": "...", "suspected": false,
                   "startDate": "2026-01-10", "tenki": "1", "isMain": true }] }

intake-map（列マッピング。形式差をコード改修せず設定で吸収）:
  { "encoding": "cp932",
    "patients":   { "path": "patients.deid.csv",
                    "columns": { "patientKey": "患者ID", "sex": "性別", "ageYears": "生年月日" } },
    "diagnosis":  { "path": "diagnosis.deid.csv",
                    "columns": { "patientKey": "患者ID", "code": "傷病名コード", "name": "傷病名",
                                 "startDate": "診療開始日", "tenki": "転帰", "isMain": "主傷病", "suspected": "" } },
    "orders": [   { "path": "processing.deid.csv", "recType": "SI",
                    "columns": { "patientKey": "患者ID", "code": "診療行為コード", "name": "名称",
                                 "date": "実施日", "count": "回数" } },
                  { "path": "drug.deid.csv", "recType": "IY",
                    "columns": { "patientKey": "患者ID", "code": "医薬品コード", "name": "名称",
                                 "date": "実施日", "count": "回数" } } ] }
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

_SUSPECT_RE = re.compile(r"疑い|の疑い")
_TRUE_TOKENS = {"1", "true", "yes", "y", "○", "主", "疑い", "の疑い"}


def _read_csv(path: Path, encoding: str) -> list[dict[str, str]]:
    with open(path, encoding=encoding, errors="replace", newline="") as fh:
        return [dict(r) for r in csv.DictReader(fh)]


def _get(row: dict[str, str], columns: dict[str, str], logical: str) -> str:
    source = columns.get(logical)
    if not source:
        return ""
    return str(row.get(source, "") or "").strip()


def _to_month(value: str) -> str:
    text = str(value or "").strip()
    m = re.fullmatch(r"(\d{4})\D?(\d{1,2}).*", text)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}"
    return ""


def _truthy(value: str) -> bool:
    return str(value or "").strip().lower() in _TRUE_TOKENS


def _int_or_none(value: str) -> int | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def build_claims(intake_map: dict[str, Any], input_dir: Path) -> list[dict[str, Any]]:
    encoding = intake_map.get("encoding", "cp932")

    # 患者属性(擬似ID → sex/age)
    patient_attrs: dict[str, dict[str, Any]] = {}
    patients_spec = intake_map.get("patients")
    if patients_spec:
        cols = patients_spec.get("columns", {})
        for row in _read_csv(input_dir / patients_spec["path"], encoding):
            key = _get(row, cols, "patientKey")
            if not key:
                continue
            patient_attrs[key] = {
                "sex": _get(row, cols, "sex"),
                "ageYears": _int_or_none(_get(row, cols, "ageYears")),
                "isInpatient": _truthy(_get(row, cols, "isInpatient")),
            }

    # claim = (patientKey, claimMonth) 単位に束ねる
    claims: dict[tuple[str, str], dict[str, Any]] = {}

    def claim_for(key: str, month: str) -> dict[str, Any]:
        ck = (key, month)
        if ck not in claims:
            attrs = patient_attrs.get(key, {})
            claims[ck] = {
                "patientKey": key,
                "claimMonth": month,
                "sex": attrs.get("sex", ""),
                "ageYears": attrs.get("ageYears"),
                "isInpatient": bool(attrs.get("isInpatient", False)),
                "items": [],
                "diseases": [],
                "_diseaseSeen": set(),
            }
        return claims[ck]

    # 病名(claimMonthは診療開始日の月。月をまたぐ継続病名は各月に効かせたいが、
    #  PoCでは開始月のclaimに載せ、点検側は同一患者の病名を突合する運用に寄せる)
    diagnosis_spec = intake_map.get("diagnosis")
    diseases_by_patient: dict[str, list[dict[str, Any]]] = {}
    if diagnosis_spec:
        cols = diagnosis_spec.get("columns", {})
        for row in _read_csv(input_dir / diagnosis_spec["path"], encoding):
            key = _get(row, cols, "patientKey")
            if not key:
                continue
            name = _get(row, cols, "name")
            suspected = _truthy(_get(row, cols, "suspected")) or bool(_SUSPECT_RE.search(name))
            disease = {
                "code": _get(row, cols, "code"),
                "name": name,
                "suspected": suspected,
                "startDate": _get(row, cols, "startDate"),
                "tenki": _get(row, cols, "tenki"),
                "isMain": _truthy(_get(row, cols, "isMain")),
            }
            diseases_by_patient.setdefault(key, []).append(disease)

    # オーダ(処置/医薬品/検体/リハビリ 等) → items。claimMonthは実施日の月。
    for order_spec in intake_map.get("orders", []) or []:
        cols = order_spec.get("columns", {})
        rec_type = order_spec.get("recType", "SI")
        for row in _read_csv(input_dir / order_spec["path"], encoding):
            key = _get(row, cols, "patientKey")
            code = _get(row, cols, "code")
            if not key or not code:
                continue
            date = _get(row, cols, "date")
            month = _to_month(date)
            if not month:
                continue
            claim = claim_for(key, month)
            claim["items"].append({
                "code": code,
                "name": _get(row, cols, "name"),
                "recType": rec_type,
                "date": date,
                "count": _int_or_none(_get(row, cols, "count")) or 1,
            })

    # 各claimに、その患者の病名を「その請求月に有効な範囲」で付与する。
    # - 開始月が請求月より後の病名は付与しない（未来の病名で適応を満たしてしまい IY-001/SI-001 を見逃すのを防ぐ）。
    # - 転帰が付く病名(治ゆ2/死亡3/中止4)は、include_resolved=False のとき除外できる
    #   （終了済み病名での禁忌の過剰警告を抑える。転帰日が無いため月粒度の近似）。
    include_resolved = bool(intake_map.get("includeResolvedDiseases", True))
    resolved_tenki = {"2", "3", "4"}
    for (key, month), claim in claims.items():
        for disease in diseases_by_patient.get(key, []):
            start_month = _to_month(disease.get("startDate", ""))
            if start_month and start_month > month:
                continue  # 請求月より後に開始した病名は対象外
            if not include_resolved and str(disease.get("tenki", "")).strip() in resolved_tenki:
                continue  # 終了済み病名を除外する設定
            claim["diseases"].append(disease)

    result = []
    for claim in claims.values():
        claim.pop("_diseaseSeen", None)
        result.append(claim)
    result.sort(key=lambda c: (c["patientKey"], c["claimMonth"]))
    return result


def _iter_jsonl(claims: Iterable[dict[str, Any]]) -> Iterable[str]:
    for claim in claims:
        yield json.dumps(claim, ensure_ascii=False, separators=(",", ":"))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="断片データ取込 → 患者×月の正規化claim(JSONL)")
    parser.add_argument("--map", required=True, help="列マッピング(intake-map.json)")
    parser.add_argument("--input", required=True, help="匿名化済みCSVのディレクトリ")
    parser.add_argument("--output", required=True, help="出力JSONL")
    args = parser.parse_args(argv)

    intake_map = json.loads(Path(args.map).read_text(encoding="utf-8"))
    claims = build_claims(intake_map, Path(args.input))
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(_iter_jsonl(claims)) + ("\n" if claims else ""), encoding="utf-8")
    print(f"claim {len(claims)}件 → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
