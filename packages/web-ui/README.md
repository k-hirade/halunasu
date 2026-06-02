# Web UI

Shared UI primitives for Halunasu web applications.

Do not put product-specific workflows here.

## Purpose

`packages/web-ui` is the source of truth for shared Halunasu browser UI.

It exists so `charting-web`, `fee-web`, `core-admin`, `referral-web`, and selected LP/signup screens do not drift into separate visual systems.

## Assets

- `styles/halunasu-ui.css`
  - design tokens
  - base typography/reset
  - navigation shell
  - buttons
  - cards
  - fields
  - badges/status dots
  - data tables
  - modals
  - toasts
  - skeletons
  - session list primitives
  - workspace shell primitives

## Boundaries

This package may contain shared visual primitives and layout patterns.

It must not contain:

- product-specific API calls
- charting recording logic
- SOAP generation logic
- fee calculation logic
- billing entitlement decisions
- patient persistence logic
- app-specific routes

## Distribution

Next.js apps import the shared CSS from this package.

Static apps receive the CSS during `npm run build:runtime-apps`; the runtime build copies `packages/web-ui/styles` into each static app dist so pages can load:

```html
<link rel="stylesheet" href="web-ui/halunasu-ui.css" />
```
