# ORCA SOAP first 3 current-logic evaluation

Generated: 2026-06-06T12:59:42.956Z

## 実行条件

- 対象: `orca-karte-gold-11.md` のSOAP書き起こし版 事例1〜3
- 入力: SOAP本文のみ。手入力オーダーなし
- API経路: `handleFeeApiRequest` でFee APIのセッション作成→算定→詳細取得を実行
- 算定エンジン: ローカルPython Fee calculator + `python/data/master/standard-master.sqlite`
- OpenAI構造化: 無効（このシェルにOPENAI_API_KEYなし。rules_no_openai経路）
- 注意: ORCA期待明細は2016年ver 4.8.0基準。点数絶対値ではなく、抽出・候補化・除外の妥当性を主に見る
- 総実行時間: 515ms

## サマリー

| 事例 | 現行結果 | 点数 | 明細数 | 病名抽出 | 主な評価 |
| --- | --- | ---: | ---: | --- | --- |
| 1 | needs_review | 553 | 5 | なし | 骨折/創傷/画像/投薬の大半が落ち、単純X線と基本料中心 |
| 2 | needs_review | 821 | 2 | なし | ポリープ切除/病理/投薬/注射が落ち、尿検査・超音波・基本料中心 |
| 3 | needs_review | 291 | 1 | なし | 喘息点滴/管理料/投薬の多くが落ち、検査と基本料中心 |

## 事例1（整形外科・国保）

### 期待明細（Docs抜粋）

```text
初・再診料 ＊初診                      2820 ×1 = 2,820
医学管理等 ＊薬剤情報提供料               100 ×1 =   100
投　薬   ＊ケフラール細粒小児用100mg 3g    130 ×3 =   390
        ＊調剤料（内服薬・浸煎薬・屯服薬）    90 ×1 =    90
        ＊カロナール錠200 200mg 1錠         10 ×5 =    50
        ＊処方料（その他）                420 ×1 =   420
処　置   ＊四肢ギプス包帯（半肢）（片）     7800 ×1 = 7,800
        ＊創傷処置（100cm²未満）           450 ×1 =   470相当
画像     ＊単純X線（頭部/デジタル・写真診断）＋ 電子画像管理加算（単純撮影） 2870 / 2240
（再診回）初・再診料 ＊再診 720 ＋ 明細書発行体制等加算 10 ＋ 処置 創傷処置 イソジン液 470
```

### 現行結果

- Status: needs_review
- Total points: 553
- Diagnoses: なし
- Calculation options source: clinical_auto
- Auto keys: outpatient_basic, imaging_orders, treatment_orders
- Clinical structuring: source=rules_no_openai / durationMs=0 / model=gpt-5.4-nano / fallback=-
- Rule inference: source=fallback_rules / durationMs=3 / masterLookupCount=0

#### 算定候補

| code | name | category | status | points | review |
| --- | --- | --- | --- | ---: | --- |
| 111000110 | 初診料 | basic | candidate | 291 | 要 |
| 140000610 | 創傷処置（１００ｃｍ２未満） | treatment | candidate | 52 | 要 |
| 170000410 | 単純撮影（イ）の写真診断 | imaging | candidate | 85 | 要 |
| 170027910 | 単純撮影（デジタル撮影） | imaging | candidate | 68 | 要 |
| 170000210 | 電子画像管理加算（単純撮影） | imaging | candidate | 57 | 要 |

#### レビュー/警告

- warning: Treatment fee not added: area size is required for wound
- warning: hospital_profile_warning: hospital_registry_not_found
- warning: hospital_profile_warning: facility_standards_not_found
- warning: 単純X線は撮影方式・写真診断区分がカルテ本文から完全には確定できないため、デジタル/写真診断イとして候補化しています。請求前に確認してください。
- warning: 処置面積がカルテ本文から確定できないため、処置料は要確認です。面積区分を確認してください。
- warning: 病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。
- 算定警告: Treatment fee not added: area size is required for wound
- 算定警告: hospital_profile_warning: hospital_registry_not_found
- 算定警告: hospital_profile_warning: facility_standards_not_found
- 算定警告: 単純X線は撮影方式・写真診断区分がカルテ本文から完全には確定できないため、デジタル/写真診断イとして候補化しています。請求前に確認してください。
- 算定警告: 処置面積がカルテ本文から確定できないため、処置料は要確認です。面積区分を確認してください。
- 算定警告: 病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。
- 初診料: Outpatient basic fee candidate for initial
- 創傷処置（１００ｃｍ２未満）: Treatment fee candidate for wound
- 単純撮影（イ）の写真診断: Imaging fee candidate for simple_radiography
- 単純撮影（デジタル撮影）: Imaging fee candidate for simple_radiography
- 電子画像管理加算（単純撮影）: Imaging fee candidate for simple_radiography

#### 評価メモ

- Docs期待では初診、薬剤情報提供、抗菌薬/鎮痛薬、ギプス、創傷処置、頭部/前腕X線が主要項目。
- 現行結果は単純X線や基本料は一部候補化するが、ギプス、創傷処理、局麻/洗浄、処方薬の展開が不足。
- 複数日SOAPを1診療日セッションに入れているため、再診回の創傷処置をどう分割するかも未定義。

## 事例2（内科・協会けんぽ→国保）

### 期待明細（Docs抜粋）

```text
初・再診料 ＊初診                      2820 ×1 = 2,820
投　薬   ＊ガスコン錠40mg 2錠 1090 / 調剤料90 / 処方料（その他）420
（内視鏡回）＊キシロカインゼリー2% 10mL 50130
病理診断 ＊T-M 1臓器 8600 ＋ 病理判断料 1500
（再診回）医学管理 薬剤情報提供料100 / 投薬 ウロカルン錠225mg 6錠 50×3=150 / ボルタレンサポ50mg 3個 170 / 調剤料(外用)60
```

