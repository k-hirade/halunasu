# HOMISサイドカー拡張(算定オーバーレイ)の意図と実装計画 (2026-07-18)

状態: PoC実装済み・動作検証済みのうえ**リポジトリからは撤去**(方針判断待ちのため)。
動作したPoCの全コードはコミット `0acbf03` に残っており、
`git checkout 0acbf03 -- poc/homis-sidecar` で30秒で復元できる
(ただし `extension/sidepanel.js` と `README.md` はコミット漏れ。sidepanel.jsは本書 §5.4 に全文を残す)。

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

| 項目 | 結果 |
| --- | --- |
| bomis患者詳細からの抽出 | 患者ID(URL)・診療日(日付ラベル+カレンダー年)・受付時刻(HH:MM)・SOAP本文を取得 |
| 患者1001 算定 | 訪問診療料890点が確定(施設恒常ルール適用)+「在宅療養」曖昧候補グループ |
| 患者1007 算定 | 890点+「在宅酸素療法」曖昧候補(114003710/114004110、辞書レーンが実マスタで検出) |
| 抽出モード | OPENAI_API_KEY無し=ルール抽出で完走。有りならv14 LLM抽出に自動切替 |
| 受診歴 | 同一患者の連続算定で履歴が積まれ初診/再診判定が働く(インメモリ) |

## 4. セレクタ契約(bomis) — 抽出仕様

HOMISのDOM変更で壊れる部分をここに集約する。実HOMIS対応時はこの表だけ差し替える。

| 項目 | セレクタ/規約 |
| --- | --- |
| 患者ID | URLクエリ `patient_id` |
| 表示中カルテ | `#pdetail_karte` |
| カルテID | `.karte-meta .kv` の「カルテID：<数字>」(患者ID+MMDD) |
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
  `{ok, externalPatientId, karteId, serviceDate, receptionTime, clinicalText, sourceUrl, extractedAt}`
  を返す。失敗時は `{ok:false, error}`。

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

実装可否を決めるのは顧客環境。以下の回答が揃うまで本番実装に着手しない。

1. **ブラウザ種別と端末管理**: HOMISをChrome/Edgeで開いているか(専用アプリ・WebViewなら拡張不可)。
   拡張の追加が組織ポリシーで許可されるか。端末管理者は誰か。
2. **ネットワーク**: 端末からインターネット(halunasu API)へHTTPSで出られるか。
   閉域網(IP-VPN)なら閉域接続構成が必要になり工数が大きく変わる。
3. **HOMISベンダー規約**: 画面情報の外部ツール利用・アドオンの制限条項、公式連携手段の有無。

本番設計でPoCから変える点:

- ブリッジ廃止 → 拡張から fee-api(Cloud Run) 直。組織認証(既存ログイン+MFA)を拡張のパネルで行い
  短寿命トークンを保持。host_permissionsは実HOMISドメイン+halunasu APIのみ。
- 配布は Chrome Web Store 限定公開 or 企業ポリシー強制インストール(野良配布しない)。
- 監査(誰が・どの患者を・いつ算定)はサーバ側の既存監査基盤に記録。
- 3省2ガイドライン対応の文書整理(外部クラウドへの診療情報送信の委託契約・院内規程)。
- セレクタ契約を実HOMISで再作成し、mock_homisをE2E回帰ハーネスとして維持する。
- 日付移送は削除。

## 7. 撤去とpushの後始末

- ローカルは削除済み(作業ツリーに `D poc/homis-sidecar/*` の未コミット削除が出ている状態)。
- コミット0acbf03(MFA対応)にPoC5ファイルが紛れてpush済み。履歴書き換え(force push)はせず、
  削除コミットを1つ積むのが安全:
  `git add poc && git commit -m "Remove HOMIS sidecar PoC (moved to docs/implplan)"`
