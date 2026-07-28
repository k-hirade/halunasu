# OpenAI主経路 + 補助Span限定再確認 STG計測

- status: complete
- generatedAt: 2026-07-28T12:58:28.980Z
- Cloud Run revision: fee-api-stg-00201-79m
- strategy: openai_primary
- coverage mode: verify
- Span artifact: wx1-multilingual-minilm-l12-v2
- cases: 8
- hard checks: pass
- recovery observed: yes
- full acceptance: pass

カルテ本文、Span文字列、患者氏名は保存していません。各入力はSHA-256と行数だけを記録します。

## Cases

- dual-act-single-line: points=606, spans=3, gaps=1, extra_calls=1, hard_check=pass
- document-and-guidance: points=293, spans=0, gaps=0, extra_calls=0, hard_check=pass
- past-act: points=446, spans=1, gaps=0, extra_calls=0, hard_check=pass
- external-act: points=293, spans=3, gaps=3, extra_calls=1, hard_check=pass
- negated-act: points=293, spans=1, gaps=0, extra_calls=0, hard_check=pass
- planned-act: points=293, spans=1, gaps=1, extra_calls=1, hard_check=pass
- current-wound-treatment: points=345, spans=1, gaps=0, extra_calls=0, hard_check=pass
- long-home-care: points=0, spans=2, gaps=1, extra_calls=1, hard_check=pass

補助経路が候補を復元しなかった場合、hard checksが通っていてもfull acceptanceは未達です。
OpenAI初回抽出が既に全行為を拾ったケースと、補助経路が動かなかったケースを区別してください。
