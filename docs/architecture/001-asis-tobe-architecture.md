# ASIS / TOBE Architecture

Status: draft  
Date: 2026-05-27  
Owner: Halunasu platform

## Decision Summary

Because there are no current customers, we can prioritize the future architecture over backward compatibility.

The target is a new monorepo and new GCP environment:

- New repository: `halunasu`
- New core GCP projects: `medical-core-stg` and `medical-core-497610`
- Shared Platform/Core data layer
- Product services remain separated by responsibility
- Firestore remains the primary operational store for the initial phase
- Cloud Storage holds large clinical artifacts
- LP never writes directly to the database

The most important boundary is:

- Shared: organization, facility, department, member, auth, billing, patient index
- Product-owned: charting encounters, audio, transcripts, SOAP, fee calculation sessions, extracted facts, receipt artifacts, referral drafts and PDFs

## ASIS: Repository And Runtime Shape

The current system is split across three repositories. `medical` already owns most platform-like concerns, while `medical-fee-calculation` has a separate tenant/auth/runtime path.

```mermaid
flowchart TB
  subgraph R1["medical repo"]
    MW["apps/web<br/>Next.js app"]
    MG["services/gateway<br/>Charting realtime API"]
    MB["services/billing<br/>Signup / Stripe / onboarding"]
    MF["services/finalize<br/>Final transcript / SOAP worker"]
    MC["packages/core<br/>Firestore store / auth helpers"]
    MCON["packages/contracts<br/>Session contracts"]
  end

  subgraph R2["medical-fee-calculation repo"]
    FW["apps/web<br/>Vite fee UI"]
    FA["apps/api<br/>FastAPI"]
    FE["src/medical_fee_calculation<br/>Calculation engine / masters"]
    FOA["Operator auth<br/>OPERATOR_ACCOUNTS_JSON"]
  end

  subgraph R3["medical-lp repo"]
    LP["Static LP<br/>HTML / CSS / Netlify"]
  end

  LP -->|"CTA to /contact-signup"| MW
  MW --> MG
  MW --> MB
  MG --> MC
  MF --> MC
  MB --> MC
  FW -->|"Netlify /api proxy"| FA
  FA --> FE
  FA --> FOA
```

## ASIS: GCP And Hosting

The current staging/runtime topology is split by product history.

```mermaid
flowchart LR
  subgraph Netlify["Netlify"]
    N1["medical web"]
    N2["medical-fee web"]
    N3["medical-lp"]
  end

  subgraph GCPMedical["GCP: medical-stg-493105 / historical medical-492407"]
    CRG["Cloud Run<br/>medical-gateway"]
    CRB["Cloud Run<br/>medical-billing"]
    CRF["Cloud Run<br/>medical-finalize"]
    FSM["Firestore<br/>organizations / members / encounters"]
    GCSM["GCS<br/>audio / artifacts"]
    SM1["Secret Manager"]
  end

  subgraph GCPFee["GCP: medical-fee-calculation-stg"]
    CRFA["Cloud Run<br/>medical-fee-api-stg"]
    FSF["Firestore<br/>staging_chart_bundles / jobs / review_items"]
    GCSF["GCS<br/>fee artifacts / masters"]
    SM2["Secret Manager<br/>operator accounts / OpenAI"]
  end

  N1 --> CRG
  N1 --> CRB
  CRG --> FSM
  CRB --> FSM
  CRF --> FSM
  CRG --> GCSM
  CRF --> GCSM
  CRG --> SM1
  CRB --> SM1

  N2 --> CRFA
  CRFA --> FSF
  CRFA --> GCSF
  CRFA --> SM2

  N3 --> N1
```

## ASIS: Data Ownership Problems

```mermaid
flowchart TB
  subgraph MedicalData["medical data"]
    ORG["organizations<br/>source-like"]
    MEM["members"]
    LOGIN["login_identities"]
    BILL["billing / access"]
    ENC["encounters"]
    PS1["patientSnapshot only<br/>no patient master"]
  end

  subgraph FeeData["medical-fee-calculation data"]
    TENANT["tenant_id"]
    TMEM["tenant_members"]
    OAUTH["operator accounts secret"]
    BUNDLE["chart_bundles"]
    PFR["patient_ref"]
    PIN["embedded patient input"]
  end

  subgraph LPData["medical-lp"]
    CTA["CTA links only<br/>no local form persistence"]
  end

  ORG -.not mapped.-> TENANT
  MEM -.duplicated concept.-> TMEM
  LOGIN -.not reused.-> OAUTH
  PS1 -.no canonical patientId.-> PFR
  CTA --> BILL
```

Current issues:

