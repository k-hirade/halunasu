# Fee white-box 32x3 bottleneck analysis

Date: 2026-07-28

## Scope

This report analyzes:

- STG diagnostic result: `result.json`
- Cloud Run revision: `fee-api-stg-00196-q5b`
- 32 measurement cases across 8 specialties x 4 encounter settings
- 64 identical-input controls, for 96 calculations total
- Cloud Logging `fee.calculate.performance` records for all 96 calculations
- Span detector `wx1-multilingual-minilm-l12-v2`
- Linker `822c970bda802cabf628c684`
- Context classifier `wx3-multilingual-minilm-l12-v3`

This is a diagnostic dataset, not holdout. It has one unique case per cell.
The two additional runs per cell prove determinism; they do not increase the
number of independent calibration examples.

## Executive conclusion

The bottleneck has improved, but it has also moved.

1. Runtime availability and determinism are solved for this revision.
   All three artifacts were available, degraded runs were 0/96, and all 32
   determinism groups matched exactly across three runs.
2. Span detection is no longer the primary bottleneck.
   Current/own span recall improved from 41.2% to 95.5%.
3. The business bottleneck is not solved.
   Only 9/88 expected current/own spans passed the diagnostic joint gate,
   only 3/88 were billable inclusions, and 0/62 span-bearing lines could be
   delegated from the LLM.
4. The current accuracy bottleneck is a combination of:
   - deterministic cue scope errors,
   - context-classifier abstention,
   - linker retrieval/code disambiguation,
   - line-level all-or-nothing routing.
5. The current latency bottleneck is still OpenAI.
   All 32 measurement cases called OpenAI with `expectedLlmLineRatio=1`.
   White-box inference adds about 1.9 seconds on average but replaces no LLM
   work while all modes remain in shadow.

The current architecture is failing closed as intended. It is safe, but it is
not yet useful as an LLM replacement path.

## Measurement validity

| Check | Result |
| --- | ---: |
| Required cells | 32/32 |
| Performance logs | 96/96 |
| Cloud Run revisions | 1 |
| Extractor versions | 1 |
| Degraded calculations | 0/96 |
| Determinism groups | 32/32 exact |
| Minimum repeat count | 3 |
| Holdout | Not used |
| Independent adjudication | Not performed |

The run is valid for bottleneck discovery. It is not valid for promotion,
threshold relaxation, or production precision claims.

## Improvement history

The historical runs used different cell counts, so the table shows direction,
not a strict controlled A/B comparison.

| Measurement | Current/own span detected | Expected code top-1 | Top-5 | Family identified | Shadow joint |
| --- | ---: | ---: | ---: | ---: | ---: |
| 00190, before normalization fix | 41.2% | 11.8% | 14.7% | 0% | 0% |
| 00191, threshold-only change | 41.2% | 11.8% | 14.7% | 0% | 0% |
| 00192, runtime/normalization fix | 96.7% | 33.3% | 43.3% | 0% | 6.7% |
| 00193, WX1 v2/WX3 v3 | 95.5% | 40.9% | 54.5% | 0% | 4.5% |
| 00196, family-aware linker | 95.5% | 39.8% | 55.7% | 29.5% | 10.2% |

What worked:

- Normalization and offset-contract alignment fixed the largest span recall
  failure.
- WX1 v2 retained high recall and improved exact boundary matching.
- The linker improved top-1/top-5 retrieval substantially.
- Family-aware linking converted some code-level ambiguity into an explicit,
  reviewable `family_only` result.
- The trace now exposes the actual gate blockers instead of collapsing them
  into a generic failure.

What did not happen:

- `family_only` intentionally does not create a code or points.
- Context coverage remains low.
- No span-bearing line became routable.
- Shadow mode cannot reduce OpenAI calls.

The recent work was therefore not ineffective. Much of it repaired
observability, safety, and the former span bottleneck. It did not yet remove the
new bottlenecks exposed afterward.

## Accuracy funnel

For the 88 expected current/own spans:

| Stage | Remaining | Rate |
| --- | ---: | ---: |
| Expected current/own spans | 88 | 100% |
| Span detected | 84 | 95.5% |
| Expected code in linker top-5 | 49 | 55.7% |
| Expected code at top-1 | 35 | 39.8% |
| Shadow joint eligible | 9 | 10.2% |
| Shadow billable inclusion | 3 | 3.4% |
| Span-bearing line delegated | 0/62 lines | 0% |

