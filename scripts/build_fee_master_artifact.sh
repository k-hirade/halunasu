#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DB="${1:-${ROOT_DIR}/python/data/master/standard-master.sqlite}"
OUT_DIR="${2:-${ROOT_DIR}/python/data/master}"
OUT_GZIP="${OUT_DIR}/standard-master.sqlite.gz"
OUT_MANIFEST="${OUT_DIR}/standard-master.manifest.json"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fee-master-artifact.XXXXXX")"
TMP_DB="${TMP_DIR}/standard-master.sqlite"
TMP_COUNTS="${TMP_DIR}/table-counts.tsv"
TMP_GZIP="${OUT_GZIP}.tmp"
TMP_MANIFEST="${OUT_MANIFEST}.tmp"

cleanup() {
  rm -rf "${TMP_DIR}"
  rm -f "${TMP_GZIP}" "${TMP_MANIFEST}"
}
trap cleanup EXIT

required_tables=(
  "medical_procedures:10000"
  "electronic_exclusions:70000"
  "electronic_bundles:200000"
  "electronic_frequency_limits:5000"
  "comment_links:15000"
  "diseases:25000"
  "disease_modifiers:2000"
  "cc_act_indications:200000"
  "cc_drug_indications:1"
  "cc_drug_contra_disease:1"
  "cc_drug_interactions:1"
  "cc_drug_dose_groups:1"
  "drugs:1"
  "comments:1"
  "specific_materials:1"
  "hospital_facility_standards:1"
)

if [[ ! -f "${SRC_DB}" ]]; then
  echo "ERROR: source master DB not found: ${SRC_DB}" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is required" >&2
  exit 1
fi
if ! command -v gzip >/dev/null 2>&1; then
  echo "ERROR: gzip is required" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

old_gzip_bytes=0
if [[ -f "${OUT_GZIP}" ]]; then
  old_gzip_bytes="$(wc -c < "${OUT_GZIP}" | tr -d ' ')"
fi

escaped_tmp_db="${TMP_DB//\'/\'\'}"
echo "Creating compact master DB with VACUUM INTO..."
sqlite3 "${SRC_DB}" "VACUUM INTO '${escaped_tmp_db}'"

validation_failed=false
: > "${TMP_COUNTS}"
for spec in "${required_tables[@]}"; do
  table="${spec%%:*}"
  minimum="${spec##*:}"
  if ! count="$(sqlite3 "${TMP_DB}" "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null)"; then
    count=0
  fi
  count="${count:-0}"
  printf '%s\t%s\t%s\n' "${table}" "${count}" "${minimum}" >> "${TMP_COUNTS}"
  if (( count < minimum )); then
    echo "ERROR: required table ${table} has ${count} rows; minimum is ${minimum}" >&2
    validation_failed=true
  fi
done

if [[ "${validation_failed}" == "true" ]]; then
  echo "Master validation failed. Existing gzip and manifest were not changed." >&2
  exit 1
fi

echo "Compressing validated master DB..."
gzip -9 -c "${TMP_DB}" > "${TMP_GZIP}"

python3 - "${TMP_DB}" "${TMP_GZIP}" "${TMP_MANIFEST}" "${TMP_COUNTS}" <<'PY'
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

db_path, gzip_path, manifest_path, counts_path = map(Path, sys.argv[1:])
tables: dict[str, int] = {}
for raw_line in counts_path.read_text(encoding="utf-8").splitlines():
    table, count, _minimum = raw_line.split("\t")
    tables[table] = int(count)

with sqlite3.connect(db_path) as conn:
    source_versions = [
        {
            "sourceType": str(row[0] or ""),
            "sourceVersion": str(row[1] or ""),
            "importedAt": str(row[2] or ""),
        }
        for row in conn.execute(
            "SELECT source_type, source_version, imported_at "
            "FROM master_sources ORDER BY source_type, source_version, imported_at"
        )
    ]

digest = hashlib.sha256()
with gzip_path.open("rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)

manifest = {
    "schemaVersion": 1,
    "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "sha256": digest.hexdigest(),
    "sourceVersions": source_versions,
    "tables": tables,
}
manifest_path.write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY

mv "${TMP_GZIP}" "${OUT_GZIP}"
mv "${TMP_MANIFEST}" "${OUT_MANIFEST}"

new_gzip_bytes="$(wc -c < "${OUT_GZIP}" | tr -d ' ')"
new_sha="$(python3 - "${OUT_GZIP}" <<'PY'
import hashlib
import sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
print(digest.hexdigest())
PY
)"

echo
echo "Fee master artifact generated"
printf '  gzip: %s\n' "${OUT_GZIP}"
printf '  manifest: %s\n' "${OUT_MANIFEST}"
printf '  size: %s -> %s bytes\n' "${old_gzip_bytes}" "${new_gzip_bytes}"
printf '  sha256: %s\n' "${new_sha}"
echo
printf '%-36s %12s %12s\n' "table" "rows" "minimum"
while IFS=$'\t' read -r table count minimum; do
  printf '%-36s %12s %12s\n' "${table}" "${count}" "${minimum}"
done < "${TMP_COUNTS}"
