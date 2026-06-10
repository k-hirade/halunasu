import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from medical_fee_calculation.master_search import _master_search_condition, _query_variants


class MasterSearchNormalizationTest(unittest.TestCase):
    def test_query_variants_cover_fullwidth_medical_terms(self):
        self.assertIn("ＣＲＰ", _query_variants("CRP"))
        self.assertIn("ＣＴ撮影", _query_variants("CT撮影"))
        self.assertIn("ＳＡＲＳ−ＣｏＶ−２", _query_variants("SARS-CoV-2"))

    def test_query_variants_keep_japanese_terms_stable(self):
        self.assertEqual(_query_variants("咽頭"), ("咽頭",))

    def test_master_search_condition_does_not_expand_code_field_variants(self):
        condition, params = _master_search_condition("p.code", ("p.short_name", "p.base_name"), "CRP")

        self.assertEqual(condition.count("p.code LIKE ?"), 1)
        self.assertGreater(condition.count("p.short_name LIKE ?"), 1)
        self.assertEqual(params[0], "%CRP%")


if __name__ == "__main__":
    unittest.main()
