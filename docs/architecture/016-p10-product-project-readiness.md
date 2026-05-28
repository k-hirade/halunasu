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

## Not Yet Done

- Billing is not linked to product projects.
- Product Firestore databases are not created.
- Product Cloud Run services are not deployed.
- Product Secret Manager secrets are not created.
- Cross-project IAM is not granted.
- Production backup is not enabled.
