# 作業依頼: 月次明細への電子点数表背反の強制(X1〜X5) (2026-07-24, レビュー反映改訂)

発見元: standing lane STG計測 `docs/20260723-standing-monthly-e2e/20260723_205224/`
(F2として `fee-universal-accuracy-workorder-20260723.md` に一次記録)。

**改訂履歴**:
- 第1改訂: 外部レビュー6指摘(①除外マスタ取得が日付・世代・特例を無視+fail-open
  ②集計後行単位の除外は過剰除外かつCSV/UKEへ漏れる ③解決手段の未定義
  ④候補同士の高点数側採用はrule_kind意味論と衝突 ⑤週・同時スコープ判定不足
  ⑥rule_kind意味論はPython実装済み)を検証し、全件妥当として反映。
- 第2改訂(2026-07-24): 追加レビュー5指摘を検証し全件妥当として反映——
  ①完全性envelope(有効世代なしのfail-open。`claim_batch.py:2723-`の最新世代
  フォールバックを実測確認) ②解決actionのrule種別制限 ③保存先は患者×月の
  専用リソース(monthlyClaimWorkがセッション内フィールドであることを
  `fee-contracts/src/index.js:656`・`fee-workspace.js:158`で実測確認)+マスタ世代・
  ruleFingerprint・スコープキー ④出力ブロック条件の統一(全適用pairの確認必須)
  ⑤simultaneousの層間整合(セッション層が同一セッション共存だけで降格することを
  `claim_adjustments.py:235-`で実測確認)。
- 第3改訂(2026-07-24): 追加レビュー5指摘を検証し全件妥当として反映——
  ①双方向レコードのcanonical edge正規化(実測: 38,671組全てが双方向・片方向行0・
  kind組は1↔2/3↔3のみ。この不変条件からの逸脱=master_incomplete)
  ②段階リリース禁止(単一flag一括有効化 or shadow mode)
  ③3コード以上のconflict graph規約(実測: 複数相手を持つコード2,937件・最大次数615。
  複雑成分は自動適用しない+順序独立テスト)
  ④conditional_review(特例=1)とunsupported_rule_kind(未知区分)の分離
  ⑤docIdへのruleFingerprint包含(履歴保存の実現)+PUTのトランザクション化。
- 第4改訂(2026-07-24): 追加レビュー3指摘を反映——①複雑成分のaction矛盾を解消
  (UIからのedge単位解決を廃し、採否変更による2コード成分への縮退のみ)
  ②候補もcandidateOccurrences単位で背反判定(コード単位畳み込み後の判定は
  過剰suppressの原因)③解決APIの認可・監査要件(org確定・権限・CSRF・
  前後値監査ログ・409)。

## 背景(実測事実)

standing laneの受入は全合格したが、月次確定点数が反復間で揺れた:

- 反復2のみ: 喀痰吸引 140003810(48点)が在宅人工呼吸指導管理料 114005410 と同月確定
- 反復3のみ: 人工呼吸 140009310(302点)が月次候補点数に計上

`electronic_exclusions`(exclusions_month)に両ペアが2010-04-01から収載済みであり、
決定論で抑止できる。

## 既存実装の到達点(調査済み。ここを正として拡張する)

**rule_kind・特例の意味論はPythonに実装済み**
(`python/medical_fee_calculation/claim_adjustments.py` `apply_electronic_consistency`、
テスト `python/tests/test_claim_adjustments.py:41-`):

- rule_kind `'1'`=①(base)を算定し②を降格 / `'2'`=②(excluded)を算定し①を降格 /
  `'3'`=いずれか一方(**低点数側を降格**)
- 特例区分 `special_condition='1'`(条件次第で併算定可、同日・同時で9,824件)は
  **自動降格せず警告のみ**
- 降格=行削除ではなく `NEEDS_REVIEW`+`excluded_from_total`(人が採用し直せる)
- **同日・同時スコープのみ降格し、同月・同週は「履歴完全性に依存するため警告に留める」
  と意図的に判断している**(同ファイルコメント)

本チケットの本質は新規ルール実装ではなく、**「月次の最終明細集合は当該月について
完全である」という性質を使って、この既存設計を同月・同週スコープへ月次層で拡張する**こと。
意味論の重複実装をNode側でしない。

現状の穴(調査済み):

- `checks_api.py:411-` `_act_exclusion_pairs` は `effective_from/to`・`source_id`
  世代選択・`special_condition` を**無視**して全世代を返す(P0)。
