# WX1 Span Root Cause

## Conclusion

The near-zero WX1 span output is caused by an `attention_mask` construction
bug in the shared ONNX runtime. It is not caused by the trained weights, ONNX
export, GCS delivery, Cloud Run, or the STG revision.

The WX1 and WX3 tokenizer artifacts use fixed padding to 256 tokens. The
runtime copies all 256 token IDs and then creates an attention mask containing
256 ones. Training used the tokenizer-generated mask, where padding positions
are zero.

Relevant implementation:

- `python/medical_fee_calculation/whitebox_onnx.py:132-153`
- `scripts/build_wx1_span_artifact.py:573-585`
- `scripts/build_wx3_context_artifact.py:119-148`

## Evidence

### Single reviewed case

Case `wx0-im-outp-0008` contains lab, blood collection, medication, and
prescription spans.

| Input | Active mask tokens | Result |
| --- | ---: | --- |
| Current runtime | 256 per line | all four lines irrelevant, zero spans |
| Tokenizer mask | 10-40 per line | lab, blood collection, medication, and prescription spans restored |

No model or artifact file was changed for this comparison.

### Original development partition

The unchanged ONNX artifact was evaluated against the exact 64-case,
256-line development partition used when the artifact was built.

- relevance accuracy: 0.9921875, exactly equal to the build report
- category TP/FP/FN: exact match for every category
- span-bearing lines: 124 / 256

This proves that ONNX export retained the learned model behavior when the
runtime input contract matches training.

### STG diagnostic matrix forecast

The corrected mask was applied locally to the same 96 reviewed cases used by
the STG shadow run.

- lines: 384
- reviewed spans: 317
- predicted spans: 328
- span-bearing lines: 179, compared with 1 in STG
- exact-offset reviewed-span recall: 73.5%
- category-overlap reviewed-span recall: 91.8%

The remaining misses are model-quality and boundary-decoding issues, not the
padding-mask failure.

## Why Existing Checks Passed

1. The artifact build calculated quality metrics from PyTorch before ONNX
   runtime execution.
2. The ONNX build probe used only the first development line, which is a
   negative S line with no expected span.
3. The build probe checked deterministic byte equality, not semantic
   correctness.
4. The readiness probe checks only that one result is returned for
   `算定確認`; it does not require a known positive span.
5. The tiny ONNX test tokenizer has no built-in padding, so it cannot reproduce
   the faulty branch.

Determinism therefore proved that the runtime returned the same wrong result,
not that the result matched the trained model.

## Remediation

### P0: Correct the shared encoder

Update `encode_batch` to:

1. copy each encoding's `attention_mask` rather than setting every serialized
   position to one;
2. obtain the pad ID from `tokenizer.padding.pad_id` when available instead of
   assuming the token name `[PAD]`;
3. validate that IDs, masks, type IDs, and offsets have consistent lengths.

This fixes WX1 and WX3. WX2 should remain behaviorally unchanged.

### P0: Add regression tests

Add a unit fixture with fixed tokenizer padding and assert:

- trailing padding mask values are zero;
- mask sum equals the number of real and special tokens;
- a positive span remains detectable;
- WX2 output is unchanged.

### P0: Add artifact parity gates

Before accepting a WX1 or WX3 artifact:

1. run PyTorch and ONNX/runtime inference over the full development split;
2. compare logits within a fixed numeric tolerance;
3. require prediction and metric non-regression;
4. record parity metrics in the build report;
5. fail if positive development examples collapse to zero runtime spans.

Add positive and negative semantic readiness probes generated only from
reviewed train/development data. Do not use holdout data.

### P1: Remeasure before model work

After deploying the runtime fix, rerun the same 160 calculations on one Cloud
Run revision. Confirm:

- span-bearing lines are no longer near zero;
- WX2 and WX3 receive measurable traffic;
- no degraded runs;
- determinism controls still pass.

Only then evaluate L3 retraining or promotion.

## Remaining Non-root-cause Work

The mask fix does not make the three-lane system ready for promotion:

- imaging and treatment had zero development recall in the existing WX1
  report;
- exact span-boundary recall is lower than overlap recall;
- WX3 currently has 1.0 abstain thresholds for temporal relation and provider
  ownership, which effectively prevents full-axis routing;
- white-box p95 was 781 ms against the 500 ms gate.

These should be addressed after the corrected runtime is remeasured. They do
not explain the original one-span STG result.
