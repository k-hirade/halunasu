import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "data/fee-rules/source/sidecar-label-axes-2026.json");
const OUTPUT_PATH = path.join(
  ROOT,
  "services/fee-api/src/fee-rule-data/sidecar-label-axes-2026.generated.json"
);

const args = new Set(process.argv.slice(2));
const source = JSON.parse(await readFile(SOURCE_PATH, "utf8"));
validateSource(source);

const payload = {
  schemaVersion: "fee-sidecar-label-axis-artifact-v1",
  revision: source.revision,
  effectiveFrom: source.effectiveFrom,
  verifiedAt: source.verifiedAt,
  sourceDefinitionSha256: sha256(canonicalJson(source)),
  sourceDocuments: [...source.sourceDocuments].sort(byField("sourceId")),
  axes: [...source.axes].sort(byField("axisId"))
};
const artifact = {
  ...payload,
  artifactPayloadSha256: sha256(canonicalJson(payload))
};
const rendered = `${JSON.stringify(artifact, null, 2)}\n`;

if (args.has("--check")) {
  const current = await readFile(OUTPUT_PATH, "utf8").catch(() => "");
  if (current !== rendered) {
    throw new Error(`fee sidecar label axis artifact is stale: ${OUTPUT_PATH}`);
  }
  console.log(`fee sidecar label axis artifact is current: ${OUTPUT_PATH}`);
} else {
  await writeFile(OUTPUT_PATH, rendered, "utf8");
  console.log(OUTPUT_PATH);
}

function validateSource(value) {
  if (!value || typeof value !== "object") {
    throw new Error("source must be an object");
  }
  for (const field of ["revision", "effectiveFrom", "verifiedAt"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`source.${field} is required`);
    }
  }
  if (!Array.isArray(value.sourceDocuments) || !value.sourceDocuments.length) {
    throw new Error("source.sourceDocuments must not be empty");
  }
  for (const document of value.sourceDocuments) {
    for (const field of ["sourceId", "title", "url", "reference"]) {
      if (typeof document?.[field] !== "string" || !document[field].trim()) {
        throw new Error(`sourceDocuments.${field} is required`);
      }
    }
  }
  if (!Array.isArray(value.axes) || !value.axes.length) {
    throw new Error("source.axes must not be empty");
  }
  const axisIds = new Set();
  for (const axis of value.axes) {
    for (const field of ["axisId", "label", "question", "factKey"]) {
      if (typeof axis?.[field] !== "string" || !axis[field].trim()) {
        throw new Error(`axes.${field} is required`);
      }
    }
    if (axisIds.has(axis.axisId)) {
      throw new Error(`duplicate axisId: ${axis.axisId}`);
    }
    axisIds.add(axis.axisId);
    // 補集合を既定値で与える軸は肯定パターン1つでよい。
    const hasDefault = Object.hasOwn(axis, "defaultValue") && axis.defaultValue !== null;
    if (!Array.isArray(axis.values) || axis.values.length < (hasDefault ? 1 : 2)) {
      throw new Error(`axes[${axis.axisId}].values must have at least ${hasDefault ? 1 : 2} entries`);
    }
    const patterns = new Set();
    for (const entry of axis.values) {
      if (!Array.isArray(entry?.patterns) || !entry.patterns.length) {
        throw new Error(`axes[${axis.axisId}].values[].patterns is required`);
      }
      if (typeof entry.optionLabel !== "string" || !entry.optionLabel.trim()) {
        throw new Error(`axes[${axis.axisId}].values[].optionLabel is required`);
      }
      for (const pattern of entry.patterns) {
        if (typeof pattern !== "string" || !pattern.trim()) {
          throw new Error(`axes[${axis.axisId}] pattern must be a non-empty string`);
        }
        if (patterns.has(pattern)) {
          throw new Error(`axes[${axis.axisId}] has a duplicate pattern: ${pattern}`);
        }
        patterns.add(pattern);
      }
    }
  }
}

function byField(field) {
  return (left, right) => String(left?.[field] || "").localeCompare(String(right?.[field] || ""));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}