All nine joint-eligible spans had the expected code at top-1, so the nine are
not false top-candidate successes in this machine precheck. This still is not
independent clinical adjudication.

The strict lane is much further from promotion:

- strict joint eligible: 1/88
- strict billable inclusion: 0/88
- strict safe exclusion: 0/25

## Root bottleneck 1: deterministic cue scope

This is the highest-priority finding because it is a deterministic contract
problem, not a model-quality problem.

`isPastOrExternalClinicalServiceContext` currently treats the bare token
`院外` as external/past context. As a result, a correct current action such as:

```text
院外処方箋を交付した
```

is marked `pastOrExternal`. `determineWhiteboxVisitFacts` then treats the line
as unsafe, and `predicateContextForLine` treats its spans as excluded.

Measured impact:

- 18/32 selected cases contain `院外処方箋`.
- `classifier_predicate_disagreement_safe_downgrade` occurred on 18 expected
  current/own spans.
- 19/32 measurement cases had ambiguous visit facts and required full LLM
  fallback.
- 45/88 current/own expected spans were on a line matching the broad
  past/external cue. Some are genuinely mixed past/current lines, but the count
  is dominated by `院外処方`.

A second scope issue is that cues are assigned to the entire SOAP line. A line
may contain:

```text
本日Xを実施。次回Yを予定。
```

The token `次回` marks the whole line as future/order-only, including X.
Nineteen current/own spans were on a line containing a future cue.

This explains why context improvements alone did not translate into routing:
the deterministic predicate can override or conflict with an otherwise useful
classifier result.

## Root bottleneck 2: task decomposition in the linker

The linker is being asked to infer some codes that cannot be selected from the
span text alone.

Current/own retrieval outcomes:

| Outcome | Count |
| --- | ---: |
| Exact expected code top-1 | 35 |
| Expected code in positions 2-5 | 14 |
| Retrieval miss | 26 |
| Underspecified family | 6 |
| Span not detected | 4 |
| Boundary/alias gap | 3 |

Of the 26 retrieval misses, 18 are the same phrase: `院外処方箋`.
The expected code is a specific prescription-fee code, but the exact code can
depend on visit-level facts such as prescription type and item count. This is
not primarily an embedding problem.

If this repeated structural class is removed only for diagnosis, linker top-5
coverage on the remaining current/own spans is 49/70 = 70.0%, rather than
49/88 = 55.7%. That is still insufficient, but it changes the diagnosis:

- the largest repeated miss needs a deterministic prescription-fee resolver;
- the remaining misses need linker/alias improvements.

The family redesign worked as designed:

- family identified: 26/88 in shadow
- exact code was deliberately not fabricated
- `jointEligible` remained false for family-only results

The missing next layer is a structured resolver that selects a family member
using orders, quantities, product identifiers, encounter facts, and facility
settings. Relaxing the family gate would create incorrect codes and points.

## Root bottleneck 3: context abstention

Among the 88 current/own spans:

- context-blocked: 56
- linker-blocked: 54
- blocked by both: 31
- blocked by neither: 9

This overlap is why fixing only one lane produces a small final change.

Uncertain context axes for current/own spans:

| Axis | Uncertain spans |
| --- | ---: |
| temporalRelation | 39 |
| actionStatus | 32 |
| sourceOrigin | 22 |
| standingStatus | 17 |
| providerOwnership | 4 |

WX3 development calibration confirms the same pattern:

| Axis | Coverage | Macro F1 | Abstain threshold |
| --- | ---: | ---: | ---: |
| temporalRelation | 39.6% | 0.268 | 0.9853 |
| sourceOrigin | 54.2% | 0.276 | 0.9938 |
| actionStatus | 70.5% | 0.318 | 0.9555 |
| standingStatus | 82.0% | 0.400 | 0.9209 |
| providerOwnership | 90.7% | 0.713 | 0.9674 |

The classifier is optimized to abstain rather than create dangerous false
positives. That is the correct safety direction, but its current coverage is
too low for routing. Globally lowering thresholds would trade visible
abstention for silent overbilling risk and is not supported by this dataset.

