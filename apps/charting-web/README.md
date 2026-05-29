# Charting Web

Migrated charting UI from `halunasu-medical-record/apps/web`.

This is the Next.js SOAP/session application. It preserves the old charting
screen structure: login, session list, session workspace, mobile recorder,
admin pages, billing pages, signup, contact signup, and password setup.

The old static first-pass `index.html` has been removed from this package so it
cannot be accidentally deployed instead of the restored Next.js application.

Local check:

```bash
npm test --workspace @halunasu/charting-web
```
