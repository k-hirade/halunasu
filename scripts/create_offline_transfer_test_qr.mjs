#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "dist", "offline-transfer-test");
const sourcePath = path.join(outputDir, "tera-3206-soap-transfer-test.html");
const restoreOnlyPath = path.join(outputDir, "tera-3206-soap-restore-test.html");
const decoderPath = path.join(outputDir, "tera-3206-offline-decoder.html");
const legacyPath = path.join(outputDir, "tera-3206-test-qr.html");

const soapText = [
  "S",
  "3日前から咳、咽頭痛、鼻汁があります。昨夜から微熱を自覚しています。",
  "食事量はやや低下していますが、水分は摂取できています。息苦しさはありません。",
  "",
  "O",
  "体温36.8℃、SpO2 98%、脈拍78回/分。意識清明です。",
  "咽頭に軽度発赤があります。胸部聴診で明らかなラ音は認めません。",
  "",
  "A",
  "急性上気道炎を疑います。現時点で肺炎を強く示唆する所見は乏しいです。",
  "",
  "P",
  "対症療法を行います。発熱が続く場合、呼吸苦が出る場合、症状が悪化する場合は再診してください。",
  "必要に応じて解熱鎮痛薬を使用してください。水分摂取と休養を指導しました。"
].join("\n");

const shortJapaneseText = [
  "日本語テスト：あいうえお、患者、診療記録。",
  "改行テスト：2行目です。",
  "記号テスト：S/O/A/P、体温36.8℃、咳あり。"
].join("\n");

const rawSamples = [
  {
    id: "jp-short-direct",
    title: "直接転記テスト: 日本語・改行",
    description: "日本語をそのままQRに入れます。前回のように日本語だけ落ちる場合、この方式は使えません。",
    chunks: splitByCodePoint(shortJapaneseText, 360)
  },
  {
    id: "soap-direct",
    title: "直接転記テスト: SOAP本文",
    description: "SOAPに近い本文をそのままQRに入れます。電子カルテへ直接貼る方式の検証用です。",
    chunks: splitByCodePoint(soapText, 360)
  }
];

const encodedTransfer = buildEncodedTransfer({
  id: "DEMO",
  text: soapText,
  // Keep restore QR codes intentionally low-density for handheld screen scans.
  encodedChunkSize: 120
});

await mkdir(outputDir, { recursive: true });

const renderedRawSamples = await Promise.all(rawSamples.map(async (sample) => ({
  ...sample,
  qrs: await Promise.all(sample.chunks.map((chunk, index) => renderQr({
    payload: chunk,
    title: `${sample.title} ${index + 1}/${sample.chunks.length}`,
    part: index + 1,
    total: sample.chunks.length,
    textLength: chunk.length
  })))
})));

const renderedEncodedQrs = await Promise.all(encodedTransfer.records.map((record, index) => renderQr({
  payload: record.payload,
  title: `復元方式 ${index + 1}/${encodedTransfer.records.length}`,
  part: index + 1,
  total: encodedTransfer.records.length,
  textLength: record.payload.length
})));

const sourceHtml = buildSourceHtml({
  rawSamples: renderedRawSamples,
  encodedQrs: renderedEncodedQrs,
  soapText,
  decoderFileName: path.basename(decoderPath)
});
const restoreOnlyHtml = buildRestoreOnlyHtml({
  encodedQrs: renderedEncodedQrs,
  soapText,
  decoderFileName: path.basename(decoderPath)
});
const decoderHtml = buildDecoderHtml({ sampleText: soapText });

await writeFile(sourcePath, sourceHtml, "utf8");
await writeFile(restoreOnlyPath, restoreOnlyHtml, "utf8");
await writeFile(decoderPath, decoderHtml, "utf8");
await writeFile(legacyPath, sourceHtml, "utf8");

console.log(sourcePath);
console.log(restoreOnlyPath);
console.log(decoderPath);

async function renderQr({ payload, title, part, total, textLength }) {
  return {
    payload,
    title,
    part,
    total,
    textLength,
    qrDataUrl: await QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 4,
      width: 640
    })
  };
}

function buildEncodedTransfer({ id, text, encodedChunkSize }) {
  const encoded = base32Encode(Buffer.from(text, "utf8"));
  const chunks = encoded.match(new RegExp(`.{1,${encodedChunkSize}}`, "g")) || [];
  const total = chunks.length;
  const records = chunks.map((chunk, index) => ({
    payload: [
      "HNSQR2SOAP",
      id,
      String(index + 1).padStart(3, "0"),
      String(total).padStart(3, "0"),
      chunk,
      "END"
    ].join("")
  }));
  return { id, text, records };
}

