# Security Boundaries

Static security checks for P8.

These tests are intentionally conservative. They keep browser clients away from Firestore, require product API auth/CSRF/security headers, and prevent obvious PHI leakage patterns in logs and audit payloads.
