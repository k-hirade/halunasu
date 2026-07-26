from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts.manage_fee_whitebox_artifact import (
    WhiteboxArtifactDistributionError,
    _remote_artifact_version,
    fetch_artifact,
    immutable_remote_manifest_uri,
    install_artifact,
    verify_artifact,
)


class ManageFeeWhiteboxArtifactTest(unittest.TestCase):
    def test_verify_and_install_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_manifest = self._write_artifact(root / "source", b"model-v1")
            artifact = verify_artifact(
                source_manifest,
                expected_type="fee_span_detector",
            )
            destination_manifest = root / "destination" / "manifest.json"
            install_artifact(artifact, destination_manifest=destination_manifest)

            installed = verify_artifact(
                destination_manifest,
                expected_type="fee_span_detector",
            )
            self.assertEqual(installed.artifact_version, "test-v1")
            self.assertEqual(
                (destination_manifest.parent / "runtime/model.bin").read_bytes(),
                b"model-v1",
            )

    def test_install_is_idempotent_but_rejects_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_manifest = self._write_artifact(root / "source", b"model-v1")
            artifact = verify_artifact(
                source_manifest,
                expected_type="fee_span_detector",
            )
            destination_manifest = root / "destination" / "manifest.json"
            install_artifact(artifact, destination_manifest=destination_manifest)
            install_artifact(artifact, destination_manifest=destination_manifest)

            target = destination_manifest.parent / "runtime/model.bin"
            target.write_bytes(b"mutated")
            with self.assertRaisesRegex(
                WhiteboxArtifactDistributionError,
                "destination artifact file differs",
            ):
                install_artifact(artifact, destination_manifest=destination_manifest)

    def test_remote_uri_is_versioned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest = self._write_artifact(Path(temporary), b"model-v1")
            artifact = verify_artifact(
                manifest,
                expected_type="fee_span_detector",
            )
            self.assertEqual(
                immutable_remote_manifest_uri(
                    artifact,
                    "gs://example/whitebox/",
                ),
                "gs://example/whitebox/fee_span_detector/test-v1/manifest.json",
            )

    def test_remote_uri_version_must_match_the_expected_artifact_contract(self) -> None:
        self.assertEqual(
            _remote_artifact_version(
                "gs://example/whitebox/fee_master_linker/test-v1/linker_manifest.json",
                expected_type="fee_master_linker",
            ),
            "test-v1",
        )
        with self.assertRaisesRegex(
            WhiteboxArtifactDistributionError,
            "must end with fee_span_detector",
        ):
            _remote_artifact_version(
                "gs://example/whitebox/fee_context_classifier/test-v1/manifest.json",
                expected_type="fee_span_detector",
            )

    def test_remote_uri_rejects_mutable_or_unsafe_artifact_versions(self) -> None:
        for version in ("latest", "..", "unsafe/version", "unsafe value"):
            with self.subTest(version=version):
                with self.assertRaises(WhiteboxArtifactDistributionError):
                    _remote_artifact_version(
                        f"gs://example/whitebox/fee_span_detector/{version}/manifest.json",
                        expected_type="fee_span_detector",
                    )

        with tempfile.TemporaryDirectory() as temporary:
            manifest = self._write_artifact(Path(temporary), b"model-v1")
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            payload["artifactVersion"] = "../unsafe"
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            artifact = verify_artifact(
                manifest,
                expected_type="fee_span_detector",
            )
            with self.assertRaisesRegex(
                WhiteboxArtifactDistributionError,
                "artifactVersion",
            ):
                immutable_remote_manifest_uri(
                    artifact,
                    "gs://example/whitebox",
                )

    def test_fetch_rejects_uri_manifest_version_mismatch_before_model_download(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_manifest = self._write_artifact(root / "source", b"model-v1")
            calls: list[list[str]] = []

            def fake_gcloud_run(command: list[str]) -> None:
                calls.append(command)
                destination = Path(command[-1])
                destination.write_bytes(source_manifest.read_bytes())

            with mock.patch(
                "scripts.manage_fee_whitebox_artifact._gcloud_run",
                side_effect=fake_gcloud_run,
            ):
                with self.assertRaisesRegex(
                    WhiteboxArtifactDistributionError,
                    "URI version does not match",
                ):
                    fetch_artifact(
                        "gs://example/whitebox/fee_span_detector/wrong-v2/manifest.json",
                        destination_manifest=root / "destination" / "manifest.json",
                        expected_type="fee_span_detector",
                        dry_run=False,
                    )

            self.assertEqual(len(calls), 1)

    def test_manifest_path_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = self._write_artifact(root, b"model-v1")
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            payload["files"]["model"]["path"] = "../model.bin"
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(Exception, "must stay under artifact root"):
                verify_artifact(
                    manifest,
                    expected_type="fee_span_detector",
                )

    @staticmethod
    def _write_artifact(root: Path, model_bytes: bytes) -> Path:
        model = root / "runtime" / "model.bin"
        model.parent.mkdir(parents=True, exist_ok=True)
        model.write_bytes(model_bytes)
        manifest = root / "manifest.json"
        manifest.write_text(
            json.dumps({
                "schemaVersion": 1,
                "artifactType": "fee_span_detector",
                "artifactVersion": "test-v1",
                "modelVersion": "test-model",
                "modelRevision": "0123456789abcdef",
                "backend": "test",
                "license": {
                    "modelId": "test/model",
                    "license": "MIT",
                    "verifiedAt": "2026-07-25",
                    "sourceUrl": "https://example.com/license",
                },
                "files": {
                    "model": {
                        "path": "runtime/model.bin",
                        "sha256": hashlib.sha256(model_bytes).hexdigest(),
                    }
                },
            }),
            encoding="utf-8",
        )
        return manifest


if __name__ == "__main__":
    unittest.main()