## Root bottleneck 4: line-level all-or-nothing routing

Routing is performed per line, not per independently resolved span.
`aggregateLineContext` assigns the entire line to the LLM when any span has
role `llm`.

The 32 measurement cases contained:

- 128 total lines
- 62 span-bearing lines
- 0 span-bearing lines delegated
- 43 span-bearing lines blocked by `llm_owns_whole_line`
- 19 span-bearing lines blocked by `visit_facts_sensitive_change`

The reported general routable-line ratio of about 50.8% is therefore not a
useful success metric: those delegated lines are irrelevant or no-span lines.
The metric that matters is `spanBearingRoutableLineRatio`, which is 0%.

This all-or-nothing rule is safe, but line granularity is too coarse for SOAP
text containing multiple sentences and mixed temporal roles.

## Remaining span work

Span detection is substantially improved:

- current/own recall: 95.5%
- exact boundaries: 85.1%
- overlapping detections: 94.7%

The four current/own misses were:

- `精神療法`
- `筋注`
- `HOT`
- `採血`

These should be addressed, but another broad WX1 retraining cycle is not the
highest-return next task. Span work is now residual compared with context,
linking, and routing granularity.

## Latency bottleneck

### End-to-end

For the 32 independent measurement calculations:

| Metric | p50 | p95 | Mean |
| --- | ---: | ---: | ---: |
| API calculation total | 14.6 s | 18.6 s | 14.2 s |
| OpenAI provider | 8.8 s | 12.0 s | 8.7 s |
| White-box three lanes | 1.88 s | 2.77 s | 1.92 s |
| Python calculator | 32 ms | 61 ms | 33 ms |
| Master lookup | 974 ms | 3.01 s | 953 ms |

Across all 96 calculations:

- total p50: 14.0 s
- total p95: 22.5 s
- OpenAI share of summed duration: 62.6%
- white-box share of summed duration: 13.4%
- correlation of total duration with OpenAI duration: 0.961
- correlation of total duration with white-box duration: 0.320

`prepare` was the reported bottleneck stage in 96/96 logs. Patient-history
loading and Python calculation were small in this workload. The earlier ideas
of DB parallelization or Python connection reuse are not the leading
opportunity for this path.

Prompt caching is already working:

- cache hit: 32/32 measurement cases
- weighted cached-input ratio: 83.5%

It reduces input-token work but does not remove the OpenAI provider latency.

### White-box lanes

| Lane | p50 | p95 |
| --- | ---: | ---: |
| Span detector | 674 ms | 712 ms |
| Linker | 533 ms | 903 ms |
| Context classifier | 660 ms | 1.20 s |
| Combined | 1.86 s | 2.77 s |

The promotion policy requires combined white-box p95 <= 500 ms. The current
2.77 seconds is about 5.5 times the limit.

The implementation invokes span detection first, then the linker, then the
context classifier. Linker and context both require spans, but are currently
awaited sequentially. Even ideal post-span parallelization would not by itself
meet the 500 ms target; model/runtime optimization is also required.

White-box duration strongly scales with detected span count. A simple
descriptive fit on these 32 measurements is about 873 ms fixed cost plus
266 ms per detected span. This is observational, not a causal benchmark, but
it supports batching and per-request overhead as optimization targets.

## Why prior improvements did not appear to work

1. The bottleneck moved after each successful repair.
   Runtime/OOM, span offsets, linking, and context are separate gates.
2. The final decision is an AND gate.
   High span recall does not compensate for low linker or context coverage.
3. Family handling improved honesty, not automatic billing.
   It intentionally exposes ambiguity without selecting a code.
4. The input contract is coarser than the decision scope.
   Sentence- and clause-level facts are currently represented by line-level
   cues.
5. A frequent contextual concept is sent to the wrong component.
   Prescription-fee selection is being treated as lexical retrieval.
6. Shadow mode cannot improve latency.
   It runs all three local lanes and still runs the complete OpenAI path.
7. Three repeats prove stability, not generalization.
   There is still only one unique diagnostic case per cell.

## Recommended order

### P0: repair deterministic scope before more model training

