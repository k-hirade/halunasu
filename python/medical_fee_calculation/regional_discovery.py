from __future__ import annotations

import re
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from urllib.parse import urljoin, urlsplit

from medical_fee_calculation.japanese_dates import parse_japanese_date


DISCOVERABLE_EXTENSIONS = frozenset((".xlsx", ".xls", ".zip", ".pdf"))
IMPORTABLE_EXTENSIONS = frozenset((".xlsx", ".xls", ".zip"))


@dataclass(frozen=True)
class RegionalSourceFileCandidate:
    regional_bureau: str | None
    kind: str | None
    page_url: str
    url: str
    label: str
    context: str
    extension: str
    is_importable: bool
    local_context: str = ""

    def to_dict(self) -> dict[str, object]:
        return {
            "regional_bureau": self.regional_bureau,
            "kind": self.kind,
            "page_url": self.page_url,
            "url": self.url,
            "label": self.label,
            "context": self.context,
            "local_context": self.local_context,
            "extension": self.extension,
            "is_importable": self.is_importable,
            "selection_score": score_regional_source_candidate(self),
        }


def discover_regional_source_files(
    html: str,
    *,
    page_url: str,
    regional_bureau: str | None = None,
    kind: str | None = None,
) -> list[RegionalSourceFileCandidate]:
    parser = _AnchorLinkParser()
    parser.feed(html)

    candidates: list[RegionalSourceFileCandidate] = []
    seen: set[str] = set()
    for href, label, context, local_context in parser.links:
        url = urljoin(page_url, unescape(href).strip())
        extension = _download_extension(url)
        if extension is None or url in seen:
            continue
        seen.add(url)
        candidates.append(
            RegionalSourceFileCandidate(
                regional_bureau=regional_bureau,
                kind=kind,
                page_url=page_url,
                url=url,
                label=_normalize_label(label),
                context=_normalize_label(context),
                extension=extension,
                is_importable=extension in IMPORTABLE_EXTENSIONS,
                local_context=_normalize_label(local_context),
            )
        )

    return candidates


def build_manifest_template(
    candidates: list[RegionalSourceFileCandidate],
    *,
    source_version: str,
    raw_root: str | Path,
    published_at: str | None = None,
    retrieved_at: str | None = None,
    recommended_only: bool = False,
) -> dict[str, list[dict[str, str]]]:
    entries: list[dict[str, str]] = []
    source_candidates = select_regional_source_file_candidates(candidates) if recommended_only else candidates
    for candidate in source_candidates:
        if not candidate.is_importable:
            continue
        if candidate.regional_bureau is None or candidate.kind is None:
            raise ValueError("regional_bureau and kind are required to build a manifest template")
        entry = {
            "kind": candidate.kind,
            "regional_bureau": candidate.regional_bureau,
            "path": str(
                Path(raw_root)
                / candidate.regional_bureau
                / source_version
                / candidate.kind
                / _url_filename(candidate.url)
            ),
            "source_version": source_version,
            "url": candidate.url,
        }
        if published_at is not None:
            entry["published_at"] = published_at
        if retrieved_at is not None:
            entry["retrieved_at"] = retrieved_at
        entries.append(entry)

    return {"entries": entries}


def select_regional_source_file_candidates(
    candidates: list[RegionalSourceFileCandidate],
    *,
    min_score: int = 20,
) -> list[RegionalSourceFileCandidate]:
    scored = [
        (score_regional_source_candidate(candidate), index, candidate)
        for index, candidate in enumerate(candidates)
        if candidate.is_importable
    ]
    selected = [
        candidate
        for score, _, candidate in sorted(scored, key=lambda item: (-item[0], item[1]))
        if score >= min_score
    ]
    candidate_dates = {
        candidate: _candidate_context_date(candidate)
        for candidate in selected
        if _candidate_context_date(candidate) is not None
    }
    if candidate_dates:
        latest_date = max(candidate_dates.values())
        selected = [
            candidate
            for candidate in selected
            if candidate_dates.get(candidate) == latest_date or _is_facility_inpatient_supplement(candidate)
        ]
    return selected


