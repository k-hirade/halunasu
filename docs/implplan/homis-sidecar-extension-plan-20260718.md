# HOMISサイドカー拡張(算定オーバーレイ)の意図と実装計画 (2026-07-18)

状態: Chrome拡張PoCは実装・動作検証後に**リポジトリから撤去済み**(削除コミット `4d669a9`)。
本書の安全境界に沿うサーバ側基盤は、feature flag既定OFFの状態で実装済み(§8)。
ただし、実HOMISの不変ID・セレクタ契約、別リポジトリの拡張、fee-webの採用UI、
顧客契約・院内承認は未完了であり、現時点で本番利用可能という意味ではない。
PoCコードのうち5ファイル(bridge.mjs / content.js / manifest.json / sidepanel.html / sw.js)は
コミット `0acbf03` から `git checkout 0acbf03 -- poc/homis-sidecar` で復元できる。
`extension/sidepanel.js` はコミットに含まれず、本書 §5.4 に全文を残す。
`README.md` はコミット・本書のどちらにも残っておらず**完全復元は不可**(内容は本書 §2〜§5 で代替)。

## 1. 意図(何を解決したいか)

顧客はHOMIS(在宅医療支援システム。実体はブラウザで使うWebアプリ)でカルテを書いている。
halunasuの算定を使うために別アプリへ切り替え・転記させるのは導入障壁が高い。
**HOMISの画面をそのままに、その場で算定結果・確認候補を出す**ことで、
「カルテを書く→その場で算定が見える」体験を作るのが目的。

HOMIS側の改修は期待できないため、顧客の端末側(ブラウザ)に入れる
**サイドカー方式(Chrome拡張)**を第一候補とする。判断材料として、
手元の疑似HOMIS(mock_homis / bomis)で全経路を実証済み。

## 2. 全体構成(PoCで実証した形)

```
mock_homis (localhost:8899)            ← 顧客環境では https の実HOMIS
   │  DOM読み取りのみ(通信・保存はしない)
Chrome拡張 (Manifest V3)
   ├ content script: カルテ抽出
   └ Side Panel: 表示UI・算定実行ボタン
   │  fetch (PoCはローカル、本番はhalunasu API)
bridge.mjs (127.0.0.1:8901)            ← 本番では fee-api(Cloud Run) が直接受ける
   └ handleFeeApiRequest(実fee-api処理) + インメモリstore + 実Python算定エンジン + ローカル完全マスタ
```

設計原則:

- **読み取り一方向**。HOMISへの書き戻し(自動入力)はしない(RPA的操作は脆弱・高リスク)。
- content script は抽出のみ。外部通信は拡張のパネル側からのみ、宛先はhost_permissionsで固定。
- 実名を送らない(患者表示名は「HOMIS患者 <外部ID>」。fee-api既存の実名非送信方針と同じ)。
- 算定ロジックの二重実装をしない(拡張は表示だけ。算定は既存fee-apiをそのまま呼ぶ)。

## 3. PoCで実証できたこと(2026-07-18検証済み)

**実証できたのは「画面抽出 → Fee API → 結果表示」の技術接続まで**である。算定精度の実証ではない。

| 項目 | 結果 |
| --- | --- |
| bomis患者詳細からの抽出 | 患者ID(URL)・診療日(日付ラベル+カレンダー年)・受付時刻(HH:MM)・SOAP本文を取得 |
| Fee API接続 | 実算定エンジン+実マスタで完走。「在宅酸素療法」曖昧候補(114003710/114004110)等、辞書レーンが実マスタで機能 |
| 抽出モード | OPENAI_API_KEY無し=ルール抽出で完走。有りならv14 LLM抽出に自動切替 |
| 受診歴 | 同一患者の連続算定で履歴が積まれ初診/再診判定が働く(インメモリ) |

**注意(循環の明示)**: PoCで表示された「訪問診療料890点確定」は、PoC側で
①受診区分を `home_visit` に固定し、②施設恒常ルール(114001110自動確定)をシードした
**自己成就の結果**であり、「HOMISの画面から訪問診療を正しく判定できた」ことを意味しない。
受診区分の判定(訪問/往診/外来/オンライン等)は未実装・未実証である(§6.3-1)。

