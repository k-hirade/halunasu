"""レセプトチェッカー Web アプリケーション

起動:  python run.py  →  http://127.0.0.1:8230
"""

from __future__ import annotations

import ipaddress
import logging
import os
import threading
import urllib.parse
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates

from ..codes import SHINRYO_SHIKIBETSU, TENKI, describe_receipt_type
from ..engine import CheckEngine, CheckResult
from ..masters import load_masters
from ..models import Severity, format_ym
from ..parser import parse_uke_bytes
from ..report.export import to_csv_bytes, to_excel_bytes
from ..rules import rule_catalog

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent

MAX_RESULTS_KEPT = 20


class VolatileSettings:
    """プロセス内だけで有効なルール設定。

    STGのスポット点検用途では、除外・履歴・返戻査定をDBへ永続化しない。
    """

    def __init__(self):
        self._disabled_rule_ids = set()

    def disabled_rule_ids(self) -> set:
        return set(self._disabled_rule_ids)

    def set_rule_enabled(self, rule_id: str, enabled: bool) -> None:
        if enabled:
            self._disabled_rule_ids.discard(rule_id)
        else:
            self._disabled_rule_ids.add(rule_id)

    def list_exclusions(self) -> list:
        return []

    def remove_exclusion(self, exclusion_id: int) -> None:
        return None

    def add_exclusion(self, rule_id: str, target: str = "", patient_name: str = "", exact: bool = False) -> None:
        return None

    def filter_findings(self, findings: list) -> tuple:
        return findings, 0


def _feature_enabled() -> bool:
    if os.environ.get("RECEPT_CHECKER_ALLOW_NON_STG") == "true":
        return True
    return os.environ.get("HALUNASU_ENV") == "stg"


def _parse_allowlist(raw: str) -> list:
    entries = []
    for token in raw.replace(",", " ").split():
        try:
            entries.append(ipaddress.ip_network(token, strict=False))
        except ValueError:
            logger.warning("Invalid IP allowlist entry ignored")
    return entries


def _client_ip(request: Request) -> str:
    for header in ("x-forwarded-for", "x-real-ip", "cf-connecting-ip"):
        value = request.headers.get(header)
        if value:
            return value.split(",")[0].strip()
    return request.client.host if request.client else ""


def _ip_gate_status(request: Request) -> str:
    raw = os.environ.get("RECEPT_CHECKER_ALLOWED_IPS") or os.environ.get("STG_GATE_ALLOWED_IPS") or ""
    allowlist = _parse_allowlist(raw)
    if not allowlist:
        return "ok" if os.environ.get("RECEPT_CHECKER_ALLOW_NON_STG") == "true" else "not_configured"
    try:
        ip = ipaddress.ip_address(_client_ip(request))
    except ValueError:
        return "forbidden"
    return "ok" if any(ip in network for network in allowlist) else "forbidden"

@asynccontextmanager
async def _lifespan(app: FastAPI):
    app.state.masters = load_masters()
    app.state.history = None
    app.state.settings = VolatileSettings()
    app.state.results = OrderedDict()  # result_id -> CheckResult
    app.state.results_lock = threading.Lock()
    yield


def _content_disposition(filename: str) -> str:
    """日本語ファイル名に対応した Content-Disposition (RFC 5987)"""
    quoted = urllib.parse.quote(filename)
    return f"attachment; filename=\"download\"; filename*=UTF-8''{quoted}"


app = FastAPI(title="レセプトチェッカー", lifespan=_lifespan)
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.globals.update(
    describe_receipt_type=describe_receipt_type,
    format_ym=format_ym,
    SHINRYO_SHIKIBETSU=SHINRYO_SHIKIBETSU,
    TENKI=TENKI,
)


def _get_result(result_id: str) -> CheckResult | None:
    return app.state.results.get(result_id)


@app.middleware("http")
async def stg_only_guard(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)
    if not _feature_enabled():
        return PlainTextResponse("Not found", status_code=404)
    ip_gate_status = _ip_gate_status(request)
    if ip_gate_status == "not_configured":
        return PlainTextResponse("STG IP allowlist is not configured.", status_code=503)
    if ip_gate_status != "ok":
        return PlainTextResponse("Forbidden", status_code=403)
    return await call_next(request)


# ---------------------------------------------------------------------------
# 画面
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "master_stats": app.state.masters.stats(),
            "recent": [
                (rid, res) for rid, res in reversed(app.state.results.items())
            ][:10],
        },
    )


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "recept-checker"}


