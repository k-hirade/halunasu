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
  const MAX_COMPLETED_CALCULATION_TASKS = 20;
  let preview = null;
  let pollingGeneration = 0;
  let extractionGeneration = 0;
  let autoReadTimer = null;
  let previewAgeTimer = null;
  let isConnected = false;
  let encounterTypeSource = null;
  let visitKindSource = null;
  let sameBuildingSource = null;
  let currentSidecarDraft = null;
  let resultGeneration = 0;
  let calculationTaskGeneration = 0;
  let activeCalculationTask = null;
  let currentResultTask = null;
  const completedCalculationTasks = new Map();
  const patientChargeMutationsInFlight = new Map();
  const acknowledgementMutationsInFlight = new Set();

  const elements = Object.fromEntries([
    "connection-badge", "connection-copy", "connect-button", "connection-section",
    "device-code-area", "device-code",
    "approval-link", "calculation-section", "extract-button", "chart-preview", "preview-patient",
    "preview-date", "preview-record", "preview-read-status", "setting-control", "setting-copy",
    "telephone-eligibility-control", "telephone-patient-initiated", "telephone-instruction-given",
    "telephone-scheduled-management",
    "same-building-control", "same-building-copy",
    "calculate-button",
    "result-section", "total-points",
    "included-group", "line-candidates", "decision-group", "decision-candidates",
    "patient-charge-group", "patient-charge-handling", "patient-charge-save",
    "patient-charge-status",
    "status-message"
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

  elements["patient-charge-handling"].addEventListener("change", () => {
    renderPatientChargeControls(currentSidecarDraft, { preserveSelection: true });
  });

  elements["patient-charge-save"].addEventListener("click", () => {
    void savePatientChargeSetting();
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
    if (!preview || !encounterType.value || patientChargeMutationsInFlight.size > 0) {
      return;
    }
    const sameBuilding = selectedSameBuilding();
    const telephoneEligibility = selectedTelephoneEligibility(encounterType);
    const task = {
      generation: ++calculationTaskGeneration,
      phase: "extracting",
      sourceTabId: preview.sourceTabId,
      externalPatientId: preview.externalPatientId,
      sourceRecordId: preview.sourceRecordId,
      serviceDate: preview.serviceDate,
      previewFingerprint: preview.previewFingerprint,
      calculationInput: calculationInputSnapshot({
        encounterType,
        sameBuilding,
        telephoneEligibility
      }),
      patientChargeFailureMessage: "",
      sidecarDraft: null
    };
    completedCalculationTasks.delete(calculationTaskKey(task));
    activeCalculationTask = task;
    invalidateRenderedResult();
    setBusy(elements["calculate-button"], true, "作成中");
    setStatus("表示中のカルテを再確認して算定案を作成しています。");
    try {
      const prepared = await sendToTab(task.sourceTabId, {
        type: "halunasu:prepare-calculation",
        previewFingerprint: task.previewFingerprint
      });
      if (!prepared?.ok) {
        throw responseError(prepared);
      }
      await assertCurrentCalculationSource(task);
      assertPreparedCalculationSource(task, prepared);
      task.phase = "calculating";
      const result = await api.calculate({
        contractVersion: "v1",
        sourceSystem: "homis",
        externalPatientId: prepared.externalPatientId,
        sourceRecordId: prepared.sourceRecordId,
        sourceRecordDisplayId: prepared.sourceRecordDisplayId || undefined,
        serviceDate: prepared.serviceDate,
        receptionTime: prepared.receptionTime || undefined,
        setting: task.calculationInput.encounterType.value,
        encounterTypeSource: task.calculationInput.encounterType.source,
        visitKind: task.calculationInput.encounterType.visitKind,
        visitKindSource: task.calculationInput.encounterType.visitKindSource,
        telephoneEligibility: task.calculationInput.telephoneEligibility,
        sameBuilding: task.calculationInput.sameBuilding.value,
        sameBuildingSource: task.calculationInput.sameBuilding.source,
        singleBuildingPatientCount: prepared.singleBuildingPatientCount ?? null,
        residenceType: prepared.facilityResidence === true
          ? "facility"
          : prepared.privateResidence === true
            ? "private"
            : null,
        clinicalText: prepared.clinicalText,
        sourceSurfaces: prepared.sourceSurfaces,
        extractionProof: prepared.extractionProof
      });
      if (activeCalculationTask !== task) {
        return;
      }
      assertCalculationResultSource(task, result?.sidecarDraft);
      task.phase = "completed";
      task.sidecarDraft = result.sidecarDraft;
      storeCompletedCalculationTask(task);
      const rendered = await renderCompletedCalculationIfCurrent(task);
      setStatus(rendered ? "" : "算定は完了しました。元のカルテに戻ると結果を表示します。");
    } catch (error) {
      if (activeCalculationTask !== task) {
        return;
      }
      activeCalculationTask = null;
      if (["preview_changed", "chart_changed_during_extraction"].includes(error.code)) {
        if (!preview || isPreviewForCalculation(task, { requireFingerprint: false })) {
          resetChartState();
        }
      }
      if ([401, 403].includes(error.status)) {
        await api.clearGrant().catch(() => {});
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
      const sourceTab = await activeTab();
      if (!sourceTab?.id) {
        throw responseError({ error: "HOMISの患者カルテ画面を開いてください。" });
      }
      const response = await sendToTab(sourceTab.id, { type: "halunasu:extract" });
      if (generation !== extractionGeneration) {
        return;
      }
      if (!response?.ok) {
        throw responseError(response);
      }
      const nextPreview = { ...response, sourceTabId: sourceTab.id };
      const unchanged = preview?.sourceTabId === nextPreview.sourceTabId
        && preview?.previewFingerprint === nextPreview.previewFingerprint;
      if (unchanged) {
        preview = nextPreview;
        const restored = await renderCompletedCalculationForCurrentPreview();
        if (!automatic) {
          setStatus(restored ? "" : "表示内容に変更はありません。");
        }
        return;
      }

      preview = nextPreview;
      invalidateRenderedResult();
      renderPreview(nextPreview);
      elements["setting-control"].disabled = false;
      elements["same-building-control"].disabled = false;
      updateCalculateButton();
      setStatus(selectedEncounterType().value
        ? "表示中のカルテを読み取りました。"
        : "読み取りました。受診区分を選択してください。");
      if (await renderCompletedCalculationForCurrentPreview()) {
        setStatus("");
      }
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
    clearInterval(previewAgeTimer);
    previewAgeTimer = null;
    preview = null;
    encounterTypeSource = null;
    visitKindSource = null;
    sameBuildingSource = null;
    elements["chart-preview"].hidden = true;
    invalidateRenderedResult();
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
      activeCalculationTask = null;
      currentResultTask = null;
      completedCalculationTasks.clear();
      resetChartState();
    }
  }

  function renderPreview(extraction) {
    elements["preview-patient"].textContent = extraction.externalPatientId;
    elements["preview-date"].textContent = extraction.serviceDate;
    elements["preview-record"].textContent = extraction.sourceRecordDisplayId || extraction.sourceRecordId;
    clearInterval(previewAgeTimer);
    renderPreviewReadStatus(extraction);
    previewAgeTimer = setInterval(() => renderPreviewReadStatus(extraction), 30_000);
    selectExtractedEncounterType(extraction);
    selectExtractedSameBuilding(extraction);
    renderTelephoneEligibilityControl();
    elements["chart-preview"].hidden = false;
  }

  function renderResult(sidecarDraft = {}, options = {}) {
    if (options.task) {
      currentResultTask = options.task;
    }
    currentSidecarDraft = sidecarDraft;
    const calculation = sidecarDraft.calculation || {};
    const candidates = (Array.isArray(calculation.candidates) ? calculation.candidates : [])
      .map((candidate) => normalizeCandidateZone(candidate));
    const decisionCandidates = candidates.filter((candidate) => (
      ["review_required", "selection_required"].includes(candidate.zone)
    ));
    elements["total-points"].textContent = `${Number(calculation.estimatedTotalPoints || 0).toLocaleString("ja-JP")}点`;
    renderCandidateGroup("included-group", "line-candidates", candidates.filter((item) => item.zone === "included"));
    renderDecisionGroup(
      decisionCandidates,
      Array.isArray(calculation.notices) ? calculation.notices : []
    );
    renderPatientChargeControls(sidecarDraft);
    if (
      currentResultTask?.patientChargeFailureMessage
      && isSameDraftRevision(currentResultTask.sidecarDraft, sidecarDraft)
    ) {
      elements["patient-charge-status"].textContent = currentResultTask.patientChargeFailureMessage;
      elements["patient-charge-status"].classList.add("is-error");
    }
    elements["result-section"].hidden = false;
  }

  function renderPatientChargeControls(sidecarDraft = {}, options = {}) {
    const patientCharge = homeMedicalTransportCharge(sidecarDraft);
    const mutation = patientChargeMutationsInFlight.get(sidecarDraft.sidecarDraftId) || null;
    const mutationInFlight = Boolean(mutation);
    const group = elements["patient-charge-group"];
    if (!patientCharge) {
      group.hidden = true;
      elements["patient-charge-handling"].value = "unknown";
      elements["patient-charge-save"].disabled = true;
      elements["patient-charge-status"].textContent = "";
      return;
    }

    group.hidden = false;
    const persistedHandling = patientChargeHandling(patientCharge);
    const selectedHandling = mutationInFlight
      ? mutation.handling
      : options.preserveSelection === true
        ? elements["patient-charge-handling"].value
        : persistedHandling;
    elements["patient-charge-handling"].value = selectedHandling;
    const writable = patientCharge.writable !== false
      && Boolean(sidecarDraft.sidecarDraftId)
      && sidecarDraft.lifecycleStatus !== "adopted";
    elements["patient-charge-handling"].disabled = mutationInFlight || !writable;
    elements["patient-charge-save"].disabled = mutationInFlight
      || !writable
      || selectedHandling === "unknown"
      || selectedHandling === persistedHandling;
    elements["patient-charge-save"].textContent = mutationInFlight ? "保存中" : "保存";
    elements["patient-charge-status"].classList.remove("is-error");
    if (!mutationInFlight) {
      elements["patient-charge-status"].textContent = patientChargeStatusText(patientCharge);
    }
  }

  async function savePatientChargeSetting() {
    const draft = currentSidecarDraft;
    const patientCharge = homeMedicalTransportCharge(draft);
    const handling = elements["patient-charge-handling"].value;
    if (
      patientChargeMutationsInFlight.has(draft?.sidecarDraftId)
      || !draft?.sidecarDraftId
      || !patientCharge
      || !["inherit", "charge", "waive", "included_in_contract"].includes(handling)
    ) {
      return;
    }
    const sourceTask = currentResultTask && isSameDraftRevision(currentResultTask.sidecarDraft, draft)
      ? currentResultTask
      : completedCalculationTaskForDraft(draft);
    let failureMessage = "";
    const mutation = { draftId: draft.sidecarDraftId, handling };
    if (sourceTask) {
      sourceTask.patientChargeFailureMessage = "";
    }
    patientChargeMutationsInFlight.set(draft.sidecarDraftId, mutation);
    renderPatientChargeControls(draft);
    updateCalculateButton();
    setStatus("");
    try {
      const response = await api.setPatientChargeSetting({
        sidecarDraftId: draft.sidecarDraftId,
        handling,
        amountMode: handling === "charge" ? "actual" : null,
        amountYen: null,
        effectiveFrom: draft.serviceDate || undefined,
        effectiveTo: null,
        expectedRevision: patientChargeRevision(patientCharge),
        expectedSourceRevision: Number(draft.sourceRevision || 0),
        expectedCalculationRevision: Number(draft.calculationRevision || 0)
      });
      if (!isSameDraftRevision(draft, response.sidecarDraft)) {
        throw responseError({ status: 409, error: "算定案が更新されています。" });
      }
      if (sourceTask && isStoredCompletedCalculationTask(sourceTask)) {
        sourceTask.sidecarDraft = mergePatientChargeResponse(
          sourceTask.sidecarDraft,
          response.sidecarDraft
        );
        sourceTask.patientChargeFailureMessage = "";
      }
      if (!isSameDraftRevision(currentSidecarDraft, draft)) {
        return;
      }
      currentSidecarDraft = mergePatientChargeResponse(currentSidecarDraft, response.sidecarDraft);
      setStatus("在宅医療交通費の患者別設定を保存しました。");
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        await api.clearGrant().catch(() => {});
        setConnected(false);
        setStatus(errorMessage(error), true);
        return;
      }
      failureMessage = errorMessage(error);
      if (sourceTask && isStoredCompletedCalculationTask(sourceTask)) {
        sourceTask.patientChargeFailureMessage = failureMessage;
      }
    } finally {
      if (patientChargeMutationsInFlight.get(draft.sidecarDraftId) === mutation) {
        patientChargeMutationsInFlight.delete(draft.sidecarDraftId);
      }
      updateCalculateButton();
      if (isSameDraftRevision(currentSidecarDraft, draft)) {
        renderResult(currentSidecarDraft, { task: sourceTask || currentResultTask });
        if (failureMessage) {
          elements["patient-charge-status"].textContent = failureMessage;
          elements["patient-charge-status"].classList.add("is-error");
        }
      }
    }
  }

  function homeMedicalTransportCharge(sidecarDraft = {}) {
    return (Array.isArray(sidecarDraft.patientCharges) ? sidecarDraft.patientCharges : [])
      .find((item) => item?.chargeType === "home_medical_transport") || null;
  }

  function patientChargeHandling(patientCharge = {}) {
    const value = String(patientCharge.handling || patientCharge.billingHandling || "unknown");
    return ["inherit", "charge", "waive", "included_in_contract"].includes(value)
      ? value
      : "unknown";
  }

  function patientChargeRevision(patientCharge = {}) {
    const value = Number(
      patientCharge.agreementRevision
      ?? patientCharge.contractRevision
      ?? patientCharge.revision
      ?? 0
    );
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function patientChargeStatusText(patientCharge = {}) {
    if (["patient_not_linked", "patient_unresolved"].includes(patientCharge.unavailableReason)) {
      return "患者連携後に設定できます。";
    }
    if (["setting_store_unavailable", "setting_lookup_failed"].includes(patientCharge.unavailableReason)) {
      return "患者別設定を取得できません。再読み取りしてください。";
    }
    if (patientCharge.writable === false) {
      return "この算定案では患者別設定を変更できません。";
    }
    switch (patientChargeHandling(patientCharge)) {
      case "inherit":
        return patientCharge.unavailableReason === "facility_default_not_configured"
          ? "施設設定が未登録のため、請求は未確定です。"
          : "施設設定を継承します。";
      case "charge":
        return patientCharge.status === "ready"
          ? "請求する設定です。"
          : "請求する設定です。実費入力待ちです。";
      case "waive":
        return "この患者には請求しません。";
      case "included_in_contract":
        return "患者契約に含めます。";
      default:
        return "未設定です。選択するまで請求に含めません。";
    }
  }

  function mergePatientChargeResponse(currentDraft, responseDraft) {
    if (!isSameDraftRevision(currentDraft, responseDraft)) {
      throw responseError({ status: 409, error: "算定案が更新されています。" });
    }
    return {
      ...currentDraft,
      patientCharges: Array.isArray(responseDraft.patientCharges)
        ? responseDraft.patientCharges
        : currentDraft.patientCharges
    };
  }

  function renderPreviewReadStatus(extraction = {}) {
    const itemCount = Math.max(0, Number(extraction.clinicalTextNodeCount || 0));
    elements["preview-read-status"].textContent = `読取済み: SOAP ${itemCount}項目・${elapsedLabel(extraction.extractedAt)}`;
  }

  function elapsedLabel(extractedAt) {
    const elapsedMs = Date.now() - Date.parse(String(extractedAt || ""));
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "時刻未取得";
    const seconds = Math.floor(elapsedMs / 1000);
    if (seconds < 10) return "たった今";
    if (seconds < 60) return `${seconds}秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分前`;
    return `${Math.floor(minutes / 60)}時間前`;
  }

  function renderCandidateGroup(groupId, containerId, candidates) {
    elements[groupId].hidden = candidates.length === 0;
    renderCandidates(elements[containerId], candidates);
  }

  function renderDecisionGroup(candidates, notices) {
    elements["decision-group"].hidden = candidates.length === 0;
    replaceChildren(
      elements["decision-candidates"],
      candidates.map((candidate) => createDecisionRow(candidate, notices))
    );
  }

  function createDecisionRow(candidate, notices) {
    const row = document.createElement("div");
    row.className = `decision-row zone-${candidate.zone}`;
    row.dataset.candidateId = String(candidate.candidateId || "");
    row.dataset.zone = candidate.zone;
    row.setAttribute("role", "listitem");

    const candidateName = decisionCandidateName(candidate);
    const kind = document.createElement("button");
    kind.type = "button";
    kind.className = `decision-kind decision-kind-${candidate.zone}`;
    kind.dataset.candidateKey = String(candidate.candidateKey || "");
    renderAcknowledgementButton(kind, candidate, candidateName, {
      busy: acknowledgementMutationsInFlight.has(String(candidate.candidateKey || ""))
    });
    kind.addEventListener("click", () => {
      void toggleCandidateAcknowledgement(kind, candidate, candidateName);
    });

    const name = document.createElement("strong");
    name.className = "decision-name";
    name.textContent = candidateName;

    const separator = document.createElement("span");
    separator.className = "decision-separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = "｜";

    const summary = document.createElement("span");
    summary.className = "decision-summary";
    summary.textContent = candidate.zone === "selection_required"
      ? selectionDecisionSummary(candidate)
      : reviewDecisionSummary(candidate, notices);

    row.append(kind, name, separator, summary);
    return row;
  }

  function renderAcknowledgementButton(button, candidate, candidateName, options = {}) {
    const acknowledgement = candidateAcknowledgement(candidate);
    const acknowledged = acknowledgement.status === "acknowledged";
    const pendingLabel = candidate.zone === "selection_required" ? "区分確認" : "要確認";
    const busy = options.busy === true;
    const canSave = Boolean(
      currentSidecarDraft?.sidecarDraftId
      && candidate.candidateKey
      && candidate.candidateFingerprint
    );
    button.dataset.acknowledgementAvailable = canSave ? "true" : "";
    button.textContent = busy ? "保存中" : acknowledged ? "確認済み" : pendingLabel;
    button.classList.toggle("is-acknowledged", acknowledged);
    button.disabled = busy || !canSave;
    button.setAttribute("aria-pressed", String(acknowledged));
    if (busy) {
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("aria-busy");
    }
    button.setAttribute(
      "aria-label",
      busy
        ? `${candidateName}の確認状態を保存中`
        : acknowledged
          ? `${candidateName}の確認済みを取り消す`
          : `${candidateName}の${pendingLabel}を確認済みにする`
    );
  }

  function candidateAcknowledgement(candidate = {}) {
    const acknowledgement = candidate.acknowledgement && typeof candidate.acknowledgement === "object"
      ? candidate.acknowledgement
      : {};
    const status = ["acknowledged", "unacknowledged", "stale"].includes(acknowledgement.status)
      ? acknowledgement.status
      : "unacknowledged";
    return {
      ...acknowledgement,
      status,
      version: Math.max(0, Number(acknowledgement.version || 0))
    };
  }

  async function toggleCandidateAcknowledgement(button, candidate, candidateName) {
    const candidateKey = String(candidate.candidateKey || "");
    if (acknowledgementMutationsInFlight.has(candidateKey) || button.disabled) {
      return;
    }
    const draft = currentSidecarDraft;
    const generation = resultGeneration;
    const acknowledgement = candidateAcknowledgement(candidate);
    const acknowledged = acknowledgement.status === "acknowledged";
    acknowledgementMutationsInFlight.add(candidateKey);
    renderAcknowledgementButton(button, candidate, candidateName, { busy: true });
    setStatus("");
    try {
      const response = await api.setCandidateAcknowledgement({
        sidecarDraftId: draft.sidecarDraftId,
        candidateKey: candidate.candidateKey,
        acknowledged: !acknowledged,
        expectedSourceRevision: Number(draft.sourceRevision || 0),
        expectedCalculationRevision: Number(draft.calculationRevision || 0),
        expectedAcknowledgementVersion: acknowledgement.version,
        candidateFingerprint: candidate.candidateFingerprint
      });
      if (!isCurrentResult(draft, generation)) {
        return;
      }
      currentSidecarDraft = mergeAcknowledgementResponse(
        currentSidecarDraft,
        response.sidecarDraft,
        candidateKey
      );
      if (isSameDraftRevision(currentResultTask?.sidecarDraft, currentSidecarDraft)) {
        currentResultTask.sidecarDraft = currentSidecarDraft;
      }
      if (
        activeCalculationTask !== currentResultTask
        && isSameDraftRevision(activeCalculationTask?.sidecarDraft, currentSidecarDraft)
      ) {
        activeCalculationTask.sidecarDraft = currentSidecarDraft;
      }
      setStatus(acknowledged
        ? `${candidateName}を未確認に戻しました。`
        : `${candidateName}を確認済みにしました。`);
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        await api.clearGrant().catch(() => {});
        setConnected(false);
        setStatus(errorMessage(error), true);
        return;
      }
      if (!isCurrentResult(draft, generation)) {
        return;
      }
      setStatus(errorMessage(error), true);
    } finally {
      if (generation === resultGeneration) {
        acknowledgementMutationsInFlight.delete(candidateKey);
      }
      if (isCurrentResult(draft, generation)) {
        renderResult(currentSidecarDraft);
      }
    }
  }

  function mergeAcknowledgementResponse(currentDraft, responseDraft, candidateKey) {
    if (!isSameDraftRevision(currentDraft, responseDraft)) {
      throw responseError({ status: 409, error: "算定案が更新されています。" });
    }
    const responseCandidate = (responseDraft.calculation?.candidates || []).find((item) => (
      String(item.candidateKey || "") === candidateKey
    ));
    if (!responseCandidate) {
      throw responseError({ status: 409, error: "算定候補が更新されています。" });
    }
    return {
      ...currentDraft,
      calculation: {
        ...currentDraft.calculation,
        candidates: (currentDraft.calculation?.candidates || []).map((item) => (
          String(item.candidateKey || "") === candidateKey ? responseCandidate : item
        ))
      }
    };
  }

  function isCurrentResult(draft, generation) {
    return generation === resultGeneration
      && isSameDraftRevision(currentSidecarDraft, draft);
  }

  function isSameDraftRevision(left, right) {
    return left?.sidecarDraftId === right?.sidecarDraftId
      && Number(left?.sourceRevision || 0) === Number(right?.sourceRevision || 0)
      && Number(left?.calculationRevision || 0) === Number(right?.calculationRevision || 0);
  }

  function invalidateRenderedResult() {
    resultGeneration += 1;
    acknowledgementMutationsInFlight.clear();
    currentSidecarDraft = null;
    currentResultTask = null;
    elements["result-section"].hidden = true;
  }

  function decisionCandidateName(candidate) {
    const display = candidate.display && typeof candidate.display === "object"
      ? candidate.display
      : null;
    const exactOption = candidate.selectionResolution === "exact"
      ? candidate.selectionNarrowing?.remainingOptions?.[0]
      : null;
    const stem = display?.stem || candidate.name || candidate.code || "名称未確定";
    const qualifier = exactOption?.qualifierLabel
      || (candidate.zone === "review_required" ? display?.qualifier : "");
    return qualifier
      ? appendQualifierLabel(stem, qualifier)
      : stem;
  }

  function reviewDecisionSummary(candidate, notices) {
    const exactOption = candidate.selectionResolution === "exact"
      ? candidate.selectionNarrowing?.remainingOptions?.[0]
      : null;
    const pointValue = finiteNumber(
      exactOption?.points ?? candidate.estimatedTotalPoints ?? candidate.points
    );
    const points = pointValue !== null && pointValue > 0
      ? `${formatPoints(pointValue)}点`
      : "点数未確定";
    const reason = humanDecisionReason(candidate, notices, exactOption?.axisQuestion)
      || "算定要件を確認してください";
    return `${points}｜${reason}`;
  }

  function selectionDecisionSummary(candidate) {
    const narrowing = candidate.selectionNarrowing && typeof candidate.selectionNarrowing === "object"
      ? candidate.selectionNarrowing
      : {};
    const options = Array.isArray(narrowing.remainingOptions) ? narrowing.remainingOptions : [];
    const question = options.find((option) => String(option?.axisQuestion || "").trim())?.axisQuestion
      || "算定区分を確認してください";
    if (options.length > 0 && options.length <= 2) {
      const choices = options.map((option) => {
        const label = String(option?.qualifierLabel || "区分名未設定").trim();
        const points = finiteNumber(option?.points);
        return `${label} ${points !== null && points > 0 ? `${formatPoints(points)}点` : "点数未確定"}`;
      }).join(" / ");
      return `${question}｜${choices}`;
    }

    const count = Math.max(0, Number(
      narrowing.remainingOptionCount
      ?? (options.length || candidate.codeCandidates?.length || 0)
    ));
    const range = selectionPointRange(narrowing);
    const pointSummary = range
      ? range.min === range.max
        ? `${formatPoints(range.min)}点`
        : `${formatPoints(range.min)}〜${formatPoints(range.max)}点`
      : "点数未確定";
    const countSummary = count > 0 ? `（${count.toLocaleString("ja-JP")}区分）` : "";
    return `${pointSummary}${countSummary}｜${question}`;
  }

  function humanDecisionReason(candidate, notices, exactQuestion = "") {
    const candidateReason = normalizedDisplayText(candidate?.reason);
    if (candidateReason && !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/iu.test(candidateReason)) {
      return candidateReason;
    }
    const candidateId = String(candidate?.candidateId || "").trim();
    const code = String(candidate?.code || "").trim();
    const related = notices
      .filter((notice) => (
        (candidateId && String(notice?.candidateId || "").trim() === candidateId)
        || (code && String(notice?.targetCode || "").trim() === code)
      ))
      .sort((left, right) => noticePriority(left) - noticePriority(right));
    const specificNotice = related.find((notice) => (
      String(notice?.badge || "") !== "requires_selection"
      && normalizedDisplayText(notice?.shortText) !== "算定区分の確認が必要です。"
    ));
    return normalizedDisplayText(specificNotice?.shortText)
      || normalizedDisplayText(exactQuestion)
      || normalizedDisplayText(related[0]?.shortText);
  }

  function normalizedDisplayText(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
  }

  function noticePriority(notice) {
    const checklistRank = notice?.checklist === true ? 0 : 10;
    const attentionRank = { required: 0, recommended: 1, reference: 2 }[
      String(notice?.attentionLevel || "reference")
    ] ?? 2;
    return checklistRank + attentionRank;
  }

  function renderCandidates(container, candidates) {
    const rows = candidates.length ? candidates.map((candidate) => {
      const row = document.createElement("div");
      row.className = "candidate-row";
      row.classList.add(`zone-${candidate.zone || "review_required"}`);
      const header = document.createElement("header");
      const name = document.createElement("strong");
      name.className = "candidate-name";
      const display = candidate.display && typeof candidate.display === "object"
        ? candidate.display
        : null;
      const exactOption = candidate.selectionResolution === "exact"
        ? candidate.selectionNarrowing?.remainingOptions?.[0]
        : null;
      const stem = display?.stem || candidate.name || candidate.code || "名称未確定";
      name.textContent = exactOption?.qualifierLabel
        ? appendQualifierLabel(stem, exactOption.qualifierLabel)
        : stem;
      const pointLabel = candidatePointLabel(candidate, exactOption);
      if (pointLabel) {
        const points = document.createElement("span");
        points.className = "candidate-points";
        points.textContent = pointLabel;
        header.append(name, points);
      } else {
        header.append(name);
      }
      row.append(header);

      const meta = document.createElement("div");
      meta.className = "candidate-meta";
      const qualifierText = [
        !exactOption && display?.stem && display.qualifier ? display.qualifier : ""
      ].filter(Boolean).join("・");
      if (qualifierText) {
        const qualifier = document.createElement("span");
        qualifier.className = "candidate-qualifier";
        qualifier.textContent = qualifierText;
        meta.append(qualifier);
      }
      const codeLabel = createCodeLabel(candidate.code || exactOption?.code || null);
      if (codeLabel) {
        meta.append(codeLabel);
      }
      if (meta.childElementCount) {
        row.append(meta);
      }
      return row;
    }) : [createTextRow("candidate-row", "候補はありません。")];
    replaceChildren(container, rows);
  }

  function normalizeCandidateZone(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return { zone: "unknown" };
    }
    if (["included", "review_required", "selection_required", "blocked"].includes(candidate.zone)) {
      return candidate;
    }
    return { ...candidate, zone: "unknown" };
  }

  function candidatePointLabel(candidate, exactOption) {
    if (exactOption) {
      return `${formatPoints(exactOption.points ?? candidate.estimatedTotalPoints ?? candidate.points ?? 0)}点`;
    }
    if (candidate.requiresSelection) {
      return "";
    }
    return `${formatPoints(candidate.estimatedTotalPoints ?? candidate.points ?? 0)}点`;
  }

  function selectionPointRange(narrowing) {
    const explicitMinimum = finiteNumber(narrowing?.pointRange?.min);
    const explicitMaximum = finiteNumber(narrowing?.pointRange?.max);
    if (
      explicitMinimum !== null
      && explicitMaximum !== null
      && explicitMinimum > 0
      && explicitMaximum > 0
    ) {
      return {
        min: Math.min(explicitMinimum, explicitMaximum),
        max: Math.max(explicitMinimum, explicitMaximum)
      };
    }
    const options = Array.isArray(narrowing?.remainingOptions) ? narrowing.remainingOptions : [];
    const values = options.map((option) => finiteNumber(option?.points));
    return values.length > 0 && values.every((value) => value !== null && value > 0)
      ? { min: Math.min(...values), max: Math.max(...values) }
      : null;
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatPoints(value) {
    return Number(value || 0).toLocaleString("ja-JP");
  }

  function appendQualifierLabel(stem, qualifierLabel) {
    const normalizedQualifier = String(qualifierLabel || "")
      .trim()
      .replace(/^[（(]\s*/u, "")
      .replace(/\s*[）)]$/u, "");
    if (!normalizedQualifier || String(stem).includes(normalizedQualifier)) return String(stem);
    return `${stem}（${normalizedQualifier}）`;
  }

  function createCodeLabel(code) {
    const normalized = String(code || "").trim();
    if (!normalized) {
      return null;
    }
    const detail = document.createElement("span");
    detail.className = "candidate-code";
    detail.textContent = normalized;
    return detail;
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

  async function sendToTab(tabId, message) {
    if (!tabId) {
      throw responseError({ error: "HOMISの患者カルテ画面を開いてください。" });
    }
    return chrome.tabs.sendMessage(tabId, message);
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function assertCurrentCalculationSource(task) {
    const tab = await activeTab();
    if (activeCalculationTask !== task || !isPreviewForCalculation(task)) {
      throw responseError({
        code: "preview_changed",
        error: "表示中のカルテが読み取り時から変わりました。"
      });
    }
    if (tab?.id !== task.sourceTabId) {
      throw responseError({
        code: "preview_changed",
        error: "表示中のカルテが読み取り時から変わりました。"
      });
    }
  }

  function assertPreparedCalculationSource(task, prepared = {}) {
    if (
      prepared.previewFingerprint !== task.previewFingerprint
      || prepared.externalPatientId !== task.externalPatientId
      || prepared.sourceRecordId !== task.sourceRecordId
      || prepared.serviceDate !== task.serviceDate
    ) {
      throw responseError({
        code: "preview_changed",
        error: "表示中のカルテが読み取り時から変わりました。"
      });
    }
  }

  function assertCalculationResultSource(task, sidecarDraft = {}) {
    if (
      sidecarDraft.externalPatientId !== task.externalPatientId
      || sidecarDraft.sourceRecordId !== task.sourceRecordId
      || sidecarDraft.serviceDate !== task.serviceDate
    ) {
      throw responseError({
        code: "calculation_response_identity_mismatch",
        error: "算定結果の患者またはカルテが一致しません。算定案を作成し直してください。"
      });
    }
  }

  function isPreviewForCalculation(task, options = {}) {
    if (!task || !preview) {
      return false;
    }
    const requireFingerprint = options.requireFingerprint !== false;
    return preview.sourceTabId === task.sourceTabId
      && preview.externalPatientId === task.externalPatientId
      && preview.sourceRecordId === task.sourceRecordId
      && (!requireFingerprint || preview.previewFingerprint === task.previewFingerprint);
  }

  async function renderCompletedCalculationIfCurrent(task) {
    if (
      task?.phase !== "completed"
      || !task.sidecarDraft
      || !isStoredCompletedCalculationTask(task)
      || !isPreviewForCalculation(task)
    ) {
      return false;
    }
    const tab = await activeTab();
    if (
      tab?.id !== task.sourceTabId
      || !isStoredCompletedCalculationTask(task)
      || !isPreviewForCalculation(task)
    ) {
      return false;
    }
    restoreCalculationInput(task.calculationInput);
    renderResult(task.sidecarDraft, { task });
    return true;
  }

  async function renderCompletedCalculationForCurrentPreview() {
    return renderCompletedCalculationIfCurrent(completedCalculationTaskForPreview(preview));
  }

  function calculationTaskKey(value = {}) {
    return JSON.stringify([
      Number(value.sourceTabId || 0),
      String(value.externalPatientId || ""),
      String(value.sourceRecordId || "")
    ]);
  }

  function storeCompletedCalculationTask(task) {
    const key = calculationTaskKey(task);
    completedCalculationTasks.delete(key);
    completedCalculationTasks.set(key, task);
    while (completedCalculationTasks.size > MAX_COMPLETED_CALCULATION_TASKS) {
      completedCalculationTasks.delete(completedCalculationTasks.keys().next().value);
    }
  }

  function completedCalculationTaskForPreview(value = {}) {
    if (!value?.sourceTabId || !value.externalPatientId || !value.sourceRecordId) {
      return null;
    }
    const task = completedCalculationTasks.get(calculationTaskKey(value)) || null;
    return task?.previewFingerprint === value.previewFingerprint ? task : null;
  }

  function completedCalculationTaskForDraft(draft = {}) {
    return [...completedCalculationTasks.values()].find((task) => (
      isSameDraftRevision(task.sidecarDraft, draft)
    )) || null;
  }

  function isStoredCompletedCalculationTask(task) {
    return Boolean(task)
      && completedCalculationTasks.get(calculationTaskKey(task)) === task;
  }

  function calculationInputSnapshot({ encounterType, sameBuilding, telephoneEligibility }) {
    return {
      encounterType: { ...encounterType },
      sameBuilding: { ...sameBuilding },
      telephoneEligibility: telephoneEligibility
        ? { ...telephoneEligibility }
        : null
    };
  }

  function restoreCalculationInput(input = {}) {
    const encounterType = input.encounterType || {};
    document.querySelectorAll('input[name="setting"]').forEach((option) => {
      option.checked = option.value === encounterType.selectionKey;
    });
    encounterTypeSource = encounterType.source || null;
    visitKindSource = encounterType.visitKindSource || null;

    const sameBuilding = input.sameBuilding || {};
    const sameBuildingValue = sameBuilding.value === true
      ? "same"
      : sameBuilding.value === false
        ? "outside"
        : "unknown";
    document.querySelectorAll('input[name="same-building"]').forEach((option) => {
      option.checked = option.value === sameBuildingValue;
    });
    sameBuildingSource = sameBuilding.source || null;

    const telephoneEligibility = input.telephoneEligibility || {};
    setNullableBooleanSelection("telephone-patient-initiated", telephoneEligibility.patientInitiated);
    setNullableBooleanSelection("telephone-instruction-given", telephoneEligibility.instructionGiven);
    setNullableBooleanSelection("telephone-scheduled-management", telephoneEligibility.scheduledManagement);
    renderEncounterTypeCopy(preview, selectedEncounterType());
    renderSameBuildingCopy(preview, selectedSameBuilding());
    renderTelephoneEligibilityControl();
    updateCalculateButton();
  }

  function setNullableBooleanSelection(elementId, value) {
    elements[elementId].value = value === true ? "true" : value === false ? "false" : "unknown";
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
    const calculationPending = ["extracting", "calculating"].includes(activeCalculationTask?.phase);
    elements["calculate-button"].disabled = calculationPending
      || patientChargeMutationsInFlight.size > 0
      || !preview
      || !selectedEncounterType().value;
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
      return "画面の形式が想定と異なります（契約 homis-mock-v6）。";
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
    if (error.status === 409) {
      return "算定案が更新されたため、算定案を作成し直してください。";
    }
    return String(error?.message || "処理を完了できませんでした。");
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})(globalThis);
