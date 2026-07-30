import unittest

from scripts.mock_homis_build_action_map import (
    billing_scope_from_limit_names,
    classify_nonbillable_action,
    normalize_action_name,
)
from scripts.export_mock_homis_evaluation_cases import patient_residence_type


class MockHomisBuildActionMapTest(unittest.TestCase):
    def test_patient_charge_is_distinct_from_claim_comments_and_attributes(self):
        self.assertEqual(
            classify_nonbillable_action(normalize_action_name("往診交通費")),
            "patient_charge",
        )
        self.assertEqual(
            classify_nonbillable_action(
                normalize_action_name("訪問診療年月日；令和 8年 6月25日")
            ),
            "claim_attribute",
        )
        self.assertEqual(
            classify_nonbillable_action(normalize_action_name("同一患家 9日、23日")),
            "claim_comment",
        )

    def test_billable_name_is_not_reclassified_as_nonbillable(self):
        self.assertIsNone(
            classify_nonbillable_action(
                normalize_action_name("在宅患者訪問診療料（１）１")
            )
        )

    def test_mock_residence_type_is_structured_from_patient_location(self):
        self.assertEqual(patient_residence_type({"is_facility": True}), "facility")
        self.assertEqual(patient_residence_type({"is_facility": False}), "private")
        self.assertEqual(patient_residence_type({}), "private")

    def test_month_and_multi_month_limits_use_patient_month_scope(self):
        self.assertEqual(billing_scope_from_limit_names(["月"]), "per_month")
        self.assertEqual(billing_scope_from_limit_names(["３月"]), "per_month")
        self.assertEqual(billing_scope_from_limit_names(["年"]), "per_month")

    def test_day_week_and_unknown_limits_stay_visit_scoped(self):
        self.assertEqual(billing_scope_from_limit_names(["日"]), "per_visit")
        self.assertEqual(billing_scope_from_limit_names(["日", "週"]), "per_visit")
        self.assertEqual(billing_scope_from_limit_names([]), "per_visit")


if __name__ == "__main__":
    unittest.main()
