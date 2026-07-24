from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.wx_retrain import (
    CommandResult,
    RetrainingGateError,
    RetrainingPipelineError,
    run_pipeline,
)


class WhiteboxRetrainingPipelineTest(unittest.TestCase):
    def test_synthetic_pipeline_runs_gates_registers_artifacts_and_deploys_shadow(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = self._fixture(root)
            calls = []

            def runner(command, working_dir, environment, timeout_seconds):
                calls.append({
                    "command": list(command),
                    "environment": dict(environment),
                    "timeout": timeout_seconds,
                    "workingDirectory": working_dir,
                })
                return CommandResult(returncode=0, duration_ms=5)

            result = run_pipeline(
                config,
                repo_root=root,
                output_dir=root / "docs" / "run",
                apply=True,
                allow_stg_shadow_deploy=True,
                command_runner=runner,
            )

            self.assertEqual(result["status"], "complete")
            self.assertEqual(len(result["gates"]), 5)
            self.assertTrue(all(gate["passed"] for gate in result["gates"]))
            self.assertEqual(
                {artifact["layer"] for artifact in result["artifacts"]},
                {"wx1", "wx2", "wx3"},
            )
            self.assertEqual(result["deployment"]["status"], "complete")
            deployment = calls[-1]
            self.assertEqual(deployment["environment"]["TARGET_ENV"], "stg")
            self.assertEqual(
                deployment["environment"]["FEE_SPAN_DETECTOR_MODE_STG"],
                "shadow",
            )
            self.assertEqual(
                deployment["environment"]["FEE_LINKER_MODE_STG"],
                "shadow",
            )
            self.assertEqual(
                deployment["environment"]["FEE_CONTEXT_CLASSIFIER_MODE_STG"],
                "shadow",
            )
            self.assertTrue((root / "docs" / "run" / "run.json").is_file())
            self.assertTrue((root / "docs" / "run" / "README.md").is_file())
            for layer, artifact_type in {
                "wx1": "fee_span_detector",
                "wx2": "fee_master_linker",
                "wx3": "fee_context_classifier",
            }.items():
                registered_root = (
                    root
                    / "python"
                    / "data"
                    / "whitebox"
                    / "registry"
                    / artifact_type
                    / f"{layer}-v1"
                )
                self.assertTrue((registered_root / "manifest.json").is_file())
                self.assertTrue((registered_root / "model.bin").is_file())
                self.assertFalse((registered_root / "training.log").exists())

    def test_failed_gate_blocks_registration_and_deployment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = self._fixture(root)
            report_path = root / "reports" / "counterexamples.json"
            report_path.write_text('{"passed": false}\n', encoding="utf-8")
            calls = []

            def runner(command, working_dir, environment, timeout_seconds):
                calls.append(list(command))
                return CommandResult(returncode=0)

            with self.assertRaises(RetrainingGateError):
                run_pipeline(
                    config_path,
                    repo_root=root,
                    output_dir=root / "docs" / "blocked",
                    apply=True,
                    allow_stg_shadow_deploy=True,
                    command_runner=runner,
                )

            summary = json.loads(
                (root / "docs" / "blocked" / "run.json").read_text(encoding="utf-8")
            )
            self.assertEqual(summary["status"], "blocked")
            self.assertEqual(summary["artifacts"], [])
            self.assertFalse((root / "python" / "data" / "whitebox").exists())
            self.assertNotIn(["deploy-fee-api-stg", "--apply"], calls)

    def test_production_or_active_mode_configuration_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = self._fixture(root)
            config = json.loads(config_path.read_text(encoding="utf-8"))
            config["targetEnvironment"] = "prod"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(
                RetrainingPipelineError,
                "targetEnvironment must be stg",
            ):
                run_pipeline(
                    config_path,
                    repo_root=root,
                    output_dir=root / "docs" / "plan",
                )

    def test_non_synthetic_training_manifest_is_rejected_before_promotion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = self._fixture(root)
            training_manifest = root / "generated" / "training-data.json"
            training_manifest.write_text(
                json.dumps({
                    "syntheticDataOnly": False,
                    "containsClinicalProductionData": True,
                }),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                RetrainingPipelineError,
                "syntheticDataOnly=true",
            ):
                run_pipeline(
                    config_path,
                    repo_root=root,
                    output_dir=root / "docs" / "blocked",
                    apply=True,
                    command_runner=lambda *unused: CommandResult(returncode=0),
                )

    def _fixture(self, root: Path) -> Path:
        (root / "generated").mkdir(parents=True)
        (root / "reports").mkdir()
        training_manifest = root / "generated" / "training-data.json"
        training_manifest.write_text(
            json.dumps({
                "syntheticDataOnly": True,
                "containsClinicalProductionData": False,
                "caseCount": 12,
            }),
            encoding="utf-8",
        )
        reports = {
            "gold_seed_300": {"passed": True},
            "soap_e2e_exact": {"passed": True},
            "stability": {"deterministicRunCount": 100, "candidateVariance": 0},
            "specialty_matrix": {"nonRegression": True},
            "counterexamples": {"passed": True},
        }
        for name, value in reports.items():
            (root / "reports" / f"{name}.json").write_text(
                json.dumps(value),
                encoding="utf-8",
            )
        artifact_paths = {}
        for layer, artifact_type in {
            "wx1": "fee_span_detector",
            "wx2": "fee_master_linker",
            "wx3": "fee_context_classifier",
        }.items():
            artifact_root = root / "generated" / layer
            artifact_root.mkdir()
            model = artifact_root / "model.bin"
            model.write_bytes(f"{layer}-model".encode("ascii"))
            (artifact_root / "training.log").write_text(
                "must not be promoted",
                encoding="utf-8",
            )
            manifest = {
                "schemaVersion": 1,
                "artifactType": artifact_type,
                "artifactVersion": f"{layer}-v1",
                "modelVersion": f"{layer}-model-v1",
                "modelRevision": "immutable-test-revision",
                "backend": "test-injected",
                "files": {
                    "model": {
                        "path": "model.bin",
                        "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
                    }
                },
            }
            manifest_path = artifact_root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            artifact_paths[layer] = manifest_path.relative_to(root).as_posix()

        gate_assertions = {
            "gold_seed_300": [
                {"purpose": "passed", "path": "passed", "op": "eq", "value": True}
            ],
            "soap_e2e_exact": [
                {"purpose": "passed", "path": "passed", "op": "eq", "value": True}
            ],
            "stability": [
                {
                    "purpose": "determinism_100",
                    "path": "deterministicRunCount",
                    "op": "gte",
                    "value": 100,
                },
                {
                    "purpose": "zero_variance",
                    "path": "candidateVariance",
                    "op": "eq",
                    "value": 0,
                },
            ],
            "specialty_matrix": [
                {
                    "purpose": "non_regression",
                    "path": "nonRegression",
                    "op": "eq",
                    "value": True,
                }
            ],
            "counterexamples": [
                {"purpose": "passed", "path": "passed", "op": "eq", "value": True}
            ],
        }
        config = {
            "schemaVersion": 1,
            "syntheticDataOnly": True,
            "trainingDataPolicy": "synthetic_only",
            "targetEnvironment": "stg",
            "deploymentMode": "shadow",
            "trainingDataManifest": "generated/training-data.json",
            "artifactRegistryRoot": "python/data/whitebox/registry",
            "stages": [
                {
                    "name": kind,
                    "kind": kind,
                    "command": ["fake-stage", kind],
                }
                for kind in (
                    "synthetic_data",
                    "train_wx1",
                    "build_wx2",
                    "train_wx3",
                )
            ],
            "gates": [
                {
                    "name": kind,
                    "kind": kind,
                    "command": ["fake-gate", kind],
                    "resultPath": f"reports/{kind}.json",
                    "assertions": gate_assertions[kind],
                }
                for kind in (
                    "gold_seed_300",
                    "soap_e2e_exact",
                    "stability",
                    "specialty_matrix",
                    "counterexamples",
                )
            ],
            "artifacts": [
                {"layer": layer, "manifestPath": artifact_paths[layer]}
                for layer in ("wx1", "wx2", "wx3")
            ],
            "deployment": {
                "command": ["deploy-fee-api-stg", "--apply"],
            },
        }
        config_path = root / "retrain.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        return config_path


if __name__ == "__main__":
    unittest.main()
