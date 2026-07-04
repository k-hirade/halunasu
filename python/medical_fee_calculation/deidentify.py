"""院内・オフライン匿名化ツール（レセ点検PoC用）。

先方の生CSV（患者/病名/処方/検体/処置/リハビリ 等）から直接識別子を除去し、
患者IDを擬似ID化（ファイル横断で一貫）して、点検に必要な項目（コード・点数・性別・年齢・日付）は残す。

方針:
- ネット送信ゼロ・外部AI不使用の単体ツール。閉域網の院内端末で実行できる。
- 患者ID → HMAC(salt, ID) の擬似ID。saltは先方がローカル保持し、我々には渡さない（＝再識別不能）。
- 生年月日 → 年齢（診療月時点/参照日時点）。強い識別子である生年月日そのものは出さない。
- 対応表(擬似ID↔実ID)は出力しない。必要なら先方だけがsaltで再現できる。
- 残存識別子スキャンで氏名・番号の漏れを警告（漏れ0を目標）。

列ロール(config):
  patient_key : HMAC で擬似ID化（全ファイル一貫）
  drop        : 列ごと削除（氏名/住所/電話/保険者番号/被保険者記号番号/受給者番号/カルテ番号 等）
  birthdate   : 生年月日 → 年齢(int)
  service_date: 日付。granularity=full(既定, YYYY-MM-DD保持) / month(YYYY-MM へ丸め)
  keep        : そのまま（傷病名コード/診療行為コード/点数/回数/性別 等）
  keep_scrub  : 自由文。氏名らしき語を簡易マスク（コードでない自由記載）
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import hmac
import json
import re
import secrets
import sys
from pathlib import Path
from typing import Any

DROP = "drop"
PATIENT_KEY = "patient_key"
BIRTHDATE = "birthdate"
SERVICE_DATE = "service_date"
KEEP = "keep"
KEEP_SCRUB = "keep_scrub"

# 残存識別子スキャン用パターン(値は出さず、ヒット件数だけ警告する)
_KATAKANA_NAME_RE = re.compile(r"[ァ-ヶー]{3,}")
_LONG_DIGITS_RE = re.compile(r"\d{7,}")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def pseudonymize(value: str, salt: bytes, length: int = 16) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    digest = hmac.new(salt, normalized.encode("utf-8"), hashlib.sha256).hexdigest()
    return digest[:length]


def _parse_date(value: str) -> dt.date | None:
    text = str(value or "").strip()
    if not text:
        return None
    # 西暦8桁/区切りあり を許容(和暦GYYMMDD は intake 側で扱う想定。ここは西暦優先)
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    m = re.fullmatch(r"(\d{4})\D?(\d{1,2})\D?(\d{1,2})", text)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def _age_at(birth: dt.date, reference: dt.date) -> int:
    age = reference.year - birth.year - ((reference.month, reference.day) < (birth.month, birth.day))
    return max(age, 0)


def _to_month(value: str) -> str:
    date = _parse_date(value)
    if date:
        return f"{date.year:04d}-{date.month:02d}"
    text = str(value or "").strip()
    m = re.fullmatch(r"(\d{4})\D?(\d{1,2}).*", text)
    return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}" if m else text


def _scrub_free_text(value: str) -> str:
    text = str(value or "")
    text = _EMAIL_RE.sub("[除去]", text)
    text = _LONG_DIGITS_RE.sub("[番号除去]", text)
    return text


def _scan_residual_identifiers(value: str) -> list[str]:
    hits: list[str] = []
    text = str(value or "")
    if _EMAIL_RE.search(text):
        hits.append("email")
    if _LONG_DIGITS_RE.search(text):
        hits.append("long_digits")
    if _KATAKANA_NAME_RE.search(text):
        hits.append("katakana_name")
    return hits


def deidentify_file(
    rows: list[dict[str, str]],
    fieldnames: list[str],
    columns: dict[str, str],
    salt: bytes,
    reference_date: dt.date,
    date_granularity: str = "full",
    unmapped_policy: str = "error",
) -> tuple[list[dict[str, str]], list[str], dict[str, Any]]:
    """1ファイル分を匿名化。戻り値: (出力行, 出力ヘッダ, サマリ)。

    fail-closed: config に無い列(未マッピング列)は既定でエラー(error)。
    住所/電話/保険記号番号 等の想定外列が匿名化済み出力へ漏れるのを防ぐ。
    unmapped_policy: error(既定・停止) / drop(未定義は削除) / keep(明示的に残す・非推奨)。
    """
    unmapped = [name for name in fieldnames if name not in columns]
    if unmapped and unmapped_policy == "error":
        raise ValueError(
            "未マッピング列があります(fail-closed): "
            + ", ".join(unmapped)
            + " — deid-config で各列に drop/keep/patient_key 等を明示するか、"
            + "unmapped_policy を drop に設定してください。"
        )

    def role_of(name: str) -> str:
        if name in columns:
            return columns[name]
        return DROP if unmapped_policy != "keep" else KEEP

    dropped = [name for name in fieldnames if role_of(name) == DROP]
    out_fields = [name for name in fieldnames if role_of(name) != DROP]
    pseudonymized_cols = [name for name, role in columns.items() if role == PATIENT_KEY]

    residual: dict[str, int] = {}

    def note_residual(kinds: list[str]) -> None:
        for kind in kinds:
            residual[kind] = residual.get(kind, 0) + 1

    out_rows: list[dict[str, str]] = []
    for row in rows:
        out: dict[str, str] = {}
        for name in out_fields:
            role = role_of(name)
            raw = row.get(name, "")
            if role == PATIENT_KEY:
                out[name] = pseudonymize(raw, salt)
            elif role == BIRTHDATE:
                birth = _parse_date(raw)
                out[name] = str(_age_at(birth, reference_date)) if birth else ""
            elif role == SERVICE_DATE:
                out[name] = _to_month(raw) if date_granularity == "month" else str(raw or "").strip()
            elif role == KEEP_SCRUB:
                out[name] = _scrub_free_text(raw)
                note_residual(_scan_residual_identifiers(out[name]))
            else:  # keep
                # keep列でも、コードでない自由文に識別子が混ざっていないか監視(値は残す・警告のみ)
                note_residual(_scan_residual_identifiers(raw))
                out[name] = raw
        out_rows.append(out)

    summary = {
        "rowCount": len(out_rows),
        "droppedColumns": dropped,
        "pseudonymizedColumns": pseudonymized_cols,
        "unmappedColumns": unmapped,
        "unmappedPolicy": unmapped_policy,
        "residualIdentifierWarnings": residual,
    }
    return out_rows, out_fields, summary


def _read_csv(path: Path, encoding: str) -> tuple[list[dict[str, str]], list[str]]:
    with open(path, encoding=encoding, errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        fieldnames = list(reader.fieldnames or [])
        rows = [dict(row) for row in reader]
    return rows, fieldnames


def _write_csv(path: Path, rows: list[dict[str, str]], fieldnames: list[str], encoding: str) -> None:
    with open(path, "w", encoding=encoding, errors="replace", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({name: row.get(name, "") for name in fieldnames})


def load_salt(config: dict[str, Any], salt_file: str | None) -> tuple[bytes, bool]:
    """salt を config/keyfile から取得。無ければ生成し (salt, generated=True) を返す。"""
    if salt_file:
        return Path(salt_file).read_text(encoding="utf-8").strip().encode("utf-8"), False
    inline = config.get("salt")
    if inline:
        return str(inline).encode("utf-8"), False
    return secrets.token_hex(32).encode("utf-8"), True


def run(config: dict[str, Any], input_dir: Path, output_dir: Path, salt: bytes, dry_run: bool = False) -> dict[str, Any]:
    reference_date = _parse_date(config.get("reference_date") or "") or dt.date.today()
    date_granularity = str(config.get("date_granularity") or "full")
    unmapped_policy = str(config.get("unmapped_policy") or "error")
    files = config.get("files") or {}
    # dry-run は非破壊確認。出力ディレクトリも作らない。
    if not dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)

    report: dict[str, Any] = {
        "referenceDate": reference_date.isoformat(),
        "dateGranularity": date_granularity,
        "unmappedPolicy": unmapped_policy,
        "dryRun": dry_run,
        "files": {},
    }
    for label, spec in files.items():
        path = input_dir / spec["path"]
        encoding = spec.get("encoding", "cp932")
        columns = spec.get("columns", {})
        rows, fieldnames = _read_csv(path, encoding)
        out_rows, out_fields, summary = deidentify_file(
            rows, fieldnames, columns, salt, reference_date, date_granularity,
            unmapped_policy=spec.get("unmapped_policy", unmapped_policy),
        )
        summary["source"] = spec["path"]
        if not dry_run:
            out_path = output_dir / f"{Path(spec['path']).stem}.deid.csv"
            _write_csv(out_path, out_rows, out_fields, encoding)
            summary["output"] = out_path.name
        report["files"][label] = summary
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="院内オフライン匿名化ツール（レセ点検PoC）")
    parser.add_argument("--config", required=True, help="匿名化設定(JSON): files/columns/reference_date 等")
    parser.add_argument("--input", required=True, help="生CSVのディレクトリ")
    parser.add_argument("--output", required=True, help="匿名化済みCSVの出力ディレクトリ")
    parser.add_argument("--salt-file", default=None, help="擬似ID用salt鍵ファイル(先方が保持・再利用)")
    parser.add_argument("--dry-run", action="store_true", help="出力せず列マッピングと件数のみ確認")
    args = parser.parse_args(argv)

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    salt, generated = load_salt(config, args.salt_file)
    if generated and not args.dry_run:
        # dry-run(非破壊確認)ではファイルを一切作らない。salt保存は本実行時のみ。
        keyfile = Path(args.output) / "SALT.keep-secret.txt"
        keyfile.parent.mkdir(parents=True, exist_ok=True)
        keyfile.write_text(salt.decode("utf-8"), encoding="utf-8")
        print(
            f"警告: saltを新規生成しました → {keyfile}\n"
            "  同一患者を一貫した擬似IDにするため、次回以降も同じsaltを --salt-file で指定してください。\n"
            "  このファイルは先方のみが保持し、我々には渡さないでください（再識別防止）。",
            file=sys.stderr,
        )
    elif generated and args.dry_run:
        print("情報: dry-run のため salt は生成せず(ファイル出力なし)。", file=sys.stderr)

    report = run(config, Path(args.input), Path(args.output), salt, dry_run=args.dry_run)

    total_warnings = sum(
        sum(f.get("residualIdentifierWarnings", {}).values()) for f in report["files"].values()
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if total_warnings:
        print(
            f"\n注意: 残存識別子の疑いが {total_warnings} 件あります。keep列に氏名/番号が混ざっていないか確認してください。",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
