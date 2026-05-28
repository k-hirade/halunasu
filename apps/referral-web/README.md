# Referral Web

Platform-backed referral letter creation UI for P6.

Local P6 scope:

- logs in through `platform-api`
- creates/uses shared Platform patients
- reads Platform facilities and departments
- creates product-owned referral drafts through `referral-api`
- creates an inline PDF placeholder without GCS or external rendering

Configure API bases with:

```html
<meta name="halunasu-platform-api-base-url" content="http://localhost:8080" />
<meta name="halunasu-referral-api-base-url" content="http://localhost:8085" />
```
