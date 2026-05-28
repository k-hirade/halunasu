# P9 Old Environment Shutdown

Status: local implementation complete
Date: 2026-05-28
Cost profile: no new billable GCP resources

## Purpose

P9 moves active development away from the old standalone applications and makes shutdown repeatable without adding cost.

The old environments are:

| Area | Local repo | GitHub repo | GCP project |
| --- | --- | --- | --- |
| Medical record / charting | `halunasu-medical-record` | `k-hirade/medical` | `medical-stg-493105`, `medical-492407` |
| Fee calculation | `halunasu-fee-calculation` | `k-hirade/medical-fee-calculation` | `medical-fee-calculation-stg`, `medical-fee-calculation` |
| Landing page | `medical-lp` | `k-hirade/medical-lp` | Netlify / domain config outside this repo |

The replacement path is the `halunasu` monorepo with Platform/Core plus product-specific services and apps.

After the project rebuild, Core and product-owned data are separated by GCP project:

| Boundary | Staging project | Production project |
| --- | --- | --- |
| Core/Platform | `medical-core-stg` | `medical-core-497610` |
| Charting | `halunasu-charting-stg` | `halunasu-charting-prod` |
| Fee calculation | `halunasu-fee-stg` | `halunasu-fee-prod` |
| Referral | `halunasu-referral-stg` | `halunasu-referral-prod` |

## Current Decision

No Firestore export, scheduled backup, GCS backup bucket, or Terraform workflow is created in P9.

Reason:

- There are no customers.
- There is no production PHI to preserve.
- Firestore exports and scheduled backups create storage artifacts and can require bucket or backup configuration.
- The safer low-cost rollback plan is to keep old projects for a short retention window and record read-only inventory.

If real PHI or irreplaceable operational data is later found in an old project, stop P9 deletion and export only to an already-existing approved bucket. Do not create a new bucket just for P9.

## Implemented

- `scripts/p9_old_environment_inventory.sh`
  - read-only inventory of old GCP projects
  - lists project metadata, billing status, relevant enabled services, Cloud Run services, Firestore databases, secret names, Artifact Registry repositories, and storage buckets
  - does not read secret values
  - does not create backups or resources
- `scripts/p9_old_environment_shutdown.sh`
  - dry-run by default
  - refuses Core projects
  - can filter services with `P9_OLD_SERVICES`
  - with explicit `P9_ALLOW_MUTATION=yes --apply`, updates existing old Cloud Run services only
  - existing-service updates can create Cloud Run config revisions
  - sets Cloud Run `min-instances=0`, `max-instances=1`, and CPU throttling
  - removes public Cloud Run invoker bindings when present
  - does not delete projects, services, databases, secrets, buckets, or APIs
- Security boundary tests guard the P9 scripts from resource creation commands.

## Inventory Snapshot

Captured read-only on 2026-05-28 with `info@halunasu.com`.

| Project | Billing | Cloud Run | Firestore | Artifact Registry | Storage |
| --- | --- | --- | --- | --- | --- |
| `medical-stg-493105` | enabled | `medical-billing`, `medical-finalize`, `medical-gateway` | `(default)` in `asia-northeast1` | `medical`, about 1.68 GB | `medical-stg-493105-raw-audio`, `medical-stg-493105_cloudbuild` |
| `medical-fee-calculation-stg` | enabled | `medical-fee-api-stg` | `(default)` in `asia-northeast1` | `cloud-run-source-deploy`, about 1.67 GB | `medical-fee-calculation-stg-artifacts`, `run-sources-medical-fee-calculation-stg-asia-northeast1` |
| `medical-492407` | enabled | `medical-billing`, `medical-finalize`, `medical-gateway` | `(default)` in `asia-northeast1` | `medical`, about 1.52 GB | `medical-492407-raw-audio`, `medical-492407_cloudbuild` |
| `medical-fee-calculation` | disabled | Cloud Run API disabled | Firestore API disabled | Artifact Registry API disabled | none listed |

Secret Manager inventory captured names only; secret values were not read.

## Applied Staging Freeze

Applied on 2026-05-28 to old staging projects only.