## 4. セレクタ契約(bomis) — 抽出仕様

HOMISのDOM変更で壊れる部分をここに集約する。実HOMIS対応時はこの表だけ差し替える。

| 項目 | セレクタ/規約 |
| --- | --- |
| 患者ID | URLクエリ `patient_id` |
| 表示中カルテ | `#pdetail_karte` |
| カルテID | `.karte-meta .kv` の「カルテID：<数字>」(患者ID+MMDD)。**年欠落・同日複数で一意でないため冪等キーには使えない(G-4)。表示・参照用のみ** |
| 診療日ラベル | `.note-soap .karte-date`(例「1/25(土)　10:30～」) → M/D と HH:MM |
| 年 | カレンダー見出し `.cal-title`(例「2025年1月」) |
| SOAP本文 | `#pdetail_karte .note-soap p`(karte-dateクラスを除く)を改行連結 |
| 診療日決定 | 年(cal-title)+M/D(日付ラベル)。年が取れない場合は算定ボタンを無効化 |

## 5. 実装仕様(復元・再実装用)

### 5.1 拡張 manifest(MV3)の要点

- `permissions: ["sidePanel", "tabs"]`
- `host_permissions`: `http://localhost:8899/*`, `http://127.0.0.1:8899/*`, `http://127.0.0.1:8901/*` のみ
- content script は `http://*/homic/*` 相当のmock URLに限定、`run_at: document_idle`
- `sw.js` は `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` のみ

### 5.2 content script

- `chrome.runtime.onMessage` で `{type:"halunasu:extract"}` を受けたときだけ §4 の契約で抽出し
  `{ok, externalPatientId, karteId, serviceDate, receptionTime, clinicalText, extractedAt}`
  を返す。失敗時は `{ok:false, error}`。
  ※ PoC版は `sourceUrl` も含めていたが、本番契約からは削除する(G-3: 送信もログ保存もしない)。

### 5.3 ブリッジ(PoC限定。本番はfee-api直)

- 127.0.0.1:8901 バインド。`GET /poc/healthz` と `POST /poc/calculate` のみ。
- 起動時シード(fee-apiテストハーネスと同方式):
  `MemoryPlatformStore` + `createOrganization/createMember/createFacility/createDepartment/upsertProductEntitlement(fee)`、
  `MemoryFeeStore`、`PythonFeeCalculator({masterDbPath, workerMode:false})`。
  認証は `createSignedSession`(MFA未登録なら `beginMfaEnrollment`→`completeMfaEnrollment`)で
  Cookie+CSRFヘッダを内部生成し `handleFeeApiRequest` に渡す。
  ※ 2026-07-18のMFA強制化(コミット0acbf03)後の復元では、この署名パラメータが
  現行の `createSignedSession` 要件と合っているか最初に確認すること。
- 施設恒常算定ルールを初回算定時にPATCH(`/v1/fee/settings/{facilityId}`)でシード:
  `home_visit_fee`(114001110, action=confirm, settings=["home_visit"])。
- `/poc/calculate` フロー: 外部患者ID→(初回のみ)`POST /v1/fee/patients`(表示名「HOMIS患者 <ID>」)
  → `POST /v1/fee/sessions`(serviceDate/receptionTime/setting/clinicalText)
  → `POST /calculate` → lineItems/candidateProposals/warningsを要約して返す。
- **PoC日付移送**: mockのカルテ日付(2025年)はマスタ適用期間(2026-06〜)前で0点になるため、
  serviceDate < 2026-06-01 のとき 2026-06-同日(28日クランプ)へ移送し、
  応答 `dateShift {from,to}` と警告に明示。`HOMIS_POC_DATE_SHIFT=0` で無効化。
  実環境では行わない。

### 5.4 sidepanel.js(コミット漏れ分の全文)