@app.post("/check")
async def check(request: Request, file: UploadFile = File(...)):
    data = await file.read()
    try:
        claim_file = parse_uke_bytes(data, source_name=file.filename or "uploaded.uke")
        app.state.masters.resolve_names(claim_file)
        engine = CheckEngine(
            app.state.masters, history=app.state.history, settings=app.state.settings
        )
        result = engine.run(claim_file)
    except Exception:
        logger.exception("点検処理でエラーが発生しました")
        return HTMLResponse(
            "<meta charset='utf-8'><p>ファイルの点検中にエラーが発生しました。"
            "UKEファイル(医科・レセプト電算処理システム形式)か確認してください。</p>"
            "<p><a href='/'>← 戻る</a></p>",
            status_code=422,
        )

    result_id = uuid.uuid4().hex[:12]
    with app.state.results_lock:
        app.state.results[result_id] = result
        while len(app.state.results) > MAX_RESULTS_KEPT:
            app.state.results.popitem(last=False)
    return RedirectResponse(url=f"/result/{result_id}", status_code=303)


@app.get("/result/{result_id}", response_class=HTMLResponse)
def result_view(
    request: Request,
    result_id: str,
    severity: str = "",
    category: str = "",
    receipt_no: int | None = None,
):
    result = _get_result(result_id)
    if result is None:
        return RedirectResponse(url="/")
    findings = result.findings
    if severity:
        findings = [f for f in findings if f.severity.value == severity]
    if category:
        findings = [f for f in findings if f.category == category]
    if receipt_no is not None:
        findings = [f for f in findings if f.receipt_no == receipt_no]
    categories = sorted({f.category for f in result.findings})
    return templates.TemplateResponse(
        request,
        "result.html",
        {
            "result_id": result_id,
            "result": result,
            "findings": findings,
            "categories": categories,
            "sel_severity": severity,
            "sel_category": category,
            "sel_receipt_no": receipt_no,
            "Severity": Severity,
        },
    )


@app.get("/result/{result_id}/receipt/{receipt_no}", response_class=HTMLResponse)
def receipt_view(request: Request, result_id: str, receipt_no: int):
    result = _get_result(result_id)
    if result is None:
        return RedirectResponse(url="/")
    receipt = next(
        (r for r in result.claim_file.receipts if r.receipt_no == receipt_no), None
    )
    if receipt is None:
        return RedirectResponse(url=f"/result/{result_id}")

    # 診療識別ごとに項目をグループ化(表示用)
    groups: dict = {}
    for it in receipt.items:
        label = SHINRYO_SHIKIBETSU.get(it.shinryo_shikibetsu, f"識別{it.shinryo_shikibetsu}")
        groups.setdefault((it.shinryo_shikibetsu, label), []).append(it)

    return templates.TemplateResponse(
        request,
        "receipt.html",
        {
            "result_id": result_id,
            "result": result,
            "receipt": receipt,
            "groups": sorted(groups.items()),
            "findings": result.findings_for(receipt_no),
            "Severity": Severity,
        },
    )


@app.get("/rules", response_class=HTMLResponse)
def rules_view(request: Request):
    return templates.TemplateResponse(
        request,
        "rules.html",
        {
            "rules": rule_catalog(),
            "disabled": app.state.settings.disabled_rule_ids(),
        },
    )


@app.post("/rules/toggle")
def rules_toggle(rule_id: str = Form(...), enabled: str = Form("1")):
    app.state.settings.set_rule_enabled(rule_id, enabled == "1")
    return RedirectResponse(url="/rules", status_code=303)


@app.get("/settings", response_class=HTMLResponse)
def settings_view(request: Request):
    versions = []
    if app.state.masters.versions:
        versions = app.state.masters.versions.labels()
    return templates.TemplateResponse(
        request,
        "settings.html",
        {
            "exclusions": app.state.settings.list_exclusions(),
            "disabled": app.state.settings.disabled_rule_ids(),
            "versions": versions,
        },
    )


@app.post("/settings/exclusions/delete")
def settings_exclusion_delete(exclusion_id: int = Form(...)):
    app.state.settings.remove_exclusion(exclusion_id)
    return RedirectResponse(url="/settings", status_code=303)


# ---------------------------------------------------------------------------
# エクスポート
# ---------------------------------------------------------------------------

@app.get("/result/{result_id}/export.xlsx")
def export_xlsx(result_id: str):
    result = _get_result(result_id)
    if result is None:
        return RedirectResponse(url="/")
    data = to_excel_bytes(result)
    name = (result.claim_file.source_name or "result").rsplit(".", 1)[0]
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": _content_disposition(f"check_{name}.xlsx")},
    )


@app.get("/result/{result_id}/export.csv")
def export_csv(result_id: str):
    result = _get_result(result_id)
    if result is None:
        return RedirectResponse(url="/")
    data = to_csv_bytes(result)
    name = (result.claim_file.source_name or "result").rsplit(".", 1)[0]
    return Response(
        content=data,
        media_type="text/csv",
        headers={"Content-Disposition": _content_disposition(f"check_{name}.csv")},
    )

