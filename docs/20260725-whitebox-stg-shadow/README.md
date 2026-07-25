# WX0-WX1 STG Shadow Execution Report

Date: 2026-07-25

## Outcome

The WX0 evaluation and WX1 build path is now executable through STG shadow.
The span detector runs in parallel with the existing LLM extraction path and
does not change billing candidates or points.

| Step | Result |
| --- | --- |
| 1. Generate 48 non-outpatient cases | Complete |
| 2. Human review | Skipped by explicit instruction |
| 3. Cover all 32 specialty-setting cells | Complete for the non-gold experimental corpus only |
| 4. Measure licensed GLiNER candidates | Complete |
| 5. Select the model path | Complete: reject direct zero-shot use and select fine-tuning |
| 6. Build the WX1 ONNX artifact | Complete |
| 7. Deploy STG shadow | Complete |

Human review was not fabricated. The 48 generated cases remain
`pending_review` and `machine_derived`; they were not promoted to canonical
gold. Consequently, canonical strict coverage remains 8/32 cells. The
experimental corpus covers 32/32 cells, but must not be used to claim
production accuracy.

## Experimental Corpus

- Generated source:
  `data/tests/fee-specialty-matrix/non-outpatient-generated-cases.json`
- Evaluation view:
  `data/tests/fee-specialty-matrix/experimental-machine-holdout.json`
- Total cases: 352
- Reviewed cases: 304
- Machine-derived pending-review cases: 48
- Holdout cells represented in the experimental view: 32/32
- Generated model: `gpt-5.4-nano`
- Generation revision:
  `UNPINNED_ALIAS_gpt-5.4-nano_observed-2026-07-25_EXPERIMENT_ONLY`
- Experimental view SHA-256:
  `5c74298229c39179b8182c1d114e588622a616fafc553886d56f551026336f04`

The unpinned generation alias is another reason this corpus is experimental
only. Each generated case retains its response ID, prompt hash, schema hash,
and blueprint hash.

## GLiNER Measurements

All candidates use an immutable model revision and an Apache-2.0 license.
These measurements include 48 machine-derived labels and are not gold
accuracy results.

| Candidate | Threshold | Runs | Precision | Recall | F1 | p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `urchade/gliner_multi-v2.1@443d26d...` | 0.1 | 3 | 1.03% | 1.32% | 1.16% | 781 / 1,229 ms |
| `Ihor/gliner-biomed-small-v1.0@9892e7c...` | 0.1 | 1 | 0% | 0% | 0% | 753 / 1,368 ms |
| `Ihor/gliner-biomed-base-v1.0@146c133...` | 0.1 | 1 | 0% | 0% | 0% | 1,541 / 2,852 ms |

The selected multilingual candidate produced the same candidate set in
192/192 runs. Its accuracy was still far below the 40% branch threshold, so
direct GLiNER deployment was rejected. The correct branch was supervised
fine-tuning of a Japanese-capable multilingual encoder.

A threshold-0.5 run generated before the aggregate iterator bug was fixed was
discarded. Model selection uses only the corrected threshold-0.1 reports.

## WX1 Artifact