- `server.js:3717-3720` は取得失敗時 `catch { return {} }` の**fail-open**(P0)。
- `packages/fee-core/src/index.js:489` は集計後の全行を `lineGroups` に入れ、
  CSV(`:898-`)・UKE(`:1124-`)は `lineGroups` を**無フィルタで出力**する。
  集計後の行に `includedInTotal=false` を付けるだけでは提出データに漏れる(P0)。
- 候補集計(`:566-596`)はconflictsを注記するが `candidateTotalPoints` へ満額計上。
- `server.js:6826` の `buildMonthlyReceiptDraft` 呼び出しはconstraints未渡し。

## 共通原則

マスタ駆動のみ・コードペアのハードコード禁止。確定済みの人の判断を機械が黙って
消さない。**意味論はPython側に一元化し、Nodeは正規化済みの解決指示を適用するだけ**。
提出(CSV/UKE)経路はfail-closed、点検注記経路は従来どおり継続優先でよい。

---

## X1. [P0] 日付有効・世代選択・特例対応の除外契約(Python側で正規化)

対象: `python/medical_fee_calculation/checks_api.py`。

1. 新関数(または `check_lookup` 拡張)`act_exclusion_rules`:
   入力 `{act_codes, claim_month または service_date}`。出力は**完全性envelope**:
   ```
   {status: "complete"              // 正常に評価した(rules 0件も合法)
          | "no_effective_generation" // 対象日に有効なマスタ世代がない
          | "master_incomplete"     // テーブル欠落・行数0等の不完全
          | "lookup_failed",        // 参照失敗
    sourceId, sourceVersion,        // 使用した世代の識別
    evaluatedFrom, evaluatedTo,     // 評価対象期間(同月なら月初〜月末)
    rules: [{scope: "same_day"|"same_month"|"same_week"|"simultaneous",
             codeA, codeB,          // canonical: codeA < codeB(下記の正規化後)
             codeAName, codeBName,
             resolution: "auto_winner"          // kind1/2の対から統合。winnerCode必須
                       | "demote_lower_points"  // kind3(双方向とも3)
                       | "conditional_review"   // special_condition='1'(条件次第で併算定可)
                       | "unsupported_rule_kind", // 未知区分(人のactionで解除不可)
             winnerCode,            // auto_winnerのみ
             specialCondition: "0"|"1",
             ruleFingerprint,       // 正規化後のcanonical edgeから生成
             effectiveFrom, effectiveTo}]}
   ```
   「ルール0件」と「評価不能」を戻り値の型で区別する。**強制経路では
   status!=="complete" を全てブロッキングエラー**にする(X5)。

   **双方向レコードの正規化(必須。対象ペア自体で発生する)**: マスタは同じ背反を
   双方向に格納する(実測: 38,671組すべてが双方向で片方向行は0。kindの組み合わせは
   `1↔2` と `3↔3` のみ)。対象ケースも
   `114005410→140003810(kind1)` と `140003810→114005410(kind2)` の2行で1つの背反。
   このまま返すと同じ背反を2ルールとして二重処理し、X3のsorted-pair docIdと
   fingerprintが衝突する。正規化規約:
   - コードを `codeA < codeB` のcanonical edgeへ統合する(1背反=1ルール)。
   - kind1/2は「最終的なwinnerコード」へ変換し、**逆方向行が同じwinnerを示すことを
     検証**する(kind1のbase = 逆方向kind2のexcluded、が一致)。kind3は双方向とも3で
     あることを検証する。
   - 実測不変条件からの逸脱の扱い(実装で精緻化):
     **逆方向行の欠落・winner矛盾(1↔1、2↔2等)は `master_incomplete`**
     (データ破損の疑い。評価全体を止める)。
     **kind組の未知組合せ(1↔3等)は当該ペアのみ `unsupported_rule_kind`**
     (1ペアの異常で全患者・全月の出力を止めるのは過剰。該当ペアは
     人のactionで解除できずfail-closedのまま)。
   - `ruleFingerprint` は正規化後のcanonical edge(scope, codeA, codeB, resolution,
     winnerCode, specialCondition, 有効期間)から生成する。
   - `effective_from <= 対象日 <= effective_to` で**日付フィルタ**する
     (対象日は同月スコープなら請求月の初日〜末日と交差判定)。
   - `source_id` は対象日を有効期間に含む世代を選択する。既存の世代選択
     (`claim_batch.py:2710-`)は**対象日以前の世代が無い場合に最新世代へ
     フォールバックする**——点検経路では従来どおりでよいが、**強制経路では
     このフォールバックを使わず `no_effective_generation` を返す**
     (古い/未来の規則で正当な明細を除外しない)。
   - `special_condition`(raw[6])を読み、`'1'` は `resolution: "conditional_review"`。
     **未知のrule_kindは `unsupported_rule_kind` として特例と区別する**(特例は
     根拠付きで両方算定の余地があるが、未知区分はシステム未対応であり
     人のactionでは解除できない)。
   - rule_kind→resolutionの対応は `claim_adjustments.py` の実装・テストと
     同一のソースから導出し(共通関数化)、**二重定義しない**。
