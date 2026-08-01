#!/usr/bin/env bash
# 疑似電子カルテ（HOMIS互換）サーバ 起動スクリプト
#
#   ./run.sh            … ポート8899で起動
#   PORT=9000 ./run.sh  … ポート指定
#
# 起動後、ブラウザで  http://localhost:8899/homic/login.php  を開く。
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8899}"
HOST="${HOST:-0.0.0.0}"

echo "疑似HOMIS を http://${HOST}:${PORT}/homic/login.php で起動します..."
echo "（ログインID/パスワードは任意の値で構いません）"
exec python3 -m uvicorn app:app --host "${HOST}" --port "${PORT}"
