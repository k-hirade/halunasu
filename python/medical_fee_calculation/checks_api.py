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
        else:
            result = check_lookup(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
