import assert from "node:assert/strict";
import test from "node:test";
import { SKETCH_TEMPLATES, SKETCH_TOOLS, validateEncounterContent } from "../src/index.js";

test("old pen strokes keep their exact shape (no tool/text/fill keys added)", () => {
  const content = validateEncounterContent({
    sketches: [{ sketchId: "s1", template: "fundus", eye: "od", strokes: [{ color: "#dc2626", width: 3, points: [1, 2, 3, 4] }] }]
  });
  assert.deepEqual(content.sketches[0].strokes[0], { color: "#dc2626", width: 3, points: [1, 2, 3, 4] });
});

test("shape, text and fill strokes are accepted and normalized", () => {
  const content = validateEncounterContent({
    sketches: [{
      sketchId: "s1",
      template: "cornea",
      eye: "os",
      strokes: [
        { tool: "pen", points: [1, 2, 3, 4] },
        { tool: "rect", fill: "hatch", points: [10, 10, 200, 200] },
        { tool: "ellipse", fill: "solid", points: [10, 10, 200, 200] },
        { tool: "arrow", fill: "solid", points: [0, 0, 100, 100] },
        { tool: "text", text: "KP+", points: [500, 500] }
      ]
    }]
  });
  const [pen, rect, ellipse, arrow, text] = content.sketches[0].strokes;
  assert.equal("tool" in pen, false, "pen is the default and is not stored");
  assert.equal(rect.tool, "rect");
  assert.equal(rect.fill, "hatch");
  assert.equal(ellipse.fill, "solid");
  assert.equal("fill" in arrow, false, "fill is only kept for closed shapes");
  assert.equal(text.text, "KP+");
  assert.equal(content.sketches[0].template, "cornea");
});

test("new templates are listed and unknown tools/fills are rejected", () => {
  for (const template of ["cornea", "lens", "gonio", "eyelid", "vfgrid", "fundus", "anterior", "blank"]) assert.ok(SKETCH_TEMPLATES.includes(template));
  assert.ok(SKETCH_TOOLS.includes("arrow"));
  assert.throws(() => validateEncounterContent({ sketches: [{ sketchId: "s", strokes: [{ tool: "spray", points: [1, 2] }] }] }), /tool/u);
  assert.throws(() => validateEncounterContent({ sketches: [{ sketchId: "s", strokes: [{ tool: "rect", fill: "dots", points: [1, 2, 3, 4] }] }] }), /fill/u);
  assert.throws(() => validateEncounterContent({ sketches: [{ sketchId: "s", strokes: [{ tool: "text", text: "x".repeat(101), points: [1, 2] }] }] }), /text/u);
});
