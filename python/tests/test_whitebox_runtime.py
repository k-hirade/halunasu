from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from medical_fee_calculation.clinical_axes import clinical_axis_values
from medical_fee_calculation.whitebox_artifacts import (
    WhiteboxArtifactError,
    load_whitebox_artifact,
)
from medical_fee_calculation.whitebox_context import (
    _classifier_text,
    classify_context,
    context_classifier_readiness,
)
from medical_fee_calculation.whitebox_linker import linker_readiness, link_spans
from medical_fee_calculation.whitebox_onnx import verify_deterministic_inference
from medical_fee_calculation.whitebox_span import (
    detect_spans,
    span_detector_readiness,
)
from scripts.build_fee_linker_index import (
    _embedding_document,
    _prefixed_embedder,
    _validate_runtime_embedding_parity,
    build_linker_artifact,
)


CURRENT_AXES = {
    "actionStatus": {"value": "performed", "confidence": 0.99, "abstained": False},
    "temporalRelation": {
        "value": "current_visit",
        "confidence": 0.99,
        "abstained": False,
    },
    "sourceOrigin": {
        "value": "own_clinic_record",
        "confidence": 0.99,
        "abstained": False,
    },
    "providerOwnership": {
        "value": "own_clinic",
        "confidence": 0.99,
        "abstained": False,
    },
    "standingStatus": {"value": "none", "confidence": 0.99, "abstained": False},
}