function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

function splitByCodePoint(text, maxLength) {
  const chars = Array.from(text);
  const chunks = [];
  for (let index = 0; index < chars.length; index += maxLength) {
    chunks.push(chars.slice(index, index + maxLength).join(""));
  }
  return chunks;
}

function buildSourceHtml({ rawSamples, encodedQrs, soapText, decoderFileName }) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tera 3206 SOAP QR転記テスト</title>
  ${sharedStyle()}
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Tera 3206 実機検証</p>
      <h1>SOAP QR転記テスト</h1>
      <p>目的は、ハルナスで作成したSOAP本文をオフラインPC上で日本語テキストとしてコピーできるか確認することです。</p>
    </header>

    <section class="panel">
      <h2>結論の見方</h2>
      <div class="steps">
        <div>
          <strong>1. 直接転記テスト</strong>
          <p>QRに日本語SOAPをそのまま入れます。これが成功すれば最短導線です。前回のように日本語が落ちる場合、この方式は不採用です。</p>
        </div>
        <div>
          <strong>2. 復元方式テスト</strong>
          <p>QRには英数字だけを入れ、オフラインPC上のローカルHTMLで日本語SOAPに戻します。最終的には復元されたSOAPをコピーして電子カルテへ貼り付けます。</p>
        </div>
      </div>
    </section>

    ${renderRestoreSection({ encodedQrs, decoderFileName, large: true })}

    <section class="panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Test 1</p>
          <h2>直接転記テスト</h2>
        </div>
        <span class="badge">電子カルテ入力欄へ直接スキャン</span>
      </div>
      ${rawSamples.map((sample) => `
        <article class="sample">
          <h3>${escapeHtml(sample.title)}</h3>
          <p>${escapeHtml(sample.description)}</p>
          <div class="qr-grid">
            ${sample.qrs.map((qr) => renderQrCard(qr, "raw")).join("")}
          </div>
        </article>
      `).join("")}
    </section>

    <section class="panel">
      <h2>期待する復元結果</h2>
      <textarea readonly>${escapeHtml(soapText)}</textarea>
    </section>
  </main>
</body>
</html>`;
}

function buildRestoreOnlyHtml({ encodedQrs, soapText, decoderFileName }) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tera 3206 SOAP復元方式テスト</title>
  ${sharedStyle()}
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Tera 3206 実機検証</p>
      <h1>SOAP復元方式テスト</h1>
      <p>この画面は復元方式だけを試すためのものです。QRはすべて英数字のみで、日本語SOAPはオフライン復元画面で戻します。</p>
    </header>

    ${renderRestoreSection({ encodedQrs, decoderFileName, large: true })}

    <section class="panel">
      <h2>期待する復元結果</h2>
      <textarea readonly>${escapeHtml(soapText)}</textarea>
    </section>
  </main>
</body>
</html>`;
}

function renderRestoreSection({ encodedQrs, decoderFileName, large = false }) {
  return `<section class="panel">
    <div class="section-head">
      <div>
        <p class="eyebrow">Test</p>
        <h2>ASCII QR + オフライン復元テスト</h2>
      </div>
      <span class="badge">このQRだけを復元画面で読む</span>
    </div>
    <p>
      オフラインPCで <code>${escapeHtml(decoderFileName)}</code> を開き、復元画面の読み取り欄をクリックしてから、下のQRを順番に読み取ってください。
      復元方式のQR本文は必ず <code>HNSQR2SOAP</code> で始まります。
    </p>
    <p>
      読み取りやすさを優先し、SOAP本文を細かく分割しています。QRが大きく表示されるように、ブラウザの拡大率は100%前後にして、画面輝度を高めにしてください。
    </p>
    <p class="warning">
      <strong>注意:</strong> 「直接転記テスト」のQRを復元画面に読ませても復元できません。
      <code>2/3SO//A/P36.8</code> のように出る場合は、日本語QRを読んでいるため、この復元テストの対象外です。
      古い復元QRでは <code>|</code> が <code>}</code> に化けることがあります。この画面のQRは記号を使わない形式に変更済みです。
    </p>
    <div class="qr-grid${large ? " qr-grid--large" : ""}">
      ${encodedQrs.map((qr) => renderQrCard(qr, "encoded")).join("")}
    </div>
  </section>`;
}

