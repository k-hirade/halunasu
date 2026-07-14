"""マスタ名称辞書スキャン(決定論セーフティネット)。

LLM抽出とは独立に、診療行為マスタの名称辞書でカルテ本文を決定論的に走査し、
「本文に名称が書かれているのに抽出・候補に無いコード」を拾うための一次照合。
確定算定には使わず、Node側で否定文脈・既出コードを除外した上で
「点数付きの確認候補」の材料になる。worker の op=name_scan と
spawn フォールバック(__main__)の両方から使う。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from medical_fee_calculation.db import connect, initialize_schema

# 短すぎる名称(点/管/など)や基本診療料はスキャン対象から外す。
# 111/112(初診・再診)はエンジンの外来基本料計算が担うため辞書スキャン不要。
_MIN_NAME_LENGTH = 4
_EXCLUDED_CODE_PREFIXES = ("111", "112")
_MAX_MATCHES = 60

# カルテは料金名称でなく行為を書く(「傷病手当金意見書を交付」「在宅酸素を継続」)。
# 特定の語尾を手書き列挙するのではなく、名称から機械的に別名を生成して照合する:
#   1) 括弧修飾の除去: 「在宅酸素療法指導管理料（その他）」→「在宅酸素療法指導管理料」
#   2) 算定用語尾の反復除去: 「〜交付料」「〜指導管理料」「〜指導料」「〜管理料」「〜療法」「〜検査」
#      → 名詞核(「傷病手当金意見書」「在宅酸素」)まで畳む
# 短い別名の誤爆は、最小長・汎用語ブラックリスト・文単位の否定判定(Node側)で抑える。
_ALIAS_STRIP_SUFFIXES = ("交付料", "指導管理料", "指導料", "管理料", "療法", "検査料")
_MIN_ALIAS_LENGTH = 4
# それ自体では行為を特定しない汎用語。別名として採用しない。
_ALIAS_BLACKLIST = frozenset({
    "指導", "管理", "検査", "処置", "注射", "手術", "撮影", "診断", "判断",
    "在宅患者", "外来患者", "入院患者", "その他", "同一建物", "情報通信",
})

# db_path -> (source_id, [(alias, code, points, role, full_name)])
_NAME_CACHE: dict[str, tuple[int, list[tuple[str, str, float, str, str]]]] = {}


def scan_names(payload: dict[str, Any]) -> dict[str, Any]:
    db_path = payload.get("db_path") or os.environ.get("FEE_MASTER_DB_PATH")
    if not db_path:
        raise ValueError("db_path or FEE_MASTER_DB_PATH is required")
    text = str(payload.get("text") or "").strip()
    if len(text) < 4:
        return {"matches": []}
    limit = int(payload.get("limit") or _MAX_MATCHES)
    limit = max(1, min(limit, _MAX_MATCHES))

    names = _load_names(str(db_path))
    matches: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    for alias, code, points, role, full_name in names:
        if code in seen_codes:
            continue
        index = text.find(alias)
        if index < 0:
            continue
        seen_codes.add(code)
        matches.append(
            {
                "code": code,
                "name": full_name,
                "points": points,
                "role": role,
                "index": index,
                "matchedText": alias,
            }
        )
        if len(matches) >= limit * 3:
            break

    # 同一位置で重なる短い名称は、より長い名称に吸収する
    # (「難病外来指導管理料」が当たった位置の「指導管理料」等を落とす)。
    matches = _drop_shadowed_matches(matches)
    matches.sort(key=lambda m: (-float(m["points"] or 0), m["code"]))
    return {"matches": matches[:limit]}


def _drop_shadowed_matches(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for match in matches:
        start = int(match["index"])
        end = start + len(str(match["matchedText"]))
        shadowed = False
        for other in matches:
            if other is match or len(str(other["matchedText"])) <= len(str(match["matchedText"])):
                continue
            other_start = int(other["index"])
            other_end = other_start + len(str(other["matchedText"]))
            if other_start <= start and end <= other_end:
                shadowed = True
                break
        if not shadowed:
            result.append(match)
    return result


def _load_names(db_path: str) -> list[tuple[str, str, float, str]]:
    resolved = str(Path(db_path).expanduser().resolve())
    conn = connect(Path(resolved))
    try:
        initialize_schema(conn)
        source_row = conn.execute(
            "SELECT id FROM master_sources WHERE source_type = 'medical_procedure_master' "
            "ORDER BY imported_at DESC, id DESC LIMIT 1"
        ).fetchone()
        source_id = int(source_row["id"]) if source_row else 0
        cached = _NAME_CACHE.get(resolved)
        if cached and cached[0] == source_id:
            return cached[1]
        rows = conn.execute(
            """
            SELECT code, short_name, points
            FROM medical_procedures
            WHERE source_id = ?
            """,
            (source_id,),
        ).fetchall()
        names: list[tuple[str, str, float, str, str]] = []
        for row in rows:
            code = str(row["code"] or "").strip()
            name = str(row["short_name"] or "").strip()
            if not code or len(name) < _MIN_NAME_LENGTH:
                continue
            if code.startswith(_EXCLUDED_CODE_PREFIXES):
                continue
            points = float(row["points"] or 0)
            role = _role_from_name(name)
            for alias in _scan_aliases(name):
                names.append((alias, code, points, role, name))
        # 長い別名を先に照合する(重なり吸収の前提)。
        names.sort(key=lambda item: -len(item[0]))
        _NAME_CACHE[resolved] = (source_id, names)
        return names
    finally:
        conn.close()


def _scan_aliases(name: str) -> list[str]:
    aliases: list[str] = []
    seen: set[str] = set()

    def add(alias: str) -> None:
        alias = alias.strip()
        if (
            len(alias) >= _MIN_ALIAS_LENGTH
            and alias not in seen
            and alias not in _ALIAS_BLACKLIST
        ):
            seen.add(alias)
            aliases.append(alias)

    add(name)
    # 括弧修飾を除いた核名称
    core = _strip_parens(name)
    add(core)
    # 語尾を反復的に畳む(名詞核へ寄せる)。核名称からも畳む。
    for base in (name, core):
        current = base
        for _ in range(3):
            stripped = _strip_one_suffix(current)
            if stripped == current:
                break
            add(stripped)
            current = stripped
    return aliases


def _strip_parens(name: str) -> str:
    result: list[str] = []
    depth = 0
    for char in name:
        if char in "（(":
            depth += 1
        elif char in "）)":
            depth = max(0, depth - 1)
        elif depth == 0:
            result.append(char)
    return "".join(result)


def _strip_one_suffix(name: str) -> str:
    for suffix in _ALIAS_STRIP_SUFFIXES:
        if name.endswith(suffix) and len(name) - len(suffix) >= _MIN_ALIAS_LENGTH:
            return name[: -len(suffix)]
    return name


def _role_from_name(name: str) -> str:
    if "加算" in name:
        return "addon"
    if "判断料" in name:
        return "judgment"
    if "減算" in name or "逓減" in name:
        return "reduction"
    return "base"


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        result = scan_names(payload)
    except Exception as exc:  # noqa: BLE001 - command boundary returns structured failure.
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from exc
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
