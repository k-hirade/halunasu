from __future__ import annotations

import json
import sys
from typing import Any

from medical_fee_calculation.api import calculate_fee_session
from medical_fee_calculation.checks_api import (
    check_lookup,
    disease_act_candidates,
    resolve_diseases,
    standing_fee_families,
)
from medical_fee_calculation.master_search import search_master
from medical_fee_calculation.name_scan import scan_names
from medical_fee_calculation.whitebox_context import (
    classify_context,
    context_classifier_readiness,
)
from medical_fee_calculation.whitebox_linker import link_spans, linker_readiness
from medical_fee_calculation.whitebox_span import detect_spans, span_detector_readiness


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
            elif operation == "disease_act_candidates":
                result = disease_act_candidates(payload)
            elif operation == "standing_fee_families":
                result = standing_fee_families(payload)
            elif operation == "name_scan":
                result = scan_names(payload)
            elif operation == "link_spans":
                result = link_spans(payload)
            elif operation == "classify_context":
                result = classify_context(payload)
            elif operation == "detect_spans":
                result = detect_spans(payload)
            elif operation == "whitebox_readiness":
                result = {
                    "linker": linker_readiness(payload.get("linker_manifest_path")),
                    "contextClassifier": context_classifier_readiness(
                        payload.get("context_manifest_path")
                    ),
                    "spanDetector": span_detector_readiness(
                        payload.get("span_manifest_path")
                    ),
                }
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