```js
const BRIDGE = "http://127.0.0.1:8901";
let extracted = null;

const $ = (id) => document.getElementById(id);
const setStatus = (text, isError = false) => {
  $("status").textContent = text;
  $("status").className = isError ? "err" : "muted";
};

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

$("btn-extract").addEventListener("click", async () => {
  setStatus("読み取り中…");
  $("result-area").hidden = true;
  try {
    const tabId = await activeTabId();
    const response = await chrome.tabs.sendMessage(tabId, { type: "halunasu:extract" });
    if (!response?.ok) {
      throw new Error(response?.error || "抽出に失敗しました。bomisの患者詳細(カルテ)画面で実行してください。");
    }
    extracted = response;
    $("meta").innerHTML = [
      `患者ID(外部): <b>${response.externalPatientId}</b>`,
      `診療日: <b>${response.serviceDate || "不明"}</b>`,
      response.receptionTime ? `受付時刻: <b>${response.receptionTime}</b>` : "",
      `カルテID: ${response.karteId || "-"}`
    ].filter(Boolean).join("<br>");
    $("soap").textContent = response.clinicalText;
    $("extract-area").hidden = false;
    $("btn-calc").disabled = !response.serviceDate;
    setStatus(response.serviceDate
      ? "読み取り完了。内容を確認して「算定する」を押してください。"
      : "診療日を特定できませんでした。カレンダー表示月とカルテを一致させてください。", !response.serviceDate);
  } catch (error) {
    setStatus(String(error?.message || error), true);
  }
});

$("btn-calc").addEventListener("click", async () => {
  if (!extracted) return;
  setStatus("算定中…（初回はエンジン起動で数十秒かかることがあります）");
  $("btn-calc").disabled = true;
  try {
    const response = await fetch(`${BRIDGE}/poc/calculate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalPatientId: extracted.externalPatientId,
        serviceDate: extracted.serviceDate,
        receptionTime: extracted.receptionTime || undefined,
        setting: "home_visit",
        clinicalText: extracted.clinicalText
      })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error ? `${body.error}` : `bridge error ${response.status}`);
    }
    renderResult(body);
    setStatus("算定完了");
  } catch (error) {
    setStatus(`算定失敗: ${String(error?.message || error)}。ブリッジ(node poc/homis-sidecar/bridge.mjs)は起動していますか？`, true);
  } finally {
    $("btn-calc").disabled = false;
  }
});

function renderResult(result) {
  $("total").textContent = `${result.totalPoints.toLocaleString()} 点`;
  $("result-meta").textContent =
    `抽出: ${result.extractionSource || "-"} / ${result.promptVersion || ""} / セッション: ${result.feeSessionId || "-"}`;
  $("lines").innerHTML = (result.lines || []).map((line) => `
    <tr class="${line.excludedFromTotal ? "excluded" : ""}">
      <td>${line.code}</td><td>${escapeHtml(line.name)}${line.excludedFromTotal ? "（合計除外）" : ""}</td>
      <td class="num">${line.points}×${line.quantity}</td><td class="num">${line.totalPoints}</td>
    </tr>`).join("") || "<tr><td>明細なし</td></tr>";
  $("proposals").innerHTML = (result.candidateProposals || []).map((p) => `
    <div class="cand"><b>${escapeHtml(p.title)} ${p.potentialPoints ? `(${p.potentialPoints}点)` : "(点数は区分確定後)"}</b>
    ${p.code ? `コード: ${p.code}` : p.codeCandidates.length ? `候補コード: ${p.codeCandidates.join(" / ")}` : ""}
    <div class="muted">${escapeHtml(p.reason)}</div></div>`).join("") || "<div class='muted'>候補なし</div>";
  $("warnings").innerHTML = (result.warnings || []).map((w) => `<div class="warn">・${escapeHtml(w)}</div>`).join("")
    || "<div class='muted'>なし</div>";
  $("result-area").hidden = false;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}
