from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.runtime_feature_profile import (
    FEATURE_BASE_NAMES,
    RuntimeFeatureProfileError,
    load_profile,
    parse_profile_text,
)


class RuntimeFeatureProfileTest(unittest.TestCase):
    def test_repository_profiles_are_complete(self) -> None:
        root = Path("configs/runtime-feature-profiles")
        for path in sorted(root.glob("*.env")):
            environment = path.stem.split("-", 1)[0]
            values = load_profile(
                path.stem,
                environment=environment,
                profile_root=root,
            )
            self.assertEqual(len(values), len(FEATURE_BASE_NAMES))

    def test_missing_feature_key_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile = root / "stg-test.env"
            profile.write_text(
                "PROFILE_ENV=stg\nPROFILE_NAME=stg-test\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                RuntimeFeatureProfileError,
                "profile is incomplete",
            ):
                load_profile(
                    "stg-test",
                    environment="stg",
                    profile_root=root,
                )

    def test_profile_environment_mismatch_is_rejected(self) -> None:
        with self.assertRaisesRegex(
            RuntimeFeatureProfileError,
            "PROFILE_ENV must be prod",
        ):
            load_profile(
                "stg-longitudinal",
                environment="prod",
                profile_root=Path("configs/runtime-feature-profiles"),
            )

    def test_enabled_layer_requires_manifest_and_gcs_uri(self) -> None:
        root = Path("configs/runtime-feature-profiles")
        source = (root / "stg-whitebox-span-shadow.env").read_text(
            encoding="utf-8"
        )
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            (temporary_root / "stg-invalid.env").write_text(
                source
                .replace("PROFILE_NAME=stg-whitebox-span-shadow", "PROFILE_NAME=stg-invalid")
                .replace(
                    "FEE_SPAN_DETECTOR_ARTIFACT_URI_STG=gs://",
                    "FEE_SPAN_DETECTOR_ARTIFACT_URI_STG=https://",
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                RuntimeFeatureProfileError,
                "must be an immutable gs://",
            ):
                load_profile(
                    "stg-invalid",
                    environment="stg",
                    profile_root=temporary_root,
                )

    def test_mutable_or_wrong_type_artifact_uri_is_rejected(self) -> None:
        root = Path("configs/runtime-feature-profiles")
        source = (root / "stg-whitebox-span-shadow.env").read_text(
            encoding="utf-8"
        )
        invalid_uris = (
            "gs://bucket/whitebox/fee_span_detector/latest/manifest.json",
            "gs://bucket/whitebox/fee_master_linker/v1/manifest.json",
            "gs://bucket/whitebox/fee_span_detector/v1/other.json",
        )
        for index, invalid_uri in enumerate(invalid_uris):
            with self.subTest(uri=invalid_uri), tempfile.TemporaryDirectory() as temporary:
                temporary_root = Path(temporary)
                (temporary_root / f"stg-invalid-{index}.env").write_text(
                    source
                    .replace(
                        "PROFILE_NAME=stg-whitebox-span-shadow",
                        f"PROFILE_NAME=stg-invalid-{index}",
                    )
                    .replace(
                        "gs://halunasu-fee-stg-artifacts/whitebox/"
                        "fee_span_detector/wx1-multilingual-minilm-l12-v1/manifest.json",
                        invalid_uri,
                    ),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    RuntimeFeatureProfileError,
                    "must be an immutable gs://",
                ):
                    load_profile(
                        f"stg-invalid-{index}",
                        environment="stg",
                        profile_root=temporary_root,
                    )

    def test_shell_syntax_is_not_evaluated(self) -> None:
        parsed = parse_profile_text("FEE_TEST=$(touch /tmp/not-run)\n")
        self.assertEqual(parsed["FEE_TEST"], "$(touch /tmp/not-run)")

    def test_export_and_duplicate_keys_are_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeFeatureProfileError, "export"):
            parse_profile_text("export FEE_TEST=true\n")
        with self.assertRaisesRegex(RuntimeFeatureProfileError, "duplicate"):
            parse_profile_text("FEE_TEST=true\nFEE_TEST=false\n")


if __name__ == "__main__":
    unittest.main()
