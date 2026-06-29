# STG Netlify IP Allowlist Runbook

Status: implemented locally for all Netlify browser apps.

This runbook describes how to restrict STG browser access by source IP without adding a username/password prompt.

## Scope

The STG gate applies to the Netlify frontend layer for:

- LP: `https://stg.halunasu.com`
- Core Admin: `https://admin.stg.halunasu.com`
- Charting: `https://charting.stg.halunasu.com`
- Fee: `https://fee.stg.halunasu.com`
- Referral: `https://referral.stg.halunasu.com`
- The corresponding STG Netlify domains

It does not protect Cloud Run URLs when they are accessed directly. Cloud Run direct access must be controlled separately by IAM, ingress, service auth, CORS, or application-level auth.

## Behavior

The Netlify Edge Function runs before the app response.

- PROD is not blocked because deploy scripts set `STG_GATE_ENABLED=false`.
- STG is blocked unless the request source IP matches `STG_GATE_ALLOWED_IPS`.
- A matching IP continues to the app normally.
- A non-matching IP receives HTTP `403 Forbidden`.
- If STG gate is enabled but `STG_GATE_ALLOWED_IPS` is empty, the response is HTTP `503`. This is intentional fail-closed behavior.

No Basic Auth is used. There is no browser username/password prompt.

## Allowlist Value Format

Set `STG_GATE_ALLOWED_IPS` to a comma- or whitespace-separated list.

Examples:

```bash
STG_GATE_ALLOWED_IPS='203.0.113.10/32'
STG_GATE_ALLOWED_IPS='203.0.113.10/32,203.0.113.11/32'
STG_GATE_ALLOWED_IPS='203.0.113.0/24,2001:db8:1234::/48'
```

Use:

- IPv4 single address: append `/32`
- IPv6 single address: append `/128`
- Office/VPN range: use the CIDR block from the network administrator or provider

Do not use private LAN addresses such as `192.168.x.x`, `10.x.x.x`, `172.16.x.x` to `172.31.x.x`, or `127.0.0.1`. Netlify sees the public egress IP, not the device's local LAN IP.

## How To Get The Value

For a single current network, get the public egress IPv4:

```bash
curl -sS https://checkip.amazonaws.com
```

or:

```bash
curl -sS https://api.ipify.org
```

If the command returns:

```text
203.0.113.10
```

then use:

```bash
STG_GATE_ALLOWED_IPS='203.0.113.10/32'
```

For IPv6, check from an IPv6-capable network:

```bash
curl -6 -sS https://api64.ipify.org
```

If the command returns:

```text
2001:db8:1234::10
```

then use:

```bash
STG_GATE_ALLOWED_IPS='2001:db8:1234::10/128'
```

For a hospital, office, or VPN, prefer a fixed egress IP or CIDR from the network administrator:

- Ask for the outbound global IP address used for web access.
- If multiple branches or VPN exits exist, list all of them.
- If the provider gives a range, use that CIDR.
- If the IP is dynamic, the allowlist will break when the IP changes; use a fixed IP or VPN egress for stable operation.

## First Deploy Or Allowlist Change

Pass `STG_GATE_ALLOWED_IPS` when deploying. The scripts set the Netlify environment variable for STG sites.

```bash
STG_GATE_ALLOWED_IPS='203.0.113.10/32' npm run build:runtime-apps -- --env all
STG_GATE_ALLOWED_IPS='203.0.113.10/32' npm run deploy:netlify-static -- --env all --app all --apply
STG_GATE_ALLOWED_IPS='203.0.113.10/32' npm run deploy:netlify-charting-next -- --env all --apply
STG_GATE_ALLOWED_IPS='203.0.113.10/32' npm run deploy:netlify-admin-fee-next -- --env all --app all --apply
```

For a Fee-only deploy:

```bash
STG_GATE_ALLOWED_IPS='203.0.113.10/32' npm run deploy:netlify-admin-fee-next -- --env all --app fee-web --apply
```

After the Netlify environment variable has been set once, normal deploys can omit `STG_GATE_ALLOWED_IPS` unless the allowlist changes.

## Normal Deploy

```bash
npm run build:runtime-apps -- --env all
npm run deploy:netlify-static -- --env all --app all --apply
npm run deploy:netlify-charting-next -- --env all --apply
npm run deploy:netlify-admin-fee-next -- --env all --app all --apply
```

For Fee-only:

```bash
npm run deploy:netlify-admin-fee-next -- --env all --app fee-web --apply
```

## Verification

From an allowed network:

```bash
curl -I https://fee.stg.halunasu.com
```

Expected result: app response, redirect, or another non-403 app-level response.

From a non-allowed network:

```bash
curl -I https://fee.stg.halunasu.com
```

Expected result:

```text
HTTP/2 403
```

If STG returns `503`, the Edge Function is deployed but `STG_GATE_ALLOWED_IPS` is not configured on that Netlify site.

## Operational Notes

- Keep the allowlist narrow. Prefer `/32` for one IPv4 or `/128` for one IPv6.
- Use a VPN with a fixed egress IP for teams, clinics, or hospitals.
- Do not commit real office IPs to Git unless that is explicitly acceptable. Prefer passing them through the shell or Netlify UI.
- `STG_GATE_USER` and `STG_GATE_PASSWORD` are not used by the current implementation.
- Direct Cloud Run URLs remain outside this Netlify gate.
