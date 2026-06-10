# Fee SOAP E2E Test Data

This directory has one canonical dataset for fee-calculation SOAP E2E tests.

## Canonical File

- `fee-soap-e2e-cases.json`

Use this file for future automated tests.

Each case contains the chart and expected result together:

- `chart`
  - SOAP chart text.
  - `chart.soap.S/O/A/P` for structured SOAP.
  - `chart.standard` for a single text representation.
- `expectedExtraction`
  - diagnoses, required procedure candidates, required review topics, forbidden candidates, and normalized signal expectations.
- `expectedClaimContext`
  - explicit claim context used to verify point calculation.
- `expectedCalculation`
  - expected points, candidate codes, and engine status.
- `billingTargets`
  - human-readable target fee items and line points.
- `evidence`
  - master/version/source evidence for the expected points.
- `caseTypeAxes`, `caseTypeSignature`
  - case-type metadata used to keep the 800 cases unique beyond `caseId`. `caseTypeSignature` is a short hash recomputed by `scripts/fee_soap_case_type_signature.mjs`.
- `status`, `qualityLabel`, `reviewPolicy`
  - review and quality metadata.

## Current Scope

The canonical file contains 800 cases:

- 300 seed cases derived from `fee-chart-gold-seed-300`.
- 500 coverage expansion cases with `COV-...` case IDs.

It includes:

- 268 `exact` cases.
- 4 `candidate_presence` cases.
- 356 `review_required` cases.
- 59 `safety` cases.
- 100 `unsupported_expected` cases.
- 13 `split_required` cases.

The non-exact cases are intentionally not point-perfect gold. They are used to verify review reasons, forbidden candidates, unsupported-domain handling, and safe non-confirmation behavior.

The 500 expansion cases are synthetic and medical-office-review-before. They are not production gold. The added `exact` cases reuse existing verified claim contexts so the calculation layer can still be regression-tested while the SOAP language broadens department and domain coverage.

The non-exact cases are generated as sufficiently detailed SOAP notes, not thin placeholders. Current measured SOAP text lengths are min 777 / avg 1,064 / max 1,294 characters across all 800 cases.

Exact cases preserve the manually thickened clinical notes where available. Some exact seed cases are intentionally concise, so the validator minimum remains 600 characters.

Coverage audit currently meets the 800-case recommended scale and the minimum case counts for major billing domains including injection, materials, dialysis/transfusion, and endoscopy. Remaining audit gaps are intentional quality-stage gaps or near-threshold department gaps after removing fake exact coverage from unsupported domains.

The dataset also enforces case-type uniqueness:

- `caseTypeSignature`: 800 unique hash signatures / 800 cases.
- Duplicate case-type groups: 0.
- `caseTypeSignature` does not treat `caseId`, date, or random strings as a meaningful type by themselves.
- Cases with the same base billing/review structure are separated by clinical documentation axes such as caregiver involvement, outside information, planned-item separation, patient background, and safety-netting context.

DPC and fee-for-service inpatient basic fee cases are separated:

- DPC cases remain review-only or unsupported safety cases.
- Fee-for-service acute inpatient basic fee cases use `inpatient_basic` labels and may be exact when the claim context is verified.

`forbiddenCandidates` must use normalized labels or codes that should not be auto-finalized. They must not use raw status phrases. Review reasons belong in `requiredReviewTopics`.

## Evaluation Policy

Do not evaluate `requiredBillingSignals` by raw substring matching against the chart text.

The chart text intentionally contains natural variations such as:

- `ゲーベンクリーム1%を10g` vs `ゲーベンクリーム1% 10g`
- `電子的に保存・管理` vs `電子画像管理`
- `マルチスライス型機器` vs `16列以上64列未満マルチスライスCT`
- patient age and visit context implying `乳幼児加算`
- generic prescription wording implying `一般名処方加算`

Tests should compare extractor output with `expectedExtraction.signalExpectations` after normalization.

Use:

- `literalInChart` for clinical facts explicitly present in the SOAP text, allowing normalized synonyms.
- `derivedFromContext` for facts inferred from age, visit type, facility standard, department, procedure context, or imaging context.
- `requiredReviewTopics` for review reasons that must be surfaced.
- `forbiddenCandidates` for candidates that must not be produced or must not be marked as finalized.

For `exact` cases, `expectedClaimContext` and expected candidate codes must still be supported by the SOAP note or by explicit patient/encounter context. Context-derived does not mean arbitrary. If an exact case expects imaging, lab tests, B-V blood collection, treatment, in-house or outside medication fees, inpatient basic fees, pediatric add-ons, electronic image management, CT equipment kind, generic prescription add-on, or outside prescription fee, the chart/context must contain a corresponding current-visit clinical anchor.

Examples:

