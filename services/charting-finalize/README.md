# Charting Finalize

Target location for final transcript and SOAP generation from `halunasu-medical-record/services/finalize`.

This worker should be invoked through Cloud Tasks OIDC where possible.

This service keeps the low-cost local finalize path and generates a rule-based
SOAP draft without introducing STT, OpenAI, Cloud Tasks, or GCS cost.

Implemented endpoint:

```text
GET /healthz
GET /readyz
POST /internal/charting/finalize
```

The internal finalize route updates product-owned charting encounter data through
the charting store and does not mutate Platform master data.
