#!/usr/bin/env bash
# ORCA(日医標準レセプトソフト)「外来版 カルテ事例集 11例」の取得・テキスト抽出スクリプト。
#
# 各PDFは「カルテ事例 + それに対応する算定例(診療報酬明細)」を含み、
# 「カルテ → 算定」のend-to-end評価(gold)用の素材として利用できる。
#
# 出典: ORCA Project / 日本医師会ORCA管理機構（非PHIの擬似カルテ, ver 4.8.0, 2016-10-28）
#   一覧ページ: https://www.orca.med.or.jp/receipt/users/manual/attachments/karte.html
#   PDF配信:    https://ftp.orca.med.or.jp/pub/data/receipt/outline/karte/pdf/
#   お試しサーバ: https://weborca-trial.orca.med.or.jp/ (user: trial / pass: weborcatrial)
#
# 注意: 取得物はORCA Projectの配布教材。社内評価での参照利用を想定。外部公開リポジトリへ
#   PDF/本文を再配布する場合は配布条件を必ず確認すること。
#
# 使い方: bash scripts/fetch_orca_karte_cases.sh [出力先ディレクトリ]
#   既定の出力先: var/orca-karte-cases （リポジトリにはコミットしない想定）

set -euo pipefail

OUT_DIR="${1:-var/orca-karte-cases}"
BASE="https://ftp.orca.med.or.jp/pub/data/receipt/outline/karte/pdf"
PREFIX="2016-10-28-karte"
UA="Mozilla/5.0"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

echo "ORCA カルテ事例集を取得します -> $(pwd)"

# まとめPDF(カルテのみ)
curl -fsSL -A "$UA" -o "${PREFIX}-cases-all11.pdf" "${BASE}/${PREFIX}-cases-all11.pdf" || echo "  warn: all11 取得失敗"

# 個別PDF(カルテ + 算定例)
for n in 01 02 03 04 05 06 07 08 09 10 11; do
  curl -fsSL -A "$UA" -o "${PREFIX}-case${n}-print.pdf" "${BASE}/${PREFIX}-case${n}-print.pdf" \
    && echo "  ok: case${n}" || echo "  warn: case${n} 取得失敗"
done

# テキスト抽出(ghostscriptがあれば)。PDFにはテキスト層があるため抽出可能。
if command -v gs >/dev/null 2>&1; then
  for pdf in ${PREFIX}-*.pdf; do
    txt="${pdf%.pdf}.txt"
    gs -sDEVICE=txtwrite -o "$txt" -dQUIET "$pdf" 2>/dev/null && echo "  text: $txt" || true
  done
else
  echo "  note: ghostscript(gs)が無いためテキスト抽出はスキップ。'brew install ghostscript' 等で導入可。"
fi

echo "完了。算定明細(点数)の抽出例:"
echo "  grep -E '(＊|　).*[0-9]+ +[0-9]+ +[0-9,]+\$' ${PREFIX}-case01-print.txt"
