#!/usr/bin/env python3
"""Export a pinned local Hugging Face encoder for the WX2 ONNX runtime."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Sequence

from medical_fee_calculation.whitebox_artifacts import sha256_file
from scripts.whitebox_training_common import (
    WhiteboxTrainingError,
    build_license_record,
    configure_determinism,
    dependency_modules,
    validate_model_revision,
)


def require_pinned_snapshot(model_dir: Path, revision: str) -> Path:
    resolved = model_dir.expanduser().resolve()
    if not resolved.is_dir():
        raise WhiteboxTrainingError(f"model snapshot is missing: {resolved}")
    parts = resolved.parts
    if "snapshots" not in parts:
        raise WhiteboxTrainingError(
            "model-dir must be a Hugging Face snapshots/<immutable-revision> directory"
        )
    snapshot_index = len(parts) - 1 - tuple(reversed(parts)).index("snapshots")
    if snapshot_index + 1 >= len(parts) or parts[snapshot_index + 1] != revision:
        raise WhiteboxTrainingError(
            "model-dir snapshot revision does not match --model-revision"
        )
    for filename in ("config.json", "tokenizer.json"):
        if not (resolved / filename).is_file():
            raise WhiteboxTrainingError(
                f"model snapshot is missing required file: {filename}"
            )
    if not any((resolved / filename).is_file() for filename in (
        "model.safetensors",
        "pytorch_model.bin",
    )):
        raise WhiteboxTrainingError("model snapshot has no supported model weights")
    return resolved


def require_empty_output(output_dir: Path) -> Path:
    resolved = output_dir.expanduser().resolve()
    if resolved.exists() and any(resolved.iterdir()):
        raise WhiteboxTrainingError(f"output directory must be empty: {resolved}")
    resolved.mkdir(parents=True, exist_ok=True)
    return resolved


def export_encoder(args: argparse.Namespace) -> dict[str, Any]:
    revision = validate_model_revision(args.model_revision)
    snapshot = require_pinned_snapshot(args.model_dir, revision)
    output = require_empty_output(args.output_dir)
    license_record = build_license_record(
        model_id=args.model_version,
        license_name=args.license,
        verified_at=args.license_verified_at,
        source_url=args.license_source_url,
    )
    if args.dry_run:
        return {
            "status": "planned",
            "modelVersion": args.model_version,
            "modelRevision": revision,
            "modelDir": str(snapshot),
            "outputDir": str(output),
            "license": license_record,
        }

    _, onnx, _, torch, transformers = dependency_modules()
    configure_determinism(args.seed)
    tokenizer = transformers.AutoTokenizer.from_pretrained(
        snapshot,
        local_files_only=True,
        use_fast=True,
        trust_remote_code=False,
    )
    if not getattr(tokenizer, "is_fast", False):
        raise WhiteboxTrainingError("WX2 requires a fast tokenizer")
    encoder = transformers.AutoModel.from_pretrained(
        snapshot,
        local_files_only=True,
        trust_remote_code=False,
    )

    class LastHiddenState(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = encoder

        def forward(self, input_ids, attention_mask):
            return self.encoder(
                input_ids=input_ids,
                attention_mask=attention_mask,
            ).last_hidden_state

    probe = tokenizer(
        ["診療報酬算定"],
        padding=True,
        truncation=True,
        max_length=args.max_length,
        return_tensors="pt",
    )
    model_path = output / "model.onnx"
    tokenizer_path = output / "tokenizer.json"
    model = LastHiddenState().eval()
    torch.onnx.export(
        model,
        (probe["input_ids"], probe["attention_mask"]),
        str(model_path),
        input_names=["input_ids", "attention_mask"],
        output_names=["last_hidden_state"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "attention_mask": {0: "batch", 1: "sequence"},
            "last_hidden_state": {0: "batch", 1: "sequence"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
    )
    onnx.checker.check_model(onnx.load(str(model_path)))
    shutil.copy2(snapshot / "tokenizer.json", tokenizer_path)
    manifest = {
        "schemaVersion": 1,
        "artifactType": "fee_sentence_encoder_export",
        "modelVersion": args.model_version,
        "modelRevision": revision,
        "sourceSnapshot": str(snapshot),
        "license": license_record,
        "maxLength": args.max_length,
        "pooling": "mean",
        "embeddingOutputName": "last_hidden_state",
        "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "files": {
            "model": {
                "path": model_path.name,
                "sha256": sha256_file(model_path),
            },
            "tokenizer": {
                "path": tokenizer_path.name,
                "sha256": sha256_file(tokenizer_path),
            },
        },
    }
    manifest_path = output / "export-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return {
        "status": "complete",
        "manifestPath": str(manifest_path),
        **manifest,
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--license", required=True)
    parser.add_argument("--license-source-url", required=True)
    parser.add_argument("--license-verified-at", required=True)
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not 16 <= args.max_length <= 512:
        parser.error("--max-length must be from 16 to 512")
    if args.opset < 13:
        parser.error("--opset must be at least 13")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        result = export_encoder(parse_args(argv))
    except WhiteboxTrainingError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
