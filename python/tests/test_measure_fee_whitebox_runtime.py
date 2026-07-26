from __future__ import annotations

import unittest

from scripts.measure_fee_whitebox_runtime import distribution, max_rss_bytes


class MeasureFeeWhiteboxRuntimeTest(unittest.TestCase):
    def test_distribution_uses_nearest_rank_p95(self) -> None:
        values = list(range(1, 21))

        result = distribution(values)

        self.assertEqual(result["count"], 20)
        self.assertEqual(result["median"], 10.5)
        self.assertEqual(result["p95"], 19.0)
        self.assertEqual(result["max"], 20.0)

    def test_max_rss_unit_is_platform_explicit(self) -> None:
        self.assertEqual(max_rss_bytes(1024, system="Darwin"), 1024)
        self.assertEqual(max_rss_bytes(1024, system="Linux"), 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
