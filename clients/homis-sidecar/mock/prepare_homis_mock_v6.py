#!/usr/bin/env python3
"""Build the homis-mock-v6 demo from the checksum-pinned fixture."""

from prepare_homis_mock_v5 import main


if __name__ == "__main__":
    raise SystemExit(main("homis-mock-v6"))
