(function registerSidePanel(global) {
  "use strict";

  const api = global.HalunasuSidecarApi;
  let preview = null;
  let pollingGeneration = 0;

  const elements = Object.fromEntries([
    "connection-badge", "connection-copy", "connect-button", "device-code-area", "device-code",
    "approval-link", "calculation-section", "extract-button", "chart-preview", "preview-patient",
    "preview-date", "preview-record", "preview-text", "setting-control", "calculate-button",
    "result-section", "total-points", "revision-copy", "line-candidates", "proposal-candidates",
    "issue-count", "issues", "status-message"
  ].map((id) => [id, document.getElementById(id)]));

  initialize();

  async function initialize() {
    setStatus("保存済みの接続を確認しています。");
    try {
      const connected = await api.connectWithStoredGrant();
      setConnected(Boolean(connected));
      setStatus(connected ? "接続済みです。表示中のカルテを読み取れます。" : "端末を接続してください。");
    } catch (error) {
      setConnected(false);
      setStatus(errorMessage(error), true);
    }
  }

  elements["connect-button"].addEventListener("click", async () => {
    pollingGeneration += 1;
    const generation = pollingGeneration;
    setBusy(elements["connect-button"], true, "発行中");
    setStatus("確認コードを発行しています。");
    try {
      const authorization = await api.startDeviceAuthorization();
      elements["device-code"].textContent = authorization.userCode;
      elements["approval-link"].href = authorization.approvalUrl;
      elements["device-code-area"].hidden = false;
      setStatus("承認ページで確認コードを承認してください。");
      await pollUntilAuthorized(authorization, generation);
    } catch (error) {
      setStatus(errorMessage(error), true);
    } finally {
      setBusy(elements["connect-button"], false, "接続を開始");
    }
  });

  elements["extract-button"].addEventListener("click", async () => {
    setBusy(elements["extract-button"], true, "読み取り中");
    setStatus("表示中のカルテを確認しています。");
    elements["result-section"].hidden = true;
    try {
      const response = await sendToActiveTab({ type: "halunasu:extract" });
      if (!response?.ok) {
        throw responseError(response);
      }
      preview = response;
      renderPreview(response);
      elements["setting-control"].disabled = false;
      updateCalculateButton();
      setStatus("読み取りました。受診区分を選択してください。");
    } catch (error) {
      preview = null;
      elements["chart-preview"].hidden = true;
      elements["setting-control"].disabled = true;
      updateCalculateButton();
      setStatus(errorMessage(error), true);
    } finally {
      setBusy(elements["extract-button"], false, "画面から読み取る");
    }
  });

  document.querySelectorAll('input[name="setting"]').forEach((input) => {
    input.addEventListener("change", updateCalculateButton);
  });

  elements["calculate-button"].addEventListener("click", async () => {
    const setting = selectedSetting();
    if (!preview || !setting) {
      return;
    }
    setBusy(elements["calculate-button"], true, "作成中");
    setStatus("表示中のカルテを再確認して算定案を作成しています。");
    try {
      const prepared = await sendToActiveTab({
        type: "halunasu:prepare-calculation",
        previewFingerprint: preview.previewFingerprint
      });
      if (!prepared?.ok) {
        throw responseError(prepared);
      }
      const result = await api.calculate({
        contractVersion: "v1",
        sourceSystem: "homis",
        externalPatientId: prepared.externalPatientId,
        sourceRecordId: prepared.sourceRecordId,
        sourceRecordDisplayId: prepared.sourceRecordDisplayId || undefined,
        serviceDate: prepared.serviceDate,
        receptionTime: prepared.receptionTime || undefined,
        setting,
        encounterTypeSource: "user",
        clinicalText: prepared.clinicalText,
        extractionProof: prepared.extractionProof
      });
      renderResult(result.sidecarDraft);
      setStatus("算定案を作成しました。内容はすべて承認前です。");
    } catch (error) {
      if (["preview_changed", "chart_changed_during_extraction"].includes(error.code)) {
        preview = null;
        elements["chart-preview"].hidden = true;
        elements["setting-control"].disabled = true;
      }
      if ([401, 403].includes(error.status)) {
        setConnected(false);
      }
      setStatus(errorMessage(error), true);
    } finally {
      setBusy(elements["calculate-button"], false, "算定案を作成");
      updateCalculateButton();
    }
  });

  async function pollUntilAuthorized(authorization, generation) {
    const expiresAt = Date.parse(authorization.expiresAt);
    const interval = Math.max(Number(authorization.pollIntervalSeconds || 5), 5) * 1000;
    while (generation === pollingGeneration && Date.now() < expiresAt) {
      await delay(interval);
      try {
        await api.pollDeviceAuthorization();
        setConnected(true);
        elements["device-code-area"].hidden = true;
        setStatus("端末を接続しました。表示中のカルテを読み取れます。");
        return;
      } catch (error) {
        if (error.code === "authorization_pending") {
          continue;
        }
        if (error.status === 429) {
          setStatus("接続確認が集中しています。しばらく待って再確認します。");
          continue;
        }
        throw error;
      }
    }
    if (generation === pollingGeneration) {
      throw responseError({ code: "expired_token", error: "確認コードの有効期限が切れました。" });
    }
  }

  function setConnected(connected) {
    elements["connection-badge"].textContent = connected ? "接続済み" : "未接続";
    elements["connection-badge"].classList.toggle("connected", connected);
    elements["connection-copy"].textContent = connected
      ? "この端末は施設アカウントに接続されています。"
      : "初回のみ、この端末を施設アカウントへ接続します。";
    elements["connect-button"].hidden = connected;
    elements["calculation-section"].hidden = !connected;
  }

  function renderPreview(extraction) {
    elements["preview-patient"].textContent = extraction.externalPatientId;
    elements["preview-date"].textContent = extraction.serviceDate;
    elements["preview-record"].textContent = extraction.sourceRecordDisplayId || extraction.sourceRecordId;
    elements["preview-text"].textContent = extraction.clinicalText;
    elements["chart-preview"].hidden = false;
  }

  function renderResult(sidecarDraft = {}) {
    const calculation = sidecarDraft.calculation || {};
    const candidates = Array.isArray(calculation.candidates) ? calculation.candidates : [];
    elements["total-points"].textContent = `${Number(calculation.estimatedTotalPoints || 0).toLocaleString("ja-JP")}点`;
    elements["revision-copy"].textContent = `再計算番号 ${Number(sidecarDraft.sourceRevision || 1)}。同じカルテを再度実行すると内容を更新します。`;
    renderCandidates(elements["line-candidates"], candidates.filter((item) => item.sourceType === "calculated_line"));
    renderCandidates(elements["proposal-candidates"], candidates.filter((item) => item.sourceType === "proposal"));
    const issues = [
      ...(Array.isArray(calculation.warnings) ? calculation.warnings : []),
      ...(Array.isArray(calculation.reviewIssues) ? calculation.reviewIssues : [])
    ];
    elements["issue-count"].textContent = `${issues.length}件`;
    replaceChildren(elements.issues, issues.length
      ? issues.map((issue) => createTextRow("issue-row", issueText(issue)))
      : [createTextRow("issue-row", "警告・確認事項はありません。")]);
    elements["result-section"].hidden = false;
  }

  function renderCandidates(container, candidates) {
    const rows = candidates.length ? candidates.map((candidate) => {
      const row = document.createElement("div");
      row.className = "candidate-row";
      const header = document.createElement("header");
      const name = document.createElement("strong");
      name.textContent = candidate.name || candidate.code || "名称未確定";
      const points = document.createElement("span");
      points.textContent = candidate.requiresSelection
        ? "点数未確定"
        : `${Number(candidate.estimatedTotalPoints || 0).toLocaleString("ja-JP")}点`;
      header.append(name, points);
      const detail = document.createElement("small");
      detail.textContent = [
        candidate.code,
        candidate.codeCandidates?.length ? `区分選択が必要（${candidate.codeCandidates.join(" / ")}）` : ""
      ]
        .filter(Boolean)
        .join(" / ");
      row.append(header, detail);
      return row;
    }) : [createTextRow("candidate-row", "候補はありません。")];
    replaceChildren(container, rows);
  }

  function createTextRow(className, value) {
    const row = document.createElement("div");
    row.className = className;
    row.textContent = value;
    return row;
  }

  function replaceChildren(container, children) {
    container.replaceChildren(...children);
  }

  function issueText(issue) {
    if (typeof issue === "string") {
      return issue;
    }
    return issue?.message || issue?.reason || issue?.title || "内容を確認してください。";
  }

  async function sendToActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw responseError({ error: "HOMISの患者カルテ画面を開いてください。" });
    }
    return chrome.tabs.sendMessage(tab.id, message);
  }

  function selectedSetting() {
    return document.querySelector('input[name="setting"]:checked')?.value || "";
  }

  function updateCalculateButton() {
    elements["calculate-button"].disabled = !preview || !selectedSetting();
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
  }

  function setStatus(message, isError = false) {
    elements["status-message"].textContent = message;
    elements["status-message"].classList.toggle("error", isError);
  }

  function responseError(response = {}) {
    const error = new Error(response.error || "処理を完了できませんでした。");
    error.code = response.code || "request_failed";
    error.status = response.status || 0;
    return error;
  }

  function errorMessage(error) {
    if (error.code === "selector_contract_mismatch") {
      return "画面の形式が想定と異なります（契約 homis-mock-v2）。";
    }
    if (["preview_changed", "chart_changed_during_extraction"].includes(error.code)) {
      return "カルテが切り替わりました。画面を再読み取りしてください。";
    }
    if (error.code === "expired_token" || String(error.message).includes("extractionProof is stale")) {
      return "読み取り内容の有効期限が切れました。画面を再読み取りしてください。";
    }
    if (["invalid_grant", "grant_missing"].includes(error.code) || error.status === 401) {
      return "端末の接続が無効です。もう一度接続してください。";
    }
    if (error.code === "access_denied") {
      return "端末の接続が拒否されました。管理者に確認してください。";
    }
    if (error.status === 429) {
      return "処理が集中しています。しばらく待ってから再度お試しください。";
    }
    return String(error?.message || "処理を完了できませんでした。");
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})(globalThis);
