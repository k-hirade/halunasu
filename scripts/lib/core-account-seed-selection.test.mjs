import assert from "node:assert/strict";
import test from "node:test";

import { selectActiveDepartmentForSeed } from "./core-account-seed-selection.mjs";

test("selects the requested active department in the target facility", () => {
  const departments = [
    {
      departmentId: "dep_shadow",
      facilityId: "fac_demo",
      displayName: "WX Shadow 整形外科",
      status: "active"
    },
    {
      departmentId: "dep_billing",
      facilityId: "fac_demo",
      displayName: "医事課",
      status: "active"
    }
  ];

  const selected = selectActiveDepartmentForSeed(departments, {
    facilityId: "fac_demo",
    displayName: "医事課"
  });

  assert.equal(selected?.departmentId, "dep_billing");
});

test("does not reuse a matching department from another facility or an inactive department", () => {
  const departments = [
    {
      departmentId: "dep_other_facility",
      facilityId: "fac_other",
      displayName: "医事課",
      status: "active"
    },
    {
      departmentId: "dep_inactive",
      facilityId: "fac_demo",
      displayName: "医事課",
      status: "inactive"
    }
  ];

  const selected = selectActiveDepartmentForSeed(departments, {
    facilityId: "fac_demo",
    displayName: "医事課"
  });

  assert.equal(selected, null);
});

test("normalizes the configured department name", () => {
  const selected = selectActiveDepartmentForSeed([
    {
      departmentId: "dep_billing",
      facilityId: "fac_demo",
      displayName: "医事課",
      status: "active"
    }
  ], {
    facilityId: "fac_demo",
    displayName: "  医事課  "
  });

  assert.equal(selected?.departmentId, "dep_billing");
});
