# OpenAI主経路 + 補助Span限定再確認 STG計測

- status: complete
- generatedAt: 2026-07-28T13:53:17.236Z
- Cloud Run revision: fee-api-stg-00202-2c4
- strategy: openai_primary
- coverage mode: off
- Span artifact: wx1-multilingual-minilm-l12-v2
- cases: 8
- hard checks: pass
- recovery observed: no
- net-new auxiliary candidates: 0
- duplicate auxiliary candidates: 0
- control comparison: not run
- full acceptance: not yet

カルテ本文、Span文字列、患者氏名は保存していません。各入力はSHA-256と行数だけを記録します。

## Cases

- dual-act-single-line: points=606, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass
- document-and-guidance: points=293, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass
- past-act: points=293, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass
- external-act: points=293, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass
- negated-act: points=293, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass
- planned-act: points=293, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass
- current-wound-treatment: points=293, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass
- long-home-care: points=0, spans=0, gaps=0, extra_calls=0, unsafe_lines=0, hard_check=pass

full acceptanceには復元観測、全ケースのoff対照比較、全安全チェックの合格が必要です。
OpenAI初回抽出が既に全行為を拾ったケースと、補助経路が動かなかったケースを区別してください。
