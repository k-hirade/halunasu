# Old Asset Cleanup

Status: in progress for non-runtime cleanup
Date: 2026-05-29
Cost profile: reduces dormant static-site and local storage footprint; no new resources

## Completed

- Deleted old Netlify sites after confirming the new Halunasu domains were live:
  - `harunas`
  - `harunas-app`
  - `harunas-stg`
  - `medical-fee-calculation-stg`
- Reconfirmed the active `halunasu-*` Netlify sites still own the custom domains
  and all checked web domains return HTTPS `200`.
- Removed historical local source clones from `/Users/hiradekeishi/medical-ai`:
  - `medical-fee-calculation`
  - `halunasu-fee-calculation`
  - `halunasu-medical-record`
  - `medical-lp`
- Confirmed old GCP projects are already `DELETE_REQUESTED`:
  - `medical-stg-493105`
  - `medical-fee-calculation-stg`
  - `medical-492407`
  - `medical-fee-calculation`
- Deleted unused Cloud Run API domain mappings:
  - `api.stg.halunasu.com`
  - `charting-api.stg.halunasu.com`
  - `fee-api.stg.halunasu.com`
  - `referral-api.stg.halunasu.com`
  - `api.halunasu.com`
  - `charting-api.halunasu.com`
  - `fee-api.halunasu.com`
  - `referral-api.halunasu.com`

## Not Touched

- `medical-ai-agent-send-email` remains because it is not clearly part of the
  medical app cutover.
- GitHub historical repositories were not deleted. Deleting remote source history
  is a separate irreversible decision.
- Active `halunasu-*` and `medical-core-*` GCP projects were not deleted.

## Remaining Decisions

1. Decide whether historical GitHub repositories should be archived or deleted.
2. Decide whether `medical-ai-agent-send-email` is related to this cleanup or should remain separate.
