"""点検ルールのレジストリ

新しいルールモジュールを追加したら _RULE_MODULES に登録する。
各モジュールは RULES(list[Rule]) / FILE_RULES(list[FileRule]) を公開する。
"""

from __future__ import annotations

import importlib

_RULE_MODULES = [
    "receipt_checker.rules.r01_format",
    "receipt_checker.rules.r02_patient",
    "receipt_checker.rules.r03_disease",
    "receipt_checker.rules.r04_drug_indication",
    "receipt_checker.rules.r05_act_indication",
    "receipt_checker.rules.r06_dosage",
    "receipt_checker.rules.r07_contraindication",
    "receipt_checker.rules.r08_exclusive",
    "receipt_checker.rules.r09_frequency",
    "receipt_checker.rules.r10_missing",
    "receipt_checker.rules.r11_comment",
    "receipt_checker.rules.r12_longitudinal",
    "receipt_checker.rules.r13_seiri",
]


def all_rules() -> list:
    rules = []
    for mod_name in _RULE_MODULES:
        mod = importlib.import_module(mod_name)
        rules.extend(getattr(mod, "RULES", []))
    return rules


def all_file_rules() -> list:
    rules = []
    for mod_name in _RULE_MODULES:
        mod = importlib.import_module(mod_name)
        rules.extend(getattr(mod, "FILE_RULES", []))
    return rules


def rule_catalog() -> list:
    """UI表示用: 全ルールの一覧"""
    out = []
    for r in all_rules() + all_file_rules():
        out.append(
            {
                "rule_id": r.rule_id,
                "name": r.name,
                "category": r.category,
                "description": r.description,
                "severity": r.default_severity.value,
            }
        )
    return out