| Project | Service | Latest ready revision after P9 | Public invoker result | Runtime result |
| --- | --- | --- | --- | --- |
| `medical-stg-493105` | `medical-billing` | `medical-billing-00031-8rn` | no IAM bindings remain | `maxScale=1`, CPU throttling enabled, no `minScale` annotation |
| `medical-stg-493105` | `medical-finalize` | `medical-finalize-00009-lcq` | only `medical-tasks-invoker-sa` remains | `maxScale=1`, CPU throttling enabled, no `minScale` annotation |
| `medical-stg-493105` | `medical-gateway` | `medical-gateway-00058-8fl` | no IAM bindings remain | `maxScale=1`, CPU throttling enabled, no `minScale` annotation |
| `medical-fee-calculation-stg` | `medical-fee-api-stg` | `medical-fee-api-stg-00045-f2n` | no IAM bindings remain | `maxScale=1`, CPU throttling enabled, no `minScale` annotation |

No `minScale` annotation means the Cloud Run service idles at zero instances. The freeze did not create services, projects, databases, secrets, buckets, images, or backup artifacts. It did create the Cloud Run config revisions listed above.

## Project Rebuild

Executed on 2026-05-28.

Deleted old projects by moving them to `DELETE_REQUESTED`:

| Old project | Final state |
| --- | --- |
| `medical-stg-493105` | `DELETE_REQUESTED` |
| `medical-fee-calculation-stg` | `DELETE_REQUESTED` |
| `medical-492407` | `DELETE_REQUESTED` |
| `medical-fee-calculation` | `DELETE_REQUESTED` |

Undo is available for a limited period with:

```bash
gcloud projects undelete PROJECT_ID
```

Created new product project shells:

| New project | Project number | Billing |
| --- | --- | --- |
| `halunasu-charting-stg` | `736866031020` | disabled |
| `halunasu-charting-prod` | `589293200640` | disabled |
| `halunasu-fee-stg` | `1048063060603` | disabled |
| `halunasu-fee-prod` | `394223136118` | disabled |
| `halunasu-referral-stg` | `903620057515` | disabled |
| `halunasu-referral-prod` | `252775147719` | disabled |

These are project shells only. Do not enable billing or product runtime APIs until an explicit P10 step requires a controlled smoke.

## Runbook

### 1. Verify Replacement

Run local replacement checks:

```bash
npm run test --workspace @halunasu/core-admin
npm run test --workspace @halunasu/core-e2e
npm run test
npm run build
```

### 2. Capture Read-Only Inventory

Run:

```bash
./scripts/p9_old_environment_inventory.sh
```

Optional local evidence file:

```bash
./scripts/p9_old_environment_inventory.sh | tee /tmp/halunasu-p9-old-environment-inventory.txt
```

This was the P9 backup substitute while there were no customers: metadata evidence plus the temporary undelete window, without storage export cost.

### 3. Old Cloud Run Freeze

Before project deletion, run:

```bash
./scripts/p9_old_environment_shutdown.sh
```

Default target projects:

- `medical-stg-493105`
- `medical-fee-calculation-stg`

To include old production projects before launch, set:

```bash
P9_OLD_PROJECTS="medical-stg-493105 medical-fee-calculation-stg medical-492407 medical-fee-calculation" ./scripts/p9_old_environment_shutdown.sh
```

To target only specific services, set:

```bash
P9_OLD_SERVICES="medical-finalize medical-gateway" ./scripts/p9_old_environment_shutdown.sh
```

### 4. Apply Existing-Service Mutations Only

Apply only after the dry-run output is reviewed and only before project deletion:

```bash
P9_ALLOW_MUTATION=yes ./scripts/p9_old_environment_shutdown.sh --apply
```

For all old projects:

```bash
P9_OLD_PROJECTS="medical-stg-493105 medical-fee-calculation-stg medical-492407 medical-fee-calculation" P9_ALLOW_MUTATION=yes ./scripts/p9_old_environment_shutdown.sh --apply
```

### 5. Freeze Old Repos

Recommended GitHub action:

- add an archive notice to the old repo descriptions
- disable auto deploy hooks for old Netlify sites
- protect old default branches or archive the repos after the retention window

Do not archive until the current local clean states are pushed or intentionally discarded:

- `halunasu-medical-record`
- `halunasu-fee-calculation`
- `medical-lp`

### 6. Project Deletion Window

Current state:

- old projects are already in `DELETE_REQUESTED`
- use `gcloud projects undelete PROJECT_ID` only if a missing secret, doc, fixture, or rollback need is discovered during the limited undelete window
- do not recreate resources inside old project IDs

## Exit Criteria

- Replacement Core/Admin/E2E checks pass.
- Read-only inventory can be captured without creating resources.
- Old staging Cloud Run shutdown can be dry-run and then applied with explicit confirmation before deletion.
- Backup/export decision is documented.
- Active development stays in `halunasu`.
- Old project deletion/retention decision is documented.