### 現行結果

- Status: needs_review
- Total points: 821
- Diagnoses: なし
- Calculation options source: clinical_auto
- Auto keys: outpatient_basic, procedure_codes
- Clinical structuring: source=rules_no_openai / durationMs=0 / model=gpt-5.4-nano / fallback=-
- Rule inference: source=fallback_rules / durationMs=90 / masterLookupCount=1

#### 算定候補

| code | name | category | status | points | review |
| --- | --- | --- | --- | ---: | --- |
| 160072210 | 超音波検査（断層撮影法）（胸腹部） | procedure | needs_review | 530 | 要 |
| 111000110 | 初診料 | basic | candidate | 291 | 要 |

#### レビュー/警告

- warning: Lab management fee skipped: facility_standard_not_found
- warning: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100681 超音波検査（断層撮影法）（胸腹部）：ア　消化器領域
- warning: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100682 超音波検査（断層撮影法）（胸腹部）：イ　腎・泌尿器領域
- warning: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100683 超音波検査（断層撮影法）（胸腹部）：ウ　女性生殖器領域
- warning: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100684 超音波検査（断層撮影法）（胸腹部）：エ　血管領域（大動脈・大静脈等）
- warning: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100685 超音波検査（断層撮影法）（胸腹部）：オ　腹腔内・胸腔内の貯留物等
- warning: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100686 超音波検査（断層撮影法）（胸腹部）：カ　その他
- warning: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 830100144 具体的な臓器又は領域；
- warning: hospital_profile_warning: hospital_registry_not_found
- warning: hospital_profile_warning: facility_standards_not_found
- warning: 病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。
- 算定警告: Lab management fee skipped: facility_standard_not_found
- 算定警告: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100681 超音波検査（断層撮影法）（胸腹部）：ア　消化器領域
- 算定警告: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100682 超音波検査（断層撮影法）（胸腹部）：イ　腎・泌尿器領域
- 算定警告: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100683 超音波検査（断層撮影法）（胸腹部）：ウ　女性生殖器領域
- 算定警告: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100684 超音波検査（断層撮影法）（胸腹部）：エ　血管領域（大動脈・大静脈等）
- 算定警告: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100685 超音波検査（断層撮影法）（胸腹部）：オ　腹腔内・胸腔内の貯留物等
- 算定警告: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 820100686 超音波検査（断層撮影法）（胸腹部）：カ　その他
- 算定警告: Required comment candidate: 160072210 超音波検査（断層撮影法）（胸腹部） needs 830100144 具体的な臓器又は領域；
- 算定警告: hospital_profile_warning: hospital_registry_not_found
- 算定警告: hospital_profile_warning: facility_standards_not_found
- 算定警告: 病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。
- 超音波検査（断層撮影法）（胸腹部）: Input medical procedure code matched master only; chapter-specific billing rules are not confirmed
- 初診料: Outpatient basic fee candidate for initial

#### 評価メモ

- Docs期待では初診時前処置薬、内視鏡的ポリープ切除、病理、再診時尿検査/血液検査/腹部超音波/注射/投薬が主要項目。
- 現行結果は尿・血液検査や超音波を一部拾うが、内視鏡手術、病理、注射、薬剤の多くが候補化されない。
- 保険変更や複数受診日の扱いは現行セッションモデルでは表現できていない。

## 事例3（内科・共済）

### 期待明細（Docs抜粋）

```text
初・再診料 ＊再診 720 ＋ 明細書発行体制等加算 10 ＋ 外来管理加算 520
医学管理等 ＊特定疾患療養管理料（診療所） 2250
注射等   ＊水溶性プレドニン20mg 1管 920
検　査   ＊末梢血液一般 210 / カリウム 1150 / CRP 160 / B-V 250
        ＊血液学的検査判断料 1250 / 生化学的検査(1)判断料 1440 / 免疫学的検査判断料 1440
（複数受診で同様の再診＋特定疾患療養管理料が反復）
```

### 現行結果

- Status: needs_review
- Total points: 291
- Diagnoses: なし
- Calculation options source: clinical_auto
- Auto keys: outpatient_basic
- Clinical structuring: source=rules_no_openai / durationMs=0 / model=gpt-5.4-nano / fallback=-
- Rule inference: source=fallback_rules / durationMs=1 / masterLookupCount=0

#### 算定候補

| code | name | category | status | points | review |
| --- | --- | --- | --- | ---: | --- |
| 111000110 | 初診料 | basic | candidate | 291 | 要 |

#### レビュー/警告

- warning: hospital_profile_warning: hospital_registry_not_found
- warning: hospital_profile_warning: facility_standards_not_found
- warning: 病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。
- 算定警告: hospital_profile_warning: hospital_registry_not_found
- 算定警告: hospital_profile_warning: facility_standards_not_found
- 算定警告: 病名が入力されていません。査定リスク確認のため、主病名または疑い病名を入力してください。
- 初診料: Outpatient basic fee candidate for initial

#### 評価メモ

- Docs期待では再診、外来管理加算、特定疾患療養管理料、点滴注射、血液/生化学/CRP、判断料が主要項目。
- 現行結果は初診料のみで、再診・検査・判断料・特定疾患療養管理料・点滴注射・処方薬が候補化されない。
- 同一SOAP内の4/19〜4/21の複数再診を1算定に集約してしまうため、受診日単位の分割評価が必要。

