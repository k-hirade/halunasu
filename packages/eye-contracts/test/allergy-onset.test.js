import assert from "node:assert/strict";
import { test } from "node:test";
import { allergyOnset, validatePatientProfileInput } from "../src/index.js";

test("keeps an optional allergy onset (YYYY or YYYY-MM) and drops it when empty", () => {
  const validated = validatePatientProfileInput({
    expectedRevision: 0,
    allergies: [
      { substance: "かに", onset: "2020-04" },
      { substance: "ペニシリン", onset: "2019" },
      { substance: "ヨード", onset: "" }
    ]
  });
  assert.equal(validated.allergies[0].onset, "2020-04");
  assert.equal(validated.allergies[1].onset, "2019");
  assert.equal("onset" in validated.allergies[2], false);
  assert.deepEqual(allergyOnset(undefined, "x"), {});
  assert.throws(() => allergyOnset("2020-13", "x"), /YYYY or YYYY-MM/u);
  assert.throws(() => allergyOnset("20-01", "x"), /YYYY or YYYY-MM/u);
});
