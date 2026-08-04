# HOMIS mock preparation and v7 runtime contract

The checksum-pinned synthetic fixture is tracked under `fixture/`. Verify it and
create the executable July 2026 mock with the existing preparation command. The
`v6` in the script name identifies the date-shift preparation revision; it is not
the selector contract emitted by the current extension.

```bash
python3 clients/homis-sidecar/mock/prepare_homis_mock_v6.py \
  --source clients/homis-sidecar/mock/fixture \
  --output tmp/mock_homis \
  --target-month 2026-07 \
  --apply
python3 clients/homis-sidecar/mock/prepare_homis_mock_v6.py \
  --source clients/homis-sidecar/mock/fixture \
  --output tmp/mock_homis \
  --target-month 2026-07 \
  --check
```

The preparation moves the synthetic target period to July 2026 (previous month June
2026) and shifts patient start/problem dates by the same offset. It does not alter the
legacy fixture DOM or inject hidden selector metadata. In particular, the prepared fixture
must not add completeness markers or an encounter-history table that are absent from
the original mock. `fixture/SHA256SUMS` protects the fixture.

Current extension builds emit the `homis-mock-v7` selector contract. At calculation
time, v7 uses the visible previous/next chart controls to collect the target month's
encounter types, reconciles them with the visible calendar, and restores the originally
displayed chart. It does not read `window.KARTE_HTML`, `window.KARTE_DATES`,
`#action_list`, `.koui-area`, or `.koui-item` as calculation input.

The v5 preparer remains as a compatibility entry point. `homis-mock-v6` and v2-v5
remain server-side rollout compatibility contracts; new extension requests use v7.
