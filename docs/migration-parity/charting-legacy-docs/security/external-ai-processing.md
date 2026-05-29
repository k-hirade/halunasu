# 外部AI処理・越境移転の整理

更新日: 2026-05-06

## 目的

本書は、ハルナスが医療機関から委託を受けて処理する診療関連データについて、どの外部AIサービスに、どの目的で、どのデータを送るかを整理し、契約・保持・学習利用・越境移転の証跡を管理するための内部資料である。

公開向けの要約は `medical-lp/privacy.html` に記載し、本書ではそれを支える実装実態と不足証跡を管理する。

## 現在の実装

### OpenAI

- 主用途
  - SOAP 生成
  - 音声文字起こし
  - Realtime 音声処理
- 主な利用 endpoint
  - `/v1/responses`
  - `/v1/audio/transcriptions`
  - `/v1/realtime`
- 送信される情報
  - 診療音声
  - 文字起こし対象の音声データ
  - SOAP 作成に必要な診療関連テキスト
- 主なコード
  - [responses-structured.js](/Users/hiradekeishi/medical-ai/medical/packages/core/src/openai/responses-structured.js)
  - [openai-final-transcribe.js](/Users/hiradekeishi/medical-ai/medical/packages/core/src/stt/openai-final-transcribe.js)
  - [openai-live-stt.js](/Users/hiradekeishi/medical-ai/medical/packages/core/src/stt/openai-live-stt.js)
- 現時点で確認済みの事実
  - `Responses API` では `store: false` を明示
  - ただし、OpenAI Platform 側の `Data controls` 証跡は未取得

### Deepgram

- 主用途
  - ライブ文字起こしのフォールバック
- 利用条件
  - 本番 `medical-gateway` で `LIVE_STT_FALLBACK_PROVIDER=deepgram`
- 送信される情報
  - ライブ文字起こし対象の診療音声
- 主なコード
  - [live-stt-config.js](/Users/hiradekeishi/medical-ai/medical/packages/core/src/stt/live-stt-config.js)
  - [server.js](/Users/hiradekeishi/medical-ai/medical/services/gateway/src/server.js)
- 現時点で確認済みの事実
  - 本番 `medical-gateway` に `LIVE_STT_FALLBACK_PROVIDER=deepgram`
  - `DEEPGRAM_API_KEY` secret 参照あり
  - したがって privacy 記載が必要な実利用中の委託先である
  - 現行コードでは `mip_opt_out=true` を Deepgram リクエストに付与していない
  - 現行コードでは Deepgram の処理 region を明示指定していない

## 現時点の保持・学習利用の整理

### OpenAI

- `Responses API` は `store: false` を明示している
  - [responses-structured.js](/Users/hiradekeishi/medical-ai/medical/packages/core/src/openai/responses-structured.js)
- ただし、これだけでは Zero Data Retention の証跡にはならない
- 本番 key が属する OpenAI org/project の `Data controls` 設定確認が必要

### Deepgram

- repo 上では fallback 利用が確認できる
- ただし、保持期間、学習利用、subprocessors、地域、DPA の証跡は repo には無い
- さらに、Model Improvement Partnership Program の opt-out はコードで強制しておらず、契約既定値またはアカウント設定に依存している

## 不足している証跡

以下は P1 として別途取得・保存する。

1. OpenAI 本番 org/project の `Data controls` スクリーンショット
2. OpenAI の ZDR または Modified Abuse Monitoring の設定値
3. Deepgram の DPA / 利用規約 / 保持条件
4. Deepgram の学習利用有無
5. Deepgram の subprocessor / データ保管地域

## 保管先

- 証跡本体は [docs/security/evidence/README.md](/Users/hiradekeishi/medical-ai/medical/docs/security/evidence/README.md) の方針に従って格納する

## 対応方針

1. OpenAI は本番 project の `Data controls` を確認し、`docs/security/evidence/` 配下に証跡を保管する
2. Deepgram は fallback で送信されるデータ種別を明記したうえで、契約・保持条件を文書化する
3. 公開 privacy と本書の記載を同期させる
