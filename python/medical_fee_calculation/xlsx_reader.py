from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree


NS = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


@dataclass(frozen=True)
class XlsxSheetRef:
    name: str
    sheet_id: str
    path: str


def read_first_sheet_rows(path: str | Path) -> list[list[str]]:
    """Read values from the first worksheet of a basic .xlsx file.

    This intentionally implements only the subset needed for public Ministry
    spreadsheets: shared strings, inline strings, numeric/string cells, and
    sparse cell references.
    """

    with zipfile.ZipFile(path) as workbook:
        return _read_first_sheet_rows_from_workbook(workbook)


def read_first_sheet_rows_from_bytes(data: bytes) -> list[list[str]]:
    """Read values from the first worksheet of a .xlsx workbook held in memory."""

    with zipfile.ZipFile(BytesIO(data)) as workbook:
        return _read_first_sheet_rows_from_workbook(workbook)


def list_sheet_refs(path: str | Path) -> list[XlsxSheetRef]:
    """Return worksheet names and internal paths in workbook order."""

    with zipfile.ZipFile(path) as workbook:
        return _sheet_refs(workbook)


def read_sheet_rows(path: str | Path, sheet_name: str) -> list[list[str]]:
    """Read values from a named worksheet in a basic .xlsx file."""

    with zipfile.ZipFile(path) as workbook:
        sheet_refs = _sheet_refs(workbook)
        for sheet_ref in sheet_refs:
            if sheet_ref.name == sheet_name:
                shared_strings = _read_shared_strings(workbook)
                return _read_sheet_rows_from_workbook(workbook, sheet_ref.path, shared_strings)
    raise ValueError(f"worksheet not found: {sheet_name}")


def read_all_sheet_rows(path: str | Path) -> list[tuple[XlsxSheetRef, list[list[str]]]]:
    """Read all worksheets from a basic .xlsx file in workbook order."""

    with zipfile.ZipFile(path) as workbook:
        shared_strings = _read_shared_strings(workbook)
        return [
            (sheet_ref, _read_sheet_rows_from_workbook(workbook, sheet_ref.path, shared_strings))
            for sheet_ref in _sheet_refs(workbook)
        ]


def _read_first_sheet_rows_from_workbook(workbook: zipfile.ZipFile) -> list[list[str]]:
    shared_strings = _read_shared_strings(workbook)
    sheet_name = _first_sheet_path(workbook)
    return _read_sheet_rows_from_workbook(workbook, sheet_name, shared_strings)


def _read_sheet_rows_from_workbook(
    workbook: zipfile.ZipFile,
    sheet_path: str,
    shared_strings: list[str],
) -> list[list[str]]:
    root = ElementTree.fromstring(workbook.read(sheet_path))
    rows: list[list[str]] = []
    for row in root.findall(".//a:sheetData/a:row", NS):
        values: dict[int, str] = {}
        for cell in row.findall("a:c", NS):
            ref = cell.get("r", "")
            column = _column_index(ref)
            if column is None:
                column = len(values)
            values[column] = _cell_value(cell, shared_strings)

        if not values:
            rows.append([])
            continue

        width = max(values) + 1
        rows.append([values.get(index, "") for index in range(width)])
    return rows


def _read_shared_strings(workbook: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(workbook.read("xl/sharedStrings.xml"))
    except KeyError:
        return []

    strings: list[str] = []
    for item in root.findall("a:si", NS):
        strings.append("".join(text.text or "" for text in item.findall(".//a:t", NS)))
    return strings


def _first_sheet_path(workbook: zipfile.ZipFile) -> str:
    sheet_refs = _sheet_refs(workbook)
    if not sheet_refs:
        raise ValueError("workbook has no sheets")
    return sheet_refs[0].path


def _sheet_refs(workbook: zipfile.ZipFile) -> list[XlsxSheetRef]:
    workbook_root = ElementTree.fromstring(workbook.read("xl/workbook.xml"))
    rels_root = ElementTree.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
    relationship_ns = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
    rels = {
        rel.get("Id"): rel.get("Target")
        for rel in rels_root.findall("r:Relationship", relationship_ns)
    }

    sheet_refs: list[XlsxSheetRef] = []
    for sheet in workbook_root.findall(".//a:sheets/a:sheet", NS):
        rel_id = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        target = rels.get(rel_id)
        if not target:
            raise ValueError(f"sheet relationship target not found: {sheet.get('name')}")
        sheet_refs.append(
            XlsxSheetRef(
                name=sheet.get("name") or "",
                sheet_id=sheet.get("sheetId") or "",
                path=_resolve_workbook_target(target),
            )
        )
    return sheet_refs


def _resolve_workbook_target(target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return "xl/" + target.lstrip("/")


def _column_index(cell_ref: str) -> int | None:
    match = re.match(r"([A-Z]+)", cell_ref)
    if not match:
        return None
    value = 0
    for char in match.group(1):
        value = value * 26 + (ord(char) - ord("A") + 1)
    return value - 1


def _cell_value(cell: ElementTree.Element, shared_strings: list[str]) -> str:
    cell_type = cell.get("t")
    if cell_type == "inlineStr":
        inline = cell.find("a:is", NS)
        if inline is None:
            return ""
        return "".join(text.text or "" for text in inline.findall(".//a:t", NS))

    value = cell.find("a:v", NS)
    if value is None or value.text is None:
        return ""

    if cell_type == "s":
        return shared_strings[int(value.text)]

    return value.text
