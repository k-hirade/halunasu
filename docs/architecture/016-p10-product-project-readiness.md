# P10 Product Project Readiness

Status: started
Date: 2026-05-28
Cost profile: read-only validation, no new resources

## Purpose

P10 starts from the new Core/product project split:

| Boundary | Staging project | Production project | Current state |
| --- | --- | --- | --- |
| Core/Platform | `medical-core-stg` | `medical-core-497610` | active |
| Charting | `halunasu-charting-stg` | `halunasu-charting-prod` | active; billing may be linked after P10.2 |
| Fee calculation | `halunasu-fee-stg` | `halunasu-fee-prod` | active; billing may be linked after P10.2 |
| Referral | `halunasu-referral-stg` | `halunasu-referral-prod` | active; billing may be linked after P10.2 |

The goal is to prevent accidental cost growth while preparing the first production-ready path.

## First Gate

Run:

```bash
./scripts/p10_project_split_preflight.sh
```

The preflight confirms:

- Core projects are active.
- Product project shells are active.
- Product project billing state is reported.
- Old historical projects are in `DELETE_REQUESTED`.
- Product runtime service enablement is reported.

Latest run on 2026-05-28:

```text
Summary: 0 failure(s), 0 warning(s).
```

## Controlled Runtime Build

P10.2 makes all STG/PROD runtime projects usable while keeping idle cost near zero.

Runtime guardrails:

- Cloud Run `min-instances=0` for STG and PROD.
- Cloud Run `max-instances=1` initially for STG and PROD.
- No Cloud SQL, GKE, VM, NAT, static IP, or Load Balancer.
- No Cloud Scheduler.
- Secret versions are limited to required runtime secrets only.
- Backup/restore is deferred until real PHI is near.

Provisioning script:

```bash
./scripts/p10_provision_runtime_projects_low_cost.sh
P10_ALLOW_BILLING=yes ./scripts/p10_provision_runtime_projects_low_cost.sh --apply
```

Deploy script:

```bash
./scripts/p10_deploy_runtime_services_low_cost.sh
./scripts/p10_deploy_runtime_services_low_cost.sh --apply
```

The deploy script creates these Cloud Run services:

```text
platform-api-stg          medical-core-stg
charting-api-stg          halunasu-charting-stg
charting-finalize-stg     halunasu-charting-stg
fee-api-stg               halunasu-fee-stg
referral-api-stg          halunasu-referral-stg

platform-api-prod         medical-core-497610
charting-api-prod         halunasu-charting-prod
charting-finalize-prod    halunasu-charting-prod
fee-api-prod              halunasu-fee-prod
referral-api-prod         halunasu-referral-prod
```

Public access:

- `platform-api-*`, `charting-api-*`, `fee-api-*`, and `referral-api-*` allow unauthenticated Cloud Run ingress because app-level session, entitlement, CORS, and CSRF checks are implemented.
- `charting-finalize-*` remains Cloud Run IAM-private.

## Runtime Project Variables

When product services move to their own projects, keep Core and product Firestore targets explicit:

| Service | Product project env | Core project env |
| --- | --- | --- |
| `charting-api` | `GOOGLE_CLOUD_PROJECT=halunasu-charting-stg` or `CHARTING_GOOGLE_CLOUD_PROJECT=halunasu-charting-stg` | `PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg` |
| `fee-api` | `GOOGLE_CLOUD_PROJECT=halunasu-fee-stg` or `FEE_GOOGLE_CLOUD_PROJECT=halunasu-fee-stg` | `PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg` |
| `referral-api` | `GOOGLE_CLOUD_PROJECT=halunasu-referral-stg` or `REFERRAL_GOOGLE_CLOUD_PROJECT=halunasu-referral-stg` | `PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg` |

`PLATFORM_GOOGLE_CLOUD_PROJECT` must point at Core so product runtimes never accidentally create or read Core records in a product project.

## Not Yet Done

- Production backup is not enabled.