def score_regional_source_candidate(candidate: RegionalSourceFileCandidate) -> int:
    if not candidate.is_importable:
        return -1000

    text = _selection_text(candidate)
    own_text = _candidate_own_text(candidate)
    score = {".zip": 12, ".xlsx": 10, ".xls": 8}.get(candidate.extension, 0)

    if _has_any(own_text, ("医科", "医　科", "medical")):
        score += 60
    if _has_any(own_text, ("歯科", "shika", "dental")):
        score -= 150
    if _has_any(own_text, ("薬局", "yakkyoku", "pharmacy")):
        score -= 150
    if _has_any(own_text, ("訪問看護", "houmon", "nursing")):
        score -= 150
    if _has_any(text, ("保険外併用", "hokengai", "heiyo")):
        score -= 150

    if candidate.kind == "hospital_registry":
        if _has_any(text, ("コード内容", "指定一覧", "指定状況", "医療機関一覧", "registry")):
            score += 35
        if _has_any(text, ("全体", "全体版", "zentai", "kikanzentai", "whole")):
            score += 20
        if _has_any(own_text, ("病院", "hospital")) and _has_any(own_text, ("医科", "medical")):
            score += 30
        if _has_any(own_text, ("診療所", "clinic")):
            score -= 90
        if _has_any(text, ("施設基準", "届出受理", "届出項目", "shisetsu", "koumoku")):
            score -= 90
        if _has_any(
            text,
            (
                "新規",
                "辞退",
                "取消",
                "廃止",
                "状態別",
                "直近",
                "処理分",
                "shinki",
                "sinki",
                "sinkikikan",
                "haishi",
                "jitai",
                "torikeshi",
            ),
        ):
            score -= 50
    elif candidate.kind == "facility_standards":
        is_inpatient_supplement = _has_any(text, ("入院基本料", "特定入院料", "nyuuin", "tokutei"))
        if _has_any(text, ("施設基準", "届出受理", "受理状況", "医療機関名簿", "accepted")):
            score += 35
        if _has_any(text, ("全体", "全体版", "whole", "shisetsu")):
            score += 20
        if is_inpatient_supplement:
            score += 30
        if _has_any(text, ("直近", "新規", "変更", "辞退")):
            score -= 50
        if _has_any(text, ("コード内容", "指定一覧", "指定状況")):
            score -= 90
        if not is_inpatient_supplement and _has_any(
            text,
            (
                "項目別",
                "主な届出項目別",
                "主な施設基準",
                "訪問看護",
                "保険外併用",
                "hokengai",
                "koumoku",
                "heiyo",
                "group",
            ),
        ):
            score -= 120

    return score


def _download_extension(url: str) -> str | None:
    path = urlsplit(url).path.lower()
    for extension in sorted(DISCOVERABLE_EXTENSIONS, key=len, reverse=True):
        if path.endswith(extension):
            return extension
    return None


def _url_filename(url: str) -> str:
    name = PurePosixPath(urlsplit(url).path).name
    if not name:
        raise ValueError(f"source URL has no filename: {url}")
    return name


def _normalize_label(value: str) -> str:
    return " ".join(unescape(value).split())


def _selection_text(candidate: RegionalSourceFileCandidate) -> str:
    return " ".join((candidate.label, candidate.context, candidate.url)).lower()


def _candidate_own_text(candidate: RegionalSourceFileCandidate) -> str:
    label_text = candidate.label.lower()
    label_url_text = " ".join((candidate.label, candidate.url)).lower()
    if _has_any(label_text, ("エクセルデータ", "excel data")):
        return label_url_text
    discriminator_terms = (
        "医科",
        "歯科",
        "薬局",
        "訪問看護",
        "病院",
        "診療所",
        "medical",
        "dental",
        "pharmacy",
        "shika",
        "yakkyoku",
        "hospital",
        "clinic",
        "nursing",
    )
    if _has_any(label_text, discriminator_terms):
        return label_url_text
    return " ".join((candidate.label, candidate.local_context, candidate.url)).lower()