```

## 6. 本番化の条件(顧客確認3点+設計課題)

本番利用可否を決めるのは顧客環境。以下の回答が揃うまで本番環境では有効化しない。

1. **ブラウザ種別と端末管理**: HOMISをChrome/Edgeで開いているか(専用アプリ・WebViewなら拡張不可)。
   拡張の追加が組織ポリシーで許可されるか。端末管理者は誰か。
2. **ネットワーク**: 端末からインターネット(halunasu API)へHTTPSで出られるか。
   閉域網(IP-VPN)なら閉域接続構成が必要になり工数が大きく変わる。
3. **HOMISベンダー規約**: 画面情報の外部ツール利用・アドオンの制限条項、公式連携手段の有無。
4. **カルテの不変ID**: カルテ1件を一意に特定するID(レコードID・作成日時等)が画面またはURLに
   存在するか(G-4の冪等キーの前提。bomisのカルテID=患者+MMDDは年欠落・同日複数で不十分)。

### 6.1 既存プロダクトからの分離方針(本番設計の原則)

サイドカーは**既存feeプロダクトと切り離した別プロダクト**として作る。PoCで意図的に密結合
(fee-api内部モジュールの直import)にした部分は、本番では次の3層で分離する。

1. **リポジトリ分離**: 拡張は別リポジトリ(例 `halunasu-homis-sidecar`)に置き、
   halunasuリポジトリには一切コードを足さない。共有するのは「APIの契約」だけ。
   E2E回帰にはmock_homisを使う(こちらも既にhalunasu外)。
2. **API契約の分離**: 拡張は fee-web が使う内部向けエンドポイント群を**呼ばない**。
   代わりに専用の統合API(最小契約・独立バージョニング)を1本だけ切る:
   `POST /v1/integrations/sidecar/calculate`
   (入力: 外部患者ID・診療日・受付時刻・区分・カルテ本文 / 出力: 明細・候補・警告の要約。
   PoCブリッジの `/poc/calculate` とほぼ同形)。
   これにより fee-api 内部の契約変更(セッション/候補の形の進化)が拡張を壊さない。
   後方互換はこの1エンドポイントだけ守ればよい。
   - 第1段: fee-api 内の独立ルート名前空間として実装(デプロイは同居、契約は分離)。
   - 第2段(単独プロダクト化する場合): 名前空間ごと薄いゲートウェイサービスへ切り出す。
     契約を先に分離しておけば、この移行で拡張側の変更はゼロ。
3. **契約・課金・権限の分離**: エンタイトルメントを別プロダクトID(例 `homis_sidecar`)にし、
   feeの契約と独立に付与・停止できるようにする。拡張の認証はこのプロダクトIDに
   スコープした短寿命トークン(既存ログイン+MFAで発行)。feeの管理画面権限は不要にする。

### 6.1.1 命名の決定(2026-07-18確定): エンドポイントは顧客非依存、顧客はテナントで表現する

「yamamoto」等の顧客名をAPIパスに入れる案を検討し、**採用しない**と決定した。

```
POST /v1/integrations/sidecar/calculate      ← パスは顧客非依存(確定)
  認証トークン   → organizationCode: yamamoto系テナント(組織スコープ)
  リクエスト     → sourceSystem: "homis"     (接続元システム)
