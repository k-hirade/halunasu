from __future__ import annotations

import unittest

from scripts.report_fee_whitebox_shadow import build_report


POLICY = {
    "schemaVersion": 1,
    "policyId": "test",
    "requiredSpecialties": ["internal_medicine"],
    "requiredEncounterSettings": ["outpatient"],
    "specialtyAliases": {"内科": "internal_medicine"},
    "telemetry": {
        "minimumRunsPerCell": 1,
        "maximumDegradedRunRate": 0,
        "maximumWhiteboxP95Ms": 500,
        "requireSingleCloudRunRevision": True,
        "requireSingleExtractorVersion": True,
    },
    "adjudication": {
        "minimumControlRepeats": 3,
        "minimumReviewedLinesPerCell": 2,
        "minimumReviewedSpansPerCell": 1,
        "minimumCodePrecision": 0.99,
        "minimumRecallDeltaVsLlm": -0.02,
        "maximumDangerousFalsePositiveRate": 0.01,
        "minimumDeterministicExactMatchRate": 1,
    },
}


def telemetry_record(session_id: str = "fee-session-1"):
    return {
        "jsonPayload": {
            "event": "fee.calculate.performance",
            "feeSessionId": session_id,
            "runtime": {"cloudRunRevision": "revision-1"},
            "whiteboxExtraction": {
                "specialty": "internal_medicine",
                "encounterSetting": "outpatient",
                "lineCount": 4,
                "shadowEncoderLineCount": 3,
                "spanBearingLineCount": 2,
                "shadowEncoderSpanBearingLineCount": 1,
                "degraded": False,
                "extractorVersion": "whitebox-v1:test",
                "spanDetectorDurationMs": 10,
                "linkerDurationMs": 20,
                "contextClassifierDurationMs": 30,
                "routeReasonCounts": {"performed_span": 2},
                "contextClassifier": {
                    "evaluatedSpans": 2,
                    "abstainedSpans": 1,
                    "uncertainAxisCounts": {"temporalRelation": 1},
                    "status": "complete",
                },
                "modes": {
                    "span": "shadow",
                    "linker": "shadow",
                    "context": "shadow",
                },
            },
        }
    }


def adjudication():
    return {
        "schemaVersion": "fee-whitebox-adjudication-v1",
        "purpose": "promotion",
        "promotionEligible": True,
        "source": {
            "runId": "run-1",
            "datasetSha256": "dataset-sha",
            "policySha256": "policy-sha",
        },
        "controlRepeats": 3,
        "deterministicExactMatchRate": 1,
        "cells": [{
            "specialty": "internal_medicine",
            "encounterSetting": "outpatient",
            "reviewedItemCount": 1,
            "reviewedLineCount": 2,
            "reviewedSpanCount": 1,
            "truePositiveCodeCount": 100,
            "falsePositiveCodeCount": 0,
            "falseNegativeCodeCount": 1,
            "llmTruePositiveCodeCount": 99,
            "llmFalseNegativeCodeCount": 2,
            "dangerousFalsePositiveCount": 0,
            "dangerousNegativeOpportunityCount": 100,
        }],
    }


def run_manifest():
    return {
        "schemaVersion": "fee-whitebox-shadow-stg-run-v1",
        "runId": "run-1",
        "status": "complete",
        "source": {
            "holdoutUsed": True,
            "datasetSha256": "dataset-sha",
            "policySha256": "policy-sha",
        },
        "methodology": {"evaluationPurpose": "promotion"},
        "environment": {"cloudRunRevision": "revision-1"},
        "runs": [
            {
                "feeSessionId": "fee-session-1",
                "measurementCell": "internal_medicine|outpatient",
                "cloudRunRevision": "revision-1",
                "extractorVersion": "whitebox-v1:test",
                "runKind": "measurement",
                "controlGroupId": "internal_medicine|outpatient:case-1",
                "controlAttempt": 1,
                "whiteboxFingerprint": "same-fingerprint",
                "machinePrecheck": {
                    "encoderCodes": ["160022510", "999999999"],
                    "llmCodes": ["160022510", "170020010"],
                },
            },
            {
                "feeSessionId": "fee-control-2",
                "measurementCell": "internal_medicine|outpatient",
                "cloudRunRevision": "revision-1",
                "extractorVersion": "whitebox-v1:test",
                "runKind": "determinism_control",
                "controlGroupId": "internal_medicine|outpatient:case-1",
                "controlAttempt": 2,
                "whiteboxFingerprint": "same-fingerprint",
            },
            {
                "feeSessionId": "fee-control-3",
                "measurementCell": "internal_medicine|outpatient",
                "cloudRunRevision": "revision-1",
                "extractorVersion": "whitebox-v1:test",
                "runKind": "determinism_control",
                "controlGroupId": "internal_medicine|outpatient:case-1",
                "controlAttempt": 3,
                "whiteboxFingerprint": "same-fingerprint",
            },
        ],
    }


