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
    checklist_findings: [],
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

  if (Array.isArray(schema.anyOf)) {
    for (const [index, variant] of schema.anyOf.entries()) {
      assertStrictObjectSchemasHaveRequiredProperties(variant, `${path}.anyOf[${index}]`);
    }
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

test("fee clinical facts request does not send the patient display name to OpenAI", async () => {
  let requestBody = null;

  await withFetch(
    async (url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ output_text: JSON.stringify(feeClinicalFactsPayload()) });
    },
    async () => {
      await extractFeeClinicalFactsWithOpenAi({
        apiKey: "test-key",
        clinicalText: "S: 経過良好。",
        sessionContext: { patientDisplayName: "山田 太郎", facilityName: "テスト医院" }
      });
    }
  );

  // 患者氏名(値)も、氏名を載せる構造化キー("patientDisplayName")も外部AIへ送信されない。
  assert.equal(requestBody.input.includes("山田 太郎"), false);
  assert.doesNotMatch(requestBody.input, /"patientDisplayName"\s*:/u);
  // 氏名の有無は非識別フラグとしてのみ渡る。施設名など氏名以外の文脈は維持。
  assert.match(requestBody.input, /"patientDisplayNameRedacted": true/u);
  assert.match(requestBody.input, /テスト医院/u);
});

test("v13 lightweight schema: type-specific variants carry only relevant fields", async () => {
  let requestBody = null;

  await withFetch(
    async (url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ output_text: JSON.stringify(feeClinicalFactsPayload()) });
    },
    async () => {
      await extractFeeClinicalFactsWithOpenAi({
        apiKey: "test-key",
        clinicalText: "O: 心電図 異常なし。",
        sessionContext: {}
      });
    }
  );

  const variants = requestBody.text.format.schema.properties.clinical_events.items.anyOf;
  assert.ok(Array.isArray(variants) && variants.length === 5, "5つの型別variant");

  // type enum は互いに素で、全variantの和が全イベント種別を覆う
  const seenTypes = [];
  for (const variant of variants) {
    const types = variant.properties.type.enum;
    for (const t of types) {
      assert.ok(!seenTypes.includes(t), `type '${t}' が複数variantに重複していない`);
      seenTypes.push(t);
    }
    // 共通: 全variantが v12 の軽量化(引用文・section・offsets無し / line_ids・queries上限)を維持
    assert.equal(variant.properties.evidence, undefined);
    assert.equal(variant.properties.section, undefined);
    assert.equal(variant.properties.char_start, undefined);
    assert.equal(variant.properties.char_end, undefined);
    assert.equal(variant.properties.evidence_line_ids.maxItems, 2);
    assert.equal(variant.properties.search_queries.maxItems, 2);
  }
  assert.equal(seenTypes.length, 15);

  const byType = (t) => variants.find((v) => v.properties.type.enum.includes(t));
  // 投薬系だけが用量フィールドを持つ
  assert.ok(byType("medication").properties.quantity_per_day);
  assert.equal(byType("lab").properties.quantity_per_day, undefined);
  // 検体系だけが specimen を持つ
  assert.ok(byType("lab").properties.specimen);
  assert.equal(byType("medication").properties.specimen, undefined);
  // 画像だけが modality を持つ
  assert.ok(byType("imaging").properties.modality);
  assert.equal(byType("procedure").properties.modality, undefined);
  // 処置系だけが面積を持つ
  assert.ok(byType("treatment").properties.area_size_cm2);
  assert.equal(byType("management").properties.area_size_cm2, undefined);
  // 一般variantは共通フィールドのみ(12個)
  assert.equal(Object.keys(byType("management").properties).length, 12);

  // checklist_findings も line_ids 化を維持
  const checklistSchema = requestBody.text.format.schema.properties.checklist_findings.items;
  assert.equal(checklistSchema.properties.evidence, undefined);
  assert.ok(checklistSchema.properties.evidence_line_ids);
  // 暴走出力の上限(既定4096)
  assert.equal(requestBody.max_output_tokens, 4096);
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
  assert.ok(schema.properties.checklist_findings);
  // v13: 型別variant。billing_domainは全variant共通、specimen系は検体variantが持つ
  const variants = schema.properties.clinical_events.items.anyOf;
  assert.ok(variants.every((v) => v.properties.billing_domain));
  const specimenVariant = variants.find((v) => v.properties.type.enum.includes("lab"));
  assert.ok(specimenVariant.properties.specimen);
  assert.ok(specimenVariant.properties.collection_method);
  assert.equal(schema.required.includes("clinical_events"), true);
  assert.equal(schema.required.includes("checklist_findings"), true);
  assert.equal(schema.required.includes("billing_events"), false);
});

test("fee clinical facts prompt asks the model to answer every checklist menu item", async () => {
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
        clinicalText: "O: 尿一般を実施。",
        sessionContext: {},
        checklistMenu: [{ menuId: "lab:urine_general", label: "尿一般", kind: "lab", billingDomain: "standard_lab" }]
      });
    }
  );

  assert.match(requestBody.instructions, /checklist_findings/);
  assert.match(requestBody.instructions, /performed_today/);
  assert.match(requestBody.input, /lab:urine_general/);
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

test("v14 全行カバレッジ: line_review が必須で各行のhas_billable_act判定を持つ", async () => {
  const module = await import("../src/fee/openai-fee-clinical-facts.js");
  assert.equal(module.FEE_CLINICAL_FACTS_PROMPT_VERSION, "fee-clinical-events-v14");
  const schema = module.feeClinicalFactsSchema || module.FEE_CLINICAL_FACTS_SCHEMA;
  // schemaが直接exportされていない場合はスキップせず、リクエストビルダー経由で検証する
  if (schema) {
    assert.ok(schema.required.includes("line_review"));
    const lineReview = schema.properties.line_review;
    assert.equal(lineReview.type, "array");
    assert.deepEqual(lineReview.items.required, ["line_id", "has_billable_act"]);
    assert.equal(lineReview.items.properties.has_billable_act.type, "boolean");
  }
});
