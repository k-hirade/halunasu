from __future__ import annotations

import json
import sys
from typing import Any

from medical_fee_calculation.api import calculate_fee_session
from medical_fee_calculation.checks_api import check_lookup, resolve_diseases
from medical_fee_calculation.master_search import search_master
from medical_fee_calculation.name_scan import scan_names


def main() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            payload = request.get("payload")
            if not isinstance(payload, dict):
                raise ValueError("payload must be an object")
            operation = str(payload.get("op") or payload.get("operation") or "calculate").strip()
            if operation == "master_search":
                result = search_master(payload)
            elif operation == "check_lookup":
                result = check_lookup(payload)
            elif operation == "resolve_diseases":
                result = resolve_diseases(payload)
            elif operation == "name_scan":
                result = scan_names(payload)
            else:
                result = calculate_fee_session(payload)
            response: dict[str, Any] = {
                "id": request_id,
                "ok": True,
                "result": result,
            }
        except Exception as exc:  # noqa: BLE001 - worker boundary returns structured failure.
            response = {
                "id": request_id if "request_id" in locals() else "",
                "ok": False,
                "error": type(exc).__name__,
                "message": str(exc),
            }
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
