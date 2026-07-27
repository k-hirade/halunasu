from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WX0_REQUIREMENTS = ROOT / "python/experiments/requirements-wx0.txt"
BUILD_REQUIREMENTS = ROOT / "python/experiments/requirements-whitebox-build.txt"
LINKER_BUILD_REQUIREMENTS = (
    ROOT / "python/experiments/requirements-whitebox-linker-build.txt"
)
MODERNBERT_BUILD_REQUIREMENTS = (
    ROOT / "python/experiments/requirements-whitebox-modernbert-build.txt"
)
RUNTIME_REQUIREMENTS = ROOT / "python/requirements-fee-runtime.txt"


def read_pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, version = line.partition("==")
        if not separator or not name or not version:
            raise AssertionError(f"{path}: expected an exact pin, got {line!r}")
        pins[name] = version
    return pins


class WhiteboxRequirementSetsTest(unittest.TestCase):
    def test_wx0_gliner_dependencies_are_compatible(self):
        pins = read_pins(WX0_REQUIREMENTS)

        self.assertEqual(pins["gliner"], "0.2.24")
        self.assertEqual(pins["transformers"], "4.57.3")
        self.assertEqual(pins["tokenizers"], "0.22.1")

    def test_artifact_builder_excludes_gliner(self):
        pins = read_pins(BUILD_REQUIREMENTS)

        self.assertNotIn("gliner", pins)
        self.assertEqual(pins["transformers"], "4.46.3")
        self.assertEqual(pins["tokenizers"], "0.20.3")

    def test_artifact_builder_matches_runtime_binary_contract(self):
        build_pins = read_pins(BUILD_REQUIREMENTS)
        runtime_pins = read_pins(RUNTIME_REQUIREMENTS)

        for package in ("numpy", "onnxruntime", "tokenizers"):
            self.assertEqual(build_pins[package], runtime_pins[package])

    def test_modern_linker_builder_is_isolated_from_legacy_builders(self):
        pins = read_pins(LINKER_BUILD_REQUIREMENTS)

        self.assertNotIn("gliner", pins)
        self.assertEqual(pins["transformers"], "4.57.3")
        self.assertEqual(pins["tokenizers"], "0.22.1")
        self.assertEqual(pins["sentencepiece"], "0.2.2")
        self.assertEqual(pins["onnxruntime"], "1.20.1")

    def test_modernbert_comparison_builder_is_isolated_from_runtime(self):
        pins = read_pins(MODERNBERT_BUILD_REQUIREMENTS)
        runtime_pins = read_pins(RUNTIME_REQUIREMENTS)

        self.assertNotIn("gliner", pins)
        self.assertEqual(pins["transformers"], "4.57.3")
        self.assertEqual(pins["tokenizers"], "0.22.1")
        self.assertEqual(pins["onnxruntime"], runtime_pins["onnxruntime"])
        self.assertNotEqual(pins["tokenizers"], runtime_pins["tokenizers"])

    def test_runtime_excludes_training_dependencies(self):
        pins = read_pins(RUNTIME_REQUIREMENTS)

        for package in ("gliner", "sentence-transformers", "torch", "transformers"):
            self.assertNotIn(package, pins)


if __name__ == "__main__":
    unittest.main()
