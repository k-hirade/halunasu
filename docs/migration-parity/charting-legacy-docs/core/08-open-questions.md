# Open Questions and Decision Log

## Open questions

## 1. Authentication detail

Open question:

- should clinicians log in with Google Workspace, email link, or another IdP?

Why it matters:

- affects onboarding, IAM, and audit identity quality

## 2. Consent and legal workflow

Open question:

- how will patient recording consent be captured and displayed?

Why it matters:

- the service records medical conversations and may require explicit operational policy

## 3. Retention policy by clinic

Open question:

- what are the final retention requirements for raw audio, transcripts, and SOAP artifacts?

Why it matters:

- changes storage lifecycle, compliance posture, and support burden

## 4. Speaker labeling strategy

Open question:

- is v1 allowed to remain `speaker=unknown`, or is a doctor/patient split required from day one?

Why it matters:

- single-device diarization quality may not be strong enough for hard guarantees

## 5. EMR export target

Open question:

- which EMR or documentation destination is the first integration target?

Why it matters:

- affects data model and output formatting

## 6. Prompt control

Open question:

- do clinics need SOAP style customization at MVP, or can one default prompt/template be used?

Why it matters:

- changes admin configuration and testing scope

## 7. Browser support floor

Open question:

- what is the minimum supported mobile browser and OS matrix?

Why it matters:

- affects audio capture implementation, especially AudioWorklet support

## 8. Pilot support model

Open question:

- who monitors alerts and retries failed sessions during pilot?

Why it matters:

- affects operational runbooks and on-call expectations

## Decision log

## Accepted decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-04-05 | Use GCP as primary cloud | explicit product direction |
| 2026-04-05 | Use Firebase + Cloud Run instead of adding Redis in phase 1 | lower fixed cost and lower ops burden |
| 2026-04-05 | Use split path architecture for live transcript and final SOAP | latency and final quality are different optimization goals |
| 2026-04-05 | Use Deepgram as primary live STT and OpenAI for fallback/finalize/SOAP | superseded on 2026-04-16 by OpenAI primary / Deepgram fallback |
| 2026-04-05 | Use smartphone audio capture and PC rendering as the core workflow | matches intended real-world use |
| 2026-04-16 | Treat `medical-stg-493105` as the canonical STG project and `medical-492407` as historical / dev | keeps deployment docs aligned with the current staging environment |
| 2026-04-16 | Keep Cloud Storage + Cloud Tasks + Cloud Run `medical-finalize` as the target finalization architecture | current inline finalization is a staging implementation step, not the desired durable architecture |
| 2026-04-16 | Maintain future `docs/core` content primarily in Japanese | reduces ambiguity for the current product and engineering workflow |
| 2026-04-16 | Use OpenAI Realtime as primary live STT and Deepgram as fallback | matches current STG runtime and keeps live/final transcription provider strategy aligned |
| 2026-04-16 | Treat `/` as the canonical session dashboard path; keep `/sessions` only as an implementation alias unless removed later | simplifies product navigation and docs |
| 2026-04-16 | Use `ハルナス` as the documentation product name | keeps product naming explicit across product and docs |
| 2026-04-16 | Defer reception workflow from MVP and keep `reception` as a future role without session permissions | avoids exposing permissions for a workflow that has no UI/API yet |

## Deferred decisions

- direct EMR integration
- multi-device recording
- multi-language support
- admin analytics dashboard
- reception visit-shell workflow
