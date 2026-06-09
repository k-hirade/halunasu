# Fee calculation quality hardening

Date: 2026-06-06

## Goal

Improve fee calculation behavior for ordinary single-visit chart text without hard-coding for a specific test SOAP. The product should treat the chart text as the source of truth, keep patient-history decisions deterministic, and surface unresolved billable facts as reviewable candidates instead of silently dropping or duplicating them.

## Scope

This document covers seven recurring issues:

1. Prevent stale previous input or extracted results from being reused after the chart text changes.
2. Decide initial/revisit fee from patient history, not from LLM phrasing.
3. Separate performed, planned, considered, instruction-only, and history events before billing.
4. Resolve master naming variation through LLM event `search_queries` and conservative master search.
5. Deduplicate medication warnings by canonical medication name.
6. Keep unresolved billable facts as review candidates.
7. Group review output by target and hide low-value/internal messages.

Multi-day SOAP documents are out of scope for this phase. If a chart contains multiple dates/visits, it should later be split before calculation.

## Current Findings

### 1. Stale session input

ASIS:

- Fee sessions are persistent documents. They store `clinicalText`, `diagnoses`, `orders`, `calculationOptions`, and the last calculation result.
- The detail screen saves the whole form before calculation. That payload includes `diagnoses` and `orders`.
- The calculate endpoint is then called with an empty body, so the API calculates from the saved session state.
- Auto diagnoses are replaced only when a new non-empty extraction result is produced. If extraction returns no diagnoses, old auto diagnoses can remain.
- Manual order rows are intentionally preserved, but the UI does not clearly distinguish stale manual rows from chart-derived placeholder rows when a user pastes a completely different chart into the same session.

TOBE:

- When `clinicalText` changes, previous auto-derived diagnosis values must not be carried forward.
- If the current extraction returns no diagnoses, stale `clinical_auto` diagnoses should be cleared rather than retained.
- Auto placeholder orders should not be persisted as manual orders.
- Manual coded orders may remain, but they must be treated as explicit user input only.

Intent:

The calculation must never combine a new chart with old auto-extracted diagnoses or placeholder orders.

### 2. Initial/revisit decision

ASIS:

- LLM/rule extraction can provide `outpatient_basic`.
- Patient history can infer initial/revisit, but current logic preserves an LLM/rule value when it conflicts with history and only adds a warning.

TOBE:

- Patient history is authoritative for default initial/revisit:
  - prior fee session for the same patient and earlier/current date -> revisit candidate
  - no prior fee session -> initial candidate
- LLM/rule visit type is advisory only and may create a review warning on conflict.

Intent:

Initial/revisit is a longitudinal administrative decision. It should not vary based on wording inside a chart note.

### 3. Event status separation

ASIS:

- Structured events support statuses such as `performed`, `prescribed`, `administered`, `planned`, `history`, and `instruction_only`.
- Only billable statuses enter calculation, but some low-value planned/instruction-only warnings still leak into review output.
- Rule-based extraction still relies on sentence-level patterns and can over-detect planned or instruction-only content.

TOBE:

- Only `performed`, `prescribed`, and `administered` events are calculation candidates.
- Planned, considered, history, and instruction-only events are either filtered or shown once as review-only context when clinically actionable.
- Low-value review strings like generic "future plan" or "instruction_only" must not be repeated.

Intent:

The user should review actual billing ambiguity, not every piece of clinical prose.

### 4. Master matching

ASIS:

- Procedure matching mixed two concepts: LLM event extraction and hardcoded clinical hints.
- Fixed hints for individual labs, disease-management fees, and specialty-specific procedures made some trial SOAPs look better, but did not generalize to new specialties.
- Search fallback is intentionally high-confidence, so many synonym variants remain unresolved unless the extracted event carries good search terms.

TOBE:

- Remove fixed clinical hint lists from calculation logic.
- Use LLM-extracted medical events plus `search_queries` as the primary bridge to the fee master.
- Keep code/point assignment grounded in the master data; do not let the LLM invent billing codes or points.
- Unresolved events should remain visible as review items instead of being silently dropped.