def manifest_telemetry_records():
    return [
        telemetry_record("fee-session-1"),
        telemetry_record("fee-control-2"),
        telemetry_record("fee-control-3"),
    ]


class ReportFeeWhiteboxShadowTest(unittest.TestCase):
    def test_gate_passes_only_with_telemetry_and_adjudication(self) -> None:
        report = build_report(
            [telemetry_record()],
            policy=POLICY,
            adjudication_payload=adjudication(),
        )

        self.assertTrue(report["gate"]["passed"])
        self.assertEqual(report["telemetry"]["routableLineRatio"], 0.75)
        self.assertEqual(
            report["telemetry"]["spanBearingRoutableLineRatio"],
            0.5,
        )
        self.assertEqual(
            report["telemetry"]["cells"]["internal_medicine|outpatient"][
                "routeReasonCounts"
            ],
            {"performed_span": 2},
        )
        self.assertEqual(
            report["telemetry"]["extractorVersionCounts"],
            {"whitebox-v1:test": 1},
        )
        self.assertEqual(
            report["telemetry"]["laneDurationMs"]["linker"]["p95"],
            20,
        )
        self.assertEqual(
            report["telemetry"]["contextClassifier"]["abstainRate"],
            0.5,
        )

    def test_gate_blocks_without_independent_adjudication(self) -> None:
        report = build_report(
            [telemetry_record()],
            policy=POLICY,
        )

        self.assertFalse(report["gate"]["passed"])
        self.assertIn(
            "adjudication",
            [
                check["name"]
                for check in report["gate"]["checks"]
                if not check["passed"]
            ],
        )

    def test_gate_blocks_when_lane_duration_telemetry_is_missing(self) -> None:
        record = telemetry_record()
        del record["jsonPayload"]["whiteboxExtraction"]["linkerDurationMs"]
        report = build_report(
            [record],
            policy=POLICY,
            adjudication_payload=adjudication(),
        )

        self.assertFalse(report["gate"]["passed"])
        self.assertEqual(
            report["telemetry"]["laneDurationMissingCounts"]["linker"],
            1,
        )
        self.assertTrue(any(
            check["name"] == "telemetry.laneDurationCompleteness"
            and not check["passed"]
            for check in report["gate"]["checks"]
        ))

    def test_specialty_alias_is_normalized_before_cell_aggregation(self) -> None:
        record = telemetry_record()
        record["jsonPayload"]["whiteboxExtraction"]["specialty"] = "内科"
        report = build_report(
            [record],
            policy=POLICY,
            adjudication_payload=adjudication(),
        )

        self.assertEqual(
            report["telemetry"]["cells"]["internal_medicine|outpatient"]["runCount"],
            1,
        )

    def test_adjudication_specialty_alias_is_normalized(self) -> None:
        reviewed = adjudication()
        reviewed["cells"][0]["specialty"] = "内科"
        report = build_report(
            [telemetry_record()],
            policy=POLICY,
            adjudication_payload=reviewed,
        )

        self.assertTrue(report["gate"]["passed"])
        self.assertIn(
            "internal_medicine|outpatient",
            report["adjudication"]["cells"],
        )

    def test_five_patient_sample_cannot_satisfy_all_required_cells(self) -> None:
        expanded = {
            **POLICY,
            "requiredSpecialties": ["internal_medicine", "pediatrics"],
        }
        report = build_report(
            [telemetry_record()],
            policy=expanded,
            adjudication_payload=adjudication(),
        )

        self.assertFalse(report["gate"]["passed"])
        self.assertTrue(any(
            check["name"] == "telemetry.pediatrics|outpatient.runCount"
            and not check["passed"]
            for check in report["gate"]["checks"]
        ))

    def test_gate_blocks_mixed_revisions_or_extractor_versions(self) -> None:
        second = telemetry_record()
        second["jsonPayload"]["runtime"]["cloudRunRevision"] = "revision-2"
        second["jsonPayload"]["whiteboxExtraction"][
            "extractorVersion"
        ] = "whitebox-v1:other"
        report = build_report(
            [telemetry_record(), second],
            policy=POLICY,
            adjudication_payload=adjudication(),
        )

        self.assertFalse(report["gate"]["passed"])
        failed = {
            check["name"]
            for check in report["gate"]["checks"]
            if not check["passed"]
        }
        self.assertIn("telemetry.cloudRunRevisions", failed)
        self.assertIn("telemetry.extractorVersion", failed)

    def test_run_manifest_filters_unrelated_logs(self) -> None:
        unrelated = telemetry_record()
        unrelated["jsonPayload"]["feeSessionId"] = "other-session"
        unrelated["jsonPayload"]["runtime"]["cloudRunRevision"] = "other-revision"
        strict_policy = {
            **POLICY,
            "telemetry": {
                **POLICY["telemetry"],
                "requireRunManifest": True,
            },
        }

        report = build_report(
            [*manifest_telemetry_records(), unrelated],
            policy=strict_policy,
            adjudication_payload=adjudication(),
            run_manifest=run_manifest(),
        )

        self.assertTrue(report["gate"]["passed"])
        self.assertEqual(report["telemetry"]["runCount"], 1)
        self.assertEqual(
            report["runManifestAudit"]["ignoredUnrelatedPerformanceRecordCount"],
            1,
        )
        comparison = report["machineComparison"]["cells"][
            "internal_medicine|outpatient"
        ]
        self.assertEqual(comparison["encoderOnlyCodes"], {"999999999": 1})
        self.assertEqual(comparison["llmOnlyCodes"], {"170020010": 1})

    def test_run_manifest_missing_or_duplicate_logs_block_gate(self) -> None:
        strict_policy = {
            **POLICY,
            "telemetry": {
                **POLICY["telemetry"],
                "requireRunManifest": True,
            },
        }
        missing = build_report(
            [],
            policy=strict_policy,
            adjudication_payload=adjudication(),
            run_manifest=run_manifest(),
        )
        duplicate = build_report(
            [*manifest_telemetry_records(), telemetry_record()],
            policy=strict_policy,
            adjudication_payload=adjudication(),
            run_manifest=run_manifest(),
        )

        self.assertFalse(missing["gate"]["passed"])
        self.assertFalse(duplicate["gate"]["passed"])
        missing_names = {
            check["name"]
            for check in missing["gate"]["checks"]
            if not check["passed"]
        }
        duplicate_names = {
            check["name"]
            for check in duplicate["gate"]["checks"]
            if not check["passed"]
        }
        self.assertIn("telemetry.runManifest.missingSessions", missing_names)
        self.assertIn("telemetry.runManifest.duplicateLogs", duplicate_names)

    def test_run_manifest_revision_mismatch_blocks_gate(self) -> None:
        strict_policy = {
            **POLICY,
            "telemetry": {
                **POLICY["telemetry"],
                "requireRunManifest": True,
            },
        }
        manifest = run_manifest()
        manifest["environment"]["cloudRunRevision"] = "revision-other"

        report = build_report(
            manifest_telemetry_records(),
            policy=strict_policy,
            adjudication_payload=adjudication(),
            run_manifest=manifest,
        )

        self.assertFalse(report["gate"]["passed"])
        self.assertTrue(any(
            check["name"] == "telemetry.runManifest.revision"
            and not check["passed"]
            for check in report["gate"]["checks"]
        ))

    def test_adjudication_source_hash_mismatch_blocks_gate(self) -> None:
        strict_policy = {
            **POLICY,
            "telemetry": {
                **POLICY["telemetry"],
                "requireRunManifest": True,
            },
        }
        reviewed = adjudication()
        reviewed["source"]["policySha256"] = "other-policy-sha"

        report = build_report(
            manifest_telemetry_records(),
            policy=strict_policy,
            adjudication_payload=reviewed,
            run_manifest=run_manifest(),
        )

        self.assertFalse(report["gate"]["passed"])
        self.assertTrue(any(
            check["name"] == "adjudication.sourceRun"
            and not check["passed"]
            for check in report["gate"]["checks"]
        ))

    def test_diagnostic_manifest_cannot_be_used_for_promotion(self) -> None:
        strict_policy = {
            **POLICY,
            "telemetry": {
                **POLICY["telemetry"],
                "requireRunManifest": True,
            },
        }
        manifest = run_manifest()
        manifest["source"]["holdoutUsed"] = False
        manifest["methodology"]["evaluationPurpose"] = "diagnostic"

        report = build_report(
            manifest_telemetry_records(),
            policy=strict_policy,
            adjudication_payload=adjudication(),
            run_manifest=manifest,
        )

        self.assertFalse(report["gate"]["passed"])
        self.assertTrue(any(
            check["name"] == "adjudication.sourceRun"
            and not check["passed"]
            for check in report["gate"]["checks"]
        ))


if __name__ == "__main__":
    unittest.main()
