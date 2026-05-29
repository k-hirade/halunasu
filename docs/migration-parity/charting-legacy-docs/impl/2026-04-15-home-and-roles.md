# Home Router and Role Definition Implementation

Date: 2026-04-15

## Goals

- Move the current session launcher from `/` to `/sessions`.
- Turn `/` into an authenticated app chooser:
  - unauthenticated users see the existing operator login panel
  - authenticated users choose between session work and admin work
  - admin entry is visible only to admin-capable roles
- Keep the existing admin <-> session navigation pattern through the top navigation.
- Replace scattered role constants with shared role definitions suitable for hospital operations.
- Block non-admin users from rendering the admin console on direct `/admin` access.

## Role Set

The shared role set remains backward-compatible with current users and expands to hospital roles:

- `platform_admin`: service operator
- `org_owner`: hospital owner or executive owner
- `org_admin`: hospital administrator
- `it_admin`: hospital IT or security administrator
- `clinical_admin`: clinical operations administrator
- `doctor`: physician
- `nurse`: nurse
- `medical_scribe`: medical scribe or physician assistant clerk
- `reception`: front desk
- `billing_staff`: medical billing staff
- `auditor`: audit viewer
- `readonly_clinical`: clinical read-only viewer

## Implementation Checklist

- Add shared role definitions and permission helpers in `@medical/contracts`.
- Expose role definitions from the store through `/api/v1/admin/role-definitions`; Firestore can override the default definitions with `role_definitions/{roleId}` documents while server authorization remains deny-by-default against known roles.
- Reuse those helpers in gateway, core stores, SiteNav, EncounterWorkspace, HomeRouter, and AdminConsole.
- Add `/sessions/page.js`.
- Replace legacy `/` links that should return to the session dashboard with `/sessions`.
- Update `docs/core/06-screen-flows.md` to show `Login -> Home selector -> Sessions/Admin`.
- Verify with `npm test` and `npm run build --workspace @medical/web`.
