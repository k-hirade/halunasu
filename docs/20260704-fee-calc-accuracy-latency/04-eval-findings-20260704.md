# 04. 実測評価からの所見（2026-07-04 stg-openai run）

`data/tests/fee-soap-e2e-v2/reports/stg-openai-5-20260704_143505.*` ＋ `stg-openai-extra5-20260704_1455-*` を分析。
**推測でなく実測**に基づく所見。前提の一部を訂正する。

---

## A. レイテンシ：**ほぼ100%がLLMコール**（重要な訂正）

5ケースの内訳（ms）:

| case | total | openAiProvider(LLM) | masterLookup | ruleBased | python |
|---|---:|---:|---:|---:|---:|
| V2-IM-LAB-001 | 27,289 | **22,381** | 395 | 2 | ~0 |
| V2-PED-LAB-002 | 22,094 | **19,109** | 188 | 1 | ~0 |
| V2-DERM-MED-003 | 15,275 | **12,891** | 154 | 0 | ~0 |
| V2-IM-MED-004 | 11,918 | **9,839** | 0 | 0 | ~0 |
| V2-IM-IMG-005 | 15,461 | **13,584** | 0 | 0 | ~0 |

- **LLM抽出コールが総時間の 83–90%**。master lookup <400ms、python算定・rules はほぼ0。
- **`firstOutputText`(TTFT)=0** … ストリーミングのTTFTが評価経路で立っていない（＝部分表示で体感を隠せていない）。
- **訂正**: [01-latency.md] で最優先にした「準備段の並列化(L1)」は**この実測では効果が極小**（prepare系DBは合計<0.5秒）。**唯一のレバーはLLMコールの短縮そのもの**。

### A-2. トークン分解（extra5含む全10ケース・確定的な法則）

| case | llm_ms | in_tok | cached | out_tok | reasoning | events+findings | tok/件 |
|---|---:|---:|---:|---:|---:|---:|---:|
| V2-PED-LABSM-255 | 29,645 | 6,269 | 2,816 | **4,492** | 0 | 18 | 250 |
| V2-IM-LAB-001 | 22,381 | 6,700 | **0** | 2,989 | 298 | 13 | 230 |
| V2-PED-LAB-002 | 19,109 | 6,624 | 2,816 | 2,614 | 418 | 10 | 261 |
| … | | | | | | | |
| V2-PED-LABEXT-249 | **4,105** | 6,237 | 2,816 | **512** | 0 | 2 | 256 |

- **corr(出力トークン, LLM時間) = 0.993**。decode速度はほぼ一定 **139 tok/s**。→ **LLM時間 ≒ 出力トークン ÷ 139**。
- **1抽出件（clinical_event / checklist_finding）あたり ~240出力トークン ≒ 1.7秒**。18件のノートは30秒、2件なら4秒。これが分散(4.1〜29.6秒)の全て。
- **reasoningトークンは0〜418（出力の9%）** … 推論は問題ではない。**構造化JSONのペイロード自体が重い**。
- **プロンプトキャッシュは部分ヒット**（warm時 2,816/約6,200。**cold時0**）。ただし入力の相関は0.428で prefill は支配的でない。

**なぜ1件240トークンか**: OpenAI strict json_schema は**全フィールド必須**のため、1イベントごとに evidence引用文・char_start/char_end・section・temporal_relation・source_origin・provider_ownership・action_status・result_assertion・certainty・billing_domain・search_queries[]… を**空でも必ず出力**する。フィールド数がそのままdecode時間になる。

### レイテンシの真の打ち手（トークン分解で確定・期待値つき）

1. **イベントschemaの軽量化（240→目標80〜100 tok/件）★最大レバー**:
   - **evidence引用文 → `evidence_line_ids` のみに**（preprocessed lines のline_idを既に渡している。引用文は行テキストの複製＝重複コスト）。
   - **char_start/char_end を削除**（文字列型で高コスト・用途限定）。
   - **search_queries を最大1〜2件に制限**、enum系の統合（temporal_relation×source_origin×provider_ownership の3軸を実務上の合成1軸へ圧縮できないか検討）。
   - 期待値: 平均7件×240=1,700tok(≒12秒) → 7件×90=630tok(**≒4.5秒**)。**相関0.993なので出力削減はほぼそのまま時間短縮になる**。
2. **二段抽出（light→selective detail）**: 1段目は「name+line_id+status+domain」だけの軽量イベント列（~40tok/件）。曖昧・高額のイベントだけ2段目で詳細化。平均ケースはさらに半減。
3. **`max_output_tokens` 上限＋イベント数上限**: 18件×250tok=30秒級の暴走を防ぐ（超過分は needs_review 化）。
4. **キャッシュのcold対策**: cold時 cached=0（初回コール）。ウォームアップ or バッチ先頭にダミー1コール。ただし効果は prefill 分のみ（限定的）。
5. **セクション並列抽出（map-reduce）**: ノートをO/A/P分割で並列 → 壁時計=max(各分割)。イベント数が多い長文ノート（LABSM-255型）に有効。
6. **ストリーミングをクライアントへ**（TTFT=0のまま＝体感を隠せていない）。

