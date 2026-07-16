"""レセ点検用のマスタ参照(check_lookup)。

コード群を1リクエストで受け取り、点検(適応/禁忌/併用/病名整備)に必要なマスタ行を返す。
算定本体には関与しない。worker の op=check_lookup と、spawn フォールバック(__main__)の両方から使う。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.name_scan import strip_parenthetical_qualifiers

# 傷病名を条件としない特殊コード(支払基金チェックマスタ)。適応判定の対象外。
NON_DISEASE_CODES = frozenset({"0000000", "0000001", "0000002", "0000003"})


def check_lookup(payload: dict[str, Any]) -> dict[str, Any]:
    db_path = payload.get("db_path") or os.environ.get("FEE_MASTER_DB_PATH")
    if not db_path:
        raise ValueError("db_path or FEE_MASTER_DB_PATH is required")

    drug_codes = _clean_codes(payload.get("drug_codes"))
    act_codes = _clean_codes(payload.get("act_codes"))
    disease_codes = _clean_codes(payload.get("disease_codes"))

    conn = connect(Path(str(db_path)))
    try:
        initialize_schema(conn)
        drug_indications = {c: _drug_indications(conn, c) for c in drug_codes}
        drug_dose_rules = {c: _drug_dose_rules(conn, c) for c in drug_codes}
        drug_dose_groups = {c: _drug_dose_groups(conn, c) for c in drug_codes}
        drug_contra = {c: _drug_contra(conn, c) for c in drug_codes}
        act_indications = {c: _act_indications(conn, c) for c in act_codes}
        interactions = _interaction_pairs(conn, drug_codes)

        # diseaseNames は「患者の病名」だけでなく、適応/禁忌マスタ側が参照する病名コードも名称化する。
        # (適応漏れ時の候補病名は drugIndications/actIndications 側にしか現れないため、
        #  これを名称化しないと点検メッセージが病名コードのまま表示される。)
        name_codes: set[str] = set(disease_codes)
        for rows in drug_indications.values():
            name_codes.update(str(r.get("diseaseCode") or "") for r in rows)
        for rows in drug_dose_rules.values():
            name_codes.update(str(r.get("diseaseCode") or "") for r in rows)
        for rows in drug_dose_groups.values():
            name_codes.update(str(r.get("diseaseCode") or "") for r in rows)
        for rows in act_indications.values():
            name_codes.update(str(r.get("diseaseCode") or "") for r in rows)
        for codes in drug_contra.values():
            name_codes.update(codes)
        name_codes.discard("")

        return {
            "drugIndications": drug_indications,
            "drugDoseRules": drug_dose_rules,
            "drugDoseGroups": drug_dose_groups,
            "drugContraDiseases": drug_contra,
            "drugInteractions": interactions,
            "actIndications": act_indications,
            "diseaseNames": _disease_names(conn, sorted(name_codes)),
            # 算定もれ点検(検査判断料)のため、診療行為コードの判断区分メタも返す。
            "procedureMeta": _procedure_meta(conn, act_codes),
            # 電子点数表由来の制約。候補提示側での回数上限(月1回等)の重複排除と
            # 背反(併算定不可)注釈に使う。判定不能でも点検は継続できる補助情報。
            "actFrequencyLimits": _act_frequency_limits(conn, act_codes),
            "actExclusions": _act_exclusion_pairs(conn, act_codes),
        }
    finally:
        conn.close()


def _procedure_meta(conn: Any, codes: list[str]) -> dict[str, dict[str, str]]:
    codes = [c for c in codes if c]
    if not codes:
        return {}
    placeholders = ",".join("?" for _ in codes)
    try:
        rows = conn.execute(
            f"""
            SELECT code, judgement_kind, judgement_group, bundle_lab_group, short_name
            FROM medical_procedures
            WHERE code IN ({placeholders})
            """,
            codes,
        ).fetchall()
    except Exception:  # noqa: BLE001 - メタは点検補助。失敗しても他は返す。
        return {}
    meta: dict[str, dict[str, str]] = {}
    for row in rows:
        code = str(row["code"])
        if code in meta:
            continue
        meta[code] = {
            "judgementKind": str(row["judgement_kind"] or "").strip(),
            "judgementGroup": str(row["judgement_group"] or "").strip().lstrip("0"),
            "bundleLabGroup": str(row["bundle_lab_group"] or "").strip(),
            "name": str(row["short_name"] or "").strip(),
        }
    return meta


def _act_frequency_limits(conn: Any, codes: list[str]) -> dict[str, list[dict[str, Any]]]:
    codes = [c for c in codes if c]
    if not codes:
        return {}
    placeholders = ",".join("?" for _ in codes)
    try:
        rows = conn.execute(
            f"""
            SELECT procedure_code, limit_code, limit_name, raw_row_json
            FROM electronic_frequency_limits
            WHERE procedure_code IN ({placeholders})
            """,
            codes,
        ).fetchall()
    except Exception:  # noqa: BLE001 - 制約は候補提示の補助。失敗しても他は返す。
        return {}
    limits: dict[str, list[dict[str, Any]]] = {}
    seen: set[tuple[str, str]] = set()
    for row in rows:
        code = str(row["procedure_code"] or "")
        unit_code = str(row["limit_code"] or "")
        if not code or (code, unit_code) in seen:
            continue
        seen.add((code, unit_code))
        max_count = None
        try:
            raw = json.loads(row["raw_row_json"] or "[]")
            # 電子点数表 算定回数テーブル: [5]=上限回数
            max_count = int(str(raw[5]).strip() or "0") if len(raw) > 5 else None
        except Exception:  # noqa: BLE001
            max_count = None
        limits.setdefault(code, []).append(
            {
                "unitCode": unit_code,
                "unit": str(row["limit_name"] or ""),
                "maxCount": max_count if max_count and max_count > 0 else None,
            }
        )
    return limits


def _act_exclusion_pairs(conn: Any, codes: list[str]) -> list[dict[str, str]]:
    codes = sorted({c for c in codes if c})
    if len(codes) < 2:
        return []
    placeholders = ",".join("?" for _ in codes)
    try:
        rows = conn.execute(
            f"""
            SELECT exclusion_table, base_code, base_name, excluded_code, excluded_name, rule_kind
            FROM electronic_exclusions
            WHERE base_code IN ({placeholders}) AND excluded_code IN ({placeholders})
            """,
            codes + codes,
        ).fetchall()
    except Exception:  # noqa: BLE001 - 制約は候補提示の補助。失敗しても他は返す。
        return []
    seen: set[tuple[str, str, str]] = set()
    out: list[dict[str, str]] = []
    for row in rows:
        base = str(row["base_code"] or "")
        excluded = str(row["excluded_code"] or "")
        table = str(row["exclusion_table"] or "")
        key = (table, base, excluded)
        if not base or not excluded or base == excluded or key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "exclusionTable": table,
                "baseCode": base,
                "baseName": str(row["base_name"] or ""),
                "excludedCode": excluded,
                "excludedName": str(row["excluded_name"] or ""),
                "ruleKind": str(row["rule_kind"] or ""),
            }
        )
    return out


def _clean_codes(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in value:
        code = str(item or "").strip()
        if code and code not in seen:
            seen.add(code)
            out.append(code)
    return out


def _drug_indications(conn: Any, drug_code: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT disease_code, sex, age_min, age_max
        FROM cc_drug_indications
        WHERE drug_code = ?
          AND disease_code IS NOT NULL
          AND disease_code NOT IN ('0000000','0000001','0000002','0000003')
        """,
        (drug_code,),
    ).fetchall()
    return [
        {
            "diseaseCode": str(r["disease_code"] or ""),
            "sex": str(r["sex"] or ""),
            "ageMin": r["age_min"],
            "ageMax": r["age_max"],
        }
        for r in rows
    ]