2. 既存 `_act_exclusion_pairs`(点検注記用)は残してよいが、強制経路からは
   使用しない。docstringに用途区別を明記。
3. テスト: 期限切れ世代が返らない/複数世代から対象日世代のみ/特例=1が
   conditional_review/未知区分がunsupported_rule_kind/kind1・2・3のresolution対応が
   `test_claim_adjustments.py` と一致。
   **正規化**: 対象2ペア(114005410×140003810、114005410×140009310)がそれぞれ
   **1つのcanonical ruleだけ**を返し、winnerCode=114005410であること。
   逆方向行のwinner不一致・片方向のみの行を合成した入力→`master_incomplete`。

## X2. [P0] occurrence単位の判定と、提出集合の分離

対象: `packages/fee-core/src/index.js` `buildMonthlyReceiptDraft`。

1. **判定はlineOccurrences単位**(集計後の行単位ではない):
   - `same_month`: 月次集合内に相手コードのoccurrenceが存在すれば該当。
   - `same_day`: **同一serviceDateのoccurrenceペアのみ**該当。処置Aが7/1・7/8に
     あり7/1だけBと衝突するなら、7/1のA(またはB。resolutionに従う)だけを対象にする。
   - `same_week` / `simultaneous` はX4の規約に従う。
2. **conflict graphの構築と成分単位の解決**(ペアの逐次適用は禁止):
   マスタには複数の背反相手を持つコードが多数ある(実測: 2相手以上が2,937件、
   最大次数615)。A-B、B-Cのような構造をペア順に処理すると、処理順で結果が変わる
   (Bを先に落とした後、Bを根拠にCを落とすかが未定義)。規約:
   - 月次集合に存在するコードに限定してcanonical edgeから**連結成分**を作る
     (スコープごと。same_dayは同一日ごとの部分グラフ)。
   - **2コードだけの孤立成分**: edgeのresolutionに従い自動適用可。
   - **3コード以上・循環・winner矛盾を含む成分**: 初期実装では自動適用せず、
     成分全体を要確認とし出力をブロックする。**UIからのedge単位解決は提供しない**
     (A-BでA、B-CでBを選ぶような相互矛盾を作れてしまうため)。解決手段は
     **元セッションの明細採否変更で成分を2コード以下へ縮退させる**こと。UIは
     成分の構成コード一覧とこの導線を表示する。edge単位保存の代替案
     (componentResolution.selectedCodes+選択集合内に背反edgeがないことの
     サーバー検証)は将来拡張とし、初期実装では採らない。
   - 適用結果が**入力順・DB取得順に依存しない**ことをテストで固定する
     (配列順をシャッフルして同一結果)。
3. resolutionの適用(2コード成分、occurrence単位):
   - `auto_winner`: loser側(winnerCodeでない側)のoccurrenceをblockedへ。
   - `demote_lower_points`: 当該occurrence対の点数比較で低い側をblockedへ。
   - `conditional_review`(特例=1): 自動でblockedにせず「未解決背反」として記録(X3)。
   - `unsupported_rule_kind`: 自動でblockedにせず、**人のactionでも解除不可**。
     当該患者×月のエクスポートはシステム対応(マスタ更新/実装追加)まで不可。
4. **集合の分離**: blockedにしたoccurrenceを除いて再集計し、
   - `lines` / `lineGroups` / `totalPoints` = **提出可能なoccurrenceのみ**から生成
   - `blockedLines` = UI・監査用の別配列(コード・名称・対象日・相手コード・
     resolution・理由文を保持。人の承認履歴は消さない)
   - CSV(`:898-`)・UKE(`:1124-`)は従来どおり `lineGroups` を出力するだけで
     劣後コードが**構造的に含まれない**ようにする。