```

理由:

1. APIパスは拡張として顧客端末に配布されるため、改名=破壊的変更+全端末更新。2施設目が
   来た時点で顧客名パスは破綻し、顧客数だけエンドポイントが増殖する。
2. この機能は「HOMISサイドカー」という汎用能力であり、顧客と接続元は冪等キー
   (`orgId + facilityId + sourceSystem + externalPatientId + 不変レコードID`、G-4参照)が
   既にデータとして表現している。パスに入れると二重表現になる。
3. APIパスは通信ログ・障害調査・外部レビューに露出する場所であり、顧客実名を焼き込まない。
4. リポジトリの既存慣例(yamamoto/nishiyamaは組織コードとサンプル設定にのみ現れ、
   APIルートには現れない)と一致させる。

顧客名「yamamoto」を使う場所(こちらが正):

| 場所 | 例 |
| --- | --- |
| テナント(組織コード) | `yamamoto-demo-stg`(既存)。本番は `yamamoto-<正式名>` |
| エンタイトルメント付与 | `homis_sidecar` プロダクトを山本組織にだけ有効化 |
| 施設設定・シード | `samples/yamamoto-*/fee-settings.json`(既存踏襲) |
| 拡張の配布チャネル | 山本病院の端末への強制インストールポリシー |
| セレクタ契約の変種 | 実HOMISのDOM契約を `homis-yamamoto-v1` としてバージョン管理(施設カスタム対応) |

これにより監査ログには組織スコープ経由で「yamamoto組織の誰が・どの患者を・いつ算定したか」が
残り、山本先生向けであることはシステム上明確なまま、APIは次の施設へそのまま使える。

### 6.2 その他の本番設計項目

- 配布は Chrome Web Store 限定公開 or 企業ポリシー強制インストール(野良配布しない)。
  拡張のリリースサイクルはfee-apiのデプロイと独立(6.1の契約分離が前提)。
- 監査(誰が・どの患者を・いつ算定)はサーバ側の既存監査基盤に記録。
- セレクタ契約を実HOMISで再作成し、mock_homisをE2E回帰ハーネスとして維持する。
- 日付移送は削除。

### 6.3 本番化ゲート(外部レビュー2026-07-18反映。全て解消するまで本番環境で有効化しない)

**G-1. 受診区分判定の設計(890点循環の解消)**
- 区分(訪問診療/往診/外来/電話・オンライン)をDOMの手掛かりから判定する契約を実HOMISで設計する。
- DOMから確定できない場合は**ユーザー選択を必須**にし、不明のまま算定確定しない(要確認扱い)。
- 施設恒常ルールだけを根拠に訪問診療料を確定に入れない(ルールは「区分が確定した受診」への
  適用に限定)。fee側のH3(encounterDetails)と同じ軸を使う。

**G-2. 拡張専用認証の設計(現行APIに存在しない。新規設計が必要)**
- PKCE相当のブラウザ外部認証フロー+算定スコープ限定の短寿命トークン。
- chrome.storage.local に長期トークンを保存しない。端末・拡張ID単位の失効。
- 専用BFF(§6.1の統合API)以外を呼べないトークンスコープ。
- `APP_FIELD_ENCRYPTION_KEY`: 機構はコード・デプロイ配線に存在するが、デプロイスクリプトは
  **GCPにsecretが無ければ黙って外す**構成(`p10_…_low_cost.sh:99`の`secret_exists`ガード)で、
  人手確認に依存すると再発する(静かな縮退クラス)。
  → **Sidecar有効環境では機械的に失敗させる**(2026-07-18レビュー反映):
  ①デプロイスクリプトは、Sidecar対象サービスで secret 不在なら `secret_exists` で黙って
  スキップせず**エラー終了**する。②サービス起動時にも `assertRequiredSecret` で検証し、
  鍵なしでは起動しない(charting-gateway `server.js:233` の既存前例を踏襲)。
  人手の `gcloud secrets` 確認は初回セットアップ手順であって、ゲートはコードに置く。

**G-3. 情報保護のリリースゲート化(「実名を送らない」は匿名化ではない)**
- SOAP本文+外部患者ID+診療日の組は診療情報・個人情報として扱う。
- リリース条件: 病院との外部送信契約・院内承認 / 保存期間・削除・ログマスキング /
  送信項目の最小化 / 組織・施設単位のアクセス制御 / **sourceUrlは送信もログ保存もしない**
  (抽出契約から削除する) / 3省2ガイドライン対応チェックリストを文書でなく
  リリースゲート(全項目クリアの確認記録)にする。

**G-4. 冪等化(重複作成・患者取り違え対策)**
- 統合APIの一意キー: `orgId + facilityId + sourceSystem + externalPatientId + <不変レコードID>`。
- **karteId(患者ID+MMDD)は一意キーに使えない**(2026-07-18レビュー反映):
  同一患者・同日の複数診療記録(定期訪問+臨時往診等)が衝突するうえ、**年を含まない**ため
  2025-01-25と2026-01-25も同一IDになる。別カルテを「既存カルテの改訂」と誤認して
  上書きする経路になる。
- 実HOMISのセレクタ契約作成時に**不変な診療記録ID**(レコード固有のID・作成タイムスタンプ等)を
  特定することを契約の必須項目にする。顧客確認(§6冒頭)にも
  「カルテ1件を一意に特定するIDが画面またはURLに存在するか」を追加する。
- **不変IDが取得できない場合は曖昧なまま保存せず、抽出を停止してエラー表示する**
  (「このカルテを一意に特定できないため算定できません」)。推測で埋めない。
- カルテ本文ハッシュをリビジョンとして保存し、同一カルテ(同一不変ID)の再実行は
  **新規作成ではなく下書きの再計算**にする(PoCのクリックごと作成をそのまま本番化しない)。

**G-5. 抽出の原子性(患者取り違えの第2経路対策)**
- 患者IDはURL・本文はDOMと別ソースから取るため、患者切替・カルテ切替・DOM更新の最中に
  「患者AのID+患者Bの本文」を作る競合がある。
- content script は抽出の**前後で** URL・患者ID・カルテIDを再取得して一致を検証し、
  不一致なら結果を破棄して再試行を促す。DOM変更(MutationObserver)を検知した抽出も破棄する。
- サイドパネルは算定実行時にプレビュー表示中の患者ID・不変IDとpayloadの一致を再検証してから
  送信する(表示と送信内容の乖離を防ぐ)。

### 6.4 パイロット前に必要(P1)

- **抽出範囲**: 現状はSOAPのみ。病名(patient_problemタブ)・処方(shohou-table)・検査・処置・
  患者属性(基本情報タブ)の抽出を追加するまでは「カルテからの限定的候補提示」であり完全算定ではない。
  この位置づけをUI文言にも明示する。
- **抽出バリデーション**: DOMバージョン・必須要素・抽出件数を検証し、欠落時は算定を**停止**する
  (部分本文のまま算定が走ることを防ぐ)。セレクタ契約に「必須要素と最低件数」を含める。
- **XSS修正**: §5.4のコードは `#meta` への `innerHTML` 挿入で患者ID・カルテIDを未エスケープの
  まま使っている(既知の欠陥)。再実装時は `escapeHtml` を全挿入値に適用するか `textContent` を使う。
