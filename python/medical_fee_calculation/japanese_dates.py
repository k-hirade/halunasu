from __future__ import annotations

import re


ERA_BASE_YEARS = {
    "明治": 1868,
    "明": 1868,
    "大正": 1912,
    "大": 1912,
    "昭和": 1926,
    "昭": 1926,
    "平成": 1989,
    "平": 1989,
    "令和": 2019,
    "令": 2019,
}


def parse_japanese_date(value: str) -> str | None:
    text = _normalize(value)
    if not text:
        return None

    western = re.search(r"(\d{4})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})", text)
    if western:
        year, month, day = (int(part) for part in western.groups())
        return f"{year:04d}-{month:02d}-{day:02d}"

    era = re.search(
        r"(明治|明|大正|大|昭和|昭|平成|平|令和|令)\s*([0-9元]{1,2})\s*(?:年|[.．])\s*([0-9]{1,2})\s*(?:月|[.．])\s*([0-9]{1,2})",
        text,
    )
    if not era:
        return None

    era_name, era_year_text, month_text, day_text = era.groups()
    era_year = 1 if era_year_text == "元" else int(era_year_text)
    year = ERA_BASE_YEARS[era_name] + era_year - 1
    return f"{year:04d}-{int(month_text):02d}-{int(day_text):02d}"


def _normalize(value: str) -> str:
    return (
        value.replace("\u3000", " ")
        .replace("－", "-")
        .replace("ー", "-")
        .replace("．", ".")
        .strip()
    )