5. 確認事項: blocked 1件ごとに
   「{名称}({対象日})は同一{月|日|週}の{相手名}と併算定できません(電子点数表背反)」。
6. **出力ブロックの統一規約**(初版の矛盾を解消):
   - kind1/2/3 は自動resolutionを**初期値として適用**する(blockedLines・totalPoints
     はプレビュー時点で決定論的に組まれる)。
   - ただし**CSV/UKEエクスポートは、その月に適用された全pairが解決済み
     (X3のaction保存済み。自動適用の確認=acknowledge_autoを含む)になるまでブロック**する。
     自動除外された明細が人の目を通らずに提出されることはない、が原則
     (candidateOnlyと同じ思想)。
   - `conditional_review`(特例=1)は初期値なし=必ず選択が要る。
   - 複雑成分はaction対象外(採否変更による縮退まで出力ブロック。X2-2)。
   - `unsupported_rule_kind` は選択でも解除できない(システム対応まで出力不可)。
   - テストは「自動適用の正しさ(プレビュー)」と「未確認pairの出力ブロック」を
     別ケースに分ける。

## X3. [P1] 月次背反の解決の保存(患者×月の専用リソース)

「どちらを請求するか」の人の判断に保存先とAPIを与える。

1. **保存先は専用リソース**: `monthlyClaimWork` は各fee session内のフィールドであり
   (`packages/fee-contracts/src/index.js:656-`、UIもセッション単位PATCH
   `apps/fee-web/components/fee-workspace.js:158-`)、患者×月の判断の置き場に
   ならない(代表セッション方式は競合しやすいため不採用)。新collection
   `fee_monthly_exclusion_resolutions`:
   ```
   docId = sha256(orgId, patientId, claimMonth, pairKey, scopeKey, ruleFingerprint)
   {orgId, patientId, claimMonth,
    pairKey,          // canonical pair(codeA < codeB) + scope
    scopeKey,         // same_month: claimMonth / same_day: 対象日 / same_week: 週キー(日曜起算)
    ruleFingerprint,  // X1のcanonical edgeから。docIdに含める(下記)
    sourceId, sourceVersion,
    action,           // 下記enum
    basisNote,        // allow_both_with_basis は必須
    resolvedByMemberId, resolvedAt, revokedAt?}
   ```
   **ruleFingerprintをdocIdに含める**: 含めないとマスタ改定後の保存が旧レコードを
   上書きし「supersededとして残す」が実現できない。fingerprint込みdocIdにより
   改定ごとに別docになり履歴が自然に保存される。「現在有効な解決」は
   **現行ルールのfingerprintと一致するdoc**のみ(それ以外は履歴として読み取り専用)。
   マスタ改定→fingerprint変化→有効な解決なし=未解決へ自動的に戻る。
   登録/取消のPUTは**Firestoreトランザクション**(または updatedAt 前提条件の
   楽観ロック)で行い、同時操作で判断が黙って上書きされないようにする。
2. **actionはrule種別ごとに許可を制限**する(マスタ上許されない選択を作らせない):
   | resolution | 許可されるaction |
   | --- | --- |
   | auto_winner (kind1/2統合) | `acknowledge_auto` / `reject_both` |
   | demote_lower_points (kind3) | `choose_a` / `choose_b` / `reject_both` |
   | conditional_review (特例=1) | `choose_a` / `choose_b` / `allow_both_with_basis`(根拠必須) / `reject_both` |
   | unsupported_rule_kind (未知区分) | **なし**(人のactionで解除不可。システム対応まで当該月のエクスポート不可) |
   **上表は2コード孤立成分のedgeにのみ適用する**。3コード以上の複雑成分(X2-2)は
   X3のactionでは解決できない(edge単位の判断は相互矛盾しうる)——元セッションの
   明細採否変更で2コード成分へ縮退させるのが唯一の解決手段であり、複雑成分内の
   edgeへのaction登録はvalidationで拒否する。auto_winnerでマスタ指定と逆側を
   採りたい場合も同様に元セッションの採否変更で構図自体を変える(導線をUIに明示)。
   validationで許可外actionを拒否する。