- **ブリッジを復元する場合の条件**: 現PoCブリッジは任意Originを反射し認証なし。復元時は
  拡張ID限定のOrigin検証・ワンタイムトークン・リクエストサイズ上限を付ける。
- **表示ポリシー**: 拡張経由の結果はすべて「算定案・要確認」として表示・保存し、
  「確定」の語を使わない。月次確定への自動反映はせず、確認・確定は fee-web 側で行う。

## 6.5 既存アプリへの影響評価(壊しうる箇所と対策)

拡張・統合APIの追加は「新しい名前空間の追加」なのでルート追加自体は低リスクだが、
**同じ組織データ・同じランタイム・同じ認証基盤を共有する**ため、以下4点は設計で
明示的に守らないと既存のfeeアプリを壊す。

1. **既存算定データへの混入(最重要・2026-07-18レビューで対策を改訂)**:
   当初案の `monthlyClaimWork.status="excluded"` は**月次レセプト案の生成しか除外しない**。
   月次サマリ(server.js `buildMonthlyClaimSummary` は月内全セッションを無条件に集計)と
   患者履歴(firestore-store `listPriorSessionsForPatient` にexcludedフィルタなし)には
   そのまま混ざり、試行セッションが点数集計・初診/再診判定・同月履歴を汚す。
   → **確定対策: Sidecarの算定は既存の feeSessions に書かず、専用コレクション
   (例 `sidecarCalculationDrafts`)に下書きとして保存する**。月次・履歴・一括候補化は
   feeSessions しか読まないため、構造的に混入しない。fee-web側で人が下書きを採用した
   ときに、患者照合(外部ID→既存患者との突合確認)を経て通常セッションとしてコピー生成する。
   excluded は「採用後に月次から外したい」場合の既存機能としてのみ使う。
