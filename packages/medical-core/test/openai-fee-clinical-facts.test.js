import assert from "node:assert/strict";
import test from "node:test";

import { extractFeeClinicalFactsWithOpenAi } from "../src/fee/openai-fee-clinical-facts.js";

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    }
  };
}

async function withFetch(mockFetch, callback) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  try {
    return await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function feeClinicalFactsPayload() {
  return {
    visit_type: {
      kind: "unknown",
      evidence: "",
      confidence: "low"
    },
    diagnoses: [],
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  };
}

test("fee clinical facts prompt preserves performed tests with normal or negative results", async () => {
  let requestBody = null;

  await withFetch(
    async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        output_text: JSON.stringify(feeClinicalFactsPayload())
      });
    },
    async () => {
      await extractFeeClinicalFactsWithOpenAi({
        apiKey: "test-key",
        clinicalText: "O: 心電図 異常なし。インフルエンザ検査 陰性。",
        sessionContext: {}
      });
    }
  );

  assert.match(requestBody.instructions, /action_status=performed/);
  assert.match(requestBody.instructions, /陰性\/正常\/異常なし/);
  assert.match(requestBody.instructions, /Use action_status=not_performed only when the clinical text says the act itself was not performed/);
});

test("fee clinical facts schema keeps enough diagnoses and excluded events for complex notes", async () => {
  let requestBody = null;

  await withFetch(
    async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        output_text: JSON.stringify(feeClinicalFactsPayload())
      });
    },
    async () => {
      await extractFeeClinicalFactsWithOpenAi({
        apiKey: "test-key",
        clinicalText: "複数疾患と予定検査を含むカルテ。",
        sessionContext: {}
      });
    }
  );

  const schema = requestBody.text.format.schema;
  assert.equal(schema.properties.diagnoses.maxItems, 8);
  assert.equal(schema.properties.excluded_events.maxItems, 8);
  assert.ok(schema.properties.clinical_events);
  assert.equal(schema.required.includes("clinical_events"), true);
  assert.equal(schema.required.includes("billing_events"), false);
});

test("fee clinical facts prompt asks for explicit area and body site when billing classification may depend on them", async () => {
  let requestBody = null;

  await withFetch(
    async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        output_text: JSON.stringify(feeClinicalFactsPayload())
      });
    },
    async () => {
      await extractFeeClinicalFactsWithOpenAi({
        apiKey: "test-key",
        clinicalText: "P: 右前腕の創傷処置。創部 4x6cm。",
        sessionContext: {}
      });
    }
  );

  assert.match(requestBody.instructions, /body_site/);
  assert.match(requestBody.instructions, /area_size_cm2/);
  assert.match(requestBody.instructions, /Do not infer a size that is not written/);
});