- CT exact cases need performed CT wording, and CT equipment-kind wording when the expected context fixes an equipment kind.
- Simple radiography exact cases need performed simple X-ray wording and the expected digital/photo-diagnosis wording.
- Lab exact cases need the relevant test evidence such as influenza antigen, group A strep rapid test, SARS-CoV-2/influenza simultaneous antigen, CRP, CBC/peripheral blood, urinalysis, or urine protein.
- B-V exact cases need blood collection wording such as venous blood draw or blood specimen submission.
- Treatment exact cases need treatment type and area evidence, such as burn/wound wording plus an area bucket.
- Inpatient basic exact cases need acute general inpatient fee wording and day-count wording.
- Outside prescription and generic prescription add-on exact cases need outside-prescription and generic-name prescription wording.

Review-topic text such as `CT機器区分確認` or `検体採取確認` alone is not enough evidence that the clinical service was performed.

For `review_required`, `unsupported_expected`, `safety`, and `split_required` cases, `forbiddenCandidates` means the item must not be treated as an automatically finalized billing line before the required review topics are resolved. A review-only mention is allowed when the case also expects `engineStatus=needs_review`.

## Visit History Setup

Initial/revisit behavior depends on actual patient history in the fee app, not only on SOAP text.

The E2E evaluator therefore prepares synthetic patient history before the target case is created:

- outpatient cases with `encounter.visitType = "revisit"` are created with one prior fee session for the same synthetic patient.
- outpatient cases whose `expectedClaimContext.outpatient_basic.fee_kind` is `revisit` are also seeded with one prior fee session.
- initial, unknown, and inpatient cases are left without seeded outpatient prior history unless a case explicitly says otherwise in future metadata.

The prior session is synthetic, uses the same generated patient, and has a service date one day before the target case. This keeps the product behavior realistic: the app's patient-history rule sees a prior fee session for revisit cases and no prior fee session for initial cases.

Use `--no-seed-visit-history` only when debugging the extractor or intentionally testing the no-history path.

## Difficulty Axes

`difficultyLevel` is the SOAP extraction difficulty.

It is intentionally separate from the source `fee-chart-gold-seed-300` calculation difficulty:

- `difficultyLevel`
  - Natural language extraction difficulty from SOAP text.
- `calculationDifficulty`
  - Source gold dataset difficulty for claim-context-to-calculation behavior.

Do not compare these two values as if they are the same scale.

## Status And Quality

The dataset keeps `status`, `qualityLabel`, `sourceReviewPolicy`, and `reviewPolicy`.

Current data is still not medical-office reviewed. `productionGoldAllowed` stays false until reviewed and explicitly promoted.

## Commands

```bash
npm run generate:fee-soap-e2e
npm run assign:fee-soap-case-types
npm run generate:fee-soap-e2e:coverage-800
npm run test:fee-soap-e2e
npm run eval:fee-soap-e2e
```

## Evaluation Scripts

`npm run eval:fee-soap-e2e` runs SOAP-to-fee evaluation in report-only mode.

It writes generated reports under `data/tests/fee-soap-e2e/reports/`, which is git-ignored:

- `latest.json`: full machine-readable result.
- `latest.jsonl`: one case per line for aggregation.
- `latest.md`: human-readable summary.

The report intentionally does not include full SOAP text, credentials, cookies, CSRF tokens, or access tokens. It records `caseId`, chart hash, expected/actual points and codes, failed stage, missing signals, forbidden violations, and timing metrics.

Useful commands:

```bash
npm run eval:fee-soap-e2e -- --limit 10
npm run eval:fee-soap-e2e -- --case L1-007-ct-head-revisit
npm run eval:fee-soap-e2e -- --assertion exact
npm run eval:fee-soap-e2e -- --assertion exact --use-expected-claim-context
npm run eval:fee-soap-e2e -- --case COV-L1-301-pediatrics-pediatric_addons-exact
npm run eval:fee-soap-e2e -- --case COV-L1-301-pediatrics-pediatric_addons-exact --no-seed-visit-history
npm run eval:fee-soap-e2e:strict
```

`--use-expected-claim-context` bypasses SOAP extraction and verifies the fee calculation engine from the expected claim context. This is useful to distinguish extraction failures from calculation failures.

For STG Cloud Run/API evaluation, use a dedicated synthetic organization and runner account, then set:

```bash
export FEE_E2E_PLATFORM_BASE_URL="https://..."
export FEE_E2E_FEE_BASE_URL="https://..."
export FEE_E2E_ORGANIZATION_CODE="..."
export FEE_E2E_LOGIN_ID="..."
export FEE_E2E_PASSWORD="..."
# export FEE_E2E_MFA_CODE="123456" # only when the runner account has MFA enrolled
# Optional. By default the runner loads the first active STG facility/department from Platform.
# export FEE_E2E_FACILITY_ID="fac_..."
# export FEE_E2E_DEPARTMENT_ID="dep_..."
npm run eval:fee-soap-e2e:stg -- --limit 10
```

STG evaluation must use only synthetic patients and synthetic SOAP notes.