- Artifact version: `wx1-multilingual-minilm-l12-v1`
- Base model:
  `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
- Immutable model revision:
  `e8f8c211226b894fcb81acc59f3b34ba3efd5f42`
- License: Apache-2.0
- Training/development: 224 / 64 cases
- Canonical holdout withheld from training and threshold selection: 16 cases
- Selected epoch: 4
- Development loss: 0.1801
- Relevance accuracy: 99.22%
- Deterministic inference: 100/100 runs
- Manifest SHA-256:
  `059a7c4adc394f1bdd3861aa703ce44f68d3a7394b4972f0ab730b24c13f456a`

Development F1 was strongest for medication (98.59%), management (88.00%),
procedure (88.05%), lab (83.60%), injection (80.00%), counseling (76.92%),
and exam (74.17%). Imaging and treatment had zero recall. Several other
categories had no development support. This is sufficient for shadow
observation, not for routing or production promotion.

Build evidence:
`docs/whitebox-artifact-builds/wx1/wx1-multilingual-minilm-l12-v1/`.

## STG Deployment

- Service: `fee-api-stg`
- Cloud Run revision: `fee-api-stg-00182-6sd`
- Image:
  `asia-northeast1-docker.pkg.dev/halunasu-fee-stg/halunasu-services/fee-api-stg:20260725-223302`
- Traffic: 100% to the new STG revision
- `FEE_SPAN_DETECTOR_MODE=shadow`
- Linker/context classifier: `off`
- PROD remains `fee-api-prod-00076-88s` with
  `FEE_SPAN_DETECTOR_MODE=off`

Cloud Run `/readyz` confirmed:

- runtime mode `span=shadow`
- artifact and immutable model revision loaded
- runtime dependencies available
- manifest checksum valid
- inference probe passed
- two-run determinism probe passed
- no error-severity entries in the new revision's startup log

Shadow mode still sends all lines through the existing LLM extraction path.
The WX1 result is retained only for comparison metrics and cannot change a
claim line or point total.

## Artifact Handling

The generated ONNX file is about 449 MB and the tokenizer is about 16 MB.
They exceed the normal Git workflow and are ignored by `.gitignore`. The
small manifest and build evidence remain versionable. The STG image already
contains the validated binaries in Artifact Registry.

A single deployment used a 644.2 MiB build context and a 582.1 MiB compressed
Cloud Build upload. After cleanup, the fee Artifact Registry repository was
1.50 GiB and the Cloud Build bucket was 2.85 GiB, above its 2.00 GiB warning
threshold. This is an operational reason to avoid rebuilding and uploading the
model on every source-only deploy.

A durable model promotion workflow still needs a dedicated binary store and
an authenticated fetch/build step. Until then, rebuilding or deploying from
a fresh clone requires regenerating the artifact with the pinned command
below.

## Reproduction

```bash
npm run prepare:fee-specialty-experimental-holdout

PYTHONPATH=python:. HF_HOME=/tmp/halunasu-hf-cache \
  .venv-wx0/bin/python -m experiments.wx0_span_zeroshot \
  --dataset data/tests/fee-specialty-matrix/experimental-machine-holdout.json \
  --entity-types data/tests/fee-specialty-matrix/entity-types.json \
  --split holdout \
  --allow-machine-labels \
  --model urchade/gliner_multi-v2.1 \
  --revision 443d26d654e0324125a96bebd8e796c14ff2efe6 \
  --threshold 0.1 \
  --repeats 3 \
  --output-dir docs/20260725-whitebox-stg-shadow/wx0/gliner-multi-v2.1-threshold-0.1-repeats-3

PYTHONPATH=python:. HF_HOME=/tmp/halunasu-hf-build-cache \
  .venv-whitebox-build/bin/python scripts/build_wx1_span_artifact.py \
  --base-model sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 \
  --model-revision e8f8c211226b894fcb81acc59f3b34ba3efd5f42 \
  --license Apache-2.0 \
  --license-source-url https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42 \
  --license-verified-at 2026-07-25 \
  --artifact-version wx1-multilingual-minilm-l12-v1

FEE_SPAN_DETECTOR_MODE_STG=shadow \
FEE_SPAN_DETECTOR_MANIFEST_PATH_STG=/app/python/data/whitebox/span-wx1-multilingual-minilm-l12-v1/manifest.json \
TARGET_ENV=stg \
TARGET_SERVICE=fee-api \
  ./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

## Verification

Passed:

- specialty workflow: 21 tests
- WX0 metric/evaluator: 11 tests
- WX1 builder: 7 focused tests and 22 builder-suite tests
- whitebox runtime: 27 Node tests and 22 Python tests
- training-view freshness check
- local and Cloud Run readiness/inference/determinism probes
