"""レセプトチェッカー Webサーバー起動スクリプト

使い方:
    python run.py            # http://127.0.0.1:8230 で起動
    python run.py --port 80  # ポート指定
"""

import argparse
import logging
import os


def main():
    parser = argparse.ArgumentParser(description="レセプトチェッカーを起動します")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8230")))
    parser.add_argument("--reload", action="store_true", help="開発用オートリロード")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    import uvicorn

    uvicorn.run(
        "receipt_checker.web.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