> reasoning effort やモデル変更は**このデータでは主要因でない**（reasoning≦9%）。まず schema を削る。

> つまり「速くする＝LLMの出力を小さく・速く・並列に」。周辺(DB/py)最適化はほぼ無意味と実測が示した。

---

## B. 精度：**正解データ(gold)の陳腐化**と**本物の抽出漏れ**を分離する

exact 5/5 fail だが、**中身は2種類**。ユーザ指摘どおり gold 側の誤りが混在する。

### B-1. gold陳腐化（＝engineがむしろ正しい・追わない）

- **`180820010` 物価対応料１（再診時等）ロ = 2点** が全ケースで「unexpected」。これは**2026年改定の物価/賃上げ対応加算**で、engineが自動付与している。gold はこれを含まず作られている。
- 影響: V2-IM-LAB-001（285 vs 283 = **+2**）、V2-IM-MED-004（361 vs 359 = **+2**）は**まさにこの2点**。→ **engineが改定対応で正しく、goldが古い**。
- V2-PED-LAB-002（+102）も `180820010`＋`160182770`(検体検査管理加算2=100点) が unexpected。検体検査管理加算は施設基準次第で妥当な自動付与の可能性。→ **gold/施設設定の確認案件**であり、engine単純バグとは限らない。
- **方針**: これらは深追いしない。ただし **gold を2026改定に更新**（物価対応料を織り込む）すれば exact pass 率は一気に上がる。

### B-2. 本物の抽出漏れ（＝明らかにズレ・要改善）

- **V2-IM-IMG-005: CTが完全欠落**（78 vs 1096, **Δ-1018**）。
  - lineItems は「再診料 + 物価対応料」のみ。期待の **CT撮影(170011810)+コンピューター断層診断(170028810)** が消えた。
  - `checklistFindingStatusCounts: { performed_today:1, **past_or_external:1** }` … **CTを「前回/他院(past_or_external)」に誤分類して除外**した公算。
  - → **時制/実施主体の誤分類による recall 崩壊**。高額項目（1000点超）でこれは致命的。
- **V2-DERM-MED-003: 院内処方が欠落**（213 vs 274, **Δ-61**）。
  - visitFacts `outside_prescription_issued: 'no'`（＝院内）。だが薬剤(620008991)・**調剤料(120001010)・処方料(120001210)** が出ていない。
  - → **医薬品/院内処方の抽出漏れ**（薬が取れないと処方料・調剤料も生まれない）。

### 本物の漏れへの打ち手（recall改善）
1. **時制/source 分類の過剰除外を是正**（最優先）:
   - 「O欄/当該受診に記載された画像・処置・検査」を **past_or_external に落としにくく**する（プロンプトの証拠優先ルール強化＋G5 status整合ガード）。
   - **imaging/medication は "event preservation rule" を強く効かせ**、曖昧でも drop せず `certainty=ambiguous`＋needs_review に倒す（過小算定＝取りこぼしを防ぐ）。
2. **画像・院内処方のチェックリスト想起を強化**（`buildClinicalChecklistMenu`）: CT/MRI/単純X線・院内処方(調剤料/処方料)を想起項目として明示。
3. **決定論の補完**: 院内薬剤が抽出されたら **調剤料/処方料を決定論で自動補完**（recept-checker MI-004 の逆：算定漏れでなく算定生成側）。画像も撮影があれば診断料を補完。

---

### B-3. extra5で見つかった軽微なギャップ（review topic欠落）

- V2-IM-NEG-054: missing reviewTopics **['実施確認']**、V2-PED-LABEXT-249: **['他科・他院情報']**。headline(safety)はpassだが、**要確認トピックの提示が期待に届かないケースがある**。
- 打ち手: checklist_finding の `unclear`/`past_or_external` を review topic 生成へ確実にマップする（B-2の時制是正と同根）。

## C. 安全性（良い点・維持）

- **Unsafe auto-billing 0%**（誤自動採用ゼロ）、**review topic recall 100%**、forbidden 0。
- つまり**「間違えるとき過小/要確認側に倒れている」** … 安全性の非対称は効いている。
- 課題は **recall（取りこぼし）** と **latency**。precision の見かけ低下は主に gold 陳腐化。

---

## D. 差し替え後の優先順位（実測反映）

**レイテンシ（LLMコール短縮が唯一のレバー）**
1. `max_output_tokens` 上限＋**イベントschemaの軽量化**（char offsets等を削る）
2. **セクション並列抽出**
3. モデル/reasoning 階層化 ＋ プロンプトキャッシュ＋クライアントストリーミング

**精度（本物の漏れのみ）**
1. **時制/source 誤分類の是正**（CTがpast_or_externalに落ちる問題）
2. **画像・院内処方の想起強化＋決定論補完**（処方料/調剤料/画像診断料）
3. **goldを2026改定に更新**（物価対応料）→ 見かけのprecision回復・回帰の土台

> [01-latency.md]/[02-accuracy.md] の一般論に対し、本ドキュメントが**実測に基づく確定的な優先順位**。まず 上の各1番から。