Intent:

Improve recall by better clinical-event extraction while avoiding one-off SOAP patches and unsafe low-confidence code assignment.

### 5. Medication warning deduplication

ASIS:

- Medication names are normalized in some paths, but duplicate warnings can still appear when LLM and deterministic extraction produce dose-bearing and plain-name variants of the same drug.

TOBE:

- Normalize medication names before warning deduplication.
- Deduplicate by target medication and reason category.

Intent:

A user should see one actionable warning per medication problem.

### 6. Unresolved billable facts

ASIS:

- Unsupported or unresolved events can become warnings, but the wording is inconsistent and can be mixed with internal English messages.
- Some unresolved items are effectively invisible in the line table.

TOBE:

- If a billable-looking fact is detected but cannot be safely coded, keep it as one review item with a clear target and reason.
- Do not fabricate points for unresolved items.

Intent:

Avoid silent underbilling while keeping final point calculation conservative.

### 7. Review grouping and language

ASIS:

- Review items are generated from calculation warnings and review-required line items.
- Titles are often generic, and Python/engine messages can leak into the UI.

TOBE:

- Review messages should be normalized to Japanese business language.
- Duplicate warnings and line-item review reasons should collapse when they refer to the same target and reason.
- Internal source labels and English engine phrases should be hidden.

Intent:

Reduce review volume and make each item actionable for medical office users.

## Implementation Direction

1. Add a server-side guard that resets stale auto diagnoses when the chart text hash changes or current extraction returns no diagnoses.
2. Make history-based initial/revisit the default calculation option, with conflict warnings instead of preserving LLM/rule output.
3. Strengthen review warning normalization and deduplication for medications, imaging, facility standards, visit history, and internal engine messages.
4. Use LLM-extracted event `search_queries` as the bridge to master search; do not add hardcoded clinical hint tables.
5. Keep unresolved billable facts as warnings, not silent drops.
6. Add focused tests for stale-auto clearing, history overriding LLM visit type, warning dedupe, and review output normalization.

## Implemented in this pass

- `services/fee-api/src/server.js`
  - `PATCH /v1/fee/sessions/:id` compares the saved chart hash with the incoming chart hash.
  - When the chart text changes, `clinical_auto` diagnoses are cleared before save, even if the client accidentally sends stale diagnosis rows.
  - During calculation, if the current extraction produces no diagnoses, old `clinical_auto` diagnoses are cleared instead of reused.
  - Calculator warnings are normalized/deduplicated before being stored and returned to the UI.
- `apps/fee-web/components/fee-workspace.js`
  - The detail screen now tracks whether order rows were explicitly touched after load.
  - If a user pastes a different chart into an existing session and has not edited order rows, saved order rows are ignored and chart-derived candidates are rebuilt.
  - Review display hides coverage/internal labels and keeps code + business category only.
- `services/fee-api/src/clinical-calculation-input.js`
  - Patient history overrides LLM/rule visit type unless the user explicitly supplied manual calculation options.
  - Medication and excluded-event normalization was expanded for recurring chronic disease examples.
- `services/fee-api/src/clinical-master-resolver.js`
  - Removed. Fixed clinical hint lists are no longer part of calculation.
- `packages/medical-core/src/fee/openai-fee-clinical-facts.js`
  - Clinical extraction now carries event status, section, date relation, provider ownership, and master-search queries.
- `packages/fee-core/src/index.js`
  - Warning review items now receive target-specific titles, for example `施設基準の確認`, `検査判断料の確認`, and `{薬剤名}の確認`.

## Regression checks added

- Changing chart text with `clinical_auto` diagnoses clears stale diagnoses.
- Patient history overrides a structured/LLM `initial` visit inference and uses `revisit`.
- Internal calculator warnings are Japanese-normalized and deduplicated.
- Fee-core review warning titles are no longer fixed to a generic warning label.

## Non-goals

- Do not make LLM decide official billing codes or points.
- Do not force exact ORCA legacy total points from long multi-day records in this phase.
- Do not add phrase-specific patches that only match one provided SOAP sample.
