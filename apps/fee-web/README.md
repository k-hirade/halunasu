# Fee Web

Platform-backed fee calculation UI for P5.

Local P5 scope:

- logs in through `platform-api`
- creates/uses shared Platform patients
- reads Platform facilities and departments
- creates product-owned fee sessions through `fee-api`
- runs deterministic mock calculation without OpenAI or GCP resources

Open `index.html` directly for static inspection, or serve it from any local static server. Configure API bases with:

```html
<meta name="halunasu-platform-api-base-url" content="http://localhost:8080" />
<meta name="halunasu-fee-api-base-url" content="http://localhost:8084" />
```
