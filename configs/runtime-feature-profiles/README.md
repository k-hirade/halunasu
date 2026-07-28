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

The deploy script validates the immutable URI/path contract before submission.
Regional Cloud Build then downloads only the artifacts selected by the profile
and validates every manifest checksum before building the fee-api image. Local
model generations are excluded from the source archive. Upload artifacts before
the first deployment of a new profile. Build logs use Cloud Logging only; do not
grant project-wide Storage Admin merely to create a Cloud Build GCS log bucket.

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
the fee-api build context inside Cloud Build. An explicit local fetch reads the
remote manifest first and reuses a checksum-verified local artifact without
downloading the model again.

## Profile intent

| Profile | Purpose |
| --- | --- |
| `stg-openai-primary-span-recheck` | OpenAI-primary extraction with one bounded Span-triggered OpenAI recheck for the Yamamoto STG facility |
| `stg-openai-primary-span-control` | Matching OpenAI-primary STG control with coverage recheck disabled |
| `stg-longitudinal` | Extraction memo and standing-fact measurements |
| `stg-monthly-enforce` | Monthly exclusion acceptance measurements |
| `stg-whitebox-span-shadow` | Isolated WX1 span shadow |
| `stg-whitebox-three-lane-shadow` | Isolated WX1/WX2/WX3 shadow |
| `stg-full-validation` | Cross-feature STG regression with all accepted STG features |

These profiles are STG-only. They do not define or enable a PROD white-box
runtime.

`stg-openai-primary-span-recheck` is the active auxiliary-recheck path. Its
coverage mode is `verify`: a threshold-passing Span detection that is absent
from the initial OpenAI facts can trigger one `line_subset` OpenAI call. The
recheck can only add review-required candidates and cannot directly add or
remove billed lines. `FEE_SPAN_DETECTOR_MODE=shadow` in this profile means the
detector itself is never an autonomous billing route; it does not mean the
OpenAI recheck is observation-only.

Use `stg-openai-primary-span-control` immediately before the verify run to
produce the required `off` control result. It keeps the same extraction,
memo, standing-fact, monthly-exclusion, Span artifact, and facility settings;
only `FEE_EXTRACTION_COVERAGE_MODE_STG` differs.

Use `stg-whitebox-three-lane-shadow` to measure the white-box stack without
memo, standing-fact, or monthly-exclusion interactions. Use
`stg-full-validation` for the subsequent cross-feature regression. Both keep
all three white-box layers in `shadow`; neither can change extracted events,
candidates, or points.
