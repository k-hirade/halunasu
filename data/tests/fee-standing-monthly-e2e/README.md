# Standing monthly E2E fixture

`1002/`は、恒常算定レーンと縦断メモを同じ2か月タイムラインで測る合成fixtureです。

- 前月: W1bの初月候補を既存レビューAPIで人承認相当に確定する
- 当月: 同じ患者のcopy-forwardカルテを算定する
- 確認: W1の履歴駆動候補、当月承認後の月次明細、`memoHitLineRatio > 0`

このfixtureのcopy-forward率は機構の上限性能を測るために意図的に作った値です。実顧客の
Do記載率や実効削減率を表すものではありません。氏名・保険番号等は合成値のみです。
