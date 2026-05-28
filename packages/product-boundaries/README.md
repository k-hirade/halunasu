# Product Boundaries

Tests that keep product APIs separated while allowing shared Platform data.

Rules enforced here:

- product APIs use the shared `requireProductContext` helper
- product APIs do not call `getProductEntitlement` directly
- product services and apps do not import or call sibling product routes directly
- cross-product workflows must be explicit export/import flows rather than shared product database reads