function buildDecoderHtml({ sampleText }) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ハルナス SOAP QR復元</title>
  ${sharedStyle()}
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">オフラインPC用</p>
      <h1>SOAP QR復元</h1>
      <p>このファイルはインターネット接続なしで動きます。Tera 3206でASCII QRを読み取り、SOAP本文を日本語に戻します。</p>
    </header>

    <section class="panel">
      <h2>読み取り欄</h2>
      <p>下の欄をクリックしてから、<code>HNSQR2SOAP</code> で始まる復元方式のQRだけを順番に読み取ってください。改行されなくても自動で検出します。</p>
      <textarea id="scanInput" class="scan" autofocus spellcheck="false" placeholder="ここに HNSQR2SOAP... が入力されます"></textarea>
      <div class="actions">
        <button type="button" id="decodeButton">SOAPを復元</button>
        <button type="button" id="clearButton" class="secondary">クリア</button>
      </div>
      <p id="status" class="status">未読み取り</p>
    </section>

    <section class="panel">
      <h2>復元されたSOAP</h2>
      <textarea id="decodedOutput" class="output" readonly placeholder="復元後のSOAP本文がここに表示されます"></textarea>
      <div class="actions">
        <button type="button" id="copyButton">SOAPをコピー</button>
      </div>
    </section>

    <section class="panel">
      <h2>このテストで期待する内容</h2>
      <textarea readonly>${escapeHtml(sampleText)}</textarea>
    </section>
  </main>

  <script>
    const scanInput = document.getElementById("scanInput");
    const decodedOutput = document.getElementById("decodedOutput");
    const statusLabel = document.getElementById("status");
    const decodeButton = document.getElementById("decodeButton");
    const clearButton = document.getElementById("clearButton");
    const copyButton = document.getElementById("copyButton");
    const recordPatternV2 = /HNSQR2SOAP([A-Z0-9]{4})(\\d{3})(\\d{3})([A-Z2-7]+)END/g;
    const recordPatternV1 = /HNSQR1[|}]SOAP[|}]([^|}]+)[|}](\\d{3})[|}](\\d{3})[|}]([A-Za-z0-9_-]+)[|}]END/g;

    scanInput.addEventListener("input", () => {
      const result = parseRecords(scanInput.value);
      statusLabel.textContent = result.message;
      if (result.ready) {
        decode();
      }
    });
    decodeButton.addEventListener("click", decode);
    clearButton.addEventListener("click", () => {
      scanInput.value = "";
      decodedOutput.value = "";
      statusLabel.textContent = "未読み取り";
      scanInput.focus();
    });
    copyButton.addEventListener("click", async () => {
      decodedOutput.select();
      try {
        await navigator.clipboard.writeText(decodedOutput.value);
        statusLabel.textContent = "SOAPをコピーしました";
      } catch {
        document.execCommand("copy");
        statusLabel.textContent = "SOAPを選択しました。必要に応じてコピーしてください";
      }
    });

    function decode() {
      const result = parseRecords(scanInput.value);
      statusLabel.textContent = result.message;
      if (!result.ready) return;
      const encoded = result.records
        .sort((a, b) => a.part - b.part)
        .map((record) => record.payload)
        .join("");
      decodedOutput.value = result.encoding === "base64url"
        ? utf8FromBase64Url(encoded)
        : utf8FromBase32(encoded);
      statusLabel.textContent = "SOAPを復元しました";
    }

    function parseRecords(value) {
      const trimmedValue = value.trim();
      const records = [];
      let match;
      recordPatternV2.lastIndex = 0;
      while ((match = recordPatternV2.exec(value)) !== null) {
        records.push({
          id: match[1],
          part: Number(match[2]),
          total: Number(match[3]),
          payload: match[4],
          encoding: "base32"
        });
      }
      if (records.length === 0) {
        recordPatternV1.lastIndex = 0;
        while ((match = recordPatternV1.exec(value)) !== null) {
          records.push({
            id: match[1],
            part: Number(match[2]),
            total: Number(match[3]),
            payload: match[4],
            encoding: "base64url"
          });
        }
      }
      if (records.length === 0) {
        if (trimmedValue.length > 0 && !trimmedValue.includes("HNSQR2SOAP") && !trimmedValue.includes("HNSQR1")) {
          return {
            ready: false,
            records,
            message: "復元方式のQRではありません。HNSQR2SOAP で始まるQRだけを読み取ってください"
          };
        }
        if (trimmedValue.includes("HNSQR2SOAP") || trimmedValue.includes("HNSQR1")) {
          return {
            ready: false,
            records,
            message: "QRデータが途中で切れています。読み取り欄をクリアして、同じQRをもう一度読み取ってください"
          };
        }
        return { ready: false, records, message: "未読み取り" };
      }
      const id = records[0].id;
      const total = records[0].total;
      const encoding = records[0].encoding;
      const sameSet = records.every((record) => record.id === id && record.total === total && record.encoding === encoding);
      if (!sameSet) {
        return { ready: false, records, message: "異なるテストQRが混ざっています" };
      }
      const uniqueParts = new Set(records.map((record) => record.part));
      const missing = [];
      for (let part = 1; part <= total; part += 1) {
        if (!uniqueParts.has(part)) missing.push(part);
      }
      if (missing.length > 0) {
        return {
          ready: false,
          records,
          message: \`\${records.length} / \${total} 個読み取り済み。未読: \${missing.join(", ")}\`
        };
      }
      return { ready: true, records, encoding, message: \`\${total} / \${total} 個読み取り済み\` };
    }

    function utf8FromBase32(value) {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      let bits = 0;
      let buffer = 0;
      const bytes = [];
      for (const char of value.replace(/=+$/g, "")) {
        const digit = alphabet.indexOf(char.toUpperCase());
        if (digit < 0) continue;
        buffer = (buffer << 5) | digit;
        bits += 5;
        if (bits >= 8) {
          bytes.push((buffer >>> (bits - 8)) & 255);
          bits -= 8;
        }
      }
      return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    }

    function utf8FromBase64Url(value) {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padding = "=".repeat((4 - normalized.length % 4) % 4);
      const binary = atob(normalized + padding);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    }
  </script>
</body>
</html>`;
}

function renderQrCard(qr, mode) {
  return `
    <article class="card">
      <h3>${escapeHtml(qr.title)}</h3>
      <div class="qr">
        <img src="${qr.qrDataUrl}" alt="${escapeHtml(qr.title)} QRコード" />
      </div>
      <div class="meta">
        <span>${qr.part} / ${qr.total}</span>
        <span>${qr.textLength}文字</span>
        <span class="badge">${mode === "encoded" ? "ASCIIのみ" : "日本語そのまま"}</span>
      </div>
      <textarea readonly>${escapeHtml(qr.payload)}</textarea>
    </article>
  `;
}

function sharedStyle() {
  return `<style>
    :root {
      color-scheme: light;
      --ink: #172326;
      --muted: #607278;
      --line: #d9e3e3;
      --teal: #0f766e;
      --teal-dark: #115e59;
      --bg: #f5f8f8;
      --card: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    main {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 56px;
    }
    header, .panel { margin-bottom: 18px; }
    h1 { margin: 0 0 8px; font-size: 1.8rem; }
    h2 { margin: 0 0 12px; font-size: 1.2rem; }
    h3 { margin: 0 0 10px; font-size: 1rem; }
    p { margin: 0 0 12px; color: var(--muted); line-height: 1.7; }
    code {
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 1px 5px;
      background: #fbfdfd;
      color: var(--teal-dark);
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 16px;
      color: #fff;
      background: var(--teal);
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary {
      color: var(--ink);
      background: #e8eeee;
    }
    .eyebrow {
      margin: 0 0 6px;
      color: var(--teal);
      font-size: 0.82rem;
      font-weight: 700;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .steps > div {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfdfd;
    }
    .sample + .sample {
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .qr-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
      gap: 14px;
    }
    .qr-grid--large {
      grid-template-columns: 1fr;
      max-width: 760px;
      margin: 0 auto;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: #fff;
    }
    .qr {
      display: grid;
      place-items: center;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .qr img {
      width: min(100%, 640px);
      height: auto;
      image-rendering: pixelated;
    }
    textarea {
      width: 100%;
      min-height: 150px;
      margin-top: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      font: 0.9rem/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--ink);
      background: #fbfdfd;
      resize: vertical;
    }
    textarea.scan { min-height: 190px; }
    textarea.output { min-height: 260px; }
    .meta, .actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin: 12px 0 0;
      font-size: 0.86rem;
      color: var(--muted);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      color: var(--teal);
      background: rgba(15, 118, 110, 0.08);
      border: 1px solid rgba(15, 118, 110, 0.16);
      border-radius: 999px;
      padding: 4px 9px;
      white-space: nowrap;
      font-size: 0.82rem;
      font-weight: 700;
    }
    .status {
      margin-top: 12px;
      color: var(--teal-dark);
      font-weight: 700;
    }
    .warning {
      border: 1px solid #f4c76b;
      border-radius: 8px;
      padding: 10px 12px;
      color: #6b4b00;
      background: #fff7df;
    }
  </style>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