- Organization and tenant identity are not unified.
- Auth/session implementation is duplicated by product.
- Patient master does not exist.
- Fee calculation stores `patient_ref` and optional embedded patient input, but not a shared `patientId`.
- LP routes signup into `medical`, so signup is already centralized in behavior but not cleanly named as Platform.
- Future referral letter creation would need patient, facility, department, doctor, and document data. Adding it to the ASIS shape would create another partial platform.

## TOBE: Monorepo Shape

The target repository keeps product services separate while sharing contracts, auth client, UI primitives, and schema definitions.

```mermaid
flowchart TB
  subgraph Repo["halunasu monorepo"]
    subgraph Apps["apps"]
      LP2["lp"]
      CW["charting-web"]
      FEEW["fee-web"]
      REFWEB["referral-web"]
    end

    subgraph Services["services"]
      PA["platform-api"]
      CA["charting-api"]
      CF["charting-finalize"]
      FA2["fee-api"]
      RA["referral-api"]
    end

    subgraph Packages["packages"]
      PC["platform-contracts"]
      AC["auth-client"]
      UI["web-ui"]
      FSCH["firestore-schema"]
    end

    subgraph Python["python"]
      MFC["medical_fee_calculation"]
    end
  end

  LP2 --> PA
  CW --> AC
  FEEW --> AC
  REFWEB --> AC

  AC --> PA
  CW --> CA
  FEEW --> FA2
  REFWEB --> RA

  PA --> PC
  CA --> PC
  FA2 --> PC
  RA --> PC
  PA --> FSCH
  CA --> FSCH
  FA2 --> FSCH
  RA --> FSCH
  FA2 --> MFC
```

## TOBE: GCP Project Topology

Create new projects instead of carrying historical project boundaries forward.

```mermaid
flowchart LR
  subgraph DNS["Cloudflare DNS"]
    D1["halunasu.com"]
    D2["app-stg.halunasu.com"]
    D3["fee-stg.halunasu.com"]
    D4["referral-stg.halunasu.com"]
    D5["*-api-stg.halunasu.com"]
  end

  subgraph Netlify2["Netlify"]
    NLP["lp"]
    NCW["charting-web"]
    NFW["fee-web"]
    NRW["referral-web"]
  end

  subgraph GCPStg["GCP: medical-core-stg"]
    CPA["Cloud Run<br/>platform-api"]
    CCA["Cloud Run<br/>charting-api"]
    CCF["Cloud Run<br/>charting-finalize"]
    CFA["Cloud Run<br/>fee-api"]
    CRA["Cloud Run<br/>referral-api"]
    CT["Cloud Tasks"]
    FS["Firestore<br/>platform + product metadata"]
    GCS["Cloud Storage<br/>product artifact buckets"]
    SEC["Secret Manager"]
    AR["Artifact Registry"]
    LOG["Cloud Logging"]
  end

  D1 --> NLP
  D2 --> NCW
  D3 --> NFW
  D4 --> NRW
  D5 --> CPA
  D5 --> CCA
  D5 --> CFA
  D5 --> CRA

  NLP --> CPA
  NCW --> CCA
  NFW --> CFA
  NRW --> CRA

  CPA --> FS
  CCA --> FS
  CFA --> FS
  CRA --> FS

  CCA --> GCS
  CCF --> GCS
  CFA --> GCS
  CRA --> GCS

  CCA --> CT
  CFA --> CT
  CRA --> CT
  CT --> CCF

  CPA --> SEC
  CCA --> SEC
  CFA --> SEC
  CRA --> SEC
  CPA --> LOG
  CCA --> LOG
  CCF --> LOG
  CFA --> LOG
  CRA --> LOG
```

Production mirrors staging:

```text
medical-core-stg    -> staging, preview, synthetic/non-production PHI policy
medical-core-497610 -> production/core, real PHI, stricter IAM, backup, retention, audit
```

Initial cost controls:

- Cloud Run request-based billing
- `min-instances=0` for staging
- `max-instances=1` for staging
- Firestore Native mode
- No GKE, VM, Cloud SQL, NAT, or external Load Balancer in the initial phase
- Cloud Storage lifecycle policies from the start

## TOBE: Shared Platform DB Boundary

