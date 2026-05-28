# Architecture Docs

This directory contains architecture decisions and system diagrams for the Halunasu unified platform.

## Documents

- [001 ASIS / TOBE Architecture](001-asis-tobe-architecture.md)
- [002 Platform Data Model](002-platform-data-model.md)
- [003 GCP Environment Plan](003-gcp-environment-plan.md)
- [004 Migration Execution Plan](004-migration-execution-plan.md)
- [005 Rearchitecture Completion Roadmap](005-rearchitecture-completion-roadmap.md)
- [006 P2 Staging Smoke Runbook](006-p2-staging-smoke-runbook.md)
- [007 P3 Staging Smoke Runbook](007-p3-staging-smoke-runbook.md)
- [008 P4 Charting Migration Runbook](008-p4-charting-migration-runbook.md)
- [009 P5 Fee Migration Runbook](009-p5-fee-migration-runbook.md)
- [010 P6 Referral Foundation Runbook](010-p6-referral-foundation-runbook.md)
- [011 P7 Product Boundaries](011-p7-product-boundaries.md)
- [012 P8 Security Operations Compliance](012-p8-security-operations-compliance.md)
- [013 P8.5 Core Hardening](013-p8-5-core-hardening.md)
- [014 P8.6 Core Admin Synthetic E2E](014-p8-6-core-admin-synthetic-e2e.md)
- [015 P9 Old Environment Shutdown](015-p9-old-environment-shutdown.md)
- [016 P10 Product Project Readiness](016-p10-product-project-readiness.md)

## Reading Order

1. Start with the ASIS/TOBE diagrams.
2. Review the Platform data model and product data boundaries.
3. Review the GCP environment plan.
4. Use the migration execution plan as the implementation checklist.
5. Use the completion roadmap to track the remaining work through old environment shutdown and production readiness.
6. Use the P2 staging smoke runbook before creating or deploying base Platform resources in `medical-core-stg`.
7. Use the P3 staging smoke runbook to verify LP signup migration and Platform provisioning.
8. Use the P4 charting migration runbook to verify the Platform-backed charting boundary.
9. Use the P5 fee migration runbook to verify the Platform-backed fee boundary.
10. Use the P6 referral foundation runbook to verify the Platform-backed referral boundary.
11. Use the P7 product boundaries document to keep product integration explicit and auditable.
12. Use the P8 security operations compliance runbook before any real PHI or customer onboarding.
13. Use the P8.5 core hardening note to verify Core authorization, audit safety, and data request handling.
14. Use the P8.6 core admin and synthetic E2E runbook to verify local Core operations before old environment shutdown.
15. Use the P9 old environment shutdown runbook to capture read-only inventory and freeze old services without adding GCP resources.
16. Use the P10 product project readiness gate before linking billing or enabling product runtime APIs.
