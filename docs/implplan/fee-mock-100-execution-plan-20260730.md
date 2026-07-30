# mock一致率100% 実行計画(E0〜E10)

- 作成日: 2026-07-30
- status: proposed(実行前)
- 親: fee-mock-100-generalization-workorder-20260730.md(M系)。本書はM系の**残作業だけ**を、実物調査済みの具体手順に落とした実行計画。手順内の主張(キー名・コマンド・トリガ有無・挙動)はすべて2026-07-30にコード・データ実物で確認済み。
- 目標: `eval:fee-mock-act-coverage` で **actCoverageRecall 100% / dangerousFalsePositiveCount 0 / コメント検知100% / 点数合計一致(billableReady基準)** を同一revisionで連続達成(M7定義)。
- 表記: [確定作業]=結果が確実な手順 / [検証CP]=実測して分岐する検証チェックポイント(想定結果と、外れた場合の修正先を事前に明記)

## E0: 施行後2か月への期間シフト [実装済み]

- **決定内容**: mock対象月を2026-07、前月を2026-06へ決定論的にシフトし、`--claim-months 2026-06,2026-07` で評価する。令和8年度点数表の施行前だった旧2026-05データは分母に含めない。
- `prepare_homis_mock_v3.py --target-month 2026-07 --check` と期間シフト回帰テストで、既往歴を維持しつつ対象期間だけが移動したことを検証する。
- 旧6月単月の分母・missing数は比較用の過去基線としてのみ扱い、最終受入はシフト後52訪問で判定する。

## E1: STGプロファイル切替デプロイ [確定作業]

- `scripts/p10_deploy_runtime_services_low_cost.sh` を `TARGET_ENV=stg` / `RUNTIME_FEATURE_PROFILE=stg-openai-primary-span-recheck`(+必要なら `TARGET_SERVICE=fee`)で実行。プロファイル指定はスクリプトの `--profile` 連携で適用される(:24-39確認済み)。
- **受入**: readyzで `clinicalExtractionStrategy: "openai_primary"` / `standingFactsEnabled: true` / `extractionCoverage.mode: "verify"`。ハーネスはpreflightでstandingFactsを検証する実装が入っているため、構成違いのまま計測が走ることはない。
- 解禁される欠落: 在医総管/施医総管本体(W1c——M4マップ補完済みなので突合可能)、K4従属加算(包括的支援・移行早期・情報連携・頻回)、G1(採血・超音波)、K5(文書)、K2(材料)の主経路動作。

## E2: 施設データ登録(fee-settings) [確定作業]

対象ファイル: `samples/yamamoto-demo-stg/fee-settings.json`。STGへの適用は既存の確立手順=`scripts/p15_seed_core_account.mjs`(このファイルをfee settingsとしてupsertする。:156-167確認済み)。

1. **`facilityStandards` に追加**(いずれも「デモ施設の届出として登録」の注記付き。`facilityStandardsConfirmed` は **false維持**——M2確定事項):
   - `jikan_gai_taio_taisei_1`(時間外対応加算1)。**注意: エンジン側は1〜4が相互排他**(`outpatient_basic.py` の `prohibited_facility_standard_keys` 確認済み)なので**1のみ**登録
   - E3で新設するトリガが要求するキー(E3で定義を一致させる。例: 在宅緩和ケア充実診療所・病院加算の届出キー)
2. **`facilityServiceSchedules` を登録**: スキーマは実装済み(`fee-contracts/src/index.js:703,755-` の `normalizeFacilityServiceSchedules`)。**値の形式はこのnormalizer実装に従って作成する**(weeklyHours・holidayDates・specialHours・有効期間)。mockの診療体制(平日日中)+1003の18:40電話が時間外判定になる時間設定
3. 適用後、fee settings取得APIで登録内容を確認してから計測する

