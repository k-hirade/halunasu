# Fee White-box Three-lane Shadow Runbook (2026-07-25)

Parent:
[next-after-WX1](./fee-whitebox-next-after-wx1-shadow-20260725.md) /
[promotion policy](../../configs/fee-whitebox-promotion-gate.json).

## Scope and safety boundary

This runbook enables WX1 span detection, WX2 master linking, and WX3 context
classification in **STG shadow mode only**. Encoder output cannot alter extracted
facts, candidates, or points. There is no PROD profile.

The controlled 32-cell dataset is synthetic. Its routable rate is a mechanism
measurement, not an estimate of customer traffic or actual copy-forward rates.

## 1. Verify local artifacts

```bash
npm run verify:fee-whitebox-artifact -- \
  --manifest python/data/whitebox/span-wx1-multilingual-minilm-l12-v1/manifest.json \
  --expected-type fee_span_detector

npm run verify:fee-whitebox-artifact -- \
  --manifest python/data/whitebox/linker-ruri-v3-30m-v1/linker_manifest.json \
  --expected-type fee_master_linker

npm run verify:fee-whitebox-artifact -- \
  --manifest python/data/whitebox/context-wx3-multilingual-minilm-l12-v1/manifest.json \
  --expected-type fee_context_classifier
```

## 2. Upload immutable artifacts

The uploader writes `gs://<registry>/<artifact-type>/<artifact-version>/` and
publishes the manifest last. Reusing a version with different bytes fails.

Verify the STG artifact bucket before the first upload:

```bash
gcloud storage buckets describe gs://halunasu-fee-stg-artifacts \
  --project halunasu-fee-stg
```

If the bucket does not exist, run the guarded P10 provisioner. White-box
artifact paths already include an immutable artifact version, so bucket-level
Object Versioning must remain disabled. STG also disables soft delete; PROD
keeps seven days of soft delete for operator-error recovery.

```bash
P10_ALLOW_BILLING=yes \
./scripts/p10_provision_runtime_projects_low_cost.sh --apply
```

Artifact fetch runs inside the regional Cloud Build worker. The operator's
machine reads only the small immutable manifest when explicitly running the
fetch CLI, and a verified local cache skips model downloads. Cloud Run does not
read this bucket at runtime. The provisioner grants the Cloud Build service
account read-only object access; keep the bucket private.

```bash
npm run upload:fee-whitebox-artifact -- \
  --manifest python/data/whitebox/span-wx1-multilingual-minilm-l12-v1/manifest.json \
  --expected-type fee_span_detector \
  --registry-uri gs://halunasu-fee-stg-artifacts/whitebox

npm run upload:fee-whitebox-artifact -- \
  --manifest python/data/whitebox/linker-ruri-v3-30m-v1/linker_manifest.json \
  --expected-type fee_master_linker \
  --registry-uri gs://halunasu-fee-stg-artifacts/whitebox

npm run upload:fee-whitebox-artifact -- \
  --manifest python/data/whitebox/context-wx3-multilingual-minilm-l12-v1/manifest.json \
  --expected-type fee_context_classifier \
  --registry-uri gs://halunasu-fee-stg-artifacts/whitebox
```

## 3. Deploy the exact STG profile

The profile is complete and fail-closed. `TARGET_ENV=all` and PROD are rejected.
The deploy script validates immutable references locally, uploads a code-only
source context to a regional Cloud Build staging bucket, and Cloud Build fetches
and verifies only the selected artifacts before creating the image. Old local
artifact generations never enter the build context. Build logs are written to
Cloud Logging only, so a `*-cloudbuild-logs` GCS bucket and a project-wide
`roles/storage.admin` grant are not required.

Current STG revision `fee-api-stg-00183-vhx` stops its Python worker at 4 GiB,
but the old runtime only reports `code null`. First deploy the signal-aware
diagnostic revision at the same size; do not label it OOM before observing
`signal=SIGKILL`.

```bash
RUNTIME_FEATURE_PROFILE=stg-whitebox-three-lane-shadow \
CPU=2 \
FEE_MEMORY=4Gi \
TARGET_ENV=stg \
TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

The white-box cold-load timeout is independently set to 120 seconds. It does
not extend normal fee calculation timeouts.

## 4. Verify readiness

```bash
curl -sS https://fee-api-stg-wmfrwcpzkq-an.a.run.app/readyz \
  | jq '{
      env,
      revision: .runtime.cloudRunRevision,
      modes: .runtimeFeatures.whiteboxExtraction,
      whitebox: .feeCalculator.whitebox,
      timeoutMs: .feeCalculator.whiteboxTimeoutMs
    }'
```

Required result:

- `env == "stg"`
- span/linker/context are all `shadow`
- all three `.feeCalculator.whitebox.*.available == true`
- all three artifact versions match the immutable manifests

If an artifact is unavailable, inspect the PHI-free worker exit event:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="fee-api-stg"
   AND jsonPayload.event="fee.python_worker.exited"' \
  --project halunasu-fee-stg \
  --freshness=30m \
  --limit=20 \
  --format=json
```

Only when this records `signal=SIGKILL`, repeat the isolated STG deployment at
8 GiB and verify readiness again:

