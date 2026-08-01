# 緊急時治療管理 独立チェッカー・単一CSV方針 (2026-08-01)

状態: 設計確定前の実装計画。実装未着手。

関連資料:

- 制度・単位・現行実装監査: `docs/20260716-emergency-treatment-management-current-fee-audit.md`
- 旧アプリ構想: `docs/20260713-care-emergency-treatment-management-app-plan.md`
- 旧作業指示: `docs/implplan/care-fee-workorder-20260717.md`

本書は、緊急時治療管理を医科診療報酬算定アプリに依存させず、単独利用と既存アプリ連携の両方を成立させるための最新方針である。入力はZIPではなく、原則として**1つのCSVファイル**に統一する。

## 1. 結論

プロダクトは「介護請求ソフトの置換」ではなく、既存の記録・請求システムに後付けできる**緊急時治療管理の根拠付き請求前チェッカー**とする。

```text
単独WebのCSV取込 ─┐
ローカルCLI       ├─> care-emergency-csv-v1 ─> 共通判定エンジン ─> 共通結果
外部API           ┤
医科Feeアプリ     ┘
```

重要な設計判断:

1. 入力は1ファイルのCSVとし、1行を「1患者・1急変エピソード・1治療日」とする。
2. 1つの急変が2日続けば、同じ`episode_key`で2行にする。
3. 重篤状態、実施行為、併算定情報は、JSONや自由区切り文字ではなく専用列で持つ。
4. CSV取込、手入力、API、Feeアプリ連携は同じ正規化契約と判定エンジンを使う。
5. 構造化CSVの判定にはLLMを使わない。PDF・自由記載の補助抽出は別経路とする。
6. 一括処理の出力も1つのCSVとし、元の入力行へ判定列を追加して返す。
7. 一括判定は最大でも`billing_candidate`までであり、一括確定はしない。
8. 介護単位を医科点数へ変換・加算しない。

## 2. なぜ「1行=1治療日」か

緊急時治療管理は、同一入所者について月1回、連続3日まで、日ごとに投薬・検査・注射・処置等の実施事実が必要である。そのため、1行をエピソード全体にすると日別実施を配列や区切り文字で埋め込む必要があり、Excel編集、列マッピング、入力エラーの特定が難しくなる。

1行を治療日とすれば、次を通常のCSV集計で判定できる。

- 暦日の連続性
- 3日上限
- 日ごとの実施行為
- 同日併算定
- 月内の別エピソード
- 行単位の取込エラーと根拠表示

同じエピソード内の共通項目は各行へ反復する。反復値が一致しない場合は推測で統合せず、`import_error`にする。

### 2.1 現場での判断と情報源

施設ごとに役割分担は異なるが、事務担当者がカルテ本文だけから医学的な重篤性を独自判断する運用にはしない。一般的には次の順序になる。

1. 医師が診断、重篤な状態、救命救急医療の必要性、施設内で行う治療方針を判断する。
2. 医師・看護職員等が急変時の状態、バイタル、指示、投薬・検査・注射・処置の実施内容、転帰を日ごとに記録する。
3. 現場から医事・介護請求担当へ、専用確認票、算定連絡又は請求システム上のフラグで候補が渡る。
4. 請求担当は、診療録と実施記録に必要事実が残っているか、対象サービスか、月1回か、連続3日以内か、同日・同月の併算定競合がないかを照合する。
5. 不足があれば医師・看護側へ照会し、根拠が揃った日だけを請求ソフトへ登録する。
6. 月次請求前に別担当者又はチェックリストで再確認する。

判断に使う情報源の優先順位は次のとおりとする。

1. 医師の診断・診療方針・救命救急医療が必要との判断を含む診療録
2. 投薬、検査、注射、処置のオーダ及び実施記録
3. 看護・介護の急変時経過、バイタル、連絡、搬送・施設内継続の記録
4. 当月の介護請求履歴と併算定項目
5. 確認票又は算定連絡票。ただし原記録への索引として扱い、確認票だけで医学的事実を確定しない

