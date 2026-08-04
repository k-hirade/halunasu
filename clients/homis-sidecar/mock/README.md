# homis-mock-v6 preparation

The checksum-pinned synthetic fixture is tracked under `fixture/`. Verify it and
create the executable July 2026 mock with the v6 preparation command:

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
legacy fixture DOM or inject hidden selector metadata. In particular, the v6 fixture
must not add completeness markers or an encounter-history table that are absent from
the original mock. `fixture/SHA256SUMS` protects the fixture.

The v5 preparer remains as a compatibility entry point. New extension builds emit only
the v6 selector contract; v2-v5 remain server-side rollout compatibility versions.
