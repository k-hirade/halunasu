const CASE_SPLITS = new Set(["train", "development", "holdout"]);
const HOLDOUT_PROVENANCE = new Set(["separate_generator", "human_reviewed"]);
const AUTHORING_PROVENANCE = new Set([
  "primary_generator",
  "separate_generator",
  "human_authored"
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codePoints(value) {
  return Array.from(String(value ?? ""));
}

function pushIssue(list, code, message, context = {}) {
  list.push({ code, message, ...context });
}

function axisEnumsFromSchema(schema, errors) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const axes = {};
  for (const axis of required) {
    const values = schema?.properties?.[axis]?.enum;
    if (!Array.isArray(values) || values.length === 0) {
      pushIssue(
        errors,
        "invalid_clinical_axes_schema",
        `generated clinical axes schema is missing enum ${axis}`
      );
      continue;
    }
    axes[axis] = new Set(values);
  }
  return axes;
}

function normalizeMatrixDimension(entries, name, errors) {
  if (!Array.isArray(entries) || entries.length === 0) {
    pushIssue(errors, "invalid_matrix", `${name} must be a non-empty array`);
    return [];
  }
  const ids = [];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const id = String(entry?.id ?? "").trim();
    if (!id) {
      pushIssue(errors, "invalid_matrix", `${name}[${index}].id is required`);
      continue;
    }
    if (seen.has(id)) {
      pushIssue(errors, "invalid_matrix", `${name} contains duplicate id ${id}`);
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function validateSpan({
  clinicalText,
  span,
  caseId,
  spanIndex,
  axes,
  categories,
  errors
}) {
  const context = { caseId, spanIndex };
  if (!isObject(span)) {
    pushIssue(errors, "invalid_span", "expected span must be an object", context);
    return;
  }

  const text = String(span.text ?? "");
  const start = span.charStart;
  const end = span.charEnd;
  const chars = codePoints(clinicalText);
  if (!text) {
    pushIssue(errors, "invalid_span", "expected span text is required", context);
  }
  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end <= start
    || end > chars.length
  ) {
    pushIssue(
      errors,
      "invalid_span_offset",
      `span offsets must satisfy 0 <= charStart < charEnd <= ${chars.length}`,
      context
    );
  } else {
    const actual = chars.slice(start, end).join("");
    if (actual !== text) {
      pushIssue(
        errors,
        "span_text_mismatch",
        `offset text ${JSON.stringify(actual)} does not equal ${JSON.stringify(text)}`,
        context
      );
    }
    const before = chars[start - 1] ?? "";
    const after = chars[end] ?? "";
    const first = chars[start] ?? "";
    const last = chars[end - 1] ?? "";
    const asciiWord = /[A-Za-z0-9_]/u;
    if (
      (asciiWord.test(before) && asciiWord.test(first))
      || (asciiWord.test(last) && asciiWord.test(after))
    ) {
      pushIssue(
        errors,
        "span_splits_ascii_token",
        "span boundary splits an ASCII word or identifier",
        context
      );
    }
  }

  if (!String(span.code ?? "").trim()) {
    pushIssue(errors, "invalid_span", "expected span code is required", context);
  }
  if (!categories.has(span.category)) {
    pushIssue(
      errors,
      "invalid_span_category",
      `category ${JSON.stringify(span.category)} is not in the generated eventType enum`,
      context
    );
  }
  for (const [axis, allowed] of Object.entries(axes)) {
    if (!allowed.has(span[axis])) {
      pushIssue(
        errors,
        "invalid_axis_value",
        `${axis}=${JSON.stringify(span[axis])} is not in the generated contract`,
        context
      );
    }
  }
}

function validateHoldout(caseItem, errors) {
  if (caseItem.split !== "holdout") return;
  const provenance = caseItem.holdoutProvenance;
  const source = provenance?.source;
  if (!HOLDOUT_PROVENANCE.has(source)) {
    pushIssue(
      errors,
      "invalid_holdout_provenance",
      "holdout must use separate_generator or human_reviewed provenance",
      { caseId: caseItem.caseId }
    );
    return;
  }
  if (
    source === "separate_generator"
    && !String(provenance?.generatorFamily ?? "").trim()
  ) {
    pushIssue(
      errors,
      "invalid_holdout_provenance",
      "separate_generator holdout requires generatorFamily",
      { caseId: caseItem.caseId }
    );
  }
  if (
    source === "human_reviewed"
    && (
      caseItem.reviewPolicy?.expectedSpansReviewed !== true
      || !String(caseItem.reviewPolicy?.reviewedBy ?? "").trim()
      || !/^\d{4}-\d{2}-\d{2}$/u.test(
        String(caseItem.reviewPolicy?.reviewedAt ?? "")
      )
    )
  ) {
    pushIssue(
      errors,
      "invalid_holdout_provenance",
      "human_reviewed holdout requires expectedSpansReviewed=true, reviewedBy, and reviewedAt (YYYY-MM-DD)",
      { caseId: caseItem.caseId }
    );
  }
}

export function validateFeeSpecialtyMatrix({
  matrix,
  dataset,
  clinicalAxesSchema,
  strict = false
}) {
  const errors = [];
  const warnings = [];
  const axes = axisEnumsFromSchema(clinicalAxesSchema, errors);
  const categories = new Set(clinicalAxesSchema?.$defs?.eventType?.enum ?? []);
  if (categories.size === 0) {
    pushIssue(
      errors,
      "invalid_clinical_axes_schema",
      "generated clinical axes schema is missing $defs.eventType.enum"
    );
  }

  const specialties = normalizeMatrixDimension(
    matrix?.specialties,
    "specialties",
    errors
  );
  const settings = normalizeMatrixDimension(
    matrix?.encounterSettings,
    "encounterSettings",
    errors
  );
  if (settings.includes("inpatient")) {
    pushIssue(
      errors,
      "inpatient_not_supported",
      "WX0 initial matrix must not include inpatient"
    );
  }

  const minimumCasesPerCell = Number(matrix?.requirements?.minimumCasesPerCell);
  const minimumHoldoutCasesPerCell = Number(
    matrix?.requirements?.minimumHoldoutCasesPerCell
  );
  if (!Number.isInteger(minimumCasesPerCell) || minimumCasesPerCell < 1) {
    pushIssue(
      errors,
      "invalid_matrix",
      "requirements.minimumCasesPerCell must be a positive integer"
    );
  }
  if (
    !Number.isInteger(minimumHoldoutCasesPerCell)
    || minimumHoldoutCasesPerCell < 1
    || minimumHoldoutCasesPerCell > minimumCasesPerCell
  ) {
    pushIssue(
      errors,
      "invalid_matrix",
      "requirements.minimumHoldoutCasesPerCell must be positive and no greater than minimumCasesPerCell"
    );
  }

  const cells = new Map();
  for (const specialty of specialties) {
    for (const encounterSetting of settings) {
      const key = `${specialty}|${encounterSetting}`;
      cells.set(key, {
        specialty,
        encounterSetting,
        reviewedCases: 0,
        holdoutCases: 0,
        pendingCases: 0
      });
    }
  }

  const cases = Array.isArray(dataset?.cases) ? dataset.cases : [];
  if (!Array.isArray(dataset?.cases)) {
    pushIssue(errors, "invalid_dataset", "dataset.cases must be an array");
  }
  const caseIds = new Set();
  const templateSplits = new Map();
  const textSplits = new Map();
  const nonHoldoutGeneratorFamilies = new Set();
  const holdoutGeneratorFamilies = new Set();

  for (const [caseIndex, caseItem] of cases.entries()) {
    if (!isObject(caseItem)) {
      pushIssue(
        errors,
        "invalid_case",
        "case must be an object",
        { caseIndex }
      );
      continue;
    }
    const caseId = String(caseItem.caseId ?? "").trim();
    if (!caseId) {
      pushIssue(errors, "invalid_case", "caseId is required", { caseIndex });
    } else if (caseIds.has(caseId)) {
      pushIssue(errors, "duplicate_case_id", `duplicate caseId ${caseId}`, {
        caseId
      });
    }
    caseIds.add(caseId);

    const key = `${caseItem.specialty}|${caseItem.encounterSetting}`;
    const cell = cells.get(key);
    if (!cell) {
      pushIssue(
        errors,
        "case_outside_matrix",
        `case uses unsupported matrix cell ${key}`,
        { caseId }
      );
    }
    if (caseItem.encounterSetting === "inpatient") {
      pushIssue(
        errors,
        "inpatient_not_supported",
        "inpatient cases are outside the initial white-box scope",
        { caseId }
      );
    }
    if (!CASE_SPLITS.has(caseItem.split)) {
      pushIssue(
        errors,
        "invalid_split",
        `split must be one of ${[...CASE_SPLITS].join(", ")}`,
        { caseId }
      );
    }
    const generationSource = caseItem.generationProvenance?.source;
    const generatorFamily = String(
      caseItem.generationProvenance?.generatorFamily ?? ""
    ).trim();
    if (!AUTHORING_PROVENANCE.has(generationSource)) {
      pushIssue(
        errors,
        "invalid_generation_provenance",
        `generationProvenance.source must be one of ${[...AUTHORING_PROVENANCE].join(", ")}`,
        { caseId }
      );
    }
    if (
      ["primary_generator", "separate_generator"].includes(generationSource)
      && !generatorFamily
    ) {
      pushIssue(
        errors,
        "invalid_generation_provenance",
        "generated cases require generationProvenance.generatorFamily",
        { caseId }
      );
    }
    if (generatorFamily) {
      if (caseItem.split === "holdout") {
        holdoutGeneratorFamilies.add(generatorFamily);
      } else {
        nonHoldoutGeneratorFamilies.add(generatorFamily);
      }
    }

    const templateId = String(caseItem.templateId ?? "").trim();
    if (!templateId) {
      pushIssue(errors, "missing_template_id", "templateId is required", {
        caseId
      });
    } else if (CASE_SPLITS.has(caseItem.split)) {
      const prior = templateSplits.get(templateId);
      if (prior && prior !== caseItem.split) {
        pushIssue(
          errors,
          "template_split_leakage",
          `templateId ${templateId} appears in both ${prior} and ${caseItem.split}`,
          { caseId }
        );
      } else {
        templateSplits.set(templateId, caseItem.split);
      }
    }

    const clinicalText = String(caseItem.clinicalText ?? "");
    if (!clinicalText.trim()) {
      pushIssue(errors, "invalid_case", "clinicalText is required", { caseId });
    } else if (CASE_SPLITS.has(caseItem.split)) {
      const signature = clinicalText.replace(/\s+/gu, " ").trim();
      const prior = textSplits.get(signature);
      if (prior && prior !== caseItem.split) {
        pushIssue(
          errors,
          "text_split_leakage",
          `identical clinicalText appears in both ${prior} and ${caseItem.split}`,
          { caseId }
        );
      } else {
        textSplits.set(signature, caseItem.split);
      }
    }

    if (!Array.isArray(caseItem.expectedSpans) || caseItem.expectedSpans.length === 0) {
      pushIssue(
        errors,
        "missing_expected_spans",
        "expectedSpans must contain at least one reviewed span",
        { caseId }
      );
    } else {
      const identities = new Set();
      caseItem.expectedSpans.forEach((span, spanIndex) => {
        validateSpan({
          clinicalText,
          span,
          caseId,
          spanIndex,
          axes,
          categories,
          errors
        });
        const identity = `${span?.charStart}|${span?.charEnd}|${span?.code}|${span?.category}`;
        if (identities.has(identity)) {
          pushIssue(
            errors,
            "duplicate_expected_span",
            "duplicate expected span annotation",
            { caseId, spanIndex }
          );
        }
        identities.add(identity);
      });
    }

    if (!isObject(caseItem.expectedClaimContext)) {
      pushIssue(
        errors,
        "missing_expected_claim_context",
        "expectedClaimContext must be an object",
        { caseId }
      );
    }
    if (caseItem.synthetic !== true) {
      pushIssue(
        errors,
        "non_synthetic_case",
        "WX0 corpus accepts synthetic cases only",
        { caseId }
      );
    }
    if (!["reviewed", "pending_review"].includes(caseItem.annotationStatus)) {
      pushIssue(
        errors,
        "invalid_annotation_status",
        "annotationStatus must be reviewed or pending_review",
        { caseId }
      );
    }
    validateHoldout(caseItem, errors);
    if (
      caseItem.split === "holdout"
      && caseItem.holdoutProvenance?.source === "separate_generator"
      && generatorFamily
      && caseItem.holdoutProvenance.generatorFamily !== generatorFamily
    ) {
      pushIssue(
        errors,
        "invalid_holdout_provenance",
        "holdoutProvenance.generatorFamily must match generationProvenance.generatorFamily",
        { caseId }
      );
    }

    if (cell) {
      if (caseItem.annotationStatus === "reviewed") {
        cell.reviewedCases += 1;
        if (caseItem.split === "holdout") cell.holdoutCases += 1;
      } else {
        cell.pendingCases += 1;
      }
    }
  }

  for (const generatorFamily of holdoutGeneratorFamilies) {
    if (nonHoldoutGeneratorFamilies.has(generatorFamily)) {
      pushIssue(
        errors,
        "generator_split_leakage",
        `generatorFamily ${generatorFamily} appears in holdout and a non-holdout split`
      );
    }
  }

  const coverage = [...cells.values()].map((cell) => {
    const caseDeficit = Math.max(0, minimumCasesPerCell - cell.reviewedCases);
    const holdoutDeficit = Math.max(
      0,
      minimumHoldoutCasesPerCell - cell.holdoutCases
    );
    return {
      ...cell,
      minimumCases: minimumCasesPerCell,
      minimumHoldoutCases: minimumHoldoutCasesPerCell,
      caseDeficit,
      holdoutDeficit,
      complete: caseDeficit === 0 && holdoutDeficit === 0
    };
  });

  if (strict) {
    for (const cell of coverage) {
      if (cell.caseDeficit > 0) {
        pushIssue(
          errors,
          "cell_case_deficit",
          `${cell.specialty}/${cell.encounterSetting} needs ${cell.caseDeficit} more reviewed cases`,
          {
            specialty: cell.specialty,
            encounterSetting: cell.encounterSetting
          }
        );
      }
      if (cell.holdoutDeficit > 0) {
        pushIssue(
          errors,
          "cell_holdout_deficit",
          `${cell.specialty}/${cell.encounterSetting} needs ${cell.holdoutDeficit} more holdout cases`,
          {
            specialty: cell.specialty,
            encounterSetting: cell.encounterSetting
          }
        );
      }
    }
  } else if (coverage.some((cell) => !cell.complete)) {
    pushIssue(
      warnings,
      "matrix_incomplete",
      "matrix is structurally valid but is not ready for WX0 measurement; run strict validation for deficits"
    );
  }

  return {
    ok: errors.length === 0,
    strict,
    caseCount: cases.length,
    reviewedCaseCount: coverage.reduce(
      (sum, cell) => sum + cell.reviewedCases,
      0
    ),
    completeCellCount: coverage.filter((cell) => cell.complete).length,
    cellCount: coverage.length,
    errors,
    warnings,
    coverage
  };
}

export function unicodeOffsetOf(text, needle, fromOffset = 0) {
  const haystack = codePoints(text);
  const target = codePoints(needle);
  if (target.length === 0) return -1;
  for (let index = fromOffset; index <= haystack.length - target.length; index += 1) {
    if (target.every((char, offset) => haystack[index + offset] === char)) {
      return index;
    }
  }
  return -1;
}
