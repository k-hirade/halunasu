#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { caseTypeAudit, decorateDatasetCaseTypes } from "./fee_soap_case_type_signature.mjs";

const repoRoot = process.cwd();
const datasetPath = path.join(repoRoot, "data/tests/fee-soap-e2e/fee-soap-e2e-cases.json");
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

decorateDatasetCaseTypes(dataset);
fs.writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`);

const audit = caseTypeAudit(dataset.cases || []);
console.log(JSON.stringify({
  datasetId: dataset.datasetId,
  version: dataset.version,
  cases: dataset.cases?.length || 0,
  caseTypeAudit: {
    uniqueCaseTypeSignatures: audit.uniqueCaseTypeSignatures,
    duplicateCaseTypeSignatureGroups: audit.duplicateCaseTypeSignatureGroups,
    uniqueBaseSignatures: audit.uniqueBaseSignatures,
    duplicateBaseSignatureGroups: audit.duplicateBaseSignatureGroups
  },
  output: path.relative(repoRoot, datasetPath)
}, null, 2));
