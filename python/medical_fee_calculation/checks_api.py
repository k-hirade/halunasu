"""レセ点検用のマスタ参照(check_lookup)。

コード群を1リクエストで受け取り、点検(適応/禁忌/併用/病名整備)に必要なマスタ行を返す。
算定本体には関与しない。worker の op=check_lookup と、spawn フォールバック(__main__)の両方から使う。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import unicodedata
from calendar import monthrange
from datetime import date
from pathlib import Path
from typing import Any

from medical_fee_calculation.claim_adjustments import exclusion_resolution
from medical_fee_calculation.db import connect, initialize_schema
from medical_fee_calculation.electronic_rules import EXCLUSION_SCOPES
from medical_fee_calculation.name_scan import _scan_aliases, strip_parenthetical_qualifiers

# 傷病名を条件としない特殊コード(支払基金チェックマスタ)。適応判定の対象外。
NON_DISEASE_CODES = frozenset({"0000000", "0000001", "0000002", "0000003"})
STANDING_FEE_MONTH_WINDOWS = {
    "月": 1,
    "２月": 2,
    "３月": 3,
    "４月": 4,
    "６月": 6,
    "１２月": 12,
    "５年": 60,
}
STANDING_FEE_ALPHA_PARTS = frozenset({"B", "C"})
STANDING_ALIAS_SUFFIXES = (
    "指導管理料",
    "指導料",
    "管理料",
    "材料加算",
    "機器加算",
    "加算",
    "療法",
)


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

        result = {
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
        if payload.get("claim_month") or payload.get("claimMonth") or payload.get("service_date") or payload.get("serviceDate"):
            result["actExclusionRules"] = _act_exclusion_rules(conn, payload, act_codes)
        return result
    finally:
        conn.close()


def act_exclusion_rules(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the strict monthly exclusion contract without advisory lookups."""

    db_path = payload.get("db_path") or os.environ.get("FEE_MASTER_DB_PATH")
    if not db_path:
        raise ValueError("db_path or FEE_MASTER_DB_PATH is required")
    conn = connect(Path(str(db_path)))
    try:
        initialize_schema(conn)
        return _act_exclusion_rules(conn, payload, _clean_codes(payload.get("act_codes")))
    finally:
        conn.close()


