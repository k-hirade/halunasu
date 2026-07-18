from __future__ import annotations

import unittest

from medical_fee_calculation.api import _fee_line_items


class MeisaishoHakkoApiTest(unittest.TestCase):
    def test_meisaisho_hakko_is_exposed_as_an_outpatient_basic_fee_add_on(self) -> None:
        items = _fee_line_items(
            [{
                "code": "112015770",
                "name": "明細書発行体制等加算",
                "points": 1.0,
                "quantity": 1,
                "total_points": 1.0,
                "status": "candidate",
                "source": "outpatient_meisaisho_hakko_add_on",
            }]
        )

        self.assertEqual(items[0]["orderType"], "basic")
        self.assertEqual(items[0]["coverage"]["chapter"], "A_basic_fee")


if __name__ == "__main__":
    unittest.main()