def _candidate_context_date(candidate: RegionalSourceFileCandidate) -> str | None:
    return parse_japanese_date(candidate.context)


def _is_facility_inpatient_supplement(candidate: RegionalSourceFileCandidate) -> bool:
    if candidate.kind != "facility_standards":
        return False
    return _has_any(_selection_text(candidate), ("入院基本料", "特定入院料", "nyuuin", "tokutei"))


def _has_any(text: str, needles: tuple[str, ...]) -> bool:
    compact_text = re.sub(r"\s+", "", text)
    return any(needle.lower() in text or re.sub(r"\s+", "", needle.lower()) in compact_text for needle in needles)


class _AnchorLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str, str, str]] = []
        self._current_href: str | None = None
        self._current_text: list[str] = []
        self._current_context = ""
        self._current_local_context = ""
        self._section_context = ""
        self._subsection_context = ""
        self._current_heading_text: list[str] | None = None
        self._text_chunks: list[str] = []
        self._row_chunks: list[str] = []
        self._tag_stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_name = tag.lower()
        if tag_name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._current_heading_text = []
        if tag_name == "tr":
            self._row_chunks = []
        if tag_name != "a":
            self._tag_stack.append(tag_name)
            return
        href = next((value for name, value in attrs if name.lower() == "href"), None)
        if href is None:
            self._tag_stack.append(tag_name)
            return
        self._current_href = href
        self._current_text = []
        row_context = _normalize_label(" ".join(self._row_chunks)) if self._in_tag("tr") else ""
        fallback_context = _normalize_label(" ".join(self._text_chunks[-8:]))
        local_context = row_context or fallback_context
        self._current_context = _normalize_label(
            " ".join((self._section_context, self._subsection_context, local_context))
        )
        self._current_local_context = local_context
        self._tag_stack.append(tag_name)

    def handle_data(self, data: str) -> None:
        if self._current_href is not None:
            self._current_text.append(data)
        else:
            text = _normalize_label(data)
            if text:
                if _looks_like_section_date(text):
                    self._subsection_context = text
                if self._current_heading_text is not None:
                    self._current_heading_text.append(text)
                if self._in_tag("tr"):
                    self._row_chunks.append(text)
                self._text_chunks.append(text)

    def handle_endtag(self, tag: str) -> None:
        tag_name = tag.lower()
        if tag_name in {"h1", "h2", "h3", "h4", "h5", "h6"} and self._current_heading_text is not None:
            heading = _normalize_label(" ".join(self._current_heading_text))
            if heading:
                self._section_context = heading
                self._subsection_context = ""
            self._current_heading_text = None
        if tag_name != "a" or self._current_href is None:
            if tag_name == "tr":
                self._row_chunks = []
            self._pop_tag(tag_name)
            return
        label = "".join(self._current_text)
        self.links.append((self._current_href, label, self._current_context, self._current_local_context))
        normalized_label = _normalize_label(label)
        if normalized_label:
            if self._in_tag("tr"):
                self._row_chunks.append(normalized_label)
            self._text_chunks.append(normalized_label)
        self._current_href = None
        self._current_text = []
        self._current_context = ""
        self._current_local_context = ""
        self._pop_tag(tag_name)

    def _in_tag(self, tag_name: str) -> bool:
        return tag_name in self._tag_stack

    def _pop_tag(self, tag_name: str) -> None:
        for index in range(len(self._tag_stack) - 1, -1, -1):
            if self._tag_stack[index] == tag_name:
                del self._tag_stack[index]
                return


def _looks_like_section_date(text: str) -> bool:
    return "現在" in text and parse_japanese_date(text) is not None