def standing_fee_families(payload: dict[str, Any]) -> dict[str, Any]:
    """Build the recurring fee-family catalog from current master attributes.

    This catalog is deliberately generated from the electronic frequency table
    and medical fee-table hierarchy. It is used only for human-review
    candidates; it never confirms a fee by itself.
    """

    db_path = payload.get("db_path") or os.environ.get("FEE_MASTER_DB_PATH")
    if not db_path:
        raise ValueError("db_path or FEE_MASTER_DB_PATH is required")
    service_date = str(payload.get("service_date") or payload.get("serviceDate") or "").strip()
    if not service_date:
        raise ValueError("service_date is required")

    conn = connect(Path(str(db_path)))
    try:
        initialize_schema(conn)
        procedure_source = conn.execute(
            """
            SELECT id, source_version, checksum_sha256
            FROM master_sources
            WHERE source_type = 'medical_procedure_master'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        frequency_source = conn.execute(
            """
            SELECT id, source_version, checksum_sha256
            FROM master_sources
            WHERE source_type = 'medical_electronic_fee_table'
            ORDER BY imported_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        if procedure_source is None or frequency_source is None:
            return {"families": [], "source": None}

        rows = conn.execute(
            """
            SELECT
                p.code,
                p.short_name,
                p.base_name,
                p.points,
                p.inout_applicability,
                p.facility_standard_codes,
                p.chapter,
                p.part,
                p.alpha_part,
                p.section,
                p.branch,
                p.item,
                f.limit_code,
                f.limit_name,
                f.raw_row_json
            FROM electronic_frequency_limits f
            JOIN medical_procedures p
              ON p.source_id = ?
             AND p.code = f.procedure_code
            WHERE f.source_id = ?
              AND (p.effective_from IS NULL OR p.effective_from <= ?)
              AND (p.effective_to IS NULL OR p.effective_to >= ?)
              AND (f.effective_from IS NULL OR f.effective_from <= ?)
              AND (f.effective_to IS NULL OR f.effective_to >= ?)
            ORDER BY p.chapter, p.part, p.alpha_part, p.section, p.branch, p.item, p.code, f.limit_code
            """,
            (
                int(procedure_source["id"]),
                int(frequency_source["id"]),
                service_date,
                service_date,
                service_date,
                service_date,
            ),
        ).fetchall()

        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            alpha_part = str(row["alpha_part"] or "").strip().upper()
            limit_name = str(row["limit_name"] or "").strip()
            window_months = STANDING_FEE_MONTH_WINDOWS.get(limit_name)
            if alpha_part not in STANDING_FEE_ALPHA_PARTS or window_months is None:
                continue
            max_count = _frequency_limit_count(row["raw_row_json"])
            if max_count is None:
                continue

            name = str(row["short_name"] or "").strip()
            family_name = strip_parenthetical_qualifiers(name).strip() or name
            hierarchy = {
                "chapter": str(row["chapter"] or "").strip(),
                "part": str(row["part"] or "").strip(),
                "alphaPart": alpha_part,
                "section": str(row["section"] or "").strip(),
                "branch": str(row["branch"] or "").strip(),
            }
            family_key = "|".join(
                [
                    hierarchy["chapter"],
                    hierarchy["part"],
                    hierarchy["alphaPart"],
                    hierarchy["section"],
                    hierarchy["branch"],
                    _normalize_standing_name(family_name),
                ]
            )
            family_id = "fee_family_" + hashlib.sha256(family_key.encode("utf-8")).hexdigest()[:24]
            family = grouped.setdefault(
                family_id,
                {
                    "familyId": family_id,
                    "name": family_name,
                    "hierarchy": hierarchy,
                    "aliases": set(),
                    "variants": {},
                },
            )
            family["aliases"].update(_standing_aliases(name))
            family["aliases"].update(_standing_aliases(family_name))

            code = str(row["code"] or "").strip()
            variant = family["variants"].setdefault(
                code,
                {
                    "code": code,
                    "name": name,
                    "baseName": str(row["base_name"] or "").strip(),
                    "points": float(row["points"] or 0),
                    "inoutApplicability": str(row["inout_applicability"] or "").strip(),
                    "facilityStandardCodes": _split_master_codes(row["facility_standard_codes"]),
                    "item": str(row["item"] or "").strip(),
                    "aliases": sorted(_standing_aliases(name)),
                    "frequencyLimits": [],
                },
            )
            frequency_key = (str(row["limit_code"] or "").strip(), window_months, max_count)
            if frequency_key not in {
                (
                    entry["unitCode"],
                    entry["windowMonths"],
                    entry["maxCount"],
                )
                for entry in variant["frequencyLimits"]
            }:
                variant["frequencyLimits"].append(
                    {
                        "unitCode": frequency_key[0],
                        "unit": limit_name,
                        "windowMonths": window_months,
                        "maxCount": max_count,
                    }
                )

        families: list[dict[str, Any]] = []
        for family in grouped.values():
            variants = sorted(family["variants"].values(), key=lambda value: value["code"])
            for variant in variants:
                variant["frequencyLimits"].sort(
                    key=lambda value: (value["windowMonths"], value["maxCount"], value["unitCode"])
                )
            families.append(
                {
                    **family,
                    "aliases": sorted(family["aliases"], key=lambda value: (-len(value), value)),
                    "variants": variants,
                }
            )
        families.sort(key=lambda value: (value["hierarchy"]["alphaPart"], value["name"], value["familyId"]))
        return {
            "families": families,
            "source": {
                "serviceDate": service_date,
                "procedureSourceId": int(procedure_source["id"]),
                "procedureVersion": str(procedure_source["source_version"] or ""),
                "procedureChecksum": str(procedure_source["checksum_sha256"] or ""),
                "frequencySourceId": int(frequency_source["id"]),
                "frequencyVersion": str(frequency_source["source_version"] or ""),
                "frequencyChecksum": str(frequency_source["checksum_sha256"] or ""),
            },
        }
    finally:
        conn.close()


def _frequency_limit_count(raw_row_json: Any) -> int | None:
    try:
        raw = json.loads(raw_row_json or "[]")
        count = int(str(raw[5]).strip() or "0") if len(raw) > 5 else 0
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return count if count > 0 else None


def _standing_aliases(name: str) -> set[str]:
    aliases = {_normalize_standing_name(value) for value in _scan_aliases(name)}
    aliases.add(_normalize_standing_name(name))
    aliases.add(_normalize_standing_name(strip_parenthetical_qualifiers(name)))
    expanded = set(aliases)
    for alias in list(aliases):
        if alias.endswith("料") and len(alias) > 4:
            expanded.add(alias[:-1])
        current = alias
        for _ in range(3):
            stripped = next(
                (
                    current[: -len(suffix)]
                    for suffix in STANDING_ALIAS_SUFFIXES
                    if current.endswith(suffix) and len(current) > len(suffix) + 1
                ),
                current,
            )
            if stripped == current:
                break
            expanded.add(stripped)
            current = stripped
        if current.startswith("在宅") and len(current) > 4:
            expanded.add(current[2:])
    return {value for value in expanded if len(value) >= 4}


def _normalize_standing_name(value: Any) -> str:
    return "".join(unicodedata.normalize("NFKC", str(value or "")).split()).lower()


def _split_master_codes(value: Any) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return []
    try:
        decoded = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        decoded = None
    if isinstance(decoded, list):
        return sorted({str(item).strip() for item in decoded if str(item).strip()})
    separators = (",", "、", ";", "；", "|", " ")
    values = [text]
    for separator in separators:
        values = [part for item in values for part in item.split(separator)]
    return sorted({part.strip() for part in values if part.strip()})


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
    """Return advisory, directional rows for existing checklist callers.

    This legacy helper is intentionally fail-open and must not be used to
    decide which monthly receipt lines are exportable. The strict path is
    `_act_exclusion_rules`.
    """

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


def _act_exclusion_rules(
    conn: Any,
    payload: dict[str, Any],
    codes: list[str],
) -> dict[str, Any]:
    try:
        evaluated_from, evaluated_to = _exclusion_evaluation_period(payload)
    except (TypeError, ValueError):
        return _exclusion_envelope(
            "lookup_failed",
            evaluated_from=None,
            evaluated_to=None,
        )

    try:
        source = _effective_electronic_source(conn, evaluated_from, evaluated_to)
        if source is None:
            return _exclusion_envelope(
                "no_effective_generation",
                evaluated_from=evaluated_from,
                evaluated_to=evaluated_to,
            )

        source_id = int(source["id"])
        source_version = str(source["source_version"] or "")
        source_row_count = int(conn.execute(
            "SELECT COUNT(*) AS count FROM electronic_exclusions WHERE source_id = ?",
            (source_id,),
        ).fetchone()["count"])
        if source_row_count <= 0:
            return _exclusion_envelope(
                "master_incomplete",
                source_id=source_id,
                source_version=source_version,
                evaluated_from=evaluated_from,
                evaluated_to=evaluated_to,
            )

        effective_row_count = int(conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM electronic_exclusions
            WHERE source_id = ?
              AND (effective_from IS NULL OR effective_from = '' OR effective_from <= ?)
              AND (effective_to IS NULL OR effective_to = '' OR effective_to >= ?)
            """,
            (source_id, evaluated_to, evaluated_from),
        ).fetchone()["count"])
        if effective_row_count <= 0:
            return _exclusion_envelope(
                "no_effective_generation",
                source_id=source_id,
                source_version=source_version,
                evaluated_from=evaluated_from,
                evaluated_to=evaluated_to,
            )

        normalized_codes = sorted({str(code or "").strip() for code in codes if str(code or "").strip()})
        if len(normalized_codes) < 2:
            return _exclusion_envelope(
                "complete",
                source_id=source_id,
                source_version=source_version,
                evaluated_from=evaluated_from,
                evaluated_to=evaluated_to,
                rules=[],
            )

        placeholders = ",".join("?" for _ in normalized_codes)
        rows = conn.execute(
            f"""
            SELECT
                exclusion_table,
                base_code,
                base_name,
                excluded_code,
                excluded_name,
                rule_kind,
                effective_from,
                effective_to,
                COALESCE(json_extract(raw_row_json, '$[6]'), '0') AS special_condition
            FROM electronic_exclusions
            WHERE source_id = ?
              AND base_code IN ({placeholders})
              AND excluded_code IN ({placeholders})
              AND (effective_from IS NULL OR effective_from = '' OR effective_from <= ?)
              AND (effective_to IS NULL OR effective_to = '' OR effective_to >= ?)
            ORDER BY exclusion_table, base_code, excluded_code, effective_from, effective_to
            """,
            [source_id, *normalized_codes, *normalized_codes, evaluated_to, evaluated_from],
        ).fetchall()
        rules = _canonical_exclusion_rules(rows)
        if rules is None:
            return _exclusion_envelope(
                "master_incomplete",
                source_id=source_id,
                source_version=source_version,
                evaluated_from=evaluated_from,
                evaluated_to=evaluated_to,
            )
        return _exclusion_envelope(
            "complete",
            source_id=source_id,
            source_version=source_version,
            evaluated_from=evaluated_from,
            evaluated_to=evaluated_to,
            rules=rules,
        )
    except Exception:  # noqa: BLE001 - strict caller distinguishes lookup failure from zero rules.
        return _exclusion_envelope(
            "lookup_failed",
            evaluated_from=evaluated_from,
            evaluated_to=evaluated_to,
        )


def _exclusion_evaluation_period(payload: dict[str, Any]) -> tuple[str, str]:
    claim_month = str(payload.get("claim_month") or payload.get("claimMonth") or "").strip()
    if claim_month:
        if len(claim_month) != 7 or claim_month[4] != "-":
            raise ValueError("claim_month must use YYYY-MM")
        year = int(claim_month[:4])
        month = int(claim_month[5:7])
        last_day = monthrange(year, month)[1]
        return f"{year:04d}-{month:02d}-01", f"{year:04d}-{month:02d}-{last_day:02d}"

    service_date = str(payload.get("service_date") or payload.get("serviceDate") or "").strip()
    parsed = date.fromisoformat(service_date)
    normalized = parsed.isoformat()
    return normalized, normalized


def _effective_electronic_source(
    conn: Any,
    evaluated_from: str,
    evaluated_to: str,
) -> Any | None:
    """Select the newest known generation with rows effective in the period.

    A revision can be published before its rules take effect. In that window,
    the preceding effective generation remains authoritative. An empty newest
    generation is returned as-is so the caller reports `master_incomplete`
    instead of silently falling back.
    """

    sources = conn.execute(
        """
        SELECT id, source_version, published_at
        FROM master_sources
        WHERE source_type = 'medical_electronic_fee_table'
          AND (
                (published_at IS NOT NULL AND published_at != '' AND substr(published_at, 1, 10) <= ?)
             OR (
                  (published_at IS NULL OR published_at = '')
                  AND source_version GLOB '????-??-??*'
                  AND substr(source_version, 1, 10) <= ?
                )
          )
        ORDER BY
          COALESCE(NULLIF(substr(published_at, 1, 10), ''), substr(source_version, 1, 10)) DESC,
          id DESC
        """,
        (evaluated_to, evaluated_to),
    ).fetchall()
    for index, source in enumerate(sources):
        source_id = int(source["id"])
        row_count = int(conn.execute(
            "SELECT COUNT(*) AS count FROM electronic_exclusions WHERE source_id = ?",
            (source_id,),
        ).fetchone()["count"])
        if index == 0 and row_count <= 0:
            return source
        if row_count <= 0:
            continue
        effective_count = int(conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM electronic_exclusions
            WHERE source_id = ?
              AND (effective_from IS NULL OR effective_from = '' OR effective_from <= ?)
              AND (effective_to IS NULL OR effective_to = '' OR effective_to >= ?)
            """,
            (source_id, evaluated_to, evaluated_from),
        ).fetchone()["count"])
        if effective_count > 0:
            return source
    return None


