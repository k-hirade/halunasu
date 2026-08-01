# homis-mock-v5 preparation

The immutable, unmodified partner fixture is tracked under `fixture/`. Verify it and
create the executable July 2026 mock with the v5 preparation command:

```bash
python3 clients/homis-sidecar/mock/prepare_homis_mock_v5.py \
  --source clients/homis-sidecar/mock/fixture \
  --output tmp/mock_homis \
  --target-month 2026-07 \
  --apply
python3 clients/homis-sidecar/mock/prepare_homis_mock_v5.py \
  --source clients/homis-sidecar/mock/fixture \
  --output tmp/mock_homis \
  --target-month 2026-07 \
  --check
```

The preparation moves the synthetic target period to July 2026 (previous month June
2026) and shifts patient start/problem dates by the same offset. It does not alter the
DOM or inject selector metadata. `fixture/SHA256SUMS` protects the upstream fixture.

The v2 and v3 scripts remain frozen for reproducing their historical selector contracts.
