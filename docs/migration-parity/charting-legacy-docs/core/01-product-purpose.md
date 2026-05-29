# Product Purpose

## Product name

`ハルナス` is a realtime outpatient documentation assistant.

## Problem

Outpatient physicians spend too much time turning spoken encounters into structured notes.
The current demo already proves a useful UI pattern, but it is not yet a deployable system that can be used in a real consultation room.

The main operational pain points are:

- the physician should not need to type during the consultation
- transcription must appear on the PC while the conversation is still happening
- the system must produce a usable SOAP draft immediately after the visit
- the setup must be lightweight enough to run from a smartphone and a browser

## Product vision

The product should let one physician start a session on a PC, place a smartphone near the doctor and patient, see the transcript in realtime, and receive a SOAP draft within seconds after the conversation ends.

The UI should inherit the strengths of the existing demo:

- visually clear live transcript
- center rail for extracted highlights and status
- right rail for progressive SOAP generation
- a focused, premium presentation suitable for physician-facing software

## Primary users

### Primary

- outpatient physicians

### Secondary

- nurses or medical assistants who may help launch the session
- clinic administrators who manage rollout and policy settings

## Core user outcome

At the end of each encounter, the physician should have:

- a readable transcript
- a structured SOAP draft
- enough confidence to review and copy the result into the EMR

## Product principles

### 1. Realtime first

The product must feel live. Transcript updates should arrive continuously without refresh.

### 2. Human in the loop

The product creates a draft, not an autonomous final chart. The physician remains responsible for review and approval.

### 3. Fast path and accurate path are separate

The live transcript path is optimized for speed.
The post-encounter path is optimized for final note quality.

### 4. Low operational overhead

The first production version should run on GCP with Firebase and avoid unnecessary infrastructure such as Redis unless traffic proves it is needed.

### 5. Failure should degrade safely

Raw audio should be preserved so that the final transcript and SOAP can still be produced even if the live STT stream temporarily degrades.

## In-scope for MVP

- physician starts a session on PC
- smartphone joins session by QR code or short code
- smartphone streams audio to backend
- PC shows realtime transcript without reload
- physician stops recording
- system generates SOAP draft after stop
- physician reviews the SOAP draft
- session data is persisted with auditability

## Out of scope for MVP

- direct EMR writeback
- autonomous note finalization without clinician review
- guaranteed speaker diarization from a single smartphone microphone
- multilingual support beyond Japanese
- deep billing automation
- full clinic workflow orchestration outside the encounter note flow

## Success metrics

### Experience targets

- partial transcript latency: `p50 < 700 ms`
- finalized turn latency: `p95 < 2.0 s`
- SOAP ready after stop: `p95 < 20 s`
- page reloads during session: `0`

### Reliability targets

- session completion success rate: `> 99%`
- live reconnect recovery: `< 5 s`
- raw audio preservation for completed sessions: `100%`

### Cost targets

- target variable cost per 15-minute encounter: `< $0.25`
- initial fixed platform cost for one clinic pilot: `< $200/month`

### Quality targets

- strong accuracy on clinical entities such as symptoms, duration, numeric values, medication names, and negation
- SOAP output should preserve uncertainty instead of hallucinating missing facts

## MVP release definition

The MVP is successful when a real physician can use:

1. one smartphone
2. one PC browser
3. one click to start
4. one click to stop and generate SOAP

and receive a clinically reviewable draft without manual refresh or backend operator intervention.