```mermaid
flowchart TB
  subgraph Platform["Shared Platform/Core collections"]
    ORG2["organizations/{orgId}"]
    OC2["organization_codes/{organizationCode}"]
    LI2["login_identities/{organizationCode:loginId}"]
    MEM2["organizations/{orgId}/members/{memberId}"]
    FAC2["organizations/{orgId}/facilities/{facilityId}"]
    DEP2["organizations/{orgId}/departments/{departmentId}"]
    PAT2["organizations/{orgId}/patients/{patientId}"]
    ALIAS2["organizations/{orgId}/patients/{patientId}/aliases/{aliasId}"]
    ENT2["organizations/{orgId}/product_entitlements/{productId}"]
    AUD2["organizations/{orgId}/audit_events/{eventId}"]
  end

  subgraph Charting["Charting product data"]
    CENC["organizations/{orgId}/charting_encounters/{encounterId}"]
    CTURN["turns / transcript refs"]
    SOAP["soap_versions"]
    AUDIO["GCS audio / transcript artifacts"]
  end

  subgraph Fee["Fee calculation product data"]
    FSES["organizations/{orgId}/fee_sessions/{feeSessionId}"]
    JOBS["jobs / extractions / review_items"]
    REC["receipt draft metadata"]
    FART["GCS calculation artifacts / masters"]
  end

  subgraph Referral["Referral product data"]
    REF["organizations/{orgId}/referrals/{referralId}"]
    RDRAFT["drafts / workflow status"]
    RPDF["GCS PDFs / attachments"]
    RTPL["recipient templates"]
  end

  PAT2 -->|"patientId + snapshot"| CENC
  PAT2 -->|"patientId + patient_ref + snapshot"| FSES
  PAT2 -->|"patientId + snapshot"| REF
  FAC2 --> CENC
  FAC2 --> FSES
  FAC2 --> REF
  DEP2 --> CENC
  DEP2 --> FSES
  DEP2 --> REF
```

Rule:

- Product records store `orgId`, `patientId`, and a product-local snapshot.
- Product services do not read sibling product records directly.
- Cross-product reuse, such as turning a SOAP note into a referral draft, must be an explicit user action through an API, not an implicit database dependency.

## TOBE: Firestore Entity Relationship

```mermaid
erDiagram
  ORGANIZATION ||--o{ MEMBER : has
  ORGANIZATION ||--o{ FACILITY : has
  ORGANIZATION ||--o{ DEPARTMENT : has
  ORGANIZATION ||--o{ PATIENT : has
  ORGANIZATION ||--o{ PRODUCT_ENTITLEMENT : grants
  ORGANIZATION ||--o{ AUDIT_EVENT : records

  FACILITY ||--o{ DEPARTMENT : contains
  PATIENT ||--o{ PATIENT_ALIAS : has

  PATIENT ||--o{ CHARTING_ENCOUNTER : referenced_by
  PATIENT ||--o{ FEE_SESSION : referenced_by
  PATIENT ||--o{ REFERRAL : referenced_by

  FACILITY ||--o{ CHARTING_ENCOUNTER : used_by
  FACILITY ||--o{ FEE_SESSION : used_by
  FACILITY ||--o{ REFERRAL : used_by

  CHARTING_ENCOUNTER ||--o{ SOAP_VERSION : has
  FEE_SESSION ||--o{ REVIEW_ITEM : has
  REFERRAL ||--o{ REFERRAL_DRAFT : has
```

## TOBE: Patient Snapshot Pattern

The patient master is shared, but product records remain historically reproducible.

```mermaid
sequenceDiagram
  participant User
  participant Web as Product Web
  participant Platform as platform-api
  participant Product as product-api
  participant Store as Firestore

  User->>Web: Select or create patient
  Web->>Platform: GET/POST /patients
  Platform->>Store: Read/write organizations/{orgId}/patients/{patientId}
  Platform-->>Web: patientId + current patient fields
  Web->>Product: Create encounter / fee session / referral
  Product->>Store: Save product record with patientId
  Product->>Store: Save patientSnapshot copied at creation time
```

Example product record shape:

```json
{
  "orgId": "org_123",
  "patientId": "pat_456",
  "patientSnapshot": {
    "displayName": "山田 太郎",
    "displayNameKana": "ヤマダ タロウ",
    "birthDate": "1970-01-01",
    "sex": "male"
  }
}
```

## TOBE: Authentication And Authorization

`platform-api` owns login, session, MFA, CSRF, members, product entitlements, and roles.

```mermaid
sequenceDiagram
  participant Browser
  participant Platform as platform-api
  participant Product as charting-api / fee-api / referral-api
  participant Store as Firestore

  Browser->>Platform: POST /auth/login<br/>organizationCode + loginId + password
  Platform->>Store: Verify login_identity and member
  Platform-->>Browser: MFA challenge if required
  Browser->>Platform: POST /auth/mfa/verify
  Platform-->>Browser: Set httpOnly session cookie + CSRF cookie
  Browser->>Product: Product API request with cookie + CSRF
  Product->>Platform: Verify session or shared signed session contract
  Product->>Store: Check orgId, memberId, product role
  Product-->>Browser: Product response
```

Role model:

```text
globalRoles:
  - org_admin
  - doctor
  - nurse
  - billing_admin

productRoles:
  charting:
    - admin
    - doctor
    - recorder
  fee:
    - admin
    - reviewer
    - doctor
  referral:
    - admin
    - doctor
```

