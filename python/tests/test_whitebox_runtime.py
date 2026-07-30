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
    CLAUSE_AWARE_INPUT_CONTRACT_VERSION,
    CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
    CLAUSE_SEGMENTATION_VERSION_MISMATCH,
    CLAUSE_SEGMENTATION_VERSION_MISSING,
    CONTEXT_INPUT_CONTRACT_VERSION_MISMATCH,
    RUNTIME_CONTEXT_INPUT_SEMANTICS,
    STRUCTURED_INPUT_CONTRACT_VERSION,
    _classifier_text,
    classify_context,
    context_artifact_runtime_compatibility,
    context_input_semantics,
    context_classifier_readiness,
)
from medical_fee_calculation.whitebox_linker import linker_readiness, link_spans
from medical_fee_calculation.whitebox_onnx import verify_deterministic_inference
from medical_fee_calculation.whitebox_span import (
    detect_spans,
    span_detector_readiness,
)
from scripts.build_fee_linker_index import (
    _annotate_family_members,
    _drug_family_identity,
    _embedding_document,
    _family_statistics,
    _prefixed_embedder,
    _procedure_family_identity,
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

    def test_linker_distinguishes_medication_billing_acts_from_drug_products(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            index = {
                "dimension": 2,
                "entries": [
                    {
                        "code": "120002910",
                        "name": "処方箋料（リフィル以外・その他）",
                        "kind": "procedure",
                        "category": "medication",
                        "matchedDoc": "処方箋料 / 院外処方箋",
                        "vector": [0.0, 1.0],
                    },
                    {
                        "code": "620000001",
                        "name": "院外処方錠",
                        "kind": "drug",
                        "category": "medication",
                        "matchedDoc": "院外処方錠",
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
                ),
            )
            result = link_spans(
                {
                    "manifest_path": str(manifest_path),
                    "spans": [{
                        "text": "院外処方箋",
                        "category": "medication",
                        "mentionType": "medication_act",
                        "lineText": "院外処方箋を発行。",
                        "section": "P",
                        "encounterSetting": "outpatient",
                        "specialty": "internal_medicine",
                    }],
                    "kinds": ["procedure", "drug"],
                    "top_k": 2,
                },
                embedder=lambda values: [[1.0, 0.0] for _ in values],
            )

            candidates = result["results"][0]["candidates"]
            self.assertEqual(candidates[0]["code"], "120002910")
            self.assertEqual(candidates[0]["lexicalMatch"], "exact")
            self.assertTrue(candidates[0]["mentionTypeMatched"])
            self.assertFalse(candidates[1]["mentionTypeMatched"])
            self.assertEqual(result["results"][0]["mentionType"], "medication_act")

    def test_linker_prefers_an_exact_drug_product_over_a_semantic_procedure(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            index = {
                "dimension": 2,
                "entries": [
                    {
                        "code": "120001210",
                        "name": "処方料（その他）",
                        "kind": "procedure",
                        "category": "medication",
                        "matchedDoc": "処方料",
                        "vector": [1.0, 0.0],
                    },
                    {
                        "code": "620007818",
                        "name": "アムロジピンOD錠5mg「トーワ」",
                        "kind": "drug",
                        "category": "medication",
                        "matchedDoc": "アムロジピンOD錠5mg「トーワ」 / アムロジピンOD錠5mg",
                        "vector": [0.0, 1.0],
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
                ),
            )
            result = link_spans(
                {
                    "manifest_path": str(manifest_path),
                    "spans": [{
                        "text": "アムロジピンOD錠5mg",
                        "category": "medication",
                        "mentionType": "drug_product",
                    }],
                    "kinds": ["procedure", "drug"],
                    "top_k": 2,
                },
                embedder=lambda values: [[1.0, 0.0] for _ in values],
            )

            candidates = result["results"][0]["candidates"]
            self.assertEqual(candidates[0]["code"], "620007818")
            self.assertEqual(candidates[0]["kind"], "drug")
            self.assertEqual(candidates[0]["lexicalMatch"], "exact")
            self.assertTrue(candidates[0]["mentionTypeMatched"])

    def test_linker_reports_family_margin_without_selecting_a_family_member(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            family_key = "drug|reimbursement:amlodipine-2.5|dosage-form:tablet|unit:tablet"
            index = {
                "dimension": 2,
                "entries": [
                    {
                        "code": "620007817",
                        "name": "アムロジピンOD錠2.5mg「トーワ」",
                        "kind": "drug",
                        "category": "medication",
                        "matchedDoc": "アムロジピンOD錠2.5mg",
                        "familyKey": family_key,
                        "familySource": "reimbursement_code",
                        "familyMemberCount": 2,
                        "vector": [1.0, 0.0],
                    },
                    {
                        "code": "621931301",
                        "name": "アムロジピンOD錠2.5mg「TCK」",
                        "kind": "drug",
                        "category": "medication",
                        "matchedDoc": "アムロジピンOD錠2.5mg",
                        "familyKey": family_key,
                        "familySource": "reimbursement_code",
                        "familyMemberCount": 2,
                        "vector": [0.999, 0.0447],
                    },
                    {
                        "code": "620000001",
                        "name": "別成分錠",
                        "kind": "drug",
                        "category": "medication",
                        "matchedDoc": "別成分錠",
                        "familyKey": "drug|reimbursement:other|dosage-form:tablet|unit:tablet",
                        "familySource": "reimbursement_code",
                        "familyMemberCount": 1,
                        "vector": [0.8, 0.6],
                    },
                ],
            }
            manifest_path = self._write_linker_index(path, index)
            result = link_spans(
                {
                    "manifest_path": str(manifest_path),
                    "spans": [{
                        "text": "アムロジピンOD錠2.5mg",
                        "category": "medication",
                        "mentionType": "drug_product",
                    }],
                    "kinds": ["drug"],
                    "top_k": 3,
                },
                embedder=lambda values: [[1.0, 0.0] for _ in values],
            )["results"][0]

            self.assertLess(result["margin"], 0.01)
            self.assertGreater(result["familyMargin"], 0.1)
            self.assertEqual(result["topFamilyKey"], family_key)
            self.assertEqual(result["topFamilyMemberCount"], 2)
            self.assertTrue(result["topFamilyReviewable"])
            self.assertEqual(
                {member["code"] for member in result["topFamilyMembers"]},
                {"620007817", "621931301"},
            )

    def test_linker_boundary_snap_requires_one_unique_longest_family_alias(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            index = {
                "dimension": 2,
                "entries": [{
                    "code": "160008010",
                    "name": "末梢血液一般検査",
                    "kind": "procedure",
                    "category": "lab",
                    "matchedDoc": "末梢血液一般検査",
                    "familyKey": "procedure|blood-count",
                    "familySource": "point_table_hierarchy_and_core",
                    "familyMemberCount": 1,
                    "vector": [1.0, 0.0],
                }],
            }
            manifest_path = self._write_linker_index(path, index)
            observed = []
            result = link_spans(
                {
                    "manifest_path": str(manifest_path),
                    "spans": [{
                        "lineId": "O-001",
                        "lineText": "末梢血液一般検査を実施",
                        "charStart": 1,
                        "charEnd": 8,
                        "text": "梢血液一般検査",
                        "category": "exam",
                        "mentionType": "procedure_act",
                    }],
                    "kinds": ["procedure"],
                },
                embedder=lambda values: (
                    observed.extend(values)
                    or [[1.0, 0.0] for _ in values]
                ),
            )["results"][0]

            self.assertEqual(observed, ["末梢血液一般検査"])
            self.assertEqual(result["resolvedSpan"]["charStart"], 0)
            self.assertEqual(result["resolvedSpan"]["charEnd"], 8)
            self.assertTrue(result["resolvedSpan"]["boundarySnapped"])

            ambiguous = {
                **index,
                "entries": [
                    index["entries"][0],
                    {
                        **index["entries"][0],
                        "code": "160008011",
                        "familyKey": "procedure|different-family",
                    },
                ],
            }
            ambiguous_path = path / "ambiguous"
            ambiguous_path.mkdir()
            ambiguous_manifest = self._write_linker_index(ambiguous_path, ambiguous)
            observed.clear()
            ambiguous_result = link_spans(
                {
                    "manifest_path": str(ambiguous_manifest),
                    "spans": [{
                        "lineId": "O-001",
                        "lineText": "末梢血液一般検査を実施",
                        "charStart": 1,
                        "charEnd": 8,
                        "text": "梢血液一般検査",
                        "category": "exam",
                        "mentionType": "procedure_act",
                    }],
                    "kinds": ["procedure"],
                },
                embedder=lambda values: (
                    observed.extend(values)
                    or [[1.0, 0.0] for _ in values]
                ),
            )["results"][0]
            self.assertEqual(observed, ["梢血液一般検査"])
            self.assertFalse(ambiguous_result["resolvedSpan"]["boundarySnapped"])

            observed.clear()
            offset_mismatch_result = link_spans(
                {
                    "manifest_path": str(manifest_path),
                    "spans": [{
                        "lineId": "O-001",
                        "lineText": "末梢血液一般検査を実施",
                        "charStart": 0,
                        "charEnd": 7,
                        "text": "梢血液一般検査",
                        "category": "exam",
                        "mentionType": "procedure_act",
                    }],
                    "kinds": ["procedure"],
                },
                embedder=lambda values: (
                    observed.extend(values)
                    or [[1.0, 0.0] for _ in values]
                ),
            )["results"][0]
            self.assertEqual(observed, ["梢血液一般検査"])
            self.assertFalse(offset_mismatch_result["resolvedSpan"]["boundarySnapped"])
            self.assertEqual(
                offset_mismatch_result["resolvedSpan"]["snapReason"],
                "original_span_offset_mismatch",
            )

    def test_linker_family_rules_use_structured_master_identity_and_flag_broad_groups(
        self,
    ) -> None:
        drug_base = {
            "name": "アムロジピンOD錠2.5mg「トーワ」",
            "reimbursement_code": "AML25",
            "product_related_code": "",
            "dosage_form": "tablet",
            "unit_code": "tablet",
        }
        self.assertEqual(
            _drug_family_identity(drug_base)["familyKey"],
            _drug_family_identity({
                **drug_base,
                "name": "アムロジピンOD錠2.5mg「TCK」",
            })["familyKey"],
        )
        procedure_base = {
            "chapter": "3",
            "part": "1",
            "alpha_part": "D",
            "section": "1",
            "branch": "1",
        }
        prescription_a = _procedure_family_identity({
            **procedure_base,
            "short_name": "処方箋料（リフィル処方箋以外の場合）",
        })
        prescription_b = _procedure_family_identity({
            **procedure_base,
            "short_name": "処方箋料（リフィル処方箋の場合）",
        })
        self.assertEqual(prescription_a["familyKey"], prescription_b["familyKey"])
        self.assertNotEqual(
            _procedure_family_identity({
                **procedure_base,
                "short_name": "末梢血液一般検査",
            })["familyKey"],
            _procedure_family_identity({
                **procedure_base,
                "short_name": "末梢血液像（鏡検法）",
            })["familyKey"],
        )

        documents = _annotate_family_members([
            {
                "kind": "procedure",
                "code": str(index),
                "familyKey": "procedure|broad",
            }
            for index in range(26)
        ])
        self.assertTrue(all(item["familyMemberCount"] == 26 for item in documents))
        statistics = _family_statistics(documents)
        self.assertEqual(statistics["overReviewLimitCount"], 1)
        self.assertEqual(statistics["maximumMemberCount"], 26)

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
                    "items": [{
                        "lineId": "O-001",
                        "spanId": "s1",
                        "text": "処置した",
                        "inputSemantics": RUNTIME_CONTEXT_INPUT_SEMANTICS,
                    }],
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

    def test_context_v2_prefixes_structured_encounter_metadata(self) -> None:
        marked = _classifier_text({
            "text": "採血を実施。",
            "spanText": "採血",
            "charStart": 0,
            "charEnd": 2,
            "previousLine": "S）発熱あり。",
            "nextLine": "A）感染症疑い。",
            "section": "O",
            "encounterSetting": "home_visit",
            "specialty": "internal_medicine",
            "sourceType": "clinical_note",
        }, input_contract_version=STRUCTURED_INPUT_CONTRACT_VERSION)
        self.assertEqual(
            marked,
            "\n".join([
                "[SETTING]home_visit[/SETTING]",
                "[SPECIALTY]internal_medicine[/SPECIALTY]",
                "[SECTION]O[/SECTION]",
                "[SOURCE]clinical_note[/SOURCE]",
                "S）発熱あり。",
                "[SPAN]採血[/SPAN]を実施。",
                "A）感染症疑い。",
            ]),
        )

    def test_context_v3_marks_the_span_in_its_clause_and_keeps_parent_line(self) -> None:
        line = "前回CTを確認し、本日は採血を実施。次回MRIを予定。"
        clause = "本日は採血を実施。"
        marked = _classifier_text({
            "text": line,
            "parentLineText": line,
            "spanText": "採血",
            "charStart": line.index("採血"),
            "charEnd": line.index("採血") + 2,
            "clauseText": clause,
            "clauseSpanCharStart": clause.index("採血"),
            "clauseSpanCharEnd": clause.index("採血") + 2,
            "section": "O",
            "encounterSetting": "outpatient",
            "specialty": "internal_medicine",
            "sourceType": "clinical_note",
        }, input_contract_version=CLAUSE_AWARE_INPUT_CONTRACT_VERSION)
        self.assertIn(f"[LINE]{line}[/LINE]", marked)
        self.assertIn(
            "[CLAUSE]本日は[SPAN]採血[/SPAN]を実施。[/CLAUSE]",
            marked,
        )

    def test_context_v4_compatibility_reason_priority_is_fixed(self) -> None:
        self.assertEqual(
            context_artifact_runtime_compatibility({
                "inputContractVersion": 1,
            })["reasonCode"],
            CONTEXT_INPUT_CONTRACT_VERSION_MISMATCH,
        )
        self.assertEqual(
            context_artifact_runtime_compatibility({
                "inputContractVersion": CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
            })["reasonCode"],
            CLAUSE_SEGMENTATION_VERSION_MISSING,
        )
        self.assertEqual(
            context_artifact_runtime_compatibility({
                "inputContractVersion": CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
                "inputSemantics": {
                    **RUNTIME_CONTEXT_INPUT_SEMANTICS,
                    "clauseSegmentationVersion": "fee-evidence-clause-v1",
                },
            })["reasonCode"],
            CLAUSE_SEGMENTATION_VERSION_MISMATCH,
        )
        self.assertTrue(
            context_artifact_runtime_compatibility({
                "inputContractVersion": CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
                "inputSemantics": RUNTIME_CONTEXT_INPUT_SEMANTICS,
            })["compatible"]
        )

    def test_historical_wx3_artifact_is_rejected_by_contract_before_runtime_load(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        manifest = json.loads(
            (
                repository_root
                / "python/data/whitebox/context-wx3-multilingual-minilm-l12-v3/manifest.json"
            ).read_text(encoding="utf-8")
        )
        compatibility = context_artifact_runtime_compatibility(manifest)

        self.assertFalse(compatibility["compatible"])
        self.assertEqual(
            compatibility["reasonCode"],
            CONTEXT_INPUT_CONTRACT_VERSION_MISMATCH,
        )

    def test_context_v4_rejects_runtime_payload_with_wrong_semantics(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            manifest_path = self._write_manifest(
                path,
                self._manifest(
                    "fee_context_classifier",
                    inputContractVersion=CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
                    inputSemantics=context_input_semantics(
                        CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION
                    ),
                ),
            )
            result = classify_context({
                "manifest_path": str(manifest_path),
                "items": [{
                    "lineId": "O-001",
                    "spanId": "span-1",
                    "text": "採血を実施。",
                    "spanText": "採血",
                    "charStart": 0,
                    "charEnd": 2,
                    "parentLineText": "採血を実施。",
                    "clauseText": "採血を実施。",
                    "clauseCharStart": 0,
                    "clauseCharEnd": 6,
                    "clauseSpanCharStart": 0,
                    "clauseSpanCharEnd": 2,
                    "inputSemantics": {
                        **RUNTIME_CONTEXT_INPUT_SEMANTICS,
                        "offsetBasis": "clause",
                    },
                }],
            }, classifier=lambda items: [{"axes": CURRENT_AXES} for _ in items])
            self.assertEqual(result["status"], "model_unavailable")
            self.assertIn("inputSemantics", result["reason"])

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
                        "inputSemantics": RUNTIME_CONTEXT_INPUT_SEMANTICS,
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
            self.assertEqual(
                result["results"][0]["spans"][0]["detectionThreshold"],
                0.5,
            )

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

    def test_context_readiness_reports_contract_mismatch_without_loading_onnx(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)
            axes = clinical_axis_values()
            manifest_path = self._write_runtime_manifest(
                path,
                "fee_context_classifier",
                backend="onnx_multi_axis",
                inputContractVersion=1,
                inputSemantics=None,
                axisLabels={key: list(value) for key, value in axes.items()},
                outputNames={key: f"{key}_logits" for key in axes},
            )
            with patch(
                "medical_fee_calculation.whitebox_context._load_onnx_context_runtime"
            ) as runtime_loader:
                result = context_classifier_readiness(manifest_path)

            self.assertFalse(result["available"])
            self.assertEqual(
                result["reasonCode"],
                CONTEXT_INPUT_CONTRACT_VERSION_MISMATCH,
            )
            runtime_loader.assert_not_called()

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
        manifest = {
            "schemaVersion": 1,
            "artifactType": artifact_type,
            "artifactVersion": "artifact-v1",
            "modelVersion": "model-v1",
            "modelRevision": "immutable-revision",
            "license": WhiteboxRuntimeTest._license(),
            "backend": "test-injected",
            "files": {},
        }
        if artifact_type == "fee_context_classifier":
            manifest.update({
                "inputContractVersion": CLAUSE_AWARE_V2_INPUT_CONTRACT_VERSION,
                "inputSemantics": RUNTIME_CONTEXT_INPUT_SEMANTICS,
            })
        manifest.update(extra)
        return manifest

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

    def _write_linker_index(self, path: Path, index: dict) -> Path:
        index_path = path / "index.json"
        index_path.write_text(json.dumps(index), encoding="utf-8")
        return self._write_manifest(
            path,
            self._manifest(
                "fee_master_linker",
                files={
                    "index": {
                        "path": "index.json",
                        "sha256": self._sha(index_path),
                    }
                },
            ),
        )

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
