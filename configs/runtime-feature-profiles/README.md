# Fee runtime feature profiles

These files declare the complete fee feature state for one environment. They
are intentionally not shell scripts: values are parsed without evaluation,
every supported key is required, and an environment mismatch fails closed.

## Validate a profile

```bash
python3 scripts/runtime_feature_profile.py check \
  --profile stg-full-validation \
  --environment stg

python3 scripts/runtime_feature_profile.py show \
  --profile stg-full-validation \
  --environment stg
```

## Deploy with a profile

Use an exact environment. `TARGET_ENV=all` is rejected when a profile is set,
so an STG experiment cannot alter PROD feature flags.

```bash
RUNTIME_FEATURE_PROFILE=stg-full-validation \
TARGET_ENV=stg \
TARGET_SERVICE=fee-api \
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

An enabled white-box layer must declare both:

- an immutable `gs://` manifest URI;
- the corresponding `/app/python/data/whitebox/...` manifest path.

The deploy script downloads every declared artifact, validates all manifest
checksums, and only then submits the fee-api build. Upload artifacts before the
first deployment of a new profile.

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

Upload is immutable by artifact type and version. A second upload is accepted
only when the remote manifest has the same SHA-256. Deployment downloads each
manifest and its files, verifies every declared checksum, and installs it into
the fee-api build context before Cloud Build starts.

## Profile intent

| Profile | Purpose |
| --- | --- |
| `stg-longitudinal` | Extraction memo and standing-fact measurements |
| `stg-monthly-enforce` | Monthly exclusion acceptance measurements |
| `stg-whitebox-span-shadow` | Isolated WX1 span shadow |
| `stg-whitebox-three-lane-shadow` | Isolated WX1/WX2/WX3 shadow |
| `stg-full-validation` | Cross-feature STG regression with all accepted STG features |

These profiles are STG-only. They do not define or enable a PROD white-box
runtime.

Use `stg-whitebox-three-lane-shadow` to measure the white-box stack without
memo, standing-fact, or monthly-exclusion interactions. Use
`stg-full-validation` for the subsequent cross-feature regression. Both keep
all three white-box layers in `shadow`; neither can change extracted events,
candidates, or points.
