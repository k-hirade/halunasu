# -*- coding: utf-8 -*-
"""疑似電子カルテ（HOMIS互換）サーバ — FastAPI。

起動:
    cd mock_homis
    uvicorn app:app --host 0.0.0.0 --port 8899

自社のスクレイパ（Playwright等）から使う場合は、ベースURLを本サーバに向けるだけ:
    HOMIS_URL=http://localhost:8899/homic/login.php
    HOMIS_BASE=http://localhost:8899/homic/
    HOMIS_USER=demo  HOMIS_PASSWORD=demo   （任意の値で可）

ルーティングは本物のHOMISに合わせて全て /homic/ 配下・?pid= ディスパッチ。
"""
import os
import sys

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import render
from data.patients import all_patients, get_patient

app = FastAPI(title="Mock HOMIS (疑似カルテ)")

_HERE = os.path.dirname(os.path.abspath(__file__))
app.mount("/homic/static", StaticFiles(directory=os.path.join(_HERE, "static")), name="static")


@app.get("/", response_class=HTMLResponse)
def root():
    return RedirectResponse(url="/homic/login.php")


@app.get("/homic/login.php", response_class=HTMLResponse)
def login_get():
    return render.login_page()


@app.post("/homic/login.php")
def login_post():
    # ID/PW は検証しない（デモ環境）。本物同様、ログイン後は患者一覧へ。
    return RedirectResponse(url="/homic/?pid=top_patients", status_code=303)


@app.get("/homic/", response_class=HTMLResponse)
def dispatch(request: Request):
    pid = request.query_params.get("pid", "top_patients")
    patient_id = request.query_params.get("patient_id", "")
    q = request.query_params.get("q", "").replace(" ", "").replace("　", "")

    if pid == "top_patients":
        return HTMLResponse(render.patient_list_page(all_patients(), q))

    patient = get_patient(patient_id)
    if patient is None and pid in (
        "patient_detail", "patient_problem", "docs_index", "patient_plan0",
    ):
        return HTMLResponse(render.patient_list_page(all_patients(), q))

    if pid == "patient_detail":
        tab = request.query_params.get("tab", "karte")
        return HTMLResponse(render.patient_detail_page(patient, tab=tab))
    if pid == "patient_problem":
        return HTMLResponse(render.problem_page(patient))
    if pid == "docs_index":
        return HTMLResponse(render.docs_page(patient))
    if pid == "patient_plan0":
        return HTMLResponse(render.plan_page(patient))

    # 未対応 pid は患者一覧にフォールバック
    return HTMLResponse(render.patient_list_page(all_patients(), q))


@app.get("/homic/admin/", response_class=HTMLResponse)
def admin(request: Request):
    """schedule_patients 等の管理系（施設同日患者数の簡易再現）。現状は空表を返す。"""
    return HTMLResponse(render.page("admin", render.topbar() +
                                    '<div class="page-main"><p>管理画面（デモ・未使用）</p></div>'))


@app.get("/healthz")
def healthz():
    return {"ok": True, "patients": len(all_patients())}
