# Care Fee API

Independent API for emergency-treatment-management pre-claim review.

- Uses Platform authentication, organization, facility, and entitlement data.
- Stores care-owned episodes, decisions, runs, and audit logs in the care project.
- Spot CSV evaluation persists metadata and hashes only, never the input or result rows.
- Does not read the medical Fee product store.

Local start:

```bash
npm run dev --workspace @halunasu/care-fee-api
```