def _drug_dose_rules(conn: Any, drug_code: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT disease_code, sex, age_min, age_max, check_kubun, max_dose, max_days, tekigi, ref_range
        FROM cc_drug_indications
        WHERE drug_code = ?
          AND (
            (max_dose IS NOT NULL AND max_dose < 99999.0)
            OR (max_days IS NOT NULL AND max_days < 999)
          )
        """,
        (drug_code,),
    ).fetchall()
    return [
        {
            "diseaseCode": str(r["disease_code"] or ""),
            "sex": str(r["sex"] or ""),
            "ageMin": r["age_min"],
            "ageMax": r["age_max"],
            "checkKubun": str(r["check_kubun"] or ""),
            "maxDose": r["max_dose"],
            "maxDays": r["max_days"],
            "tekigi": str(r["tekigi"] or ""),
            "refRange": str(r["ref_range"] or ""),
        }
        for r in rows
    ]


def _drug_dose_groups(conn: Any, drug_code: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT group_name, unit, disease_code, sex, age_min, age_max,
               ingredient_amount, target_flag, max_dose, ref_range
        FROM cc_drug_dose_groups
        WHERE drug_code = ?
          AND max_dose IS NOT NULL
          AND max_dose < 99999999.0
        """,
        (drug_code,),
    ).fetchall()
    return [
        {
            "groupName": str(r["group_name"] or ""),
            "unit": str(r["unit"] or ""),
            "diseaseCode": str(r["disease_code"] or ""),
            "sex": str(r["sex"] or ""),
            "ageMin": r["age_min"],
            "ageMax": r["age_max"],
            "ingredientAmount": r["ingredient_amount"],
            "targetFlag": str(r["target_flag"] or ""),
            "maxDose": r["max_dose"],
            "refRange": str(r["ref_range"] or ""),
        }
        for r in rows
    ]


