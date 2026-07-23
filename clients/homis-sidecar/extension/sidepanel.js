(function registerSidePanel(global) {
  "use strict";

  const api = global.HalunasuSidecarApi;
  const SETTING_LABELS = {
    home_visit: "定期訪問",
    house_call: "往診",
    outpatient: "外来",
    telephone_revisit: "電話再診"
  };
  const AUTO_READ_DEBOUNCE_MS = 220;
  let preview = null;
  let pollingGeneration = 0;
  let extractionGeneration = 0;
  let autoReadTimer = null;
  let isConnected = false;
  let lastCalculationContext = null;
  let encounterTypeSource = null;
  let visitKindSource = null;
  let sameBuildingSource = null;

  const elements = Object.fromEntries([
    "connection-badge", "connection-copy", "connect-button", "connection-section",
    "device-code-area", "device-code",
    "approval-link", "calculation-section", "extract-button", "chart-preview", "preview-patient",
    "preview-date", "preview-record", "preview-text", "preview-details", "setting-control", "setting-copy",
    "telephone-eligibility-control", "telephone-patient-initiated", "telephone-instruction-given",
    "telephone-scheduled-management",
    "same-building-control", "same-building-copy",
    "calculate-button",
    "result-section", "total-points", "revision-copy", "line-candidates", "proposal-candidates",
    "issue-count", "issues", "status-message"
  ].map((id) => [id, document.getElementById(id)]));

  initialize();

  async function initialize() {
    setStatus("保存済みの接続を確認しています。");
    try {
      const connected = await api.connectWithStoredGrant();
      setConnected(Boolean(connected));
      setStatus(connected ? "" : "端末を接続してください。");
      if (connected) {
        scheduleAutoRead({ delay: 0 });
      }
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
    clearTimeout(autoReadTimer);
    const generation = ++extractionGeneration;
    await readDisplayedChart({ automatic: false, generation });
  });

  document.querySelectorAll('input[name="setting"]').forEach((input) => {
    input.addEventListener("change", () => {
      encounterTypeSource = "user";
      visitKindSource = input.value === "telephone_revisit" ? "user" : null;
      renderEncounterTypeCopy(preview, selectedEncounterType());
      renderTelephoneEligibilityControl();
      updateCalculateButton();
    });
  });

  document.querySelectorAll('input[name="same-building"]').forEach((input) => {
    input.addEventListener("change", () => {
      sameBuildingSource = input.value === "unknown" ? null : "user";
      renderSameBuildingCopy(preview, selectedSameBuilding());
    });
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "halunasu:chart-state-changed") {
      return false;
    }
    void handleChartStateChanged(message, sender);
    return false;
  });

  chrome.tabs.onActivated.addListener(() => {
    scheduleAutoRead({ invalidate: true });
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
      scheduleAutoRead({ invalidate: true });
    }
  });

  elements["calculate-button"].addEventListener("click", async () => {
    const encounterType = selectedEncounterType();
    if (!preview || !encounterType.value) {
      return;
    }
    const expectedPreviewFingerprint = preview.previewFingerprint;
    setBusy(elements["calculate-button"], true, "作成中");
    setStatus("表示中のカルテを再確認して算定案を作成しています。");
    try {
      const prepared = await sendToActiveTab({
        type: "halunasu:prepare-calculation",
        previewFingerprint: expectedPreviewFingerprint
      });
      if (!prepared?.ok) {
        throw responseError(prepared);
      }
      assertCurrentPreview(expectedPreviewFingerprint);
      const sameBuilding = selectedSameBuilding();
      const result = await api.calculate({
        contractVersion: "v1",
        sourceSystem: "homis",
        externalPatientId: prepared.externalPatientId,
        sourceRecordId: prepared.sourceRecordId,
        sourceRecordDisplayId: prepared.sourceRecordDisplayId || undefined,
        serviceDate: prepared.serviceDate,
        receptionTime: prepared.receptionTime || undefined,
        setting: encounterType.value,
        encounterTypeSource: encounterType.source,
        visitKind: encounterType.visitKind,
        visitKindSource: encounterType.visitKindSource,
        telephoneEligibility: selectedTelephoneEligibility(encounterType),
        sameBuilding: sameBuilding.value,
        sameBuildingSource: sameBuilding.source,
        singleBuildingPatientCount: prepared.singleBuildingPatientCount ?? null,
        clinicalText: prepared.clinicalText,
        extractionProof: prepared.extractionProof
      });
      assertCurrentPreview(expectedPreviewFingerprint);
      lastCalculationContext = {
        externalPatientId: prepared.externalPatientId,
        serviceDate: prepared.serviceDate,
        settingLabel: encounterType.label,
        sameBuildingLabel: sameBuilding.label
      };
      renderResult(result.sidecarDraft);
      setStatus("");
    } catch (error) {
      if (["preview_changed", "chart_changed_during_extraction"].includes(error.code)) {
        resetChartState();
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

  async function handleChartStateChanged(message, sender) {
    if (!isConnected || !sender.tab?.id) {
      return;
    }
    const tab = await activeTab();
    if (!tab?.id || tab.id !== sender.tab.id) {
      return;
    }
    if (!message.available) {
      clearTimeout(autoReadTimer);
      extractionGeneration += 1;
      resetChartState();
      setStatus("HOMISのカルテ画面を開くと自動で読み取ります。");
      return;
    }
    const identityChanged = Boolean(preview) && (
      preview.externalPatientId !== message.patientId
      || preview.sourceRecordId !== message.sourceRecordId
    );
    scheduleAutoRead({ invalidate: identityChanged });
  }

  function scheduleAutoRead(options = {}) {
    if (!isConnected) {
      return;
    }
    clearTimeout(autoReadTimer);
    const generation = ++extractionGeneration;
    if (options.invalidate) {
      resetChartState();
      setStatus("表示中のカルテが切り替わりました。読み取り直しています。");
    }
    const delayMilliseconds = Number.isFinite(options.delay)
      ? Math.max(Number(options.delay), 0)
      : AUTO_READ_DEBOUNCE_MS;
    autoReadTimer = setTimeout(() => {
      void readDisplayedChart({ automatic: true, generation });
    }, delayMilliseconds);
  }

  async function readDisplayedChart({ automatic, generation }) {
    setBusy(elements["extract-button"], true, "読み取り中");
    if (!automatic) {
      setStatus("表示中のカルテを確認しています。");
    }
    try {
      const response = await sendToActiveTab({ type: "halunasu:extract" });
      if (generation !== extractionGeneration) {
        return;
      }
      if (!response?.ok) {
        throw responseError(response);
      }
      const unchanged = preview?.previewFingerprint === response.previewFingerprint;
      if (unchanged) {
        preview = response;
        if (!automatic) {
          setStatus("表示内容に変更はありません。");
        }
        return;
      }

      preview = response;
      lastCalculationContext = null;
      elements["result-section"].hidden = true;
      renderPreview(response);
      elements["setting-control"].disabled = false;
      elements["same-building-control"].disabled = false;
      updateCalculateButton();
      setStatus(selectedEncounterType().value
        ? "表示中のカルテを読み取りました。"
        : "読み取りました。受診区分を選択してください。");
    } catch (error) {
      if (generation !== extractionGeneration) {
        return;
      }
      resetChartState();
      const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(String(error?.message || ""));
      setStatus(
        automatic && noReceiver
          ? "HOMISのカルテ画面を開くと自動で読み取ります。"
          : errorMessage(error),
        !(automatic && noReceiver)
      );
    } finally {
      if (generation === extractionGeneration) {
        setBusy(elements["extract-button"], false, "再読み取り");
        updateCalculateButton();
      }
    }
  }

  function resetChartState() {
    preview = null;
    lastCalculationContext = null;
    encounterTypeSource = null;
    visitKindSource = null;
    sameBuildingSource = null;
    elements["chart-preview"].hidden = true;
    elements["result-section"].hidden = true;
    elements["setting-control"].disabled = true;
    elements["same-building-control"].disabled = true;
    elements["telephone-eligibility-control"].hidden = true;
    document.querySelectorAll('input[name="setting"]').forEach((input) => { input.checked = false; });
    for (const id of [
      "telephone-patient-initiated",
      "telephone-instruction-given",
      "telephone-scheduled-management"
    ]) {
      elements[id].value = "unknown";
    }
    const unknownSameBuilding = document.querySelector('input[name="same-building"][value="unknown"]');
    if (unknownSameBuilding) {
      unknownSameBuilding.checked = true;
    }
    elements["setting-copy"].textContent = "";
    elements["same-building-copy"].textContent = "";
    setBusy(elements["extract-button"], false, "再読み取り");
    updateCalculateButton();
  }

  function assertCurrentPreview(expectedFingerprint) {
    if (!preview || preview.previewFingerprint !== expectedFingerprint) {
      throw responseError({
        code: "preview_changed",
        error: "表示中のカルテが読み取り時から変わりました。"
      });
    }
  }

  async function pollUntilAuthorized(authorization, generation) {
    const expiresAt = Date.parse(authorization.expiresAt);
    const interval = Math.max(Number(authorization.pollIntervalSeconds || 5), 5) * 1000;
    while (generation === pollingGeneration && Date.now() < expiresAt) {
      await delay(interval);
      try {
        await api.pollDeviceAuthorization();
        setConnected(true);
        elements["device-code-area"].hidden = true;
        setStatus("端末を接続しました。表示中のカルテを確認しています。");
        scheduleAutoRead({ delay: 0 });
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
    isConnected = connected;
    elements["connection-badge"].textContent = connected ? "接続済み" : "未接続";
    elements["connection-badge"].classList.toggle("connected", connected);
    // 接続済みなら接続セクション自体を畳む(常時表示する価値のある情報ではない)。
    elements["connection-section"].hidden = connected;
    elements["connect-button"].hidden = connected;
    elements["calculation-section"].hidden = !connected;
    if (connected) {
      elements["device-code-area"].hidden = true;
    } else {
      clearTimeout(autoReadTimer);
      extractionGeneration += 1;
      resetChartState();
    }
  }

  function renderPreview(extraction) {
    elements["preview-patient"].textContent = extraction.externalPatientId;
    elements["preview-date"].textContent = extraction.serviceDate;
    elements["preview-record"].textContent = extraction.sourceRecordDisplayId || extraction.sourceRecordId;
    elements["preview-text"].textContent = extraction.clinicalText;
    elements["preview-details"].open = false;
    selectExtractedEncounterType(extraction);
    selectExtractedSameBuilding(extraction);
    renderTelephoneEligibilityControl();
    elements["chart-preview"].hidden = false;
  }

  function renderResult(sidecarDraft = {}) {
    const calculation = sidecarDraft.calculation || {};
    const candidates = Array.isArray(calculation.candidates) ? calculation.candidates : [];
    elements["total-points"].textContent = `${Number(calculation.estimatedTotalPoints || 0).toLocaleString("ja-JP")}点`;
    elements["revision-copy"].textContent = [
      lastCalculationContext
        ? `患者${lastCalculationContext.externalPatientId} / ${lastCalculationContext.serviceDate} / ${lastCalculationContext.settingLabel} / ${lastCalculationContext.sameBuildingLabel}`
        : "",
      `再計算 ${Number(sidecarDraft.sourceRevision || 1)}回目`
    ].filter(Boolean).join(" ・ ");
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
      row.append(header);
      if (candidate.requiresSelection && candidate.codeCandidates?.length) {
        // コードの羅列はパネルを圧迫するため件数だけ見せ、必要なときに展開する。
        const choices = document.createElement("details");
        choices.className = "code-details";
        const summary = document.createElement("summary");
        summary.textContent = `${candidate.codeCandidates.length}件の区分から選択が必要`;
        const list = document.createElement("small");
        list.textContent = candidate.codeCandidates.join(" / ");
        choices.append(summary, list);
        row.append(choices);
      } else if (candidate.code) {
        const detail = document.createElement("small");
        detail.className = "candidate-code";
        detail.textContent = candidate.code;
        row.append(detail);
      }
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
    const tab = await activeTab();
    if (!tab?.id) {
      throw responseError({ error: "HOMISの患者カルテ画面を開いてください。" });
    }
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function selectedEncounterType() {
    const selectionKey = document.querySelector('input[name="setting"]:checked')?.value || "";
    const visitKind = selectionKey === "telephone_revisit" ? "telephone_revisit" : null;
    const value = visitKind ? "outpatient" : selectionKey;
    return {
      value,
      source: value ? (encounterTypeSource || "user") : null,
      visitKind,
      visitKindSource: visitKind ? (visitKindSource || "user") : null,
      selectionKey,
      label: SETTING_LABELS[selectionKey] || selectionKey
    };
  }

  function selectExtractedEncounterType(extraction = {}) {
    document.querySelectorAll('input[name="setting"]').forEach((input) => { input.checked = false; });
    const selectionKey = extraction.visitKind === "telephone_revisit"
      ? "telephone_revisit"
      : extraction.encounterType;
    const input = selectionKey
      ? document.querySelector(`input[name="setting"][value="${selectionKey}"]`)
      : null;
    if (input) {
      input.checked = true;
    }
    encounterTypeSource = input ? (extraction.encounterTypeSource || "dom") : null;
    visitKindSource = extraction.visitKind === "telephone_revisit"
      ? (extraction.visitKindSource || "dom")
      : null;
    renderEncounterTypeCopy(extraction, selectedEncounterType());
  }

  function renderEncounterTypeCopy(extraction = {}, selection = selectedEncounterType()) {
    if (selection.source === "user") {
      elements["setting-copy"].textContent = `手動選択: ${selection.label}`;
      return;
    }
    if (selection.value && extraction.encounterTypeSource === "dom") {
      const sourceLabel = extraction.encounterTypeLabel || selection.label;
      elements["setting-copy"].textContent = `画面の「診療記録 ${sourceLabel}」から「${selection.label}」を選択しました。`;
      return;
    }
    if (extraction.encounterTypeLabel) {
      elements["setting-copy"].textContent = `画面の「${extraction.encounterTypeLabel}」は自動判定の対象外です。受診区分を選択してください。`;
      return;
    }
    elements["setting-copy"].textContent = "画面から判定できません。受診区分を選択してください。";
  }

  function renderTelephoneEligibilityControl() {
    elements["telephone-eligibility-control"].hidden = (
      selectedEncounterType().visitKind !== "telephone_revisit"
    );
  }

  function selectedTelephoneEligibility(encounterType = selectedEncounterType()) {
    if (encounterType.visitKind !== "telephone_revisit") {
      return null;
    }
    return {
      establishedPatient: null,
      patientInitiated: nullableBooleanSelection(elements["telephone-patient-initiated"].value),
      instructionGiven: nullableBooleanSelection(elements["telephone-instruction-given"].value),
      scheduledManagement: nullableBooleanSelection(elements["telephone-scheduled-management"].value)
    };
  }

  function nullableBooleanSelection(value) {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return null;
  }

  function selectedSameBuilding() {
    const value = document.querySelector('input[name="same-building"]:checked')?.value || "unknown";
    if (value === "same") {
      return { value: true, source: sameBuildingSource || "user", label: "同一建物" };
    }
    if (value === "outside") {
      return { value: false, source: sameBuildingSource || "user", label: "同一建物以外" };
    }
    return { value: null, source: null, label: "同一建物区分未確認" };
  }

  function selectExtractedSameBuilding(extraction = {}) {
    const value = extraction.sameBuilding === true
      ? "same"
      : extraction.sameBuilding === false
        ? "outside"
        : "unknown";
    const input = document.querySelector(`input[name="same-building"][value="${value}"]`);
    if (input) {
      input.checked = true;
    }
    sameBuildingSource = extraction.sameBuildingSource || null;
    renderSameBuildingCopy(extraction, selectedSameBuilding());
  }

  function renderSameBuildingCopy(extraction = {}, selection = selectedSameBuilding()) {
    const count = Number(extraction?.singleBuildingPatientCount || 0);
    if (selection.source === "user") {
      elements["same-building-copy"].textContent = `手動選択: ${selection.label}`;
      return;
    }
    if (count > 0) {
      elements["same-building-copy"].textContent = `画面の単一建物 ${count}名から「${selection.label}」と判定しました。`;
      return;
    }
    if (extraction?.privateResidence === true) {
      elements["same-building-copy"].textContent = "画面の個人宅表示から「同一建物以外」と判定しました。";
      return;
    }
    elements["same-building-copy"].textContent = "画面から判定できません。未確認のままでは該当明細を合計に含めません。";
  }

  function updateCalculateButton() {
    elements["calculate-button"].disabled = !preview || !selectedEncounterType().value;
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
    if (/Receiving end does not exist|Could not establish connection/i.test(String(error?.message || ""))) {
      return "カルテ画面と接続できません。拡張機能とカルテ画面を再読み込みしてください。";
    }
    if (error.code === "selector_contract_mismatch") {
      return "画面の形式が想定と異なります（契約 homis-mock-v3）。";
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