2. **reviewDecisionsリセットとの競合**: 下書きコレクション方式(上記1)により、拡張の再実行は
   通常セッションに一切触れないため、この競合は構造的に消える。採用後の再計算・確認は
   fee-web の既存フロー(再計算リセット告知あり)に一本化し、統合APIから採用済みセッションを
   更新する経路は作らない。
3. **認証基盤の変更リスク**: 拡張専用トークン(G-2)はプラットフォーム認証への追加になる。
   直近でMFA強制化(0acbf03)が入ったばかりの共有コンポーネントであり、既存ログインフローの
   回帰が最も高くつく。
   → 対策: 既存セッション発行経路には手を入れず、**追加のトークン種別として実装**する。
   スコープ強制(統合API以外は403)を「実装の注意」ではなくテストで固定する。
4. **ランタイム同居の負荷干渉**: 第1段はfee-apiと同一Cloud Runのため、拡張からの算定
   (LLM抽出~10秒)がfee-web利用者のレイテンシ・メモリ(4Gi、マスタ展開1.7GB)と競合する。
   → 対策: 組織・トークン単位のレート制限を統合APIに最初から付ける。負荷が見えたら
   §6.1第2段(ゲートウェイ切り出し)へ移行する判断材料としてstageメトリクスを流用する。

## 6.6 長期エンジニアリング指針(将来の自分たちへの注意)

1. **契約の凍結とN-1互換**: 拡張は顧客端末に配布され、更新は管理ポリシー経由で遅延する。
   統合APIは契約スナップショットテストを置き、**最新と1つ前の拡張バージョンの両方**が
   通ることをリリースゲートにする。「サーバを直したから拡張も直す」は同時デプロイできない。
2. **セレクタ契約のドリフト監視**: HOMIS側の画面改修は通知なく来る。抽出成功率と
   DOM契約バージョンをテレメトリで送り、契約不一致時は**算定を止める**(誤抽出で走らせない。
   §6.4のバリデーションと同じ思想)。リモート設定でのkill switchを最初から持つ。
   mock_homisのE2Eはリポジトリ横断のCIとして維持する。
3. **データ出所の永続的な区別**: `sourceSystem` タグは「あとで消せない」前提で最初から付ける。
   評価(精度計測)・履歴判定(初再診)・監査のすべてが「どの経路で入ったデータか」に依存する。
   出所不明データが混ざると、これまで積み上げた精度計測の前提が壊れる。
4. **試行データのライフサイクル**: 拡張の「その場算定」は採用されない下書きを大量に残す。
   未採用のまま一定期間経過したsidecar下書きの整理方針(保持期間・削除)を
   G-3の削除義務と合わせて最初に決める。放置するとFirestoreコスト・月次クエリ性能(G2)・
   誤操作リスクが単調に増える。
5. **「候補のみ」ポリシーの侵食防止**: 将来「拡張から直接確定したい」という要望は必ず来る。
   統合APIが確定明細を作れないことを**テストで固定**し、緩める場合は本書の改訂を必須にする
   (人の確認なしの自動確定は、このプロダクトの安全設計の根幹に反する)。
6. **顧客固有化の誘惑への抵抗**: §6.1.1の決定(顧客名はテナントとデータで表現)を維持する。
   施設カスタムはセレクタ契約バージョン(`homis-yamamoto-v1`)と施設設定に閉じ込め、
   コード分岐・ルート分岐にしない。

## 7. 撤去とpushの後始末(完了)

- コミット0acbf03(MFA対応)にPoC5ファイルが紛れてpushされたが、履歴書き換えはせず
  削除コミット `4d669a9` で撤去済み(push済み)。本計画書の追加もコミット済み。
- 現在リポジトリにPoCコードは存在しない(`git ls-files poc/` = 0件)。

