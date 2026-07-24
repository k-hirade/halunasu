from __future__ import annotations

import unittest

from experiments.wx0_load import run_benchmark


class Wx0LoadTest(unittest.TestCase):
    def test_runs_declared_concurrency_levels_and_collects_rss(self) -> None:
        def fake_post(_url, _payload, _headers, _timeout):
            return {
                "ok": True,
                "status": 200,
                "durationMs": 12.5,
                "error": None,
                "json": {"runtimeMetrics": {"rssBytes": 1234}},
            }

        result = run_benchmark(
            url="https://example.invalid/infer",
            payload={"text": "採血を実施"},
            headers={},
            concurrency_levels=[1, 2],
            requests_per_worker=2,
            timeout_seconds=5,
            warmup_requests=1,
            rss_json_path="runtimeMetrics.rssBytes",
            post_json=fake_post,
        )

        self.assertEqual([level["concurrency"] for level in result["levels"]], [1, 2])
        self.assertTrue(all(level["errorCount"] == 0 for level in result["levels"]))
        self.assertTrue(all(level["rssBytes"]["max"] == 1234 for level in result["levels"]))
        self.assertIn("true cold start", result["note"])


if __name__ == "__main__":
    unittest.main()
