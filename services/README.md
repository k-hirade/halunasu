# Services

Backend services live here.

Services:

- `platform-api`: shared auth, organization, facility, department, member, patient, signup, billing
- `charting-api`: Platform-session-validated charting encounter API
- `charting-finalize`: local/mock final transcript and SOAP worker, kept undeployed in P4
- `fee-api`: Platform-session-validated medical fee calculation API with mock calculation in P5
- `referral-api`: Platform-session-validated referral letter API with PDF placeholder in P6