3. API: 患者×月の解決一覧GET+登録/取消PUT(冪等)。fee-webの月次画面に
   「背反の確認」操作(actionボタン+根拠入力)を出す。
   **認可・監査(このAPIはCSV/UKEの内容を変えるため必須)**:
   - `orgId` はリクエストボディから受け取らず**認証セッションから確定**する
     (既存のrequireProductContext規約)。
   - 対象の患者・請求月・pairが同一組織に属することをサーバー側で検証する。
   - 実行権限は月次請求を確認できるロールに限定する(既存の月次確認系と同じ権限)。
   - PUT/取消は既存の `requireMutationCsrf` を通す。
   - 監査ログ(`createAuditEvent`)に**変更前後のaction**・pairKey・fingerprint・
     操作者を記録する(本文・患者氏名は含めない)。
   - 同時更新の競合(トランザクション前提条件の不成立)は **409 Conflict** を返す。
   - テスト: 他組織の患者×月への操作拒否/権限不足の拒否/CSRF欠落の拒否/
     競合時409/監査イベントの記録。
4. 適用順: 保存済みactionは自動resolutionの**表示初期値を上書き**するが、
   許可制限(上記表)の範囲内でのみ有効。X2-5のとおり、全適用pairのaction保存が
   エクスポートの前提。

## X4. [P1] スコープ判定の規約

1. `same_week`: serviceDatesの単純重なりでは同一週の別日を検出できない。
   **日曜起算の暦週**(H1頻度制限で確定済みの週境界規約。
   `python/medical_fee_calculation/electronic_rules.py` の docstring 出典)へ
   変換して同週判定する。週境界規約はPython側の既存関数を共通利用し重複実装しない。
2. `simultaneous` の層間整合(初版の不整合を解消):
   - **月次層はsimultaneousを評価対象外**とする。別セッション(別受診)間の「同時」は
     定義上成立せず、同一セッション内はセッション層が既に扱っているため、
     月次層で再評価する余地がない。この根拠をコードコメントに残す。
   - セッション層は現在「同一セッション内に両コードが共存するだけで降格」する
     (`claim_adjustments.py:235-`、共存=同時のプロキシ)。このプロキシの妥当性を
     **支払基金の電子点数表仕様(背反「同時」の定義)で一次資料確認**し、
     出典コメントを追加する。仕様上「同一受診内共存≠同時」であれば
     警告のみへ緩める。確認までは既存挙動を維持してよい
     (降格はNEEDS_REVIEW+excluded_from_totalであり、黙って消えるわけではない)。
3. セッション計算層の同日降格は現状維持。同月・同週を警告に留める既存判断も
   **セッション層では維持**する(セッション時点の履歴は不完全になりうる)。
   同月・同週の強制は月次層(X2)だけが行う——月次最終集合は当該月について
   完全だから、という根拠をコードコメントに残す。

## X5. [P1] 取得のfail-closed化と呼び出し経路の統一

1. `monthlyCandidateConstraints`(`services/fee-api/src/server.js:3688-`)を
   X1の新契約に切り替え、**用途で失敗時挙動を分ける**:
   - 点検注記・候補注記用途: 従来どおり失敗時は注記なしで継続(点検は補助情報)。
   - **提出経路(CSV/UKE生成・月次確定)**: 取得失敗は例外にし、出力を止める
     (`catch { return {} }` のfail-openを強制経路に使わない)。
2. `server.js:6826` の `buildMonthlyReceiptDraft` 呼び出しにもconstraintsを渡し、
   「constraints無しで月次を組む経路」を無くす(builder側で引数を必須化するか、
   欠落時はblocked判定不能として提出経路をエラーにする)。

## 候補行の扱い(X2に統合、初版X3の修正)

- **候補もoccurrence単位で判定する**: 現行の候補集計はコード単位へ先に畳む
  (`packages/fee-core/src/index.js:503-` occurrenceCount+serviceDates)ため、
  そのまま背反判定するとコード全体を0点にしてしまう。確定明細と同様に
  `candidateOccurrences` を構築してから背反判定し、その後に再集計する。
  例: 候補Aが7/1・7/8、確定Bが7/1のみ(同日背反)→ **7/1の候補occurrenceだけ**
  suppressedになり、7/8の候補は残る(反例テスト必須)。
- 確定occurrenceと背反する候補occurrence: `candidateTotalPoints` に計上しない
  (0点+suppressedByExclusion+理由注記)。
