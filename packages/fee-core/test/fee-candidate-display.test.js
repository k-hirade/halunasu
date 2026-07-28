import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFeeCandidateDisplay } from "../src/fee-candidate-display.js";

test("fee candidate display separates the master stem from its qualifiers", () => {
  assert.deepEqual(
    buildFeeCandidateDisplay("在宅患者訪問診療料（１）１（同一建物居住者以外）"),
    {
      stem: "在宅患者訪問診療料",
      qualifier: "(1)1(同一建物居住者以外)"
    }
  );
  assert.deepEqual(
    buildFeeCandidateDisplay("外来・在宅ベースアップ評価料（１）３（訪問診療時）イ"),
    {
      stem: "外来・在宅ベースアップ評価料",
      qualifier: "(1)3(訪問診療時)イ"
    }
  );
});

test("fee candidate display removes proposal-only confirmation wording", () => {
  assert.deepEqual(
    buildFeeCandidateDisplay("「在宅酸素療法」の算定区分確認", { proposal: true }),
    { stem: "在宅酸素療法", qualifier: "" }
  );
  assert.deepEqual(
    buildFeeCandidateDisplay("在宅データ提出加算（在医総管・施医総管）の算定確認", {
      proposal: true
    }),
    {
      stem: "在宅データ提出加算",
      qualifier: "(在医総管・施医総管)"
    }
  );
});

test("fee candidate display keeps backward-safe empty and unqualified names", () => {
  assert.deepEqual(buildFeeCandidateDisplay(""), { stem: "", qualifier: "" });
  assert.deepEqual(
    buildFeeCandidateDisplay("再診料"),
    { stem: "再診料", qualifier: "" }
  );
  assert.deepEqual(
    buildFeeCandidateDisplay("薬剤名「メーカー名」"),
    { stem: "薬剤名", qualifier: "" }
  );
});