## TOBE: Signup And LP

LP remains a static entry point. Signup belongs to Platform.

```mermaid
flowchart LR
  Visitor["Visitor"]
  LP3["apps/lp<br/>static marketing site"]
  Signup["platform-api<br/>/signup"]
  Verify["Email verification"]
  Org["Create organization"]
  Admin["Create admin member"]
  Billing["Create billing/access state"]
  Login["Redirect to product login"]

  Visitor --> LP3
  LP3 --> Signup
  Signup --> Verify
  Verify --> Org
  Org --> Admin
  Admin --> Billing
  Billing --> Login
```

No LP database writes. No LP-specific signup backend.

## TOBE: Product Data Flow

```mermaid
flowchart TB
  subgraph PlatformAPI["platform-api"]
    AUTH["auth/session"]
    ORGM["org/facility/department"]
    PATM["patient index"]
    ENT["product entitlements"]
  end

  subgraph ChartingAPI["charting-api"]
    LIVE["realtime STT"]
    ENCC["encounter command"]
    SNAP1["patientSnapshot"]
  end

  subgraph FeeAPI["fee-api"]
    INTAKE["EMR text intake"]
    EXTRACT["LLM fact extraction"]
    CALC["fee calculation engine"]
    SNAP2["patientSnapshot"]
  end

  subgraph ReferralAPI["referral-api"]
    DRAFT["referral draft"]
    PDF["PDF generation"]
    SNAP3["patientSnapshot"]
  end

  PlatformAPI --> ChartingAPI
  PlatformAPI --> FeeAPI
  PlatformAPI --> ReferralAPI

  PATM --> SNAP1
  PATM --> SNAP2
  PATM --> SNAP3

  ChartingAPI -->|"audio/transcript artifacts"| GCS1["GCS charting bucket"]
  FeeAPI -->|"receipt artifacts / masters"| GCS2["GCS fee bucket"]
  ReferralAPI -->|"PDF / attachments"| GCS3["GCS referral bucket"]
```

## Migration Plan

With no customers, migration can be a clean cutover rather than a compatibility migration.

```mermaid
gantt
  title Halunasu Re-architecture Plan
  dateFormat  YYYY-MM-DD
  axisFormat  %m/%d

  section Foundation
  Architecture docs and ADRs           :a1, 2026-05-27, 3d
  Monorepo skeleton                    :a2, after a1, 2d
  medical-core-stg via Terraform       :a3, after a2, 4d

  section Platform
  Platform Firestore schema            :b1, after a3, 4d
  Auth/session/MFA/CSRF                :b2, after b1, 5d
  Organization/facility/patient APIs   :b3, after b2, 5d

  section Product Migration
  Charting migration                   :c1, after b3, 7d
  Fee calculation migration            :c2, after b3, 8d
  LP migration                         :c3, after b2, 3d

  section New Product
  Referral app foundation              :d1, after b3, 6d

  section Cutover
  New staging verification             :e1, after c2, 4d
  Stop old staging services            :e2, after e1, 2d
```

## Repository Decision

Use a new monorepo.

Reasons:

- Current customer count is zero, so migration compatibility has low value.
- Cross-product schema and auth need one source of truth.
- Referral app should not be added as a fourth independent repository.
- Python fee calculation code can remain Python while sharing deployment, contracts, docs, and infrastructure.
- Existing repositories can become migration sources and later archives.

## GCP Decision

Use the newly created core projects.

```text
medical-core-stg
medical-core-497610
```

Do not keep expanding:

- `medical-stg-493105`
- `medical-492407`
- `medical-fee-calculation`
- `medical-fee-calculation-stg`

Reasons:

- Current projects encode historical boundaries.
- Fee calculation currently has its own staging project and operator auth.
- A new Platform DB is easier to reason about in a clean project.
- IAM, Secret Manager, Firestore, GCS, and Cloud Run naming can be made consistent from the start.

## Open Implementation Choices

These should be decided before code migration:

- Whether product metadata should be stored as org subcollections or top-level product collections with `orgId`.
- Whether product APIs verify sessions by calling `platform-api` or by validating a shared signed session token locally.
- Whether `platform-api` and `charting-api` start as separate Cloud Run services immediately or begin in one Node service and split later.
- Whether Cloud Run custom domains are enough for production launch or whether a Load Balancer is needed later for WAF, mTLS, or centralized routing.
- Whether patient alias matching should be exact-only at first or include fuzzy candidate generation.

## Non-goals

- Do not merge all clinical data into a single product-neutral collection.
- Do not let product services read sibling product records directly.
- Do not store large clinical text, audio, PDFs, or calculation artifacts in Firestore.
- Do not make LP responsible for signup persistence.
- Do not keep `OPERATOR_ACCOUNTS_JSON` as a production auth source.
