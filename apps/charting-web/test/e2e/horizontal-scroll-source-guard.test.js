import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const checkedFiles = [
  "apps/charting-web/app/globals.css",
  "apps/charting-web/components/encounter-workspace.js",
  "apps/charting-web/components/admin-console.js",
  "apps/charting-web/components/session-launcher.js"
];

test("web UI does not implement horizontal scrolling", async () => {
  const forbiddenPatterns = [
    /\boverflow-x\s*:\s*(auto|scroll)\b/i,
    /\bscrollLeft\b/,
    /\bhorizontal-scroll\b/i
  ];
  const violations = [];

  for (const relativePath of checkedFiles) {
    const content = await readFile(path.join(repoRoot, relativePath), "utf8");
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      if (forbiddenPatterns.some((pattern) => pattern.test(line))) {
        violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});
