import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "config/migration-parity/parity-manifest.json");
const reportOnly = process.argv.includes("--report-only");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const failures = [];

for (const [app, spec] of Object.entries(manifest)) {
  for (const requiredFile of spec.requiredFiles || []) {
    check(
      existsSync(path.join(repoRoot, requiredFile)),
      app,
      `missing required file: ${requiredFile}`
    );
  }

  for (const marker of spec.requiredApiMarkers || []) {
    const content = await readOptional(marker.file);
    check(
      content.includes(marker.text),
      app,
      `missing required marker "${marker.text}" in ${marker.file}`
    );
  }

  for (const marker of spec.forbiddenProductionMarkers || []) {
    const content = await readOptional(marker.file);
    check(
      !content.includes(marker.text),
      app,
      `forbidden production marker "${marker.text}" remains in ${marker.file}`
    );
  }
}

if (failures.length) {
  console.error("Migration parity check found incomplete items:");
  for (const failure of failures) {
    console.error(`- [${failure.app}] ${failure.message}`);
  }

  if (!reportOnly) {
    process.exitCode = 1;
  }
} else {
  console.log("Migration parity check passed.");
}

function check(condition, app, message) {
  if (!condition) {
    failures.push({ app, message });
  }
}

async function readOptional(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return "";
  }

  return readFile(absolutePath, "utf8");
}
