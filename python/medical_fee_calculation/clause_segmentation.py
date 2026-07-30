"""Shared clinical evidence clause segmentation contract."""

from __future__ import annotations

import re
import unicodedata
from typing import Any


CLAUSE_SEGMENTATION_VERSION = "fee-evidence-clause-v2"
LEGACY_CLAUSE_SEGMENTATION_VERSION = "fee-evidence-clause-v1"

_SENTENCE_BOUNDARIES = frozenset("。．.!！?？；;\n\r")
_CLAUSE_BOUNDARIES = frozenset("、，,")
_OPEN_PARENTHESES = frozenset("（(【［[")
_CLOSE_PARENTHESES = frozenset("）)】］]")
_PUNCTUATION_ONLY = frozenset("、，,。．.!！?？；;（）()【】［］[]")
_GOVERNING_PREFIX_ONLY_PATTERN = re.compile(
    r"^(?:本日|今回|当日|前回|先月|以前|過去|他院|前医|他科|紹介元|持参|"
    r"健診|検診|外部資料|次回|後日|今後)(?:は|も|で|では|について)?[、，,]?$"
)
_LEGACY_CONTEXT_CLAUSE_BOUNDARY_PATTERN = re.compile(
    r"(?:[。！？!?；;]+|[、,](?=\s*(?:本日|今回|当日|前回|先月|以前|過去|次回|"
    r"後日|今後|他院|前医|当院|院内|自院)))"
)


def split_clinical_evidence_clauses(
    value: str = "",
    *,
    line_id: str = "L",
) -> list[dict[str, Any]]:
    """Return the Python equivalent of splitClinicalEvidenceClauses."""

    text = str(value or "")
    clauses: list[dict[str, Any]] = []
    start = 0
    sentence_index = 0
    parenthetical_depth = 0

    def append(raw_start: int, raw_end: int, separator_after: str = "") -> None:
        raw = text[raw_start:raw_end]
        leading_match = re.search(r"\S", raw)
        if leading_match is None:
            return
        trimmed_right = raw.rstrip()
        trimmed = trimmed_right.strip()
        if trimmed and all(char in _PUNCTUATION_ONLY for char in trimmed):
            return
        clause_start = raw_start + leading_match.start()
        clause_end = raw_start + len(trimmed_right)
        clauses.append({
            "clauseId": (
                f"{str(line_id or 'L')}:C{len(clauses) + 1:03d}"
            ),
            "text": text[clause_start:clause_end],
            "charStart": clause_start,
            "charEnd": clause_end,
            "sentenceIndex": sentence_index,
            "parentheticalDepth": parenthetical_depth,
            "separatorAfter": separator_after,
        })

    for index, char in enumerate(text):
        if char in _OPEN_PARENTHESES:
            append(start, index, char)
            start = index + 1
            parenthetical_depth += 1
            continue
        if char in _CLOSE_PARENTHESES and parenthetical_depth > 0:
            append(start, index, char)
            start = index + 1
            parenthetical_depth = max(0, parenthetical_depth - 1)
            continue
        if char in _SENTENCE_BOUNDARIES and not _is_decimal_point(text, index):
            append(start, index + 1, char)
            start = index + 1
            sentence_index += 1
            continue
        if char in _CLAUSE_BOUNDARIES:
            append(start, index + 1, char)
            start = index + 1

    append(start, len(text))
    if not clauses and text.strip():
        append(0, len(text))
    return _merge_governing_prefix_clauses(
        clauses,
        text,
        line_id=str(line_id or "L"),
    )


def split_legacy_context_clauses(
    value: str = "",
    *,
    line_id: str = "L",
) -> list[dict[str, Any]]:
    """Preserve historical contract-3 artifact reproduction."""

    text = str(value or "")
    clauses: list[dict[str, Any]] = []

    def append(raw_start: int, raw_end: int) -> None:
        raw = text[raw_start:raw_end]
        leading = len(raw) - len(raw.lstrip())
        trailing = len(raw.rstrip())
        clause_start = raw_start + leading
        clause_end = raw_start + trailing
        if clause_end <= clause_start:
            return
        clauses.append({
            "clauseId": f"{str(line_id or 'L')}:C{len(clauses) + 1:03d}",
            "text": text[clause_start:clause_end],
            "charStart": clause_start,
            "charEnd": clause_end,
        })

    start = 0
    for match in _LEGACY_CONTEXT_CLAUSE_BOUNDARY_PATTERN.finditer(text):
        append(start, match.end())
        start = match.end()
    append(start, len(text))
    if not clauses and text:
        append(0, len(text))
    return clauses


def _is_decimal_point(text: str, index: int) -> bool:
    if text[index] not in {".", "．"}:
        return False
    previous = text[index - 1] if index > 0 else ""
    following = text[index + 1] if index + 1 < len(text) else ""
    return previous in "0123456789" and following in "0123456789"


def _normalize_predicate_text(value: str) -> str:
    return re.sub(
        r"\s+",
        "",
        unicodedata.normalize("NFKC", str(value or "")),
    )


def _merge_governing_prefix_clauses(
    clauses: list[dict[str, Any]],
    text: str,
    *,
    line_id: str,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    index = 0
    while index < len(clauses):
        current = clauses[index]
        following = clauses[index + 1] if index + 1 < len(clauses) else None
        if (
            following is not None
            and current["sentenceIndex"] == following["sentenceIndex"]
            and current["parentheticalDepth"] == following["parentheticalDepth"]
            and _GOVERNING_PREFIX_ONLY_PATTERN.fullmatch(
                _normalize_predicate_text(current["text"])
            )
        ):
            merged.append({
                **current,
                "text": text[current["charStart"]:following["charEnd"]],
                "charEnd": following["charEnd"],
                "separatorAfter": following["separatorAfter"],
            })
            index += 2
            continue
        merged.append(current)
        index += 1

    return [
        {
            **clause,
            "clauseId": f"{line_id}:C{index + 1:03d}",
        }
        for index, clause in enumerate(merged)
    ]
