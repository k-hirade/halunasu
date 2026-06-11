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
    visit_facts: {
      outside_prescription_issued: "unknown",
      generic_name_prescription: "unknown",
      prescription_evidence: ""
    },
    diagnoses: [],
    clinical_events: [],
    excluded_events: [],
    missing_information: [],
    review_flags: []
  };
}

function assertStrictObjectSchemasHaveRequiredProperties(schema, path = "schema") {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (schema.type === "object" && schema.properties) {
    assert.equal(
      schema.additionalProperties,
      false,
      `${path} should reject additional properties`
    );
    const propertyKeys = Object.keys(schema.properties).sort();
    const requiredKeys = [...(schema.required || [])].sort();
    assert.deepEqual(
      requiredKeys,
      propertyKeys,
      `${path} required keys must match properties for OpenAI strict json_schema`
    );
    for (const key of propertyKeys) {
      assertStrictObjectSchemasHaveRequiredProperties(schema.properties[key], `${path}.properties.${key}`);
    }
  }

  if (schema.type === "array") {
    assertStrictObjectSchemasHaveRequiredProperties(schema.items, `${path}.items`);
  }
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

test("fee clinical facts schema is valid for OpenAI strict json_schema", async () => {
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
        clinicalText: "O: 胸部X線 異常なし。",
        sessionContext: {}
      });
    }
  );

  assert.equal(requestBody.text.format.strict, true);
  assertStrictObjectSchemasHaveRequiredProperties(requestBody.text.format.schema);
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
  assert.ok(schema.properties.visit_facts);
  assert.ok(schema.properties.clinical_events);
  assert.ok(schema.properties.clinical_events.items.properties.billing_domain);
  assert.ok(schema.properties.clinical_events.items.properties.specimen);
  assert.ok(schema.properties.clinical_events.items.properties.collection_method);
  assert.equal(schema.required.includes("clinical_events"), true);
  assert.equal(schema.required.includes("billing_events"), false);
});

test("fee clinical facts prompt asks for explicit specimen and collection method without inferring from findings", async () => {
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
        clinicalText: "O: 咽頭発赤あり。鼻咽頭ぬぐい液でインフルエンザ検査を実施。",
        sessionContext: {}
      });
    }
  );

  assert.match(requestBody.instructions, /specimen/);
  assert.match(requestBody.instructions, /collection_method/);
  assert.match(requestBody.instructions, /咽頭発赤/);
});

test("fee clinical facts prompt delegates domain classification to structured billing domain", async () => {
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
        clinicalText: "静脈採血後に検体提出。夜間頻尿あり。時間外加算の算定条件確認。",
        sessionContext: {}
      });
    }
  );

  assert.match(requestBody.instructions, /billing_domain/);
  assert.match(requestBody.instructions, /静脈採血後に検体提出 is billing_domain=standard_lab/);
  assert.match(requestBody.instructions, /夜間頻尿 is a symptom\/time context, not emergency_time_addon/);
  assert.match(requestBody.instructions, /時間外加算の算定条件確認 is billing_domain=emergency_time_addon/);
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