def _drug_contra(conn: Any, drug_code: str) -> list[str]:
    rows = conn.execute(
        "SELECT disease_code FROM cc_drug_contra_disease WHERE drug_code = ?",
        (drug_code,),
    ).fetchall()
    return [str(r["disease_code"] or "") for r in rows if str(r["disease_code"] or "").strip()]


def _interaction_pairs(conn: Any, drug_codes: list[str]) -> list[list[str]]:
    codes = sorted(set(drug_codes))
    if len(codes) < 2:
        return []
    placeholders = ",".join("?" for _ in codes)
    rows = conn.execute(
        f"""
        SELECT drug_a, drug_b FROM cc_drug_interactions
        WHERE drug_a IN ({placeholders}) AND drug_b IN ({placeholders})
        """,
        codes + codes,
    ).fetchall()
    seen: set[tuple[str, str]] = set()
    out: list[list[str]] = []
    for r in rows:
        key = tuple(sorted((str(r["drug_a"] or ""), str(r["drug_b"] or ""))))
        if key[0] and key[1] and key not in seen:
            seen.add(key)
            out.append([key[0], key[1]])
    return out


def _act_indications(conn: Any, act_code: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT disease_code, sex, age_min, age_max, nyugai, utagai
        FROM cc_act_indications
        WHERE act_code = ?
          AND disease_code IS NOT NULL
          AND disease_code NOT IN ('0000000','0000001','0000002','0000003')
        """,
        (act_code,),
    ).fetchall()
    return [
        {
            "diseaseCode": str(r["disease_code"] or ""),
            "sex": str(r["sex"] or ""),
            "ageMin": r["age_min"],
            "ageMax": r["age_max"],
            "nyugai": str(r["nyugai"] or ""),
            "utagai": str(r["utagai"] or ""),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# 病名コード化(name -> 傷病名コード)。カルテ由来の名称主体の病名を標準コードへ寄せ、
# 適応/禁忌点検(コード照合)を実効化する。recept-checker(search_diseases_by_name /
# decompose_uncoded_name)を halunasu の diseases/disease_modifiers へ移植。
# ---------------------------------------------------------------------------

_ACTIVE_DISEASE_FILTER = "(effective_to = '99999999' OR effective_to = '' OR effective_to IS NULL)"


def resolve_diseases(payload: dict[str, Any]) -> dict[str, Any]:
    db_path = payload.get("db_path") or os.environ.get("FEE_MASTER_DB_PATH")
    if not db_path:
        raise ValueError("db_path or FEE_MASTER_DB_PATH is required")
    names = payload.get("names")
    names = names if isinstance(names, list) else []

    conn = connect(Path(str(db_path)))
    try:
        initialize_schema(conn)
        modifiers = _load_modifiers(conn)
        resolved: dict[str, Any] = {}
        for raw in names:
            name = str(raw or "").strip()
            if not name or name in resolved:
                continue
            resolved[name] = _resolve_one_disease(conn, modifiers, name)
        return {"resolved": resolved}
    finally:
        conn.close()


def disease_act_candidates(payload: dict[str, Any]) -> dict[str, Any]:
    """病名から支払基金チェックマスタの適応診療行為を決定論的に逆引きする。

    ``nyugai`` / ``utagai`` の値意味は、支払基金「コンピュータチェック対象
    事例ファイル仕様書」に基づいて実ファイル検証済みの移植元
    ``services/recept-checker/receipt_checker/rules/r05_act_indication.py`` に従う。
    nyugai は 0=共通・1=入院・2=入院外、utagai は
    0=確定/疑い可・1=確定のみ・2=疑いのみである。

    これは自動算定ではなく確認候補の生成用であり、対象病名だけで実施事実を
    確定しない。
    """
    db_path = payload.get("db_path") or os.environ.get("FEE_MASTER_DB_PATH")
    if not db_path:
        raise ValueError("db_path or FEE_MASTER_DB_PATH is required")

    diagnoses = payload.get("diagnoses")
    diagnoses = diagnoses if isinstance(diagnoses, list) else []
    prefixes = _clean_act_prefixes(payload.get("act_code_prefixes"))
    if not diagnoses or not prefixes:
        return {"candidates": [], "unresolvedNames": [], "resolvedNames": []}

    setting = str(payload.get("setting") or "").strip().lower()
    patient_age = _optional_float(payload.get("patient_age"))
    patient_sex = _normalize_patient_sex(payload.get("patient_sex"))
    service_date = _date_key(payload.get("service_date"))
    limit = max(1, min(int(payload.get("limit") or 12), 50))

    conn = connect(Path(str(db_path)))
    try:
        initialize_schema(conn)
        modifiers = _load_modifiers(conn)
        resolved_diagnoses: list[dict[str, Any]] = []
        unresolved_names: list[str] = []
        seen_names: set[str] = set()
        for raw in diagnoses:
            diagnosis = raw if isinstance(raw, dict) else {"name": raw}
            name = str(diagnosis.get("name") or diagnosis.get("displayName") or "").strip()
            if not name or name in seen_names:
                continue
            seen_names.add(name)
            resolution = _resolve_one_disease(conn, modifiers, name)
            code = str(resolution.get("code") or "").strip()
            if not code:
                unresolved_names.append(name)
                continue
            suspected = bool(
                diagnosis.get("suspected") is True
                or str(diagnosis.get("status") or "").strip().lower() == "suspected"
                or resolution.get("suspected") is True
                or name.endswith("の疑い")
            )
            resolved_diagnoses.append({"name": name, "code": code, "suspected": suspected})

        if not resolved_diagnoses:
            return {
                "candidates": [],
                "unresolvedNames": sorted(unresolved_names),
                "resolvedNames": [],
            }

        disease_codes = sorted({item["code"] for item in resolved_diagnoses})
        disease_placeholders = ",".join("?" for _ in disease_codes)
        prefix_sql = " OR ".join("act_code LIKE ?" for _ in prefixes)
        rows = conn.execute(
            f"""
            SELECT DISTINCT act_code, disease_code, sex, age_min, age_max, nyugai, utagai
            FROM cc_act_indications
            WHERE disease_code IN ({disease_placeholders})
              AND disease_code NOT IN ('0000000','0000001','0000002','0000003')
              AND ({prefix_sql})
            """,
            [*disease_codes, *(f"{prefix}%" for prefix in prefixes)],
        ).fetchall()

        diagnoses_by_code: dict[str, list[dict[str, Any]]] = {}
        for diagnosis in resolved_diagnoses:
            diagnoses_by_code.setdefault(diagnosis["code"], []).append(diagnosis)

        matched_by_act: dict[str, set[str]] = {}
        for row in rows:
            if not _act_indication_patient_matches(row, patient_sex, patient_age, setting):
                continue
            for diagnosis in diagnoses_by_code.get(str(row["disease_code"] or ""), []):
                if not _act_indication_suspicion_matches(str(row["utagai"] or ""), diagnosis["suspected"]):
                    continue
                act_code = str(row["act_code"] or "").strip()
                if act_code:
                    matched_by_act.setdefault(act_code, set()).add(diagnosis["name"])

        procedure_rows = _procedure_rows_for_candidates(conn, sorted(matched_by_act), service_date)
        families: dict[str, dict[str, Any]] = {}
        for row in procedure_rows:
            code = str(row["code"] or "").strip()
            name = str(row["short_name"] or "").strip()
            if not code or not name or "加算" in name:
                continue
            family_name = strip_parenthetical_qualifiers(name).strip() or name
            family = families.setdefault(family_name, {
                "familyName": family_name,
                "codes": {},
                "matchedDiseases": set(),
            })
            family["codes"][code] = {
                "code": code,
                "name": name,
                "points": float(row["points"] or 0),
            }
            family["matchedDiseases"].update(matched_by_act.get(code, set()))

        candidates: list[dict[str, Any]] = []
        for family_name in sorted(families):
            family = families[family_name]
            codes = sorted(
                family["codes"].values(),
                key=lambda item: (-float(item["points"] or 0), item["code"]),
            )[:8]
            candidates.append({
                "familyName": family_name,
                "codes": codes,
                "matchedDiseases": sorted(family["matchedDiseases"]),
            })
            if len(candidates) >= limit:
                break

        return {
            "candidates": candidates,
            "unresolvedNames": sorted(unresolved_names),
            "resolvedNames": sorted(item["name"] for item in resolved_diagnoses),
        }
    finally:
        conn.close()


def _clean_act_prefixes(value: Any) -> list[str]:
    values = value if isinstance(value, list) else []
    return sorted({str(item or "").strip() for item in values if str(item or "").strip().isdigit()})[:12]


def _optional_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _normalize_patient_sex(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"1", "male", "m", "男", "男性"}:
        return "1"
    if normalized in {"2", "female", "f", "女", "女性"}:
        return "2"
    return ""


def _act_indication_patient_matches(row: Any, patient_sex: str, patient_age: float | None, setting: str) -> bool:
    row_sex = str(row["sex"] or "0").strip() or "0"
    if patient_sex and row_sex not in {"0", patient_sex}:
        return False
    age_min = _optional_float(row["age_min"])
    age_max = _optional_float(row["age_max"])
    if patient_age is not None:
        if age_min is not None and age_min > 0 and patient_age < age_min:
            return False
        if age_max is not None and age_max < 999 and patient_age > age_max:
            return False
    nyugai = str(row["nyugai"] or "0").strip() or "0"
    if nyugai == "1" and setting != "inpatient":
        return False
    if nyugai == "2" and setting == "inpatient":
        return False
    return True


def _act_indication_suspicion_matches(utagai: str, suspected: bool) -> bool:
    normalized = str(utagai or "0").strip() or "0"
    if suspected:
        return normalized in {"0", "2"}
    return normalized in {"0", "1"}


def _date_key(value: Any) -> str:
    return "".join(char for char in str(value or "") if char.isdigit())[:8]


def _procedure_rows_for_candidates(conn: Any, codes: list[str], service_date: str) -> list[Any]:
    if not codes:
        return []
    placeholders = ",".join("?" for _ in codes)
    rows = conn.execute(
        f"""
        SELECT code, short_name, points, effective_from, effective_to
        FROM medical_procedures
        WHERE source_id = (
            SELECT id FROM master_sources
            WHERE source_type = 'medical_procedure_master'
            ORDER BY imported_at DESC, id DESC LIMIT 1
        )
          AND code IN ({placeholders})
        """,
        codes,
    ).fetchall()
    if not service_date:
        return list(rows)
    result = []
    for row in rows:
        effective_from = _date_key(row["effective_from"])
        effective_to = _date_key(row["effective_to"])
        if effective_from and service_date < effective_from:
            continue
        if effective_to and effective_to != "99999999" and service_date > effective_to:
            continue
        result.append(row)
    return result


def _load_modifiers(conn: Any) -> list[tuple[str, str]]:
    rows = conn.execute(
        "SELECT code, name FROM disease_modifiers WHERE name IS NOT NULL AND name <> '' "
        "ORDER BY LENGTH(name) DESC"
    ).fetchall()
    return [(str(r["code"] or ""), str(r["name"] or "")) for r in rows]


def _search_disease_by_name(conn: Any, text: str, limit: int = 5) -> list[tuple[str, str, str]]:
    text = (text or "").strip()
    if not text:
        return []
    rows = conn.execute(
        f"SELECT code, name FROM diseases WHERE name = ? AND {_ACTIVE_DISEASE_FILTER} LIMIT ?",
        (text, limit),
    ).fetchall()
    if rows:
        return [(str(r["code"] or ""), str(r["name"] or ""), "exact") for r in rows]
    rows = conn.execute(
        f"SELECT code, name FROM diseases WHERE name LIKE ? AND {_ACTIVE_DISEASE_FILTER} "
        "ORDER BY LENGTH(name) LIMIT ?",
        (f"%{text}%", limit),
    ).fetchall()
    return [(str(r["code"] or ""), str(r["name"] or ""), "partial") for r in rows]


def _resolve_one_disease(conn: Any, modifiers: list[tuple[str, str]], name: str) -> dict[str, Any]:
    suspected = "疑い" in name
    prefixes: list[list[str]] = []
    suffixes: list[list[str]] = []
    core = name

    def is_exact(text: str) -> bool:
        cands = _search_disease_by_name(conn, text, limit=1)
        return bool(cands) and cands[0][2] == "exact"

    while core and not is_exact(core):
        stripped = False
        for code, mod_name in modifiers:
            if not mod_name:
                continue
            if code.startswith("8"):  # 接尾語(の疑い 等)
                if core.endswith(mod_name) and len(core) > len(mod_name):
                    suffixes.insert(0, [code, mod_name])
                    if "疑い" in mod_name or code == "8002":
                        suspected = True
                    core = core[: -len(mod_name)]
                    stripped = True
                    break
            else:  # 接頭語(急性 等)
                if core.startswith(mod_name) and len(core) > len(mod_name):
                    prefixes.append([code, mod_name])
                    core = core[len(mod_name):]
                    stripped = True
                    break
        if not stripped:
            break

    candidates = _search_disease_by_name(conn, core)
    best = candidates[0] if candidates else None
    return {
        "code": best[0] if best else "",
        "matchedName": best[1] if best else "",
        "matchType": best[2] if best else "none",
        "suspected": suspected,
        "core": core,
        "prefixes": prefixes,
        "suffixes": suffixes,
        "candidates": [[c, n, t] for (c, n, t) in candidates],
    }


def _disease_names(conn: Any, disease_codes: list[str]) -> dict[str, str]:
    codes = [c for c in disease_codes if c]
    if not codes:
        return {}
    placeholders = ",".join("?" for _ in codes)
    rows = conn.execute(
        f"SELECT code, name FROM diseases WHERE code IN ({placeholders})",
        codes,
    ).fetchall()
    out: dict[str, str] = {}
    for r in rows:
        code = str(r["code"] or "")
        if code and code not in out:
            out[code] = str(r["name"] or "")
    return out


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        op = str(payload.get("op") or payload.get("operation") or "check_lookup").strip()
        if op == "resolve_diseases":
            result = resolve_diseases(payload)
        elif op == "disease_act_candidates":
            result = disease_act_candidates(payload)
        else:
            result = check_lookup(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
