from __future__ import annotations

import unittest

from experiments.wx0_context_baseline import (
    classify_context_baseline,
    dangerous_negative_truth,
    dangerous_false_positive,
)


class Wx0ContextBaselineTest(unittest.TestCase):
    def test_past_other_provider_wins_over_standing_wording(self) -> None:
        result = classify_context_baseline("前医で在宅酸素療法を継続中。")
        self.assertEqual(result["temporalRelation"]["value"], "past")
        self.assertEqual(result["sourceOrigin"]["value"], "other_provider_record")
        self.assertEqual(result["providerOwnership"]["value"], "other_provider")
        self.assertEqual(result["standingStatus"]["value"], "none")

    def test_current_continuation_is_multi_axis(self) -> None:
        result = classify_context_baseline("当院で在宅酸素療法を継続。")
        self.assertEqual(result["actionStatus"]["value"], "performed")
        self.assertEqual(result["temporalRelation"]["value"], "current_visit")
        self.assertEqual(result["standingStatus"]["value"], "continued")

    def test_future_continuation_does_not_become_standing(self) -> None:
        result = classify_context_baseline("次回から在宅酸素療法を継続予定。")
        self.assertEqual(result["actionStatus"]["value"], "planned")
        self.assertEqual(result["temporalRelation"]["value"], "future")
        self.assertEqual(result["standingStatus"]["value"], "none")

    def test_negated_action_is_not_performed(self) -> None:
        result = classify_context_baseline("ネブライザーは施行せず。")
        self.assertEqual(result["actionStatus"]["value"], "not_performed")
        self.assertEqual(result["temporalRelation"]["value"], "current_visit")

    def test_dangerous_false_positive_definition_is_asymmetric(self) -> None:
        self.assertTrue(
            dangerous_false_positive(
                "temporalRelation",
                "past",
                "current_visit",
            )
        )
        self.assertFalse(
            dangerous_false_positive(
                "temporalRelation",
                "current_visit",
                "past",
            )
        )
        self.assertTrue(dangerous_negative_truth("temporalRelation", "past"))
        self.assertFalse(
            dangerous_negative_truth("temporalRelation", "current_visit")
        )


if __name__ == "__main__":
    unittest.main()