class WhiteboxRuntimeTest(unittest.TestCase):
    def test_linker_build_uses_one_alias_document_per_master_code(self) -> None:
        self.assertEqual(
            _embedding_document(
                "創傷処置",
                ["創傷処置", "創傷処置（１００ｃｍ２未満）"],
            ),
            "創傷処置 / 創傷処置 / 創傷処置（１００ｃｍ２未満）",
        )
        self.assertEqual(
            _embedding_document("聾", ["聾", "ロウ", "H919"]),
            "聾 / 聾 / ロウ / H919",
        )
        self.assertEqual(
            _embedding_document(
                "バリトゲンＨＤ　９８．６％",
                ["バリトゲンＨＤ　９８．６％", "ﾊﾞﾘﾄｹﾞﾝHD", "バリトゲンＨＤ"],
            ),
            "バリトゲンＨＤ　９８．６％ / バリトゲンＨＤ　９８．６％ / ﾊﾞﾘﾄｹﾞﾝHD",
        )

    def test_linker_document_prefix_is_applied_before_embedding(self) -> None:
        observed = []

        def embed(values):
            observed.extend(values)
            return [[1.0] for _ in values]

        prefixed = _prefixed_embedder(embed, "検索文書: ")
        self.assertEqual(prefixed(["創傷処置"]), [[1.0]])
        self.assertEqual(observed, ["検索文書: 創傷処置"])

    def test_determinism_probe_rejects_byte_different_output(self) -> None:
        calls = 0

        def changing_output():
            nonlocal calls
            calls += 1
            return [{"score": 0.9 + calls / 100}]

        with self.assertRaisesRegex(
            WhiteboxArtifactError,
            "output is not deterministic",
        ):
            verify_deterministic_inference(
                changing_output,
                label="test runtime",
            )

    def test_linker_builder_requires_build_runtime_embedding_parity(self) -> None:
        result = _validate_runtime_embedding_parity(
            [[1.0, 0.0], [0.0, 1.0]],
            [[1.0, 0.0], [0.0, 1.0]],
        )
        self.assertEqual(result["probeCount"], 2)
        self.assertEqual(result["minimumCosine"], 1.0)

        with self.assertRaisesRegex(ValueError, "embedding spaces do not match"):
            _validate_runtime_embedding_parity(
                [[1.0, 0.0]],
                [[0.0, 1.0]],
            )

    def test_artifact_rejects_checksum_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            (path / "index.json").write_text("{}", encoding="utf-8")
            manifest = self._manifest(
                "fee_master_linker",
                files={"index": {"path": "index.json", "sha256": "0" * 64}},
            )
            manifest_path = path / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(WhiteboxArtifactError, "checksum mismatch"):
                load_whitebox_artifact(
                    manifest_path,
                    expected_type="fee_master_linker",
                    required_files=("index",),
                )

    def test_artifact_requires_verified_commercial_license_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            manifest = self._manifest("fee_master_linker")
            manifest.pop("license")
            manifest_path = self._write_manifest(path, manifest)
            with self.assertRaisesRegex(
                WhiteboxArtifactError,
                "license verification is required",
            ):
                load_whitebox_artifact(
                    manifest_path,
                    expected_type="fee_master_linker",
                )

            manifest["license"] = {
                **self._license(),
                "license": "CC-BY-NC-4.0",
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(
                WhiteboxArtifactError,
                "not approved for commercial runtime use",
            ):
                load_whitebox_artifact(
                    manifest_path,
                    expected_type="fee_master_linker",
                )

            invalid_licenses = (
                (
                    {key: value for key, value in self._license().items() if key != "sourceUrl"},
                    "license field is missing: sourceUrl",
                ),
                (
                    {**self._license(), "verifiedAt": "07/25/2026"},
                    "verifiedAt must be YYYY-MM-DD",
                ),
                (
                    {**self._license(), "verifiedAt": "2999-01-01"},
                    "verifiedAt cannot be in the future",
                ),
                (
                    {**self._license(), "sourceUrl": "http://example.test/license"},
                    "sourceUrl must be an HTTPS URL",
                ),
            )
            for license_record, message in invalid_licenses:
                with self.subTest(message=message):
                    manifest["license"] = license_record
                    manifest_path.write_text(
                        json.dumps(manifest),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(WhiteboxArtifactError, message):
                        load_whitebox_artifact(
                            manifest_path,
                            expected_type="fee_master_linker",
                        )

    def test_linker_builder_rejects_unverified_license_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            output_dir = path / "artifact"
            with self.assertRaisesRegex(
                WhiteboxArtifactError,
                "not approved for commercial runtime use",
            ):
                build_linker_artifact(
                    master_db=path / "missing-master.sqlite",
                    model_dir=path / "missing-model",
                    onnx_model=None,
                    tokenizer=None,
                    output_dir=output_dir,
                    model_version="model-v1",
                    model_revision="revision-v1",
                    license_model_id="test/noncommercial",
                    license_name="CC-BY-NC-4.0",
                    license_verified_at="2026-07-25",
                    license_source_url="https://example.test/noncommercial",
                )
            self.assertFalse(output_dir.exists())

    def test_linker_groups_codes_applies_category_penalty_and_effective_date(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            index = {
                "dimension": 2,
                "entries": [
                    {
                        "code": "140000610",
                        "name": "創傷処置",
                        "kind": "procedure",
                        "category": "procedure",
                        "matchedDoc": "創部を処置",
                        "points": 52,
                        "effectiveFrom": "2026-06-01",
                        "effectiveTo": "2028-05-31",
                        "vector": [1.0, 0.0],
                    },
                    {
                        "code": "600000001",
                        "name": "創傷薬",
                        "kind": "drug",
                        "category": "medication",
                        "matchedDoc": "創傷薬",
                        "vector": [1.0, 0.0],
                    },
                    {
                        "code": "old",
                        "name": "旧処置",
                        "kind": "procedure",
                        "category": "procedure",
                        "matchedDoc": "旧処置",
                        "effectiveTo": "2025-05-31",
                        "vector": [1.0, 0.0],
                    },
                ],
            }
            index_path = path / "index.json"
            index_path.write_text(json.dumps(index), encoding="utf-8")
            manifest_path = self._write_manifest(
                path,
                self._manifest(
                    "fee_master_linker",
                    files={
                        "index": {
                            "path": "index.json",
                            "sha256": self._sha(index_path),
                        }
                    },
                    indexVersion="link-v1",
                ),
            )
            result = link_spans(
                {
                    "manifest_path": str(manifest_path),
                    "spans": [{"text": "創部を処置", "category": "procedure"}],
                    "kinds": ["procedure", "drug"],
                    "service_date": "2026-07-24",
                    "top_k": 5,
                },
                embedder=lambda values: (
                    self.assertEqual(values, ["創部を処置"])
                    or [[1.0, 0.0] for _ in values]
                ),
            )
            self.assertEqual(result["status"], "complete")
            candidates = result["results"][0]["candidates"]
            self.assertEqual([item["code"] for item in candidates], ["140000610", "600000001"])
            self.assertEqual(candidates[0]["categoryMatched"], True)
            self.assertEqual(candidates[1]["score"], 0.9)
            self.assertNotIn("old", [item["code"] for item in candidates])

    def test_linker_applies_manifest_query_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            index = {
                "dimension": 2,
                "entries": [
                    {
                        "code": "140000610",
                        "name": "創傷処置",
                        "kind": "procedure",
                        "matchedDoc": "創傷処置",
                        "vector": [1.0, 0.0],
                    }
                ],
            }
            index_path = path / "index.json"
            index_path.write_text(json.dumps(index), encoding="utf-8")
            manifest_path = self._write_manifest(
                path,
                self._manifest(
                    "fee_master_linker",
                    files={
                        "index": {
                            "path": "index.json",
                            "sha256": self._sha(index_path),
                        }
                    },
                    queryPrefix="検索クエリ: ",
                ),
            )
            observed = []

            def embed(values):
                observed.extend(values)
                return [[1.0, 0.0] for _ in values]

            result = link_spans(
                {
                    "manifest_path": str(manifest_path),
                    "spans": [{"text": "創傷処置", "category": "procedure"}],
                },
                embedder=embed,
            )
            self.assertEqual(result["status"], "complete")
            self.assertEqual(observed, ["検索クエリ: 創傷処置"])

    def test_context_contract_validates_all_axes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            manifest_path = self._write_manifest(
                path,
                self._manifest("fee_context_classifier"),
            )
            result = classify_context(
                {
                    "manifest_path": str(manifest_path),
                    "items": [{"lineId": "O-001", "spanId": "s1", "text": "処置した"}],
                },
                classifier=lambda items: [{"axes": CURRENT_AXES} for _ in items],
            )
            self.assertEqual(result["status"], "complete")
            self.assertEqual(
                result["results"][0]["axes"]["actionStatus"]["value"],
                "performed",
            )

    def test_context_marks_the_exact_repeated_span_from_offsets(self) -> None:
        text = "前回CTを確認し、本日はCTを施行"
        second_start = text.rindex("CT")
        marked = _classifier_text({
            "text": text,
            "spanText": "CT",
            "charStart": second_start,
            "charEnd": second_start + 2,
            "previousLine": "",
            "nextLine": "",
        })
        self.assertEqual(marked, "前回CTを確認し、本日は[SPAN]CT[/SPAN]を施行")

    def test_context_contract_rejects_mismatched_span_offsets(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            manifest_path = self._write_manifest(
                path,
                self._manifest("fee_context_classifier"),
            )
            result = classify_context(
                {
                    "manifest_path": str(manifest_path),
                    "items": [{
                        "lineId": "O-001",
                        "spanId": "s1",
                        "text": "前回CT、本日採血",
                        "spanText": "採血",
                        "charStart": 2,
                        "charEnd": 4,
                    }],
                },
                classifier=lambda items: [{"axes": CURRENT_AXES} for _ in items],
            )
            self.assertEqual(result["status"], "model_unavailable")
            self.assertIn("does not match", result["reason"])

    def test_span_contract_checks_offsets_against_source(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            manifest_path = self._write_manifest(
                path,
                self._manifest("fee_span_detector"),
            )
            result = detect_spans(
                {
                    "manifest_path": str(manifest_path),
                    "lines": [{"lineId": "O-001", "text": "創傷処置を施行"}],
                },
                detector=lambda lines: [{
                    "relevance": "relevant",
                    "relevanceConfidence": 0.99,
                    "spans": [{
                        "charStart": 0,
                        "charEnd": 4,
                        "text": "創傷処置",
                        "category": "procedure",
                        "confidence": 0.98,
                    }],
                }],
            )
            self.assertEqual(result["status"], "complete")
            self.assertEqual(result["results"][0]["spans"][0]["text"], "創傷処置")

    def test_missing_artifacts_return_explicit_unavailable_envelopes(self) -> None:
        self.assertEqual(
            link_spans({"manifest_path": "/missing", "spans": []})["status"],
            "index_unavailable",
        )
        self.assertEqual(
            classify_context({"manifest_path": "/missing", "items": []})["status"],
            "model_unavailable",
        )
        self.assertEqual(
            detect_spans({"manifest_path": "/missing", "lines": []})["status"],
            "model_unavailable",
        )

    def test_span_readiness_requires_a_successful_inference_probe(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            manifest_path = self._write_runtime_manifest(
                path,
                "fee_span_detector",
                backend="onnx_token_classifier",
                entityTypes=["procedure"],
                tokenLabels=["O", "B-procedure", "I-procedure"],
                relevanceLabels=["relevant", "irrelevant", "abstain"],
                tokenLogitsOutputName="token_logits",
                relevanceLogitsOutputName="relevance_logits",
            )
            with (
                patch(
                    "medical_fee_calculation.whitebox_span.runtime_dependency_status",
                    return_value={"available": True},
                ),
                patch(
                    "medical_fee_calculation.whitebox_span._load_onnx_span_runtime",
                    return_value=SimpleNamespace(
                        detect=lambda lines: [{
                            "relevance": "relevant",
                            "spans": [{
                                "text": "採血",
                                "category": "lab",
                            }],
                        } for _ in lines]
                    ),
                ),
            ):
                result = span_detector_readiness(manifest_path)
            self.assertTrue(result["available"])
            self.assertEqual(result["inferenceProbe"], "passed")
            self.assertEqual(result["semanticProbe"], "passed")
            self.assertEqual(result["determinismProbe"]["repeatCount"], 2)

            with (
                patch(
                    "medical_fee_calculation.whitebox_span.runtime_dependency_status",
                    return_value={"available": True},
                ),
                patch(
                    "medical_fee_calculation.whitebox_span._load_onnx_span_runtime",
                    return_value=SimpleNamespace(
                        detect=lambda lines: [{
                            "relevance": "irrelevant",
                            "spans": [],
                        } for _ in lines]
                    ),
                ),
            ):
                result = span_detector_readiness(manifest_path)
            self.assertFalse(result["available"])
            self.assertIn("semantic probe", result["reason"])

            probe_calls = 0

            def changing_probe(lines):
                nonlocal probe_calls
                probe_calls += 1
                return [
                    {
                        "relevance": "relevant",
                        "spans": [{
                            "text": "採血",
                            "category": "lab",
                        }],
                        "probeCall": probe_calls,
                    }
                    for _ in lines
                ]

            with (
                patch(
                    "medical_fee_calculation.whitebox_span.runtime_dependency_status",
                    return_value={"available": True},
                ),
                patch(
                    "medical_fee_calculation.whitebox_span._load_onnx_span_runtime",
                    return_value=SimpleNamespace(detect=changing_probe),
                ),
            ):
                result = span_detector_readiness(manifest_path)
            self.assertFalse(result["available"])
            self.assertIn("not deterministic", result["reason"])

            with (
                patch(
                    "medical_fee_calculation.whitebox_span.runtime_dependency_status",
                    return_value={"available": True},
                ),
                patch(
                    "medical_fee_calculation.whitebox_span._load_onnx_span_runtime",
                    side_effect=WhiteboxArtifactError("broken span model"),
                ),
            ):
                result = span_detector_readiness(manifest_path)
            self.assertFalse(result["available"])
            self.assertIn("broken span model", result["reason"])

    def test_context_readiness_requires_a_successful_inference_probe(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            axes = clinical_axis_values()
            manifest_path = self._write_runtime_manifest(
                path,
                "fee_context_classifier",
                backend="onnx_multi_axis",
                axisLabels={key: list(value) for key, value in axes.items()},
                outputNames={key: f"{key}_logits" for key in axes},
            )
            with (
                patch(
                    "medical_fee_calculation.whitebox_context.runtime_dependency_status",
                    return_value={"available": True},
                ),
                patch(
                    "medical_fee_calculation.whitebox_context._load_onnx_context_runtime",
                    return_value=SimpleNamespace(
                        classify=lambda items: [{"axes": CURRENT_AXES} for _ in items]
                    ),
                ),
            ):
                result = context_classifier_readiness(manifest_path)
            self.assertTrue(result["available"])
            self.assertEqual(result["inferenceProbe"], "passed")
            self.assertEqual(result["semanticProbe"], "passed")
            self.assertEqual(result["determinismProbe"]["repeatCount"], 2)

            abstained_axes = {
                **CURRENT_AXES,
                "actionStatus": {
                    "value": "performed",
                    "confidence": 0.8,
                    "abstained": True,
                },
            }
            with (
                patch(
                    "medical_fee_calculation.whitebox_context.runtime_dependency_status",
                    return_value={"available": True},
                ),
                patch(
                    "medical_fee_calculation.whitebox_context._load_onnx_context_runtime",
                    return_value=SimpleNamespace(
                        classify=lambda items: [
                            {"axes": abstained_axes}
                            for _ in items
                        ]
                    ),
                ),
            ):
                result = context_classifier_readiness(manifest_path)
            self.assertFalse(result["available"])
            self.assertIn("semantic probe", result["reason"])

    def test_linker_readiness_rejects_encoder_index_dimension_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            index_path = path / "index.json"
            index_path.write_text(
                json.dumps({
                    "dimension": 2,
                    "entries": [{
                        "code": "140000610",
                        "name": "創傷処置",
                        "kind": "procedure",
                        "matchedDoc": "創傷処置",
                        "vector": [1.0, 0.0],
                    }],
                }),
                encoding="utf-8",
            )
            manifest_path = self._write_runtime_manifest(
                path,
                "fee_master_linker",
                backend="onnx_sentence_encoder",
                dimension=3,
                pooling="mean",
                extra_files={"index": index_path},
            )
            with (
                patch(
                    "medical_fee_calculation.whitebox_linker.runtime_dependency_status",
                    return_value={"available": True},
                ),
                patch(
                    "medical_fee_calculation.whitebox_linker._load_onnx_embedder",
                    return_value=SimpleNamespace(
                        encode=lambda texts: [[1.0, 0.0, 0.0] for _ in texts]
                    ),
                ),
            ):
                result = linker_readiness(manifest_path)
            self.assertFalse(result["available"])
            self.assertIn("dimension does not match", result["reason"])

    @staticmethod
    def _manifest(artifact_type: str, **extra):
        return {
            "schemaVersion": 1,
            "artifactType": artifact_type,
            "artifactVersion": "artifact-v1",
            "modelVersion": "model-v1",
            "modelRevision": "immutable-revision",
            "license": WhiteboxRuntimeTest._license(),
            "backend": "test-injected",
            "files": {},
            **extra,
        }

    @staticmethod
    def _license():
        return {
            "modelId": "test/whitebox-model",
            "license": "Apache-2.0",
            "verifiedAt": "2026-07-25",
            "sourceUrl": "https://example.test/whitebox-model/license",
        }

    @staticmethod
    def _write_manifest(path: Path, manifest) -> Path:
        manifest_path = path / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path

    def _write_runtime_manifest(
        self,
        path: Path,
        artifact_type: str,
        *,
        backend: str,
        extra_files: dict[str, Path] | None = None,
        **extra,
    ) -> Path:
        model_path = path / "model.onnx"
        tokenizer_path = path / "tokenizer.json"
        model_path.write_bytes(b"test-onnx")
        tokenizer_path.write_text("{}", encoding="utf-8")
        files = {
            "model": {
                "path": model_path.name,
                "sha256": self._sha(model_path),
            },
            "tokenizer": {
                "path": tokenizer_path.name,
                "sha256": self._sha(tokenizer_path),
            },
        }
        for key, file_path in (extra_files or {}).items():
            files[key] = {
                "path": file_path.name,
                "sha256": self._sha(file_path),
            }
        return self._write_manifest(
            path,
            self._manifest(
                artifact_type,
                backend=backend,
                files=files,
                **extra,
            ),
        )

    @staticmethod
    def _sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
