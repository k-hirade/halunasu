const DEVICE_DEFINITIONS = Object.freeze([
  { type: "ventilator", pattern: /(?:人工呼吸器|TPPV|NPPV)/u },
  { type: "tracheostomy_cannula", pattern: /(?:気管切開|気管カニューレ|カニューレ)/u },
  { type: "oxygen_concentrator", pattern: /酸素濃縮装置/u },
  { type: "oxygen_cylinder", pattern: /酸素ボンベ/u },
  { type: "oxygen_demand_valve", pattern: /デマンドバルブ/u },
  { type: "home_oxygen", pattern: /(?:在宅酸素|HOT)/iu },
  { type: "suction_device", pattern: /(?:喀痰吸引器|吸引器)/u },
  { type: "enteral_nasal_tube", pattern: /(?:経鼻|経腸|腸瘻).{0,12}(?:栄養|カテ|チューブ)|栄養用ディスポカテ/u },
  { type: "urinary_indwelling_catheter", pattern: /(?:膀胱|尿道).{0,12}(?:留置|カテーテル)|膀胱留置用ディスポ/u },
  { type: "gastrostomy_catheter", pattern: /(?:胃瘻|PEG).{0,12}(?:カテ|チューブ|ボタン)/iu }
]);

export function normalizeSidecarStructuredFacts({
  sourceSurfaces = {},
  serviceDate = null
} = {}) {
  const current = sourceSurfaces.currentChart;
  const documents = sourceSurfaces.documents;
  const currentAvailable = current?.status === "ok";
  const documentsAvailable = documents?.status === "ok";
  const raw = currentAvailable && isPlainObject(current.raw) ? current.raw : {};

  return {
    schemaVersion: "fee-sidecar-structured-facts-v1",
    sourceStatus: {
      currentChart: sourceStatus(current),
      documents: sourceStatus(documents)
    },
    care: {
      certificationLevel: currentAvailable
        ? careCertificationLevel(raw.careInsuranceText)
        : null,
      certificationStatus: currentAvailable
        ? (careCertificationLevel(raw.careInsuranceText) === null ? "unknown" : "known")
        : "unavailable",
      visitingNurseWeeklyCount: currentAvailable
        ? visitingNurseWeeklyCount(raw.visitingNurseText)
        : null,
      visitingNurseFrequencyStatus: currentAvailable
        ? (visitingNurseWeeklyCount(raw.visitingNurseText) === null ? "unknown" : "known")
        : "unavailable",
      ictCoordination: currentAvailable
        ? ictCoordinationValue(`${raw.careInsuranceText || ""}\n${raw.visitingNurseText || ""}`)
        : null,
      ictCoordinationStatus: currentAvailable
        ? (ictCoordinationValue(`${raw.careInsuranceText || ""}\n${raw.visitingNurseText || ""}`) === null
          ? "unknown"
          : "known")
        : "unavailable"
    },
    devices: currentAvailable ? normalizeDevices(raw.deviceManagementText) : [],
    prescriptions: currentAvailable
      ? asArray(raw.prescriptionRows).map((text, index) => ({
        sourceIndex: index,
        text: normalizedText(text)
      })).filter((row) => row.text)
      : [],
    documents: documentsAvailable
      ? asArray(documents.raw?.rows)
        .map((value, index) => normalizeDocumentFact(value, index, serviceDate))
        .filter(Boolean)
      : [],
    encounter: {
      patientStartDate: currentAvailable && isIsoDate(raw.patientStartDate)
        ? raw.patientStartDate
        : null,
      calendarMonth: currentAvailable ? nullableString(raw.calendarMonth) : null,
      monthlyVisitDays: currentAvailable
        ? uniqueStrings(asArray(raw.calendarVisitDates).filter(isIsoDate))
        : [],
      serviceDate: isIsoDate(serviceDate) ? serviceDate : null
    }
  };
}

function sourceStatus(surface) {
  if (surface?.status === "ok") {
    return { status: "known", unavailableReason: null };
  }
  if (surface?.status === "unavailable") {
    return {
      status: "unavailable",
      unavailableReason: nullableString(surface.unavailableReason) || "fetch_failed"
    };
  }
  return { status: "unknown", unavailableReason: null };
}

function careCertificationLevel(value) {
  const match = normalizedText(value).match(/要介護\s*([1-5])/u);
  return match ? Number(match[1]) : null;
}

function visitingNurseWeeklyCount(value) {
  const match = normalizedText(value).match(/週\s*([1-7])\s*回/u);
  return match ? Number(match[1]) : null;
}

function ictCoordinationValue(value) {
  const text = normalizedText(value);
  if (/(?:MCS|ICT|電子連絡帳|情報共有システム)\s*(?:連携|共有)/iu.test(text)) {
    return true;
  }
  return null;
}