def _canonical_exclusion_rules(rows: list[Any]) -> list[dict[str, Any]] | None:
    grouped: dict[tuple[str, str, str, str, str, str], list[Any]] = {}
    for row in rows:
        table = str(row["exclusion_table"] or "")
        scope = EXCLUSION_SCOPES.get(table)
        base = str(row["base_code"] or "").strip()
        excluded = str(row["excluded_code"] or "").strip()
        if not scope or not base or not excluded or base == excluded:
            return None
        code_a, code_b = sorted((base, excluded))
        special_condition = str(row["special_condition"] or "0").strip() or "0"
        effective_from = str(row["effective_from"] or "")
        effective_to = str(row["effective_to"] or "")
        grouped.setdefault(
            (scope, code_a, code_b, special_condition, effective_from, effective_to),
            [],
        ).append(row)

    canonical: list[dict[str, Any]] = []
    for key in sorted(grouped):
        scope, code_a, code_b, special_condition, effective_from, effective_to = key
        pair_rows = grouped[key]
        directions = {
            (str(row["base_code"] or "").strip(), str(row["excluded_code"] or "").strip())
            for row in pair_rows
        }
        if directions != {(code_a, code_b), (code_b, code_a)}:
            return None

        row_by_direction = {
            (str(row["base_code"] or "").strip(), str(row["excluded_code"] or "").strip()): row
            for row in pair_rows
        }
        if len(row_by_direction) != 2:
            return None
        kinds = [str(row["rule_kind"] or "").strip() for row in row_by_direction.values()]
        resolution = exclusion_resolution(kinds[0], special_condition)
        winner_code: str | None = None

        if resolution == "conditional_review":
            pass
        elif all(kind in {"1", "2"} for kind in kinds):
            winners = {
                str(row["base_code"] if str(row["rule_kind"] or "").strip() == "1" else row["excluded_code"])
                for row in row_by_direction.values()
            }
            if len(winners) != 1:
                return None
            winner_code = next(iter(winners))
            resolution = "auto_winner"
        elif kinds == ["3", "3"] or sorted(kinds) == ["3", "3"]:
            resolution = "demote_lower_points"
        else:
            resolution = "unsupported_rule_kind"

        name_by_code: dict[str, str] = {}
        for row in row_by_direction.values():
            name_by_code.setdefault(str(row["base_code"]), str(row["base_name"] or ""))
            name_by_code.setdefault(str(row["excluded_code"]), str(row["excluded_name"] or ""))
        fingerprint_payload = {
            "scope": scope,
            "codeA": code_a,
            "codeB": code_b,
            "resolution": resolution,
            "winnerCode": winner_code,
            "specialCondition": special_condition,
            "effectiveFrom": effective_from or None,
            "effectiveTo": effective_to or None,
        }
        fingerprint = hashlib.sha256(
            json.dumps(
                fingerprint_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        canonical.append(
            {
                "scope": scope,
                "codeA": code_a,
                "codeB": code_b,
                "codeAName": name_by_code.get(code_a, ""),
                "codeBName": name_by_code.get(code_b, ""),
                "resolution": resolution,
                "winnerCode": winner_code,
                "specialCondition": special_condition,
                "ruleFingerprint": fingerprint,
                "effectiveFrom": effective_from or None,
                "effectiveTo": effective_to or None,
            }
        )
    return canonical


def _exclusion_envelope(
    status: str,
    *,
    source_id: int | None = None,
    source_version: str | None = None,
    evaluated_from: str | None,
    evaluated_to: str | None,
    rules: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "status": status,
        "sourceId": source_id,
        "sourceVersion": source_version,
        "evaluatedFrom": evaluated_from,
        "evaluatedTo": evaluated_to,
        "rules": rules or [],
    }


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
        elif op == "standing_fee_families":
            result = standing_fee_families(payload)
        else:
            result = check_lookup(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