- 解禁される欠落(6月分): 時間外対応加算1(電話・往診セット内)、時間外加算(再診)(18:40判定)、ベースアップ(1)2/明細書発行(トリガに電話等再診料が含まれることは `outpatient_basic.py:66-108` で確認済み——基本料コードが立てば派生する)

## E3: 不在トリガの追加(dependent_addon 7種) [確定作業・実物確認済みの欠落]

**調査結果(2026-07-30確定)**: 現行トリガカタログ(`standing-structured-triggers-2026.json`)の全19エントリを列挙し、goldに存在する以下の加算のdependent_addonトリガが**存在しない**ことを確認:

| 追加するトリガ | 親ファミリ | 発火事実 | gold件数(6月含む) |
| --- | --- | --- | --- |
| 在宅緩和ケア充実診療所・病院加算(在医総管/施医総管) | 在医総管・施医総管 | 親候補+施設基準キー(E2で定義・登録) | **25** |
| 人工呼吸器加算(陽圧式人工呼吸器) | 在宅人工呼吸指導管理料 | devices: 人工呼吸器(TPPV) | 1 |
| 気管切開患者用人工鼻加算 | 在宅気管切開患者指導管理料 | devices: 人工鼻 | 1 |
| 在宅酸素療法材料加算(その他)/酸素濃縮装置加算/酸素ボンベ加算/呼吸同調式デマンドバルブ加算 | 在宅酸素療法指導管理料 | devices: 各機器 | 4 |

- 実装: K4スキーマ(v2)の `dependent_addon` エントリとして追加。各エントリに一次資料出典(C002注・C107・C103等の該当section)+`humanVerifiableConditions`+`failureMode: confirm_with_note`(recall-first方針)。artifactの再生成(`build_fee_standing_trigger_artifact.mjs`)+sha更新。
- 汎用性: devices事実・親ファミリ・施設基準キー駆動(カタログ追加のみ、レーン本体のコード不変=K4の設計どおり)。

## E4: 初回再計測 [確定作業]

```
npm run eval:fee-mock-act-coverage -- \
  --claim-months 2026-06,2026-07 \
  --organization-code yamamoto-demo-stg --login-id yamamoto-admin \
  --password-file .secrets/yamamoto-demo-stg-password.txt --mfa-code <MFA> \
  --extension-id nhbmaniknlcaaelpaoogepmkhphmmjof \
  --output-dir "docs/20260730-mock-act-coverage-stg/$(date '+%Y%m%d_%H%M%S')"
```

残missingを全件、以下のE5〜E8のどれに落ちるか仕分ける(「その他」を残さない=M7)。

## E5〜E8: 検証チェックポイント(初回再計測の残差に対して)

### E5 [検証CP] 電話再診セットの体制加算が候補化されるか

- **背景(確認済み)**: `applyTelephoneVariant` は `visitKind === telephone_revisit` を要求(`encounter-variants.js`)。初回計測では1003は電話等再診料の確認候補1件のみで体制加算候補が無かった。
- **確認**: (a) ハーネス/exportが電話ケースに `visitKind: "telephone_revisit"` を送っているか (b) E2のキー登録後、体制加算(時間外対応1・明細書発行・ベースアップ(1)2)が候補または確定に現れるか
- **外れた場合の修正先**: (a)なら `export_mock_homis_evaluation_cases.py`(電話ケースへのvisitKind付与) (b)なら `encounter-variants.js` のtelephone経路——基本料が確認候補に留まる場合でも、体制加算セットを同グループの候補として出す(K6のencounter-basic artifactのセット定義を参照し、新規ハードコードはしない)

### E6 [検証CP] K2材料・K5文書・G1検査(openai_primary構成で初検証)

- 対象: 気切チューブ(1002)・栄養カテ/膀胱カテ(1010)・胃瘻カテ(1011)/訪看指示料・特別訪看指示加算(1011,1002)/一般採血(1005)・超音波(1012)
- **想定**: G1(節スコープ)+K2(exact解決)+K5(交付記載)は実装・テスト済みであり、正しい構成なら候補化される。M4でマップ側の突合も解禁済み
- **外れた場合の修正先**: K2は `specific-material-attribute-resolver.js`(属性辞書の不足分)、K5は `document-billing-lane.js`(交付表現・対応表)、G1は `clinical-predicates.js`(節スコープ/語彙)。いずれも修正時はE2コーパスtrainへのfixture追加+安定性ゲート(汎用性ゲート2・3)

