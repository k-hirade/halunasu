# homis-mock-v3 preparation

The external `mock_homis` demo is kept outside this package. Prepare a fresh copy of
`mock_partner.zip` with the tracked, idempotent command below:

```bash
python3 clients/homis-sidecar/mock/prepare_homis_mock_v3.py tmp/mock_homis --apply
python3 clients/homis-sidecar/mock/prepare_homis_mock_v3.py tmp/mock_homis --check
```

The preparation moves the synthetic target period to June 2026 (previous month May 2026),
adds a stable `data-record-id` and `data-single-building-patient-count` to
`#pdetail_karte`, and updates both whenever the visible chart changes. It fails closed when
the expected mock source anchors are not present. The v2 script remains available for
reproducing the previous selector contract only.
