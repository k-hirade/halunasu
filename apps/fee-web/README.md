# Fee Web

Platform-backed fee calculation UI for P5.

Local P5 scope:

- logs in through `platform-api`
- creates/uses shared Platform patients
- reads Platform facilities and departments
- creates product-owned fee sessions through `fee-api`
- runs deterministic mock calculation without OpenAI or GCP resources

For the production-like static bundle, run `npm run build:runtime-apps` from the repository root and open `dist/runtime-apps/{stg|prod}/fee-web/index.html`. The runtime build copies the shared UI stylesheet into `web-ui/halunasu-ui.css`.

Open `index.html` directly only for lightweight static inspection. Configure API bases with:

```html
<meta name="halunasu-platform-api-base-url" content="http://localhost:8080" />
<meta name="halunasu-fee-api-base-url" content="http://localhost:8084" />
```