```bash
RUNTIME_FEATURE_PROFILE=stg-whitebox-three-lane-shadow \
CPU=2 \
FEE_MEMORY=8Gi \
TARGET_ENV=stg \
TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

Do not start the matrix harness until all three artifacts are available.

After every successful deploy, P19 applies these storage controls:

- regional and legacy STG Cloud Build sources: delete after one day;
- regional and legacy PROD Cloud Build sources: delete after seven days;
- Cloud Build logs: retain in Cloud Logging according to the project's logging
  retention policy; do not create a dedicated GCS log bucket;
- white-box artifact bucket: disable Object Versioning;
- noncurrent STG artifact generations: delete after one day;
- noncurrent PROD artifact generations: delete after seven days, followed by
  the seven-day soft-delete recovery window.

Live immutable artifact versions are not age-deleted because a runtime profile
may still reference an older rollback version.

## 5. Validate and run the 32-cell harness

The diagnostic dry run must select 96 reviewed, synthetic, non-holdout cases:
8 specialties x 4 encounter settings x 3 cases. It also schedules one
identical-input control per cell three times. The first calculation is shared
with the 96 measurements, so the total is 160 calculations (96 + 64).

```bash
npm run eval:fee-whitebox-shadow-stg -- --dry-run
```

On the first run only, create dedicated specialty departments instead of
rewriting an existing department:

```bash
FEE_E2E_MFA_CODE=<current-6-digit-code> \
npm run eval:fee-whitebox-shadow-stg -- \
  --purpose diagnostic \
  --control-repeats 3 \
  --organization-code yamamoto-demo-stg \
  --login-id yamamoto-admin \
  --password-file .secrets/yamamoto-demo-stg-password.txt \
  --provision-departments
```

Subsequent runs omit `--provision-departments`. Telephone cells are represented
using the production contract `setting=outpatient` plus
`encounterDetails.visitKind=telephone_revisit`; telemetry normalizes them to the
dedicated `telephone` cell.

The harness writes `result.json` after every calculation and records only
synthetic identifiers, hashes, revision metadata, and machine precheck results.
The machine precheck is **not** independent adjudication. Control calculations
are excluded from telemetry accuracy/latency denominators and are used only for
white-box fingerprint determinism.

## 6. Export and isolate Cloud Logging

Set `RUN_DIR` to the directory printed by the harness:

```bash
RUN_DIR=docs/20260725-whitebox-three-lane-shadow/<run-id>

gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="fee-api-stg"
   AND jsonPayload.event="fee.calculate.performance"' \
  --project halunasu-fee-stg \
  --freshness=6h \
  --limit=2000 \
  --format=json > "$RUN_DIR/cloud-logging.json"
```

Generate the report with the harness result as a mandatory session allowlist:

```bash
npm run report:fee-whitebox-shadow -- \
  --input "$RUN_DIR/cloud-logging.json" \
  --run-manifest "$RUN_DIR/result.json" \
  --output-dir "$RUN_DIR/report"
```

Unrelated Cloud Run traffic is ignored. Missing logs, duplicate logs, an
incomplete harness, purpose/holdout mismatch, cell mismatch, revision
mismatch, or a missing/invalid lane duration blocks the gate. Missing duration
telemetry is never treated as zero milliseconds.

## 7. Prepare and compile independent review

Prepare a run-bound queue. The command verifies the manifest-bound dataset and
policy SHA-256 values. Diagnostic runs remain ineligible for promotion:

```bash
npm run prepare:fee-whitebox-adjudication -- \
  --run-manifest "$RUN_DIR/result.json" \
  --output "$RUN_DIR/adjudication-queue.json"
```

Review only the `humanReview` object of every selected item, then compile it:

```bash
npm run compile:fee-whitebox-adjudication -- \
  --queue "$RUN_DIR/adjudication-queue.json" \
  --output "$RUN_DIR/adjudication.json"
```

The compiler rejects incomplete reviews, purpose/holdout mismatches, a policy
SHA-256 mismatch, and changes to clinical text, selection metadata, or machine
comparisons. Feed the compiled file to the reporter only for the same run:

```bash
npm run report:fee-whitebox-shadow -- \
  --input "$RUN_DIR/cloud-logging.json" \
  --run-manifest "$RUN_DIR/result.json" \
  --adjudication "$RUN_DIR/adjudication.json" \
  --output-dir "$RUN_DIR/report-with-adjudication"
```

## 8. Promotion interpretation

The current local three-layer p95 sum is 984–1,252 ms, above the declared
500 ms gate. This result does not permit loosening the gate.

Even if telemetry passes later, the report remains blocked until a separately
reviewed `fee-whitebox-adjudication-v1` file covers every cell and satisfies:

- minimum reviewed cases, lines, and spans;
- code precision and recall non-inferiority;
- dangerous false-positive limit;
- deterministic exact-match repeat count.

LLM agreement and the harness machine precheck are not gold truth.
The final report also requires the adjudication run ID, dataset SHA-256, and
policy SHA-256 to match the run manifest.

The promotion path is a separate holdout run. It fails before network access
until every cell has at least 3 reviewed cases, 20 reviewed lines, and 10
reviewed spans:

```bash
npm run eval:fee-whitebox-shadow-stg -- --purpose promotion --dry-run
```

## 9. Cross-feature regression after isolated shadow

Only after isolated shadow is understood, deploy the combined STG profile and
rerun longitudinal, standing, and monthly-exclusion acceptance suites:

```bash
RUNTIME_FEATURE_PROFILE=stg-full-validation \
FEE_MEMORY=4Gi \
TARGET_ENV=stg \
TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

No command in this runbook enables white-box routing in PROD.