### E7 [検証CP] 同一患家(1009)と同一患家コメント検知

- **確認**: M6により1009の2訪問で再診料セット5件が候補一致し、**1008には差替え候補が出ない**こと。`second_visit` と判定した場合だけ、施設恒常ルールで自動追加された訪問診療料・訪問時ベースアップ評価料を抑制し、artifact由来の再診料セットを採用不可の確認候補として提示する。初回患者・順序不明・相手未作成では自動抑制しない。またclaim_comment「同一患家 9日、23日」が `comment_detected` になること(検知はM6の警告文言とコメント突合——`fee-mock-act-coverage.mjs:97,633-` の仕組み)
- **外れた場合の修正先**: `same-household-visit.js`(警告文言に「同一患家」の明示を含める等)。※M6実装への既存P2(SECOND_VISIT_CANDIDATESの出典/K6 artifact参照化・docsへの抑制挙動追記・Firestore複合索引)は**このタイミングで同時に対応**する

### E8 [検証CP] 施医総管系の突合完走

- **確認**: W1c候補(codeCandidates=区分コード群)がM4マップの `candidate_codes` と交差して一致すること。区分不足(単一建物人数由来の区分など)があれば `standing-billing-profiles.js` の `selectStandingFamilyVariant` の変数供給を確認

## E9: 連続再計測+証跡 [確定作業]

1. 残差ゼロを確認後、**同一revisionで計3回**実行し、各回 actCoverageRecall 100% / dangerousFP 0 / コメント検知100% / 点数合計一致(billableReady基準)を確認(M7受入)
2. M8証跡: mock固有分岐なし・fixture配置(trainのみ)・負例fixture(M9トリガ+E3追加分の「出ないこと」)・candidatePrecision実数の記録をレポートに含める
3. README冒頭に E0 の5月除外の明記

## E10: ゲートとコミット [確定作業・省略不可]

1. **gold gate 2系統(seed-300 / v2 exact 138)+抽出安定性ゲート** — 本差分はエンジン(`checks_api.py`・`outpatient_basic.py`)に触れているため必須
2. E2コーパス dev/holdout 回帰ゼロ(E6で述語・辞書に触れた場合)
3. ゲート緑を確認してからコミット(コミットはユーザー)

## 付録: 6月missing 73件の閉じ込め対応表(初回計測の実測値ベース)

| 欠落グループ | 件数 | 閉じるステップ |
| --- | --- | --- |
| 在医総管/施医総管本体(全区分) | ≈15 | E1(W1c解禁)+M4済み+E8 |
| 在宅緩和ケア充実加算(在/施) | ≈13 | E1+**E3**+E2(キー) |
| 包括的支援・移行早期・情報連携・頻回 | ≈9 | E1(K4+M3 surfaces済み) |
| 指導管理料本体(酸素・人工呼吸・気切) | 3 | E1(K4 device_management済み)+M3済み |
| 機器加算6種 | 6 | **E3** |
| 時間外対応1・明細書発行・ベースアップ(1)2・再診料系・往診 | ≈12 | E2+E5(+M4済みの往診) |
| 時間外加算(再診) | 1 | E2(診療時間) |
| 材料4種 | ≈5 | E6 |
| 文書(訪看指示料・特別訪看指示加算) | 3 | E6 |
| 検査(採血・超音波) | 2 | E1+E6 |
| 同一患家(再診料セット) | ≈5 | E7(M6実装済み) |
| コメント検知 | 1 | E7 |

※件数は5月除外後の6月分概算。E4の初回再計測で確定させ、この表を実測で更新する。