function normalizeDevices(value) {
  const text = normalizedText(value);
  if (!text || /登録なし/u.test(text)) {
    return [];
  }
  return DEVICE_DEFINITIONS
    .filter((definition) => definition.pattern.test(text))
    .map((definition) => ({
      type: definition.type,
      attributes: deviceAttributes(definition.type, text)
    }));
}

function deviceAttributes(type, text) {
  if (type === "tracheostomy_cannula") {
    const size = text.match(/(\d+(?:\.\d+)?)\s*mm/iu);
    return {
      doubleTube: /(?:複管|二重管)/u.test(text)
        ? true
        : /(?:単管|一重管)/u.test(text) ? false : null,
      cuffed: /カフ(?:付き|付|あり|有|圧)/u.test(text)
        ? true
        : /カフ(?:なし|無し|無)/u.test(text) ? false : null,
      suctionEnabled: /(?:吸引有|吸引あり|吸引機能あり|カフ上部吸引)/u.test(text)
        ? true
        : /(?:吸引無|吸引なし|吸引無し)/u.test(text) ? false : null,
      sizeMm: size ? Number(size[1]) : null
    };
  }
  if (type === "enteral_nasal_tube") {
    return {
      route: /腸瘻/u.test(text) ? "enterostomy" : /(?:経鼻|鼻腔)/u.test(text) ? "nasal" : null,
      variant: /乳幼児.{0,5}非\s*DEHP/iu.test(text)
        ? "infant_non_dehp"
        : /乳幼児/u.test(text)
          ? "infant_general"
          : /経腸栄養用/u.test(text)
            ? "enteral_nutrition"
            : /特殊型/u.test(text)
              ? "special"
              : /一般/u.test(text) ? "general" : null
    };
  }
  if (type === "urinary_indwelling_catheter") {
    return {
      variant: /圧迫止血/u.test(text)
        ? "compression_hemostasis"
        : /特定[（(]?\s*1/u.test(text)
          ? "special_1"
          : /特定[（(]?\s*2/u.test(text)
            ? "special_2"
            : /(?:2管|二腔).{0,5}[（(]?\s*3/u.test(text)
              ? "two_lumen_3"
              : /(?:2管|二腔).{0,5}[（(]?\s*2/u.test(text)
                ? "two_lumen_2"
                : /(?:2管|二腔).{0,5}[（(]?\s*1/u.test(text) ? "two_lumen_1" : null,
      system: /閉鎖式/u.test(text) ? "closed" : /標準型/u.test(text) ? "standard" : null
    };
  }
  if (type === "gastrostomy_catheter") {
    return {
      placement: /小腸/u.test(text) ? "small_bowel" : /胃留置|胃内/u.test(text) ? "stomach" : null,
      retention: /バルーン/u.test(text)
        ? "balloon"
        : /バンパー/u.test(text) ? "bumper" : /一般型/u.test(text) ? "general" : null,
      guidewire: /ガイドワイヤー(?:あり|有)/u.test(text)
        ? true
        : /ガイドワイヤー(?:なし|無し|無)/u.test(text) ? false : null
    };
  }
  return {};
}

function normalizeDocumentFact(value, index, serviceDate) {
  if (!isPlainObject(value)) {
    return null;
  }
  const kind = normalizedText(value.kind);
  if (!kind) {
    return null;
  }
  return {
    sourceIndex: index,
    kind,
    periodText: normalizedText(value.period),
    writtenDateText: normalizedText(value.writtenDate),
    statusText: normalizedText(value.status),
    actionStatus: documentActionStatus(value.status),
    documentDate: documentDate(value.writtenDate, serviceDate)
  };
}

function documentActionStatus(value) {
  const text = normalizedText(value);
  if (/交付|発行/u.test(text)) return "issued";
  if (/作成|記入/u.test(text)) return "created";
  if (/受領|持参|受け取/u.test(text)) return "received";
  if (/送付|発送/u.test(text)) return "sent";
  return "unknown";
}

function documentDate(value, serviceDate) {
  const text = normalizedText(value).normalize("NFKC");
  if (isIsoDate(text)) {
    return validDateOnly(text) ? text : null;
  }
  if (!isIsoDate(serviceDate)) {
    return null;
  }
  const match = text.match(/^(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/u);
  if (!match) {
    return null;
  }
  const result = [
    serviceDate.slice(0, 4),
    String(Number(match[1])).padStart(2, "0"),
    String(Number(match[2])).padStart(2, "0")
  ].join("-");
  return validDateOnly(result) ? result : null;
}

function validDateOnly(value) {
  if (!isIsoDate(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  return [...new Set(values.map(String).filter(Boolean))].sort();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nullableString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