厚生労働省の[指定施設サービス等の算定基準](https://www.mhlw.go.jp/web/t_doc?dataId=82aa0255&dataType=0)は、重篤となり救命救急医療が必要な場合に、投薬、検査、注射、処置等を行ったことを算定条件としている。[留意事項通知](https://www.mhlw.go.jp/web/t_doc?dataId=00ta4383&dataType=1&pageNo=2)は対象となる重篤状態、月1回、連続3日、特定治療との同時算定不可を示している。このため、カルテは主な臨床根拠だが、カルテ本文だけでは月内請求履歴や併算定まで確認できず、単独では判定を完結できない。

## 3. 単一CSV契約

契約名: `care-emergency-csv-v1`

### 3.1 ファイル規約

- 文字コード: 出力はUTF-8 BOM。入力はUTF-8、UTF-8 BOM、CP932を受け付ける。
- CSV: RFC 4180準拠。カンマ・改行・ダブルクォートを含むセルは正しくクォートする。
- ヘッダー: ASCIIの固定列名を正とする。画面では日本語ラベルを表示する。
- 日付: `YYYY-MM-DD`、日時: ISO 8601。タイムゾーン省略時は施設の設定値を使う。
- 真偽値: `true` / `false` / 空欄のみ。空欄は不明、`false`は明示的な否定として区別する。
- 空欄: 記録に無い事実を補完しない。必須情報の空欄は`needs_review`または`import_error`にする。
- CSVセルへJSONを埋め込まない。
- 同一ファイル内で`schema_version`を混在させない。
- 元ファイル全体と各正規化行のSHA-256をサーバ側で生成し、結果へ記録する。

### 3.2 入力列

| 列 | 必須 | 内容 |
| --- | --- | --- |
| `schema_version` | 必須 | 常に`care-emergency-csv-v1` |
| `batch_id` | 任意 | 施設側の一括処理識別子 |
| `facility_code` | 必須 | ハルナス施設コードまたは外部施設コード |
| `care_office_number` | 条件付き | 介護保険事業所番号。施設設定で解決できる場合は省略可 |
| `care_service_type` | 必須 | 対象サービス種別enum |
| `claim_month` | 必須 | `YYYY-MM` |
| `patient_key` | 必須 | 施設内で一意の患者・入所者キー |
| `patient_display_name` | 任意 | 画面確認用。匿名化取込では空欄可 |
| `episode_key` | 必須 | 同一急変を束ねる施設内キー |
| `onset_at` | 必須 | 急変発生日時 |
| `treatment_date` | 必須 | この行が表す治療日 |
| `acute_diagnosis` | 必須 | 急変時病名・状態 |
| `severe_consciousness_disorder` | 条件付き | 意識障害又は昏睡 |
| `severe_respiratory_failure` | 条件付き | 急性呼吸不全又は慢性呼吸不全の急性増悪 |
| `severe_heart_failure` | 条件付き | 急性心不全、心筋梗塞を含む |
| `severe_shock` | 条件付き | ショック |
| `severe_metabolic_disorder` | 条件付き | 重篤な代謝障害 |
| `severe_other_poisoning` | 条件付き | その他薬物中毒等で重篤なもの |
| `emergency_care_required` | 必須 | 救命救急医療が必要との判断 |
| `emergency_care_rationale` | 条件付き | 上記判断の根拠。`true`なら必須 |
| `facility_treatment_rationale` | 任意 | 搬送・入院ではなく施設内治療とした経緯 |
| `medication_performed` | 必須 | 当日の投薬実施 |
| `medication_detail` | 条件付き | 実施した投薬の内容 |
| `test_performed` | 必須 | 当日の検査実施 |
| `test_detail` | 条件付き | 実施した検査と結果 |
| `injection_performed` | 必須 | 当日の注射・点滴実施 |
| `injection_detail` | 条件付き | 実施した注射・点滴の内容 |
| `procedure_performed` | 必須 | 当日の処置実施 |
| `procedure_detail` | 条件付き | 実施した処置の内容 |
| `physician_confirmed` | 必須 | 医師確認済みか。法令文言の代用ではなく製品上の安全ゲート |
| `physician_confirmed_by` | 条件付き | 確認者識別子 |
| `physician_confirmed_at` | 条件付き | 確認日時 |
| `existing_emergency_claim_count_month` | 必須 | ファイル外を含む当月既算定件数。0以上の整数 |
| `existing_emergency_claim_start_date` | 条件付き | 既算定がある場合の開始日 |
| `concurrent_specific_treatment` | 必須 | 当日の特定治療算定 |
| `concurrent_specific_disease_facility_treatment` | 必須 | 当日の所定疾患施設療養費等の算定 |
| `concurrent_comprehensive_medical_management` | 必須 | 短期入所の総合医学管理加算等の算定 |
| `existing_claim_service_code` | 任意 | 既存介護請求データとの比較用コード |
| `transfer_requested` | 任意 | 搬送依頼の有無 |
| `transfer_outcome` | 任意 | 搬送、入院、施設内継続等の転帰 |
| `source_record_id` | 任意 | 元システムの記録ID |
| `source_excerpt` | 任意 | 判定根拠となる原文。自由記載から事実を補完しない |
| `input_origin` | 必須 | `manual/csv_export/ocr/fee_app/api` |

6つの重篤状態列は、少なくとも1つが`true`である必要がある。すべて`false`なら対象外候補、すべて空欄なら要確認とする。

### 3.3 サービス種別enum

- `roken`
- `care_medical_institution`
- `short_stay_roken`
- `short_stay_care_medical_institution`
- `preventive_short_stay_roken`
- `preventive_short_stay_care_medical_institution`

表示名からサービスコードを直接決めない。`care_service_type + treatment_date + facility settings`から有効なコード・単位を解決する。

### 3.4 最小入力例

```csv
schema_version,batch_id,facility_code,care_office_number,care_service_type,claim_month,patient_key,patient_display_name,episode_key,onset_at,treatment_date,acute_diagnosis,severe_consciousness_disorder,severe_respiratory_failure,severe_heart_failure,severe_shock,severe_metabolic_disorder,severe_other_poisoning,emergency_care_required,emergency_care_rationale,facility_treatment_rationale,medication_performed,medication_detail,test_performed,test_detail,injection_performed,injection_detail,procedure_performed,procedure_detail,physician_confirmed,physician_confirmed_by,physician_confirmed_at,existing_emergency_claim_count_month,existing_emergency_claim_start_date,concurrent_specific_treatment,concurrent_specific_disease_facility_treatment,concurrent_comprehensive_medical_management,existing_claim_service_code,transfer_requested,transfer_outcome,source_record_id,source_excerpt,input_origin
care-emergency-csv-v1,202608-a,nishiyama-care-01,1234567890,care_medical_institution,2026-08,P0001,,E0001,2026-08-10T14:20:00+09:00,2026-08-10,誤嚥性肺炎による急性呼吸不全,false,true,false,false,false,false,true,酸素化低下があり緊急治療を要した,施設内で医師管理下に治療継続,true,抗菌薬投与,true,採血及び血液ガス,true,末梢点滴,true,酸素投与3L,false,,,0,,false,false,false,,false,施設内治療継続,R1001,"SpO2低下。酸素投与、採血、点滴を開始。",csv_export
care-emergency-csv-v1,202608-a,nishiyama-care-01,1234567890,care_medical_institution,2026-08,P0001,,E0001,2026-08-10T14:20:00+09:00,2026-08-11,誤嚥性肺炎による急性呼吸不全,false,true,false,false,false,false,true,酸素化低下があり緊急治療を要した,施設内で医師管理下に治療継続,true,抗菌薬投与,true,採血,true,末梢点滴,true,酸素投与2L,true,D001,2026-08-11T09:00:00+09:00,0,,false,false,false,,false,施設内治療継続,R1002,"酸素、抗菌薬、点滴を継続。",csv_export
```

例は契約確認用であり、単位・サービスコードの根拠には使用しない。

## 4. 入力検証

### 4.1 `import_error`にするもの

- 必須識別子、日付、サービス種別の形式不正
- 同じ`facility_code + patient_key + episode_key + treatment_date`の重複
- 同じエピソード内で`onset_at`、病名、重篤状態などの反復値が矛盾
- `true`の実施行為に詳細が無い
- `physician_confirmed=true`なのに確認者又は確認日時が無い
- `claim_month`と`treatment_date`が不整合
- 対応していない`schema_version`

### 4.2 `needs_review`にするもの

- 重篤状態がすべて不明
- 救命救急医療の必要性又は根拠が不明
- 投薬・検査・注射・処置がすべて不明又は未実施
- 当月既算定件数が不明
- 併算定状態が不明
- 医師確認が未完了
- 月をまたぐ連続エピソードなど、公式解釈を確定していない境界

`import_error`と`needs_review`を混ぜない。前者は機械的に読み取れない状態、後者は読み取れたが算定判断に必要な事実が不足する状態である。

## 5. 出力CSV

出力ファイル名: `emergency-treatment-result_<claim_month>_<run_id>.csv`

入力列をそのまま保持し、次の列を末尾へ追加する。

| 出力列 | 内容 |
| --- | --- |
| `import_status` | `accepted/import_error` |
| `judgment_status` | `billing_candidate/needs_review/conflict/not_eligible/import_error` |
| `eligible_day` | この治療日を単位計上できる候補か |
| `day_judgment` | `eligible/needs_review/over_limit/not_eligible` |
| `resolved_service_code` | 有効期間付きマスタから解決したコード |
| `resolved_service_code_name` | コード名称 |
| `unit_score` | 算定日のマスタ単位 |
| `counted_units` | この行で計上する候補単位 |
| `episode_eligible_day_count` | エピソード内の対象日数 |
| `episode_total_units` | エピソード合計候補単位。各行へ同じ値を反復 |
| `reason_codes` | 安定した機械可読reason code。`;`区切り |
| `missing_fields` | 不足列名。`;`区切り |
| `conflict_codes` | 併算定競合reason code。`;`区切り |
| `master_version` | 使用した介護サービスコードマスタ版 |
| `rule_version` | 使用した判定ルール版 |
| `source_file_sha256` | 入力CSV全体のハッシュ |
| `normalized_row_sha256` | 正規化後行のハッシュ |
| `run_id` | 判定実行ID |
| `evaluated_at` | 判定日時 |

CSVのセルは説明文ではなくreason codeを正とし、UIと日本語説明はreason codeから生成する。これにより表現変更で比較結果が揺れない。

## 6. 利用モード

### 6.1 スポット一括判定

診療報酬算定アプリを利用しない施設向け。

1. 独立画面でCSVを1ファイル選択
2. 文字コード・ヘッダー・件数を事前検証
3. 一括判定
4. 状態別一覧と根拠を画面表示
5. 結果CSVを1ファイルで出力

症例や確定結果は恒久保存しない。処理の安全性と障害調査に必要な最小ジョブメタデータだけを保持し、入力・結果オブジェクトは短期TTLで削除する。削除期間はセキュリティレビューで確定する。

### 6.2 運用管理

医師確認、対象外理由、月次確定、監査ログが必要な施設向け。CSV取込後に`careFeeEpisodes`へ保存し、個別レビューする。

### 6.3 Feeアプリ連携

医科FeeアプリはCSVを生成して再取込するのではなく、同じ`care-emergency-csv-v1`相当のJSON行を介護側APIへ渡すアダプターとする。医科`feeSessions`、`totalPoints`、`candidateProposals`へ介護単位を混在させない。

連携の境界は次のとおりとする。

- `fee`と`care_fee`の両entitlementを持ち、施設が連携を明示的に有効化した場合だけ動かす。
- Feeアプリが渡すのは、患者・施設・診療日、原記録、実施行為、取得元、抽出版等の証拠と構造化事実であり、医科の算定候補や点数を介護の結論として渡さない。
- `care-fee`側から`feeSessions`やFee内部storeを直接参照しない。確定カルテ又は算定入力の保存後に、outbox/event経由で版付き契約を送る。
- 同じ記録の再送は`facility + patient + sourceRecordId + sourceRevisionHash`で冪等に処理する。
- Fee側で既に抽出した事実は再利用できるが、元記録、抽出器版、確信度を保持し、介護要件で不足する項目は`needs_review`にする。
- 同じ正規化事実はCSV、API、Fee連携のどこから入っても`care-fee-core`で同じ結果になる。

### 6.4 自動月次点検

Fee連携を有効にした施設では、カルテ保存時の増分検知と月次締め前の再点検を組み合わせる。

```text
カルテ確定
  -> Fee連携アダプターが証拠と事実を送信
  -> 急変・治療管理シグナルを点検
  -> 該当又は情報不足ならcareFeeEpisodeを下書き作成

月次締め前
  -> 当月の下書き・既算定・併算定情報を再取得
  -> 月1回、連続3日、日別実施、競合を再判定
  -> 算定候補・要確認・競合・対象外の一覧を作成
  -> 事務担当者が確認・確定
```

運用要件:

1. 自動化するのは検知、再判定、一覧作成までとし、自動確定・自動請求・請求ソフトへの自動書戻しは行わない。
2. 原記録に医学的判断又は日別実施が無ければ補完せず、`needs_review`として医師・看護側への確認事項を示す。
3. 月次ジョブは施設タイムゾーンと請求月を明示し、同じ対象月を再実行しても下書きや候補を重複作成しない。
4. 全カルテを毎月LLMで再抽出しない。保存時に版付き解析結果を作り、月次は差分と未処理・失敗記録だけを再処理する。
5. 月次実行ごとに、対象記録数、解析済み数、候補数、要確認数、エラー数、未取得数をcoverage reportへ残す。候補0件だけでは正常完了と判断しない。
6. Fee側にデータがない施設でも、CSV、手入力又は外部APIだけで同じ月次判定を実行できる。

### 6.5 CLI

```bash
npm run eval:care-emergency-csv -- \
  --input emergency-treatment.csv \
  --output emergency-treatment-result.csv
```

純粋なCSV正規化・決定論判定に限定し、構造化CSVではOpenAIを呼ばない。院内ネットワーク制約下の検証と回帰にも使用する。

## 7. アーキテクチャ

```text
apps/care-fee-web/                         独立した利用画面
packages/care-fee-contracts/              CSV/JSON契約、enum、validator
packages/care-fee-core/                   決定論判定
services/fee-api/src/care-fee/            初期のAPI実装先
scripts/evaluate_care_emergency_csv.mjs    CLI
```

初期は既存Cloud Run、認証、組織、患者、監査基盤を共有してよい。ただし次を禁止する。

- `care-fee-core`からFeeアプリ又は`feeSessions`をimportする
- 医科点数マスタから介護単位を解決する
- WebとAPIで判定ロジックを二重実装する
- 入力経路ごとに異なる判定ルールを使う

独立商品としては`care_fee` entitlementと独立ナビゲーションを持たせる。商用契約、スケール、障害分離の必要が生じた段階で`care-fee-api`を物理分割する。

### 7.1 Webアプリとドメインの境界

初回リリースから、医科診療報酬算定の画面内機能ではなく、独立したWebアプリとして提供する。

| 環境 | Webアプリ | 想定ドメイン | Netlify site（新設予定） |
| --- | --- | --- | --- |
| STG | `apps/care-fee-web` | `https://care.stg.halunasu.com` | `halunasu-care-fee-stg` |
| PROD | `apps/care-fee-web` | `https://care.halunasu.com` | `halunasu-care-fee-prod` |

境界は次のとおりとする。

- `fee.halunasu.com/care`配下には実装しない。医科Feeのルーティング、セッション画面、算定候補、合計点数へ介護機能を混在させない。
- Feeアプリのハンバーガーメニューから、`care_fee` entitlementを持つ利用者に限り独立ドメインへのリンクを表示してよい。
- 病院コード、個人ID、組織、施設、認証基盤は既存Platformと共有し、製品権限は`fee`と`care_fee`で分離する。
- `care-fee-web`は同一オリジンの`/api/platform`と`/api/care-fee`を使用する。初期の`/api/care-fee`は既存`fee-api`内の`/v1/care-fee/`へプロキシする。
- CSV画面、ナビゲーション、エラー表示、監査導線は介護報酬点検として独立させる。Feeアプリのコンポーネントを直接importせず、必要なデザイントークンだけを共有する。
- `fee-api`停止時の影響を初期は許容するが、商用SLA、負荷又はリリース周期が分かれた時点で`care-fee-api`へ物理分割する。

この構成により、診療報酬算定を契約していない施設でも介護報酬点検だけを利用でき、制度・単位・権限・障害の境界も画面上で明確になる。

### 7.2 医科診療報酬算定との共通基盤と分離境界

共通点はカルテ入力だけではない。両製品とも、業務上は次の同じパイプラインを持つ。

```text
原記録・実績
  -> 事実の構造化
  -> 有効期間付きマスタ・施設設定・履歴による決定論点検
  -> 不足情報と競合の提示
  -> 人による確認・確定
  -> 監査証跡・月次出力
```

ただし、共通化するのは基盤能力に限定し、制度固有の判定を1つの算定エンジンへ統合しない。

| 領域 | 共通化方針 |
| --- | --- |
| 病院コード・個人ID・組織・施設・利用者 | Platformの認証・テナント境界を共有する |
| ロール、製品権限、監査ログ | 基盤形式を共有し、`fee`と`care_fee`の権限は分ける |
| CSV/API/手入力、文字コード、行エラー | 汎用の安全な取込部品とジョブ実行基盤を再利用する |
| 原文、元記録ID、入力ハッシュ、取得日時 | provenanceの形式と改ざん検知方式を共有する |
| 有効期間付きマスタ、ルール版、再現可能性 | loaderとmanifestの設計原則を共有し、マスタ本体は分ける |
| `unknown/true/false`、要確認、競合 | 3値とfail-closedの原則、表示部品を共有する |
| 人による採用・対象外化・確定 | HITLと監査イベントの共通パターンを使う |
| CSV出力、処理時間、Cloud Runログ | 出力・可観測性の基盤を共有する |

入力資料も同一ではない。

- 医科診療報酬算定は、SOAP、病名、処方、オーダ、検査、処置、在宅医療機器、医科施設基準などを主に扱う。
- 緊急時治療管理は、医師・看護・介護記録、急変時の重篤状態、救命救急医療が必要な理由、施設内治療の理由、日別の投薬・検査・注射・処置、搬送転帰、介護請求履歴を扱う。
- カルテ本文は両方で利用できる証拠の1つだが、緊急時治療管理ではカルテ本文だけで算定可否を確定しない。

次は分離を維持する。

- 医科の`fee-core`と介護の`care-fee-core`
- 医科点数マスタと介護サービスコード・単位マスタ
- 医科の施設基準と介護サービス種別・介護施設設定
- 医科点数、概算医療費と介護単位
- 医科レセプトの患者月集計と、緊急時治療管理の月1回・連続3日等の集計
- `feeSessions`等の医科保存領域と`careFeeEpisodes`等の介護保存領域

コード共有は、実装を見て少なくとも2製品で同じ契約が安定した後に、認証、CSV parser、provenance、監査、マスタmanifest等の技術部品を小さく切り出す。医科と介護を抽象的な「万能算定エンジン」へ先に統合することはしない。

## 8. 競合調査

### 8.1 直接・隣接競合

| 製品 | 公開情報で確認できた範囲 | 本製品との関係 |
| --- | --- | --- |
| [CAREKARTE](https://www.carekarte.jp/claim/) | 老健・介護医療院の記録から請求まで対応。老健・介護医療院版の[請求運用マニュアル](https://storage.carekarte.jp/wp_9dfg43aaet8/wp-content/uploads/RKN_CKBillingManual.pdf)では、緊急時傷病の開始日、終了日、傷病名、施設療養の実施理由を登録し、緊急時治療管理を請求へ接続する運用を確認した | 最も近い直接競合。ただし公開資料では、任意の外部記録を一括投入し、重篤状態・実施事実・月内制限・併算定を根拠付きで独立点検する機能までは確認できない |
| [ワイズマン 介護老人保健施設管理システムSP](https://www.wiseman.co.jp/products/welfare/facility/health/) / [介護医療院カルテ](https://www.wiseman.co.jp/products/welfare/facility/care-medical/) | 老健・介護医療院の記録、計画、給付費請求を一体提供 | 既存システム置換領域では強い。ハルナスは置換ではなく請求前点検として併用する |
| [ほのぼのNEXT](https://www.ndsoft.jp/lp/lp_next/) | 介護記録、請求、LIFE、請求前の警告・進捗管理を一体提供 | 総合業務システムとしての競合。ベンダー非依存CSV点検で差別化する |
| [福祉見聞録](https://www.fukushikenbunroku.com/products/houtsu/index.php) | 予定と実績、施設体制と実績の不一致、請求電文のエラーを点検 | 形式・実績整合チェックの隣接競合。臨床根拠の説明可能な判定が差分 |
| [国保中央会 介護伝送ソフト](https://www.kokuho.or.jp/kaigosoft/jigyosho_ver10/index.html) | 介護給付費請求の入力・確認・伝送。サービスコードと適用年月等に基づく設定・形式チェック | 請求提出の最終工程。ハルナスはその前段で証拠と算定要件を点検する |

### 8.2 競争上の判断

介護記録・計画・請求・国保連伝送をすべて持つ製品と正面から競争しない。初期の価値は次に限定する。

1. 既存製品を問わず単一CSVで取り込める。
2. 緊急時治療管理に特化し、算定候補だけでなく不足根拠を返す。
3. 月1回、連続3日、日別実施、併算定競合を決定論で再現する。
4. マスタ版、ルール版、入力ハッシュを結果へ残す。
5. 既存請求ソフトのデータを上書きせず、結果CSVを人が確認して反映する。
6. 単独Web、CLI、API、Fee連携で同一結果を返す。

公開資料を調査した範囲では、「任意の介護記録・紙確認票・他社請求データを一括投入し、緊急時治療管理だけを根拠付きで判定する独立チェッカー」は確認できなかった。ただし非公開オプションの存在は否定できないため、CAREKARTE、ワイズマン、ほのぼのNEXTの導入施設へのヒアリングで最終確認する。

## 9. 実装順序

### Phase 0: 契約と反例

- `care-emergency-csv-v1` validatorと日本語テンプレートを作る。
- 正例、対象外、情報不足、4日目、月2回目、非連続、併算定、医科500点混同のgoldを作る。
- 同一エピソードの反復値矛盾、重複行、CP932、改行入りセルをparserテストへ入れる。

### Phase 1: DB/UI非依存の判定

- `packages/care-fee-core`を純関数で実装する。
- effective-datedな介護サービスコードマスタを追加する。
- CLIで1 CSV入力・1 CSV出力を完成させる。
- 同じ入力を100回実行して正規化結果と判定結果が一致することを確認する。

### Phase 2: 独立Web

- `apps/care-fee-web`の第一画面をCSV取込画面にする。
- 取込前プレビュー、エラー行、状態別一覧、患者別根拠を実装する。
- スポット判定では永続症例を作らず、結果CSVを返す。
- CSV件数と処理時間を計測し、同期・非同期の境界を実測で決める。

### Phase 3: 運用保存と監査

- 医師確認、対象外化、確定、月次一覧、監査ログを追加する。
- 西山病院の確認票相当の印刷を追加する。

### Phase 4: 連携

- Feeアプリの介護レーンから共通APIへ接続する。
- 確定カルテのoutbox/event、冪等な取込、増分検知、月次再点検、coverage reportを実装する。
- 西山病院が利用している介護記録・請求ソフトのCSVアダプターを追加する。
- 介護給付費請求データへの書戻しは、先に読取専用の比較を実装し、十分な検証後に別スコープで判断する。

## 10. 受入条件

1. 同じ正規化入力はCLI、単独Web、API、Feeアダプターで同じ判定になる。
2. 構造化CSVの判定でOpenAI呼出しが0回である。
3. 介護コード・単位が医科の候補・合計へ一切入らない。
4. 単位はサービス種別と治療日に有効なマスタから解決され、実装コードに518を固定しない。
5. 1～3日、4日目、非連続、月2回目、併算定、情報不足をgoldどおり判定する。
6. 一括処理は自動確定しない。
7. 不明と明示的否定を区別する。
8. 取込エラーは行番号と列名を返し、他の正常行の判定を妨げない。
9. 西山病院の匿名化済み正例・不算定例で、医事担当者の判断と差分を全件説明できる。
10. マスタ版、ルール版、入力ハッシュを結果CSVだけで追跡できる。
11. Fee未契約の施設はCSVだけで全機能を利用できる。
12. Fee連携時も自動確定・自動請求を行わず、月次coverage reportで未処理と失敗を検知できる。

## 11. 西山病院へ確認する事項

- 確認票を使う施設・事業所・サービス種別
- 現在の介護記録・請求システム名とバージョン
- 現システムから出力できるCSVの実物と列定義
- 緊急時治療管理の月間件数
- 算定した正例、不算定とした反例、返戻例
- 医師、看護師、医事担当者の入力・確認・確定手順
- 当月既算定、特定治療、所定疾患施設療養費を取得できるデータ源
- 患者氏名を送らず施設内患者キーだけで運用できるか

この回答を待たずPhase 0とPhase 1は開始できる。回答は西山固有CSVアダプター、印刷様式、運用権限に反映する。