- **候補同士の背反**: 初版の「高点数側を計上」は誤り(rule_kindの優先方向と衝突)。
  X1のresolutionに従う——`auto_winner` はwinner側のみ計上、
  `demote_lower_points` のみ点数比較、`conditional_review`/`unsupported_rule_kind` は
  **どちらも計上せず**両候補に要確認注記。

## テスト

- X1: 日付フィルタ・世代選択・特例=1・kind1/2/3対応(`test_claim_adjustments.py` と
  同一の意味論であることをクロス検証するテストを含む)。
  envelope: 有効世代なし→`no_effective_generation`(最新世代フォールバックしない)、
  ルール0件→`complete`+空rules(両者が区別される)、参照失敗→`lookup_failed`。
- X3: 許可外action(auto_winnerでchoose_a等、unsupported_rule_kindへの全action)が
  validationで拒否される。
  ruleFingerprint不一致(マスタ改定)→旧解決が再利用されず未解決へ戻る。
  allow_both_with_basisは根拠noteなしで拒否。
- 出力ブロック: 自動適用のみ(未acknowledge)→エクスポート不可/全pair解決済み→可。
- X2: 7/1・7/8にAがあり7/1のみBと同日背反→7/1側occurrenceのみblocked、
  7/8は残る(過剰除外の反例テスト)。same_monthは1件でも該当。
  blockedLinesとlines/lineGroupsの分離。**CSV・UKE出力に劣後コードが含まれない**。
  未解決背反あり→エクスポートがエラー。
- X3: 解決保存→自動resolutionより優先/解決取消→未解決に戻り出力ブロック。
- X2グラフ: 3コード成分(A-B, B-C)→自動適用されず成分全体が要確認、
  edgeへのaction登録が拒否され、片方のセッション採否変更で2コード成分に
  縮退すると解決可能になる。
  入力配列・取得順をシャッフルしても結果同一(順序独立)。
- 候補occurrence: 候補Aが7/1・7/8、確定Bが7/1のみ→7/1の候補のみsuppressed、
  7/8の候補は残る(コード単位で全滅しない)。
  unsupported_rule_kindを含む月→人のactionなしではエクスポート不可のまま。
- X4: 同一週別日(日曜起算)の検出/simultaneousは月次層で評価されない。
- X5: 提出経路でcheckLookup失敗→エラー(fail-closed)、点検経路→継続。
- **回帰=standing fixture再走**: `data/tests/fee-standing-monthly-e2e/1002` を
  同一コマンドで再走し、月次確定点数3,502点の3反復完全一致
  (喀痰吸引はblockedLinesに現れ、CSV/UKEに出ない)、候補点数の3反復一致
  (人工呼吸302点が非計上)。
- gold 2系統+反例コーパス: 既存の「同日複数処置の確認」警告
  (`server.js:8619-8621`、別部位根拠がありうる同日系)の挙動が変わらないこと。
  特例=1ペアが自動blockedされないこと。

## 受入基準

1. standing fixture再走で確定点数・候補点数が3反復完全一致。
2. 背反による除外はblockedLines+確認事項として全件可視(黙って消えた行ゼロ)。
3. CSV/UKEに劣後コードが構造的に含まれない。未解決背反があれば出力がブロックされる。
4. 提出経路はfail-closed(参照失敗だけでなく**有効世代なし・マスタ不完全でも**
   背反明細が出力されない=エクスポートが止まる)。
5. gold 2系統 green。

## 実施順

X1(Python契約) → X2(occurrence判定+集合分離+候補統合) → X4(スコープ規約、X2と同PR可) →
X3(解決の保存とUI/API) → X5(fail-closed+経路統一) → fixture再走で受入。

**段階リリースの規約(第3改訂で変更)**: X3以前にX2の自動除外だけを有効化しない
——人が確認していない明細がlineGroupsから消えたままCSV/UKEを出力できてしまい、
X2-6の原則(全pair確認まで出力を止める)と矛盾するため。展開は次のどちらかのみ:

1. **X1〜X5を単一のfeature flag(`FEE_MONTHLY_EXCLUSION_ENFORCEMENT`、既定off)で
   一括有効化**する(推奨。STGで先に有効化して計測)。
2. flag offの間は **shadow mode**: `blockedLinesPreview` とmetrics
   (発火ペア・成分サイズ・resolution分布)だけを生成し、
   `lines` / `totalPoints` / `lineGroups` / エクスポートは一切変更しない。
   STGでshadow計測→有効化、の順に使う。
