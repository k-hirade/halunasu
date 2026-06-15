# Official Master Configs

This directory keeps versioned operational inputs for official master updates.

- `2026-05-01/ssk-master-catalog.json` fixes the SSK download URLs discovered from the official source pages for the 2026-05-01 snapshot.
- `2026-05-01/standard-master-build.json` is the reproducible SQLite build manifest after raw SSK files and the Regional Bureau manifest are available locally.
- `2026-06-15/` is reserved for the Reiwa 8 June 2026 snapshot. Generate it from the current SSK pages before rebuilding the SQLite DB:

```bash
PYTHONPATH=python python3 -m medical_fee_calculation.cli discover-ssk-master-catalog \
  --source-version 2026-06-15 \
  --output configs/official-master/2026-06-15/ssk-master-catalog.json \
  --fail-on-warning
```

Monthly updates should create a new dated directory instead of overwriting previous snapshots.
