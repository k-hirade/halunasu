function normalizedName(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
}

export function selectActiveDepartmentForSeed(departments = [], {
  facilityId,
  displayName
} = {}) {
  const expectedFacilityId = String(facilityId || "").trim();
  const expectedDisplayName = normalizedName(displayName);
  if (!expectedFacilityId || !expectedDisplayName) {
    return null;
  }
  return departments.find((department) => (
    department?.status === "active"
    && String(department.facilityId || "").trim() === expectedFacilityId
    && normalizedName(department.displayName) === expectedDisplayName
  )) || null;
}
