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
  const ATTENTION_ORDER = Object.freeze({
    required: 0,
    recommended: 1,
    reference: 2
  });
  const ATTENTION_PRESENTATION = Object.freeze({
    required: { icon: "!", label: "要対応" },
    recommended: { icon: "?", label: "確認推奨" },
    reference: { icon: "i", label: "参考" }
  });
  const CHECKLIST_LIMIT = 5;
  let preview = null;
  let pollingGeneration = 0;
  let extractionGeneration = 0;
  let autoReadTimer = null;
  let previewAgeTimer = null;
  let isConnected = false;
  let lastCalculationContext = null;
  let encounterTypeSource = null;
  let visitKindSource = null;
  let sameBuildingSource = null;

  const elements = Object.fromEntries([
    "connection-badge", "connection-copy", "connect-button", "connection-section",
    "device-code-area", "device-code",
    "approval-link", "calculation-section", "extract-button", "chart-preview", "preview-patient",
    "preview-date", "preview-record", "preview-read-status", "setting-control", "setting-copy",
    "telephone-eligibility-control", "telephone-patient-initiated", "telephone-instruction-given",
    "telephone-scheduled-management",
    "same-building-control", "same-building-copy",
    "calculate-button",
    "result-section", "total-points", "decision-count", "calculation-diff", "revision-copy",
    "included-group", "line-candidates", "review-group", "proposal-candidates",
    "selection-group", "selection-candidates", "blocked-group", "blocked-candidates",
    "checklist-count", "checklist", "checklist-overflow", "checklist-overflow-copy",
    "detail-log-button", "detail-log-section", "detail-log-count", "detail-log",
    "detail-log-back-button", "status-message"
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

  elements["detail-log-button"].addEventListener("click", () => {
    elements["calculation-section"].hidden = true;
    elements["result-section"].hidden = true;
    elements["detail-log-section"].hidden = false;
  });

  elements["detail-log-back-button"].addEventListener("click", () => {
    elements["detail-log-section"].hidden = true;
    elements["calculation-section"].hidden = !isConnected;
    elements["result-section"].hidden = false;
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
        residenceType: prepared.facilityResidence === true
          ? "facility"
          : prepared.privateResidence === true
            ? "private"
            : null,
        clinicalText: prepared.clinicalText,
        sourceSurfaces: prepared.sourceSurfaces,
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
      elements["detail-log-section"].hidden = true;
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
    clearInterval(previewAgeTimer);
    previewAgeTimer = null;
    preview = null;
    lastCalculationContext = null;
    encounterTypeSource = null;
    visitKindSource = null;
    sameBuildingSource = null;
    elements["chart-preview"].hidden = true;
    elements["result-section"].hidden = true;
    elements["detail-log-section"].hidden = true;
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
    clearInterval(previewAgeTimer);
    renderPreviewReadStatus(extraction);
    previewAgeTimer = setInterval(() => renderPreviewReadStatus(extraction), 30_000);
    selectExtractedEncounterType(extraction);
    selectExtractedSameBuilding(extraction);
    renderTelephoneEligibilityControl();
    elements["chart-preview"].hidden = false;
  }

  function renderResult(sidecarDraft = {}) {
    const calculation = sidecarDraft.calculation || {};
    const candidates = (Array.isArray(calculation.candidates) ? calculation.candidates : [])
      .map((candidate) => normalizeCandidateZone(candidate));
    elements["total-points"].textContent = `${Number(calculation.estimatedTotalPoints || 0).toLocaleString("ja-JP")}点`;
    elements["decision-count"].textContent = `${Number(
      calculation.decisionCandidateCount
      ?? candidates.filter((candidate) => candidate.zone !== "included").length
    ).toLocaleString("ja-JP")}件`;
    elements["revision-copy"].textContent = [
      lastCalculationContext
        ? `患者${lastCalculationContext.externalPatientId} / ${lastCalculationContext.serviceDate} / ${lastCalculationContext.settingLabel} / ${lastCalculationContext.sameBuildingLabel}`
        : "",
      `再計算 ${Number(sidecarDraft.calculationRevision || 1)}回目`
    ].filter(Boolean).join(" ・ ");
    renderCalculationDiff(sidecarDraft.calculationDiff);
    renderCandidateGroup("included-group", "line-candidates", candidates.filter((item) => item.zone === "included"));
    renderCandidateGroup("review-group", "proposal-candidates", candidates.filter((item) => item.zone === "review_required"));
    renderCandidateGroup("selection-group", "selection-candidates", candidates.filter((item) => item.zone === "selection_required"));
    renderCandidateGroup("blocked-group", "blocked-candidates", candidates.filter((item) => item.zone === "blocked"));
    const notices = Array.isArray(calculation.notices) ? calculation.notices : null;
    const detailNotices = notices
      ? sortReviewIssues(notices)
      : [
          ...(Array.isArray(calculation.warnings) ? calculation.warnings : []),
          ...sortReviewIssues(Array.isArray(calculation.reviewIssues) ? calculation.reviewIssues : [])
        ];
    const checklist = notices
      ? detailNotices.filter((notice) => notice?.checklist === true)
      : detailNotices;
    const visibleChecklist = checklist.slice(0, CHECKLIST_LIMIT);
    elements["checklist-count"].textContent = `${checklist.length}件`;
    replaceChildren(elements.checklist, visibleChecklist.length
      ? visibleChecklist.map(createChecklistRow)
      : [createTextRow("checklist-row empty", "対応が必要な項目はありません。")]);
    const hiddenChecklistCount = Math.max(0, checklist.length - visibleChecklist.length);
    elements["checklist-overflow"].hidden = detailNotices.length === 0;
    elements["checklist-overflow-copy"].textContent = hiddenChecklistCount > 0
      ? `ほか${hiddenChecklistCount}件。詳細ログは全${detailNotices.length}件です。`
      : `詳細ログ ${detailNotices.length}件`;
    elements["detail-log-count"].textContent = `${detailNotices.length}件`;
    replaceChildren(elements["detail-log"], detailNotices.length
      ? detailNotices.map(createDetailLogRow)
      : [createTextRow("detail-log-row empty", "記録はありません。")]);
    elements["detail-log-section"].hidden = true;
    elements["result-section"].hidden = false;
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

  function renderCalculationDiff(diff) {
    if (!diff || typeof diff !== "object") {
      elements["calculation-diff"].hidden = true;
      elements["calculation-diff"].textContent = "";
      return;
    }
    const added = Number(diff.candidates?.addedCount || 0);
    const removed = Number(diff.candidates?.removedCount || 0);
    const pointDelta = Number(diff.pointDelta || 0);
    const pointPrefix = pointDelta > 0 ? "+" : pointDelta < 0 ? "−" : "±";
    elements["calculation-diff"].textContent = `前回から: 候補+${added}/−${removed}・点数${pointPrefix}${Math.abs(pointDelta).toLocaleString("ja-JP")}`;
    elements["calculation-diff"].hidden = false;
  }

  function renderCandidateGroup(groupId, containerId, candidates) {
    elements[groupId].hidden = candidates.length === 0;
    renderCandidates(elements[containerId], candidates);
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
      name.textContent = display?.stem || candidate.name || candidate.code || "名称未確定";
      const points = document.createElement("span");
      points.className = "candidate-points";
      const exactOption = candidate.selectionResolution === "exact"
        ? candidate.selectionNarrowing?.remainingOptions?.[0]
        : null;
      points.textContent = candidate.sourceSubtype === "sensor_candidate"
        ? "要確認"
        : candidate.requiresSelection && !exactOption
          ? "要選択"
          : `${Number(exactOption?.points ?? candidate.estimatedTotalPoints ?? 0).toLocaleString("ja-JP")}点`;
      header.append(name, points);
      row.append(header);

      const meta = document.createElement("div");
      meta.className = "candidate-meta";
      const qualifierText = [
        display?.stem && display.qualifier ? display.qualifier : "",
        exactOption ? "要確認（区分確定済み）" : ""
      ].filter(Boolean).join("・");
      if (qualifierText) {
        const qualifier = document.createElement("span");
        qualifier.className = "candidate-qualifier";
        qualifier.textContent = qualifierText;
        meta.append(qualifier);
      }
      meta.append(createCodeReference(candidate.code || exactOption?.code || null));
      if (meta.childElementCount) {
        row.append(meta);
      }
      if (candidate.requiresSelection) {
        row.append(createSelectionNarrowing(candidate));
      }
      return row;
    }) : [createTextRow("candidate-row", "候補はありません。")];
    replaceChildren(container, rows);
  }

  function normalizeCandidateZone(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return { zone: "review_required" };
    }
    if (["included", "review_required", "selection_required", "blocked"].includes(candidate.zone)) {
      return candidate;
    }
    return { ...candidate, zone: "review_required" };
  }

  function createCodeReference(code) {
    const normalized = String(code || "").trim();
    const detail = document.createElement(normalized ? "a" : "span");
    detail.className = "candidate-code";
    detail.textContent = normalized || "コード未確定";
    if (normalized) {
      detail.href = `https://shirobon.net/?s=${encodeURIComponent(normalized)}`;
      detail.target = "_blank";
      detail.rel = "noopener noreferrer";
      detail.title = "しろぼんねっとで確認";
    }
    return detail;
  }

  function createSelectionNarrowing(candidate) {
    const narrowing = candidate.selectionNarrowing || {};
    const container = document.createElement("section");
    container.className = "selection-narrowing";
    const count = Number(narrowing.remainingOptionCount ?? candidate.codeCandidates?.length ?? 0);
    const summary = document.createElement("div");
    summary.className = "selection-summary";
    const countLabel = document.createElement("strong");
    countLabel.textContent = count === 1 ? "区分を1件に絞り込み" : `${count.toLocaleString("ja-JP")}区分`;
    summary.append(countLabel);
    if (narrowing.pointRange) {
      const range = document.createElement("span");
      const minimum = Number(narrowing.pointRange.min || 0).toLocaleString("ja-JP");
      const maximum = Number(narrowing.pointRange.max || 0).toLocaleString("ja-JP");
      range.textContent = minimum === maximum ? `${minimum}点` : `${minimum}〜${maximum}点`;
      summary.append(range);
    }
    container.append(summary);

    const filters = Array.isArray(narrowing.appliedFilters) ? narrowing.appliedFilters : [];
    if (filters.length) {
      const chipRow = document.createElement("div");
      chipRow.className = "selection-filter-chips";
      for (const filter of filters) {
        const chip = document.createElement("span");
        chip.className = "selection-filter-chip";
        chip.textContent = `${filter.label} ✓ ${filter.evidenceLabel}`;
        chipRow.append(chip);
      }
      container.append(chipRow);
    }

    const options = Array.isArray(narrowing.remainingOptions) ? narrowing.remainingOptions : [];
    if (options.length) {
      const question = document.createElement("p");
      question.className = "selection-question";
      question.textContent = options[0]?.axisQuestion || "HOMISで算定区分を確認してください";
      container.append(question);
      const optionList = document.createElement("div");
      optionList.className = "selection-option-list";
      for (const option of options.slice(0, 6)) {
        const optionRow = document.createElement("div");
        optionRow.className = "selection-option-row";
        const label = document.createElement("span");
        label.textContent = option.qualifierLabel || "区分名未設定";
        const optionPoints = document.createElement("strong");
        optionPoints.textContent = `${Number(option.points || 0).toLocaleString("ja-JP")}点`;
        optionRow.append(label, optionPoints, createCodeReference(option.code));
        optionList.append(optionRow);
      }
      container.append(optionList);
      if (options.length > 6) {
        const overflow = document.createElement("p");
        overflow.className = "selection-overflow";
        overflow.textContent = `他${options.length - 6}区分（詳細ログ）`;
        container.append(overflow);
      }
    }
    return container;
  }

  function createTextRow(className, value) {
    const row = document.createElement("div");
    row.className = className;
    row.textContent = value;
    return row;
  }

  function createChecklistRow(notice) {
    const row = document.createElement("div");
    const attentionLevel = normalizedAttentionLevel(notice?.attentionLevel);
    row.className = `checklist-row attention-${attentionLevel}`;
    const marker = createAttentionMarker(attentionLevel);
    const text = document.createElement("span");
    text.textContent = notice?.shortText || issueText(notice);
    row.append(marker, text);
    return row;
  }

  function createDetailLogRow(notice) {
    const row = document.createElement("article");
    const attentionLevel = normalizedAttentionLevel(notice?.attentionLevel);
    row.className = `detail-log-row attention-${attentionLevel}`;
    const header = document.createElement("header");
    const label = document.createElement("strong");
    label.textContent = notice?.shortText || "確認記録";
    const labels = document.createElement("span");
    labels.className = "detail-log-labels";
    labels.append(createAttentionMarker(attentionLevel));
    const audience = document.createElement("span");
    audience.className = "detail-log-audience";
    audience.textContent = notice?.audience === "admin" ? "管理者向け" : "診療担当者向け";
    labels.append(audience);
    header.append(label, labels);
    const detail = document.createElement("p");
    detail.textContent = notice?.detailText || issueText(notice);
    row.append(header, detail);
    return row;
  }

  function createAttentionMarker(attentionLevel) {
    const presentation = ATTENTION_PRESENTATION[attentionLevel];
    const marker = document.createElement("span");
    marker.className = `attention-marker attention-${attentionLevel}`;
    marker.setAttribute("aria-label", presentation.label);
    marker.textContent = presentation.icon;
    return marker;
  }

  function normalizedAttentionLevel(value) {
    const level = String(value || "");
    return Object.hasOwn(ATTENTION_PRESENTATION, level) ? level : "reference";
  }

  function replaceChildren(container, children) {
    container.replaceChildren(...children);
  }

  function issueText(issue) {
    if (typeof issue === "string") {
      return issue;
    }
    return issue?.messageForStaff
      || issue?.message
      || issue?.reason
      || issue?.title
      || "内容を確認してください。";
  }

  function sortReviewIssues(issues = []) {
    return issues
      .map((issue, index) => ({ issue, index }))
      .sort((left, right) => {
        const attentionDifference = attentionOrder(left.issue?.attentionLevel)
          - attentionOrder(right.issue?.attentionLevel);
        if (attentionDifference !== 0) {
          return attentionDifference;
        }
        const codeDifference = String(left.issue?.issueCode || "")
          .localeCompare(String(right.issue?.issueCode || ""), "ja");
        return codeDifference || left.index - right.index;
      })
      .map((entry) => entry.issue);
  }

  function attentionOrder(attentionLevel) {
    return Object.hasOwn(ATTENTION_ORDER, attentionLevel)
      ? ATTENTION_ORDER[attentionLevel]
      : Number.MAX_SAFE_INTEGER;
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
      return "画面の形式が想定と異なります（契約 homis-mock-v4）。";
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
