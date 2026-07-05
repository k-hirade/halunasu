"""公的マスターデータのダウンロード

以下の公開データを取得し master_data/raw/ に展開する:

1. 基本マスター(診療報酬情報提供サービス shinryohoshu.mhlw.go.jp)
   - 医科診療行為(s) / 医薬品(y) / 特定器材(t) / コメント(c)
2. 傷病名・修飾語マスター(社会保険診療報酬支払基金 ssk.or.jp)
3. 医科電子点数表(支払基金): 補助/包括/背反1〜4/入院基本料/算定回数テーブル
4. コンピュータチェック チェックマスタ(支払基金):
   医薬品適応(IY_Tekio)/傷病名禁忌/併用禁忌/投与量グループ/漫然グループ/
   医科診療行為適応(SI_Shobyo)/対象事例(CC_JIREI)

いずれも審査支払機関・厚労省が請求事務用に無償公開しているデータ。
URLは改定・更新で変わるため、失敗時は各ページから手動ダウンロードして
master_data/raw/ に置いてもよい(ファイル名の先頭一致で認識する)。

使い方:
    python -m receipt_checker.masters.download [--dest master_data/raw]
"""

from __future__ import annotations

import argparse
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

# 年度版ごとの (URL, 説明) リスト。年度改定・マスター更新でURLが変わったら更新する。
# 支払基金の全件ZIPは更新日付入りファイル名のため、最新は各掲載ページで確認:
#   基本マスター: https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.html 〜 _08.html
#   電子点数表:   https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.html
#   チェックマスタ: https://www.ssk.or.jp/shinryohoshu/ssk_cc/index.html
DOWNLOADS_COMMON = [
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_07.files/b_20260601.zip", "傷病名マスター"),
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_08.files/z_20260601.zip", "修飾語マスター"),
    ("https://www.ssk.or.jp/shinryohoshu/ssk_cc/index.files/20251031_CC_JIREI_CHECKMASTA.zip", "コンピュータチェック チェックマスタ"),
]
DOWNLOADS_R06 = [
    ("https://shinryohoshu.mhlw.go.jp/shinryohoshu/file/etc/R06_s.zip", "医科診療行為マスター(R6)"),
    ("https://shinryohoshu.mhlw.go.jp/shinryohoshu/file/etc/R07_y.zip", "医薬品マスター(R7)"),
    ("https://shinryohoshu.mhlw.go.jp/shinryohoshu/file/etc/R06_t.zip", "特定器材マスター(R6)"),
    ("https://shinryohoshu.mhlw.go.jp/shinryohoshu/file/etc/R06_c.zip", "コメントマスター(R6)"),
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.files/tensuhyo_02_R6.zip", "医科電子点数表(R6)"),
]
DOWNLOADS_R08 = [
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_01.files/s_ALL20260701.zip", "医科診療行為マスター(R8)"),
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_04.files/y_ALL20260630.zip", "医薬品マスター(R8)"),
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_05.files/t_ALL20260529.zip", "特定器材マスター(R8)"),
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/kihonmasta/kihonmasta_06.files/c_ALL20260626.zip", "コメントマスター(R8)"),
    ("https://www.ssk.or.jp/seikyushiharai/tensuhyo/ikashika/index.files/tensuhyo_02.zip", "医科電子点数表(R8)"),
]
VERSIONS = {"R06": DOWNLOADS_R06, "R08": DOWNLOADS_R08}

# ZIP内ファイル名(日本語)→ 保存名
RENAME = {
    "チェックマスタ": "checkmaster",
    "補助マスターテーブル": "hojo",
    "包括テーブル": "hokatsu",
    "背反テーブル": "haihan",
    "入院基本料テーブル": "nyuin_kihon",
    "算定回数テーブル": "santei_kaisu",
}


def fetch(url: str, timeout: int = 300) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (receipt-checker)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def extract_zip(data: bytes, dest: Path) -> list:
    saved = []
    with zipfile.ZipFile(io.BytesIO(data), metadata_encoding="cp932") as zf:
        for info in zf.infolist():
            name = info.filename
            if name.endswith("/") or name.lower().endswith(".pdf"):
                continue
            safe = name
            for k, v in RENAME.items():
                safe = safe.replace(k, v)
            safe = safe.replace(" ", "_").split("/")[-1]
            out = dest / safe
            out.write_bytes(zf.read(info))
            saved.append(out.name)
    return saved


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="公的マスターデータのダウンロード",
        epilog=(
            "例(改定またぎ対応の2年度版構成):\n"
            "  python -m receipt_checker.masters.download --version R06 --dest master_data/raw_r06\n"
            "  python -m receipt_checker.masters.download --version R08 --dest master_data/raw_r08\n"
            "  python -m receipt_checker.masters.official_import --raw master_data/raw_r06 "
            "--db master_data/masters_R06.db --label 令和6年度版\n"
            "  python -m receipt_checker.masters.official_import --raw master_data/raw_r08 "
            "--db master_data/masters_R08.db --effective 202606 --label 令和8年度版"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--dest", default="master_data/raw", help="展開先ディレクトリ")
    ap.add_argument("--version", choices=sorted(VERSIONS), default="R08",
                    help="年度版(既定: R08=令和8年度版)")
    args = ap.parse_args(argv)
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    ok = True
    for url, label in VERSIONS[args.version] + DOWNLOADS_COMMON:
        try:
            print(f"取得中: {label} ... ", end="", flush=True)
            data = fetch(url)
            if len(data) < 5000:
                raise RuntimeError(f"応答が小さすぎます({len(data)}バイト)。URLが変わった可能性があります")
            files = extract_zip(data, dest)
            print(f"OK ({len(data):,}バイト → {', '.join(files)})")
        except Exception as e:
            ok = False
            print(f"失敗: {e}\n  → 手動で {url} を取得し {dest}/ に展開してください")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