1. Exclude `院外処方` from the generic external-provider cue.
2. Split cue evaluation to sentence/clause scope and bind each cue to the
   span it governs.
3. Add counterexamples for:
   - current `院外処方箋を交付`
   - genuine `他院で処方`
   - `前回X。本日はYを実施`
   - `本日Xを実施。次回Yを予定`
4. Keep fail-closed behavior when scope remains ambiguous.

### P0: separate contextual code resolution from semantic retrieval

1. Resolve prescription-fee families from structured visit/order facts.
2. Use the linker to retrieve a family or candidate set, not to invent
   missing quantity/type qualifiers.
3. Keep `family_only` non-billable until a deterministic resolver or human
   selection supplies the missing discriminator.

### P1: improve context after the input contract is corrected

1. Rebuild the WX3 training/evaluation view with clause-scoped inputs.
2. Focus on temporalRelation, actionStatus, and sourceOrigin.
3. Recalibrate on independent examples; do not lower thresholds using this
   32-case diagnostic run.
4. Preserve dangerous-false-positive gates.

### P1: improve the remaining linker misses

Use a hybrid candidate union:

- exact normalized aliases,
- medical abbreviation aliases,
- character n-gram/BM25 retrieval,
- embedding retrieval,
- category-constrained reranking.

Evaluate the remaining misses separately from contextual families such as
prescription fees.

### P1: remeasure routing at the correct granularity

After the P0 fixes, rerun the same 32-cell diagnostic and require:

- visit-facts ambiguity to decrease for the identified false-positive cases;
- non-zero span-bearing routable lines;
- lower context blocker counts;
- no new dangerous inclusion;
- unchanged determinism and no degraded runs.

Then add multiple unique cases per cell. Do not count identical repeats as
calibration samples.

### P2: optimize white-box latency

After correctness is stable:

1. batch model inputs;
2. remove repeated serialization/process overhead;
3. run linker and context concurrently if the worker architecture permits;
4. profile ONNX session/thread configuration;
5. evaluate validated INT8 artifacts;
6. optimize or cache cold master lookup.

Every runtime optimization must retain artifact determinism and the accuracy
gates.

## Local implementation after this measurement

Implemented locally on 2026-07-28:

- corrected external-provider detection so `院外処方`, `院外で処方`, and
  `処方は院外` remain this clinic's prescription-delivery facts;
- moved deterministic temporal, execution, and provider cues to a shared
  contract;
- split mixed chart lines into evidence clauses and classified each span using
  only its governing clause;
- rejected linker boundary expansion when it crosses an evidence clause;
- changed routing from line-level all-or-nothing to clause-level mixed routing,
  so only unresolved clauses are sent to the LLM in route mode;
- resolved current-visit outside/in-house and generic-name prescription facts
  through structured visit facts instead of generic master retrieval;
- merged deterministic and LLM visit facts conservatively: one known value
  survives an unknown value, while conflicting values become `unknown`;
- added clause, partial-routing, structured-fact, and linker-bypass metrics
  without adding raw clinical text to the runtime trace.

Local verification:

- `@halunasu/fee-contracts`: 22/22 passed
- `@halunasu/fee-api`: 342/342 passed
- white-box JavaScript runtime suite: 53/53 passed
- white-box Python runtime suite: 35 passed, 7 skipped

This does not change the interpretation of the preceding STG result. The
deployed revision measured above predates these changes. A new STG deployment
and a same-matrix remeasurement are required to establish the actual change in
partial routing, context blockers, OpenAI line ratio, latency, and safe
inclusion. The linker and WX3 model can remain residual bottlenecks after the
contract and routing errors are removed.

## Final answer

The former bottleneck was improved:

- runtime availability: fixed
- deterministic repeatability: fixed
- span detection: largely fixed
- linker family visibility: improved

The overall bottleneck is not yet solved:

- useful span-bearing routing: 0%
- OpenAI replacement: 0%
- strict billable inclusion: 0%
- white-box p95 target: failed

The most important new finding is that the next step should not be another
generic model-training cycle. First repair the deterministic context scope and
move prescription-fee selection out of the generic semantic linker. Only then
will another context/linker measurement reveal the remaining model-quality
bottleneck instead of repeatedly measuring contract errors.
