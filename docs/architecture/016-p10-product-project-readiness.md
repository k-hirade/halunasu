# P10 Product Project Readiness

Status: started
Date: 2026-05-28
Cost profile: read-only validation, no new resources

## Purpose

P10 starts from the new Core/product project split:

| Boundary | Staging project | Production project | Current state |
| --- | --- | --- | --- |
| Core/Platform | `medical-core-stg` | `medical-core-497610` | active |
| Charting | `halunasu-charting-stg` | `halunasu-charting-prod` | active, billing disabled |
| Fee calculation | `halunasu-fee-stg` | `halunasu-fee-prod` | active, billing disabled |
| Referral | `halunasu-referral-stg` | `halunasu-referral-prod` | active, billing disabled |

The goal is to prevent accidental cost growth while preparing the first production-ready path.

## First Gate

Run:

```bash
./scripts/p10_project_split_preflight.sh
```

The preflight confirms:

- Core projects are active.
- Product project shells are active.
- Product project shells have billing disabled.
- Old historical projects are in `DELETE_REQUESTED`.
- Product projects have not had major runtime services enabled unexpectedly.

Latest run on 2026-05-28:

```text
Summary: 0 failure(s), 0 warning(s).
```

## Controlled Next Move

Do not enable all product projects at once.

Recommended order:

1. Keep product production projects billing-disabled.
2. Select one staging product project for the first controlled smoke.
3. Link billing only for that one staging project.
4. Enable only the APIs required for that product.
5. Deploy with Cloud Run `min-instances=0` and staging `max-instances=1`.
6. Verify cross-project session, entitlement, and patient reference calls to Core.
7. Add backup/restore only after real PHI is near.

Recommended first target: `halunasu-charting-stg`, because charting exercises the largest boundary surface: patient references, audio/transcript artifacts, SOAP generation, and worker-style finalize behavior.

The guarded activation script is dry-run by default:

```bash
./scripts/p10_activate_product_project_guarded.sh charting stg
```

Latest dry-run on 2026-05-28:

```text
Project: halunasu-charting-stg
Current billingEnabled=False
DRY RUN: gcloud billing projects link halunasu-charting-stg ...
DRY RUN: gcloud services enable artifactregistry.googleapis.com cloudbuild.googleapis.com firestore.googleapis.com iam.googleapis.com run.googleapis.com secretmanager.googleapis.com storage.googleapis.com cloudtasks.googleapis.com ...
```

Actual activation requires all of:

```bash
BILLING_ACCOUNT_ID=XXXXXX-XXXXXX-XXXXXX P10_ALLOW_BILLING=yes ./scripts/p10_activate_product_project_guarded.sh charting stg --apply
```

Do not run `--apply` for production without `P10_ALLOW_PROD=yes`.

## Runtime Project Variables

When product services move to their own projects, keep Core and product Firestore targets explicit:

| Service | Product project env | Core project env |
| --- | --- | --- |
| `charting-api` | `GOOGLE_CLOUD_PROJECT=halunasu-charting-stg` or `CHARTING_GOOGLE_CLOUD_PROJECT=halunasu-charting-stg` | `PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg` |
| `fee-api` | `GOOGLE_CLOUD_PROJECT=halunasu-fee-stg` or `FEE_GOOGLE_CLOUD_PROJECT=halunasu-fee-stg` | `PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg` |
| `referral-api` | `GOOGLE_CLOUD_PROJECT=halunasu-referral-stg` or `REFERRAL_GOOGLE_CLOUD_PROJECT=halunasu-referral-stg` | `PLATFORM_GOOGLE_CLOUD_PROJECT=medical-core-stg` |

`PLATFORM_GOOGLE_CLOUD_PROJECT` must point at Core so product runtimes never accidentally create or read Core records in a product project.

## Not Yet Done

- Billing is not linked to product projects.
- Product Firestore databases are not created.
- Product Cloud Run services are not deployed.
- Product Secret Manager secrets are not created.
- Cross-project IAM is not granted.
- Production backup is not enabled.
