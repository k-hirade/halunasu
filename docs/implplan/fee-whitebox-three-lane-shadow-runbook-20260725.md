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

If the bucket does not exist, create it once in the fee STG project and enable
object versioning. This is infrastructure setup, not an application deploy:

```bash
gcloud storage buckets create gs://halunasu-fee-stg-artifacts \
  --project halunasu-fee-stg \
  --location asia-northeast1 \
  --uniform-bucket-level-access

gcloud storage buckets update gs://halunasu-fee-stg-artifacts \
  --versioning
```

Artifact fetch runs on the deploy operator's machine before Cloud Build. Cloud
Run does not read this bucket at runtime, so no public access or Cloud Run
service-account grant is required. Keep the bucket private.

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
The deploy script fetches and verifies every artifact before Cloud Build.

Local cold-process measurement observed a maximum RSS of 1,650.53 MiB. The
fee-api deploy script already defaults to `FEE_MEMORY=4Gi`; keep that value for
the three-lane run.

```bash
RUNTIME_FEATURE_PROFILE=stg-whitebox-three-lane-shadow \
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

## 5. Validate and run the 32-cell harness

The dry run must select 96 reviewed, synthetic, non-holdout cases: 8
specialties x 4 encounter settings x 3 cases.

```bash
npm run eval:fee-whitebox-shadow-stg -- --dry-run
```

On the first run only, create dedicated specialty departments instead of
rewriting an existing department:

```bash
FEE_E2E_MFA_CODE=<current-6-digit-code> \
npm run eval:fee-whitebox-shadow-stg -- \
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
The machine precheck is **not** independent adjudication.

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
incomplete harness, holdout use, cell mismatch, or revision mismatch blocks the
gate.

## 7. Promotion interpretation

The current local three-layer p95 sum is 984–1,252 ms, above the declared
500 ms gate. This result does not permit loosening the gate.

Even if telemetry passes later, the report remains blocked until a separately
reviewed `fee-whitebox-adjudication-v1` file covers every cell and satisfies:

- minimum reviewed lines and spans;
- code precision and recall non-inferiority;
- dangerous false-positive limit;
- deterministic exact-match repeat count.

LLM agreement and the harness machine precheck are not gold truth.

## 8. Cross-feature regression after isolated shadow

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
