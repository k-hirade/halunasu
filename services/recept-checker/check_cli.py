"""コマンドラインからUKEファイルを点検する

使い方:
    python check_cli.py ファイル.UKE                 # 画面に結果表示
    python check_cli.py ファイル.UKE -o 結果.xlsx    # Excel出力
    python check_cli.py ファイル.UKE -o 結果.csv     # CSV出力
    python check_cli.py ファイル.UKE --save-history  # 縦覧用履歴に保存
"""

import argparse
import logging
import sys
from pathlib import Path

from receipt_checker.engine import CheckEngine
from receipt_checker.masters import load_masters
from receipt_checker.models import Severity
from receipt_checker.parser import parse_uke_file
from receipt_checker.report.export import to_csv_bytes, to_excel_bytes
from receipt_checker.store import HistoryStore

SEV_MARK = {
    Severity.ERROR: "[エラー]",
    Severity.WARNING: "[警告]  ",
    Severity.INFO: "[情報]  ",
}


def main():
    parser = argparse.ArgumentParser(description="UKEファイルを点検します")
    parser.add_argument("uke_file", help="点検するUKEファイル")
    parser.add_argument("-o", "--output", help="結果の出力先(.xlsx / .csv)")
    parser.add_argument("--masters", help="マスターディレクトリ(省略時は同梱デモマスター)")
    parser.add_argument("--history-db", default="data/history.db", help="縦覧用履歴DB")
    parser.add_argument("--save-history", action="store_true", help="点検後に履歴へ保存")
    parser.add_argument("--no-history", action="store_true", help="縦覧点検を無効化")
    parser.add_argument("--settings-db", default="data/settings.db",
                        help="点検設定DB(点検除外・ルールON/OFF)")
    parser.add_argument("--no-settings", action="store_true",
                        help="点検除外・ルールON/OFF設定を無視して全件表示")
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING)

    masters = load_masters(args.masters)
    history = None
    if not args.no_history:
        Path(args.history_db).parent.mkdir(parents=True, exist_ok=True)
        history = HistoryStore(args.history_db)
    settings = None
    if not args.no_settings:
        from receipt_checker.settings import AppSettings

        settings = AppSettings(args.settings_db)

    claim_file = parse_uke_file(args.uke_file)
    masters.resolve_names(claim_file)
    engine = CheckEngine(masters, history=history, settings=settings)
    result = engine.run(claim_file)

    print(f"\n=== 点検結果: {claim_file.source_name} ===")
    print(f"医療機関: {claim_file.facility.name}  請求年月: {claim_file.facility.seikyu_ym}"
          + (f"  適用マスター: {result.master_version}" if result.master_version else ""))
    print(f"レセプト件数: {len(claim_file.receipts)}  実行ルール数: {result.rules_run}")
    print(
        f"指摘: エラー {result.error_count} / 警告 {result.warning_count} / 情報 {result.info_count}"
        + (f"(点検除外により{result.excluded_count}件を非表示)" if result.excluded_count else "")
        + "\n"
    )

    for f in result.findings:
        loc = f"No.{f.receipt_no} {f.patient_name}" if f.receipt_no else "(ファイル)"
        print(f"{SEV_MARK[f.severity]} {f.rule_id} {loc}: {f.message}")
        if f.detail:
            print(f"          └ {f.detail}")

    if args.output:
        out = Path(args.output)
        if out.suffix == ".xlsx":
            out.write_bytes(to_excel_bytes(result))
        elif out.suffix == ".csv":
            out.write_bytes(to_csv_bytes(result))
        else:
            print(f"未対応の出力形式です: {out.suffix}", file=sys.stderr)
            sys.exit(2)
        print(f"\n結果を {out} に出力しました")

    if args.save_history and history is not None:
        saved = history.save_claim_file(claim_file)
        print(f"履歴に{saved}件保存しました(縦覧点検用)")

    sys.exit(1 if result.error_count else 0)


if __name__ == "__main__":
    main()
