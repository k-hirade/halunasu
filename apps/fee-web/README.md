# Fee Web

Next.js fee calculation UI for P5.

Local P5 scope:

- logs in through `platform-api`
- creates/uses shared Platform patients
- reads Platform facilities and departments
- creates product-owned fee sessions through `fee-api`
- runs deterministic mock calculation without OpenAI or GCP resources

Local development:

```bash
npm run dev --workspace @halunasu/fee-web
```

STG/PROD are deployed as a Netlify Next.js app, not as the legacy static
`index.html` bundle. Use the repository deploy script from the root:

```bash
npm run deploy:netlify-admin-fee-next -- --env stg --app fee-web --apply
```

Runtime API bases are configured through Netlify/Next environment variables.
