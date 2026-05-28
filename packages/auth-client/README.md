# Auth Client

Shared browser/server helpers for Platform session handling.

This package should not own auth state. `platform-api` remains the source of truth.

Server-side product APIs use this package to verify the signed `halunasu_session`
cookie issued by `platform-api`, enforce CSRF on mutating browser requests, and
check product roles from the Platform session payload.

`requireProductContext` is the shared P7 gate for product APIs. It verifies the
session, login identity token version, active member, product entitlement, and
allowed product/global roles before a product service reads or writes data.