## 8. サーバ側基盤の実装状況(2026-07-18)

### 8.1 実装済み

1. **別プロダクト・認証境界**
   - プロダクトID `homis_sidecar` を追加し、通常の `fee` 権限・セッションと分離した。
   - `POST /v1/auth/sidecar-token` で、MFA確認済みの既存ログインから5分間の
     `sidecar:calculate` 専用トークンを発行する。
   - トークンは `audience=fee-api`、拡張ID、端末ID、S256 proof keyに束縛する。
     通常トークンから統合API、専用トークンから通常APIへのアクセスは双方とも拒否する。
   - 拡張ID・端末失効リスト・組織のエンタイトルメント・ロール・MFAをサーバ側で再検証する。

2. **顧客非依存の統合API v1**
   - `POST /v1/integrations/sidecar/calculate` を追加した。
   - `sourceUrl` は契約レベルで拒否し、`orgId + facilityId + sourceSystem + externalPatientId +
     sourceRecordId` を冪等キーにする。同一不変レコードの本文変更は新規作成せずrevisionを上げる。
   - 抽出前後の患者ID・不変レコードID一致、DOM非変更、プレビュー一致、必須DOM要素数、
     セレクタ契約バージョン、抽出時刻(15分以内)を検証し、不完全な抽出は算定前に停止する。
   - 受診区分は必須入力で、根拠を `dom` または `user` として保持する。不明値は受け付けない。

3. **通常算定データからの構造的分離**
   - 下書きは `sidecar_calculation_drafts` に保存し、`fee_sessions`、月次集計、通常の患者履歴には
     採用前に一切入れない。
   - エンジンが確定明細を返しても、統合API保存時に全明細をcandidate/needs_reviewへ強制変換する。
     レセプト案・確定明細は返さない。
   - 採用済み下書きだけは、次回のSidecar算定で過去受診として利用できる。

4. **人による採用のAPI境界**
   - `GET /v1/fee/sidecar-drafts`、`GET /v1/fee/sidecar-drafts/:id`、
     `POST /v1/fee/sidecar-drafts/:id/adopt` を追加した。
   - 採用時は `sourceSystem + facilityId + patientNumber` が一致する構造化患者識別子を必須にし、
     施設情報を持たない旧 `externalPatientIds` だけでは採用できない。
   - 採用はFirestore transactionで通常セッション生成と下書き状態変更を同時に行い、再送しても
     同じ通常セッションを返す。採用後のSidecar再計算・上書きは禁止する。

5. **保持期限・監査・運用ゲート**
   - 下書きの既定保持期間は30日、設定可能範囲は1〜90日。API表示用ISO時刻とは別に
     Firestore日時型 `purgeAt` を保存し、`firestore.indexes.json` でTTLを有効化する。
   - トークン発行、下書き算定、採用を既存監査ログへ記録する。安全なID・件数だけを記録し、
     SOAP本文とsource URLをログpayloadに入れない。
   - `HOMIS_SIDECAR_ENABLED` は既定OFF。有効環境で暗号鍵、拡張ID、セレクタ契約が無い場合は
     デプロイスクリプトまたはサービス起動を失敗させる。

### 8.2 現時点で未完了(本番・パイロットの外部ゲート)

1. 実HOMISでの不変診療記録ID、受診区分、必須DOM要素、抽出対象範囲の確定。
2. 顧客端末のChrome/Edge拡張許可、インターネット到達性、HOMIS利用規約・ベンダー許諾の確認。
3. 別リポジトリでの本番拡張実装。現リポジトリには拡張コードを戻さない。
4. fee-webで下書きを一覧・患者照合・採用するUI。APIは実装済みだが画面導線は未実装。
5. 病院との外部送信契約、院内承認、3省2ガイドライン確認記録、保持期間の正式決定。
6. mock_homisと実セレクタ契約を使う拡張↔API E2E、N-1契約互換、負荷・障害時のkill switch演習。

上記未完了項目が残る間は、環境変数でSidecarを有効化せず、通常のfee-web利用へ影響させない。
