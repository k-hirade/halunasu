# 眼科専用電子カルテ UI/UX 調査レポート(Halunasu eye 向け)

作成日: 2026-11-01 / 対象: クラウド眼科電子カルテを1人で開発する前提での、画面設計レベルの参照情報

---

## 0. 先に結論(TL;DR)

1. **公開情報から画面の細部までわかる日本の眼科カルテはほとんどない。** NIDEK、トプコン、ビーライン、ファーストメディカル、ユヤマはどれも画面やマニュアルを公開していない。今回いちばん具体的だった日本の一次情報は、**京都市立病院の調達仕様書(Claio / C-Note、ファインデックス)** と **CLIPLA Eye の機能ページ** の2つ。とくに京都市立病院の仕様書は、現場が何を求めているかを項目単位で書いているので、事実上の要求仕様として使える(§2.1)。
2. **好評な製品の共通点**(ModMed EMA は AAO 2015 調査で「使いやすい」が 81.9%、EyeMD は 91.7%。最下位の NextGen は 16.7%、Compulink は 9.1%):
   - 1画面で完結する(タブ移動や画面遷移がない)
   - 前回値の pull forward と、右眼→左眼の「1タッチコピー」
   - 「異常なし」を一括入力するボタン
   - 医師ごとの "sticky"(前回選んだ値を覚える)とプロトコル(セット)
   - タッチ・iPad・ペンで直接描けるシェーマ
3. **不満の筆頭はどの調査でも同じで「クリック数が多い」「画面遷移が多い」。** 続いて「描画ツールが使いにくい」「機器と連携しない」「ユーザー単位でカスタマイズできない」。AAO 2015 調査も、Capterra・KLAS・StudentDoctor のレビューも同じ傾向。
4. **日本では「紙の2号紙のような見開き」「右眼が先(上または左)」「検査値は左右の列に分ける」「眼圧は測定方法と時刻つき」「次回指示を前回からコピー」が当たり前の要求になっている**(京都市立病院仕様書、日本眼科医会の眼鏡処方箋様式、新潟大学の緑内障連携パス)。
5. **CLIPLA Eye の差別化要素**は、ステータス別のカード式受付ボード、レフケラをレシート形式で表示、タブレット専用の検査入力画面、暗室用ダークモード、同じカルテを複数人で同時に編集できること。Halunasu eye が真っ先に比較されるクラウド競合なので、これらは最低ラインと考えるべき。

---

## 1. 調査範囲と信頼度について

- 調べ方は Web 検索と公開ページ・公開PDFの取得のみ。デモ動画は文字起こしが公開されているものに限り参照した。ログインが必要なマニュアル(Epic UserWeb、NIDEK/トプコンの取説など)と Reddit は見られていない。Reddit は検索に出ず、StudentDoctor も本文は 403 で、検索スニペットしか取れなかった。
- 信頼度は次の4段階で表記する。
  - **[一次]**: メーカーのヘルプやマニュアル、病院の調達仕様書、学会の様式
  - **[ユーザー]**: Capterra・KLAS・フォーラム・学会調査のユーザー評価
  - **[宣伝]**: メーカーの宣伝や比較メディア
  - **[未検証]**: 筆者の一般知識。出典で裏付けられていない
- **右眼を赤、左眼を青とする色分けの慣習は、日本でも海外でも出典を見つけられなかった**(§5.6)。

---

## 2. 日本の製品

### 2.1 京都市立病院「眼科カルテシステム(Claio、C-Note)機能仕様書」[一次]

出典: https://www.kch-org.jp/wp-content/uploads/2022/03/2d245f88d0972cb80545103558b00b98-5.pdf (2022年、ファインデックス製品の調達仕様)

日本の眼科で「最低限ないと困る」とされる要件が項目単位で並んでいる。設計に直結する項目を抜き出す。

| 項番 | 要求 | 設計上の意味 |
|---|---|---|
| 2-1-2 | カルテ入力は**見開き型**のインターフェイスで行う | 紙の2号紙と同じく、左に所見・経過、右に処方・処置という見開き構成が期待されている |
| 2-1-3 / 2-1-4 | 経過記録に、指定した検査データや画像を**貼り付け**られる(拡大・縮小可) | 検査値ブロックをカルテ本文に差し込む操作が必要 |
| 2-1-12 / 2-1-13 | **仮登録**(書きかけ保存)ができる。仮登録中は明示し、保持したまま別患者を書ける | 書きかけの状態を並行して持てること |
| 2-1-20 | 矩形・円・自由線・直線・テキスト・付箋。**10色以上**、ユーザーごとに設定 | 描画の基本セット |
| 2-3-1 | シェーマのモードは**ペイント/オブジェクト/混合**から選ぶ | ラスタで描くかベクタで描くかを選べる |
| 2-3-2 | シェーマはタブで分類し、**使用頻度の高いもの**を選べる。表示サイズも変えられる | よく使う下絵を優先して出す |
| 2-3-3 | ペンタブレットの**筆圧(濃淡・太さ・軌跡)**を再現する | Pointer Events の pressure に対応する |
| 2-3-5 | **過去カルテのシェーマをコピー**できる | 前回の図を引き継ぐ機能は必須 |
| 2-4-1〜3 | 初診や病名ごとのカルテセット。科共通と個人用の2階層。**ショートカットアイコンを2つ以上** | テンプレートの階層化とワンタップ起動 |
| 2-5-1〜5 | 検査歴を一般表示と**眼科専用表示**で切り替える。全件・当日・**直近10日**・機器別で表示。**左右の眼で列を左右に分ける**。**眼圧グラフ**。CSV・印刷・クリップボードに出力 | 前回値表示の仕様そのもの |
| 1-5-8 | **視力と眼圧をグラフ表示** | 推移グラフは必須 |
| 1-5-6 | 検査テンプレート: 自覚視力の複数作成、手術用自覚視力、CFF、涙液、プリズム、色覚(石原ほか多数)、斜視(CUT/APCT/大型弱視鏡)、眼位(Krimsky/Hirschberg/9方向)、Worth4灯、近点計、Mチャート など | 視能訓練士が行う検査の種類の広さ |
| 1-5-7 | **眼鏡処方箋とCL処方箋**を発行する | 必須 |
| 2-7-1〜3 | 注射・レーザー・手術のテンプレート記録を要約表示(注射の薬剤と回数、レーザーのサイズ・発数・回数)し、時系列で一覧 | 抗VEGF の回数管理などに使うフローシート |
| 2-8-1〜5 | **次回指示**: 150個以上(10行×15列)。**前回の指示をコピーして修正**できる。アレルギーや感染症も表示 | 次回指示はグリッドで、前回からコピーする |
| 2-11-3 | 受付指示票に受付番号・ID・バーコード・氏名・予約・コメント・**前回検査情報**を印字 | 紙の指示票に前回値を載せる運用 |
| 2-13-1〜4 | 受付患者一覧: 進捗とコメントを画面入力やバーコードで更新。**フィルタのプリセットタブを5つ以上**(予約枠・担当医)。**検査指示と検査の終了状況を表示** | 待ち一覧の要件 |
| 1-5-4 | 細隙灯の画像には**左右の情報を自動で付与** | 左右(L/R)は自動で付くのが基本 |
| 1-8-2 / 2-9-2 | **当日行った検査から、実施入力(算定)の項目を自動選択** | 検査を行えば算定候補が出る |

### 2.2 CLIPLA Eye(クリプラ、クラウド)[宣伝/一次寄り]

出典: https://clipla.jp/eye/service/ 、 https://clipla.jp/eye/ 、 https://www.aspicjapan.org/asu/service/15071 、事例 https://www.it-hojo.jp/h30/doc/pdf/h30_medical_tsurumityuoganka.pdf

**受付・待ち一覧**
- 受付後の患者を「診察中」「会計待ち」などのステータスごとに**カード**で表示し、カードを移動してステータスを変える。
- ステータスの名前と並び順は医院ごとに設定できる。全端末に自動で反映される。
- 患者IDのバーコード付き指示書を、1人分でも、待っている複数人分の一括でも印刷できる。

**検査値**
- 機器の数値と画像を**ワンクリック**で取り込める。
- **レフケラは見慣れたレシート形式**のままカルテに表示する。機器から出る感熱紙の見た目を再現しているということ。
- **iPad 向けに最適化した検査員用の機能**があり、検査値・眼圧・視力・眼鏡処方・CL処方を扱う。
- タブレットには、取り込んだ機器データをもとに検査値を入力する専用画面がある。

**シェーマ**
- ペンは**7段階の太さ・6色**。テンプレートには任意の画像を登録でき、テキストも書き込める。
- テキストボックスやペンの線は1本ずつ、またはまとめて選択・移動・拡縮・削除できる(オブジェクトモード相当)。
- 描き心地のため、タッチモニタかタブレットを推奨している。

**セットと処方**
- 「全体セット」(診療行為・検査・薬剤・病名)をワンクリックで入力できる。薬剤だけ、処置だけといった項目別のセットも作れる。
- 処方の数量や日数に「0」を入れると、残薬で継続する場合を記録できる。
- CL処方箋は登録済みのレンズ一覧から選んで作る。

**その他**
- **ダークモード**: 暗室での診察用に、カルテの色を反転する。
- **同時編集**: 同じ患者のカルテを複数人で同時に閲覧でき、異なるセクションなら同時に編集できる。
- **環境**: Chrome の最新版、解像度は **1920×1080 以上**。端末を増やしても追加料金はかからない。
- 2026-10-26 に、過去カルテを要約する生成AIサマリー機能を追加(当面無料)。
- 導入事例(横浜鶴見中央眼科)の声: 「過去の治療履歴が一目で確認できる」「本院・分院で何人待っているかを共有でき、混雑に応じて応援に行けるようになった」。運用は**段階的に電子化**した。
- 宣伝コピーは「1画面完結」「快適な画面設計で誰でも簡単操作」。
- ユーザーレビュー: ITreview・ITトレンドともに **0件**で確認できなかった。

### 2.3 NIDEK NAVIS-CL / NAVIS-EX [宣伝/二次]

- **NAVIS-CL**(診療所向け電子カルテ、オンプレ)
  - 比較記事によると、シェーマは**筆圧を感知**し、**スケッチの下絵が豊富**。手術管理・統計・OCR とも連携する。
    - https://meetsmore.com/product-services/electronic-karte/media/179598
  - 二次情報では、**2023年4月から新規受注を停止**しており、新規導入は DONUTS の CLIUS が引き受ける。CLIUS には NAVIS-CL のノウハウを生かして眼科機能を共同開発し、NAVIS-AZU との連携も目指す(2024-11 協業)。
    - https://donuts.ne.jp/wp-content/uploads/2024/11/PRESSRELEASE-241111_clius_nidek.pdf 、 https://xexeq.jp/blogs/media/topics22218
  - 画面構成、視力入力、前回値の表示方法は**公開情報では確認できなかった**。
- **NAVIS-EX**(画像ファイリング)
  - 取得・表示・描画・計測・パノラマ・ステレオ表示・合成・**Follow-Up**の機能を持つ(FDA K181345)。
    - https://fda.innolitics.com/device/K181345
  - 日本版には OCT の機械学習解析がある(名古屋市立大学 2019)。
    - https://www.nagoya-cu.ac.jp/media/20190415.pdf
  - 比較画面の具体的な見た目は未確認。

### 2.4 トプコン IMAGEnet eカルテ V5 / V5クラウド [宣伝]

- 眼科機器メーカーが作った眼科専用カルテで、オンプレとクラウドの両方がある。
- 宣伝文句は「入力支援機能によりカルテ記入を効率化」。比較記事には、導入者が「直感的で画面レイアウトがわかりやすい」と評価しているとの記述がある。
  - https://it-trend.jp/emr/article/comparison_ophthalmology 、 https://www.shopowner-support.net/?p=165725
- 入力画面の詳細は**未確認**。2026年3月に IMAGEnet7(データ管理)を発売している。

### 2.5 ビーライン Medius CL / MediusPlus [宣伝]

- **検査テンプレート300種以上、シェーマ500種以上**、処方アシスト、チャット機能がある。
- 「シンプルで見やすく、診察画面のレイアウトを変えられる」。MediusPlus はタブレット入力に対応。
- 出典: https://www.shopowner-support.net/?p=165725 、 https://it-trend.jp/emr/article/comparison_ophthalmology

### 2.6 ファーストメディカル eyemet's(アイメッツ)[宣伝]

- 「**起動画面から画面配置まで自由に設定できる**」。受付は順番に表示し、検査画像と数値は自動で取り込む。
- 「代診医にも使いやすい」とされている。電子カルテと画像ファイリングが一体で、段階的に導入できる。
- デモや無料体験はない。
- 出典: https://www.shopowner-support.net/?p=165725

### 2.7 ファインデックス Claio 眼科パッケージ / C-Note [一次・宣伝]

- C-Note は「**2号紙のイメージの画面上で、好きな位置に所見を入力したり、検査結果や画像を貼り付けたりして、紙カルテのように書ける**」。閲覧も「紙カルテのページをめくる感覚」で行う。
  - innervision 2013/2022: https://innervision.co.jp/03book/buhin2013/pdf/2-40.pdf 、 https://www.innervision.co.jp/ressources/pdf/buhin2022/1-26.pdf
- 検査の台紙に直接書き込めるので、紙と同じ運用ができる。時系列で経過を参照できる。スタンプ機能もある。
- 大学病院や基幹病院への導入が多い(京都市立病院の仕様書は §2.1)。

### 2.8 その他

- **ぺんカル**(京葉電子工業、2023年9月発売、眼科専用クラウド): レセコン・電子カルテ・画像ファイリングを一体にしている。紙カルテをスキャンする「カルテビューア」が標準。画面の詳細は不明。
  - https://www.shopowner-support.net/?p=166435
- **ユヤマ BrainBox**: ある第三者サイトに「歯科・眼科専門 非対応製品」と書かれている。眼科専用の機能は**確認できなかった**。
  - https://it-trend.jp/emr_sub-withoutbeds/9138
- **トーメー**: 眼科向けの電子カルテやファイリング製品は**公開情報では見つからなかった**。
- **富士フイルム**: 眼科向けファイリング製品は見つからなかった。日本の眼科ファイリングでは、トプコン(IMAGEnet)、NIDEK(NAVIS-EX)、ファインデックス(Claio)、Zeiss(FORUM)が主に挙がる。
- **汎用クラウドカルテの眼科利用**
  - エムスリーデジカル: iPad と Apple Pencil で、シェーマや写真に手書きできる。ある眼科は「iPad Pro のペン入力で手書きの便利さが残る」と満足している。
  - CLIUS: iPad で使え、「どこに何があるか直感的にわかる」との評価がある。
  - 出典: https://www.shopowner-support.net/?p=165725 、 https://www.aspicjapan.org/asu/service/9417

### 2.9 日本の文献に見る導入時の痛み [一次・学会抄録]

- 佐賀大学眼科(臨床眼科 2011): 紙カルテが不要になった割合は、稼働6か月後に14.9%、12か月後に40.0%。紙をなくしたことで外来の待ち時間は8.8分短くなった。一方で「**情報量の少ない再診**」の紙カルテをスキャンする運用には限界があり、完全移行には長い時間がかかる。
  - https://webview.isho.jp/journal/detail/abs/10.11477/mf.1410103670
- 別の病院(臨床眼科 2006): 予約ありの再診は診察時間が短くなった。一方、**初診と予約なしの再診では長くなった**。
  - https://webview.isho.jp/journal/detail/abs/10.11477/mf.1410100955
- 示唆: **再診を速く回すこと**が電子化の効果の中心で、初診は遅くなりやすい。Halunasu が「使いにくい」と言われる場合も、まず再診のタップ数を数えるのが合理的。

---

## 3. 海外の製品

### 3.1 ModMed EMA Ophthalmology(iPad ネイティブ、クラウド)

**画面と操作 [一次: メーカー動画の文字起こしと記事]**
- 「**Virtual Exam Room**」で、精細な眼の図をタップしたり描いたりして所見を入れる。グレード付けは矢印で行う。チェックマークで所見を入れる。
  - https://www.modmed.com/ophthjourney/exam/
- **ピンチズームと長押し**で現在の部位をハイライトする。所見は ICD-10 の詳細度とひもづく。
- 開いた時点で「**pull forward された前回の検査・所見・印象・計画・描画**」が出ている。
- C/D 比を右眼に入れて、**ワンタッチで左眼にコピー**する。
  - https://modmed.com/resources/videos/documenting-eye-exam-ophthalmology-ehr
- **描画**: 自由に描いた線は眼のどの部位かを自動で判別する。定型の図をスタンプして拡縮・回転できる。描画はレイヤー構造で、**次回の受診に持ち越せる**(第三者レビュー)。
  - https://softwarefinder.com/resources/5-top-ophthalmology-ehrs-for-your-medical-practice

**学習とセット [ユーザー: 医師の寄稿]**
- **Adaptive learning**: 核白内障→処方と選ぶと、その医師がよく使う術後薬がリストの上に来る。
- **Sticky**: 主訴・印象、印象ごとの計画、言い回しを覚えている。
- **Protocols**: 印象・検査・計画・処方・説明・フォローアップをまとめて保存しておき、診察室で適用する(術前後、糖尿病網膜症、ドライアイなど)。
- **略語展開**: 「art」と打つと人工涙液の説明文に展開される。
- 患者が帰った直後にカルテが確定し、時間外の記載が要らなくなった。
  - https://www.ophthalmologytimes.com/view/intuitive-emr-platform-adapts-ophthalmic-workflow

**2023年の新UI [宣伝]**
- **1画面**で問診から検査、印象と計画まで済む。**検査全体を入力する欄が1つ**だけあり、「hem」と3文字打つと候補が出る。タップすると、結膜出血なのか黄斑出血なのかを判別して正しい部位に入る。
- 印象(例: wet AMD)を選ぶと、OCT・注射・1か月後再診が自動でキューに入る。経過観察の計画は「数クリック」。
- 問診は患者が事前に入力し、技師は確認するだけ。
  - https://www.ophthalmologytimes.com/view/aao-2023-simplifying-the-charting-process-with-modmed-s-new-initiative

**ユーザーの声 [ユーザー]**
- 良い点
  - 「iPad ネイティブアプリがとても slick」。スクライブなしでも回せる。
  - AAO 2015 調査で「総合的に使いやすい」は 81.9%(強く同意36.4+同意45.5)、「もう一度買う」は 81.8%。
- 不満
  - **iPad 版とデスクトップ版の機能差**(最頻出)
  - 「ノートを仕上げるまでのクリックと画面遷移が多すぎる」
  - 予約キャンセルのクリック数
  - 請求との連携
  - 構造化項目を無視してフリーテキストに逃げてしまう
  - StudentDoctor の書き込み: 「I hate Mod Med with a passion… very click heavy」
- 出典: https://capterra.com/p/124590/EMA/reviews/ 、 https://forums.studentdoctor.net/threads/emrs.1431955 (スニペット)、AAO 調査 PDF(後述)

### 3.2 Epic Kaleidoscope(大病院・大学向け)[一次: アイオワ大学の Epic 研修サイト]

- 構成要素: Ophthalmology Exam、描画ツール(線・図形・**ステンシル**)、眼科略語の**自動修正辞書**。SmartLinks と SmartPhrases で検査要素を紹介状などに引き込む。
- **Tech Work List**: 技師の作業リスト。検査の開始・終了、結果入力、別の医師への割り当てができる。実際に行った検査に合わせてオーダーを変更でき、算定が正確になる。
- **Rooming と dashboard のステータス**で院内の患者の動きを追う。
- **Imaging & Procedures Home**: 患者をまたいで、複数の検査結果をまとめて判読できる。
- 眼鏡処方の署名は Eye Exam navigator か Wrap Up から行い、印刷できる。
- 出典: https://epicsupport.sites.uiowa.edu/node/806
- 視力や眼圧の入力グリッドの具体像は**ログインが必要で未確認**。
- ユーザー評価: AAO 2015 で「使いやすい」は 41.6%。大規模な汎用 EHR は「ナビゲーションが複雑で入力が面倒」(AAO MIT 委員会 2011)。
  - https://www.eweek.com/news/ehrs-fall-short-for-eye-doctors-report/

### 3.3 Nextech IntelleChartPRO(現 Nextech EHR)

- **1ページ型の検査画面**。「画面から画面、タブからタブへ移動しない。全部が1つの流れるページ」[ユーザー]。
- プロファイルに応じて必要なセクションだけを表示する[宣伝 2019]。
- 「**bubble clicking**」(丸いボタンをクリックして選ぶ)が好評[KLAS]。
- **Glaucoma Flowsheet**[宣伝 2020]
  - 1ページに眼圧・点眼・C/D・手術を表で並べる。眼圧グラフには点眼と手術のイベントを重ね、**目標眼圧の帯**を示す。リスク因子、直近の検査日、治療方針も同じ画面にある。
  - https://www.biospace.com/nextech-announces-new-glaucoma-flowsheet
- 不満[ユーザー]
  - 「機能はするが使いやすくない。**クリックが多い**」(KLAS 2025-12)
  - 「患者画面は右クリック、ツールバーは左クリックという不統一」(G2)
  - ワークフローを色分けしたいという要望
  - テンプレートを作り込むのに手間がかかる
  - https://klasresearch.com/comments/nextech-intellechartpro-ehr/212668

### 3.4 Compulink(Advantage)

- **OneTab**: 「検査全体を1画面で記載」。**SMART Orders**: 診断・評価・オーダー・計画を1クリックで入れる。Visual Documentation Engine: 診断から記載を自動生成する[宣伝]。
- 不満[ユーザー]: 「検査の記載がとても tedious」「入力が cumbersome」「アップデートのたびに不具合」「高い技術リテラシーが要る」。AAO 2015 で「使いやすい」は **9.1%**。
- 出典: https://www.compulinkadvantage.com/ophthalmology/ 、 https://www.capterra.com/p/209707/Compulink-Healthcare-Solutions/reviews/

### 3.5 Eyefinity EHR(Encompass)/ OfficeMate [一次: 公開ヘルプ]

具体的な操作手順がわかる貴重な一次資料。

**Visit Overview の Vision Summary**
- 必須の5領域(Pupils / VF / Motility / IOP / VA)が記載されると、セクションの色が**オレンジから緑**に変わる。完了状態が色でわかる。
- 「**Mark Pupils, Motility, VF Normal**」リンク1つで3領域をまとめて「異常なし」にできる。

**各検査の入力**
- 各検査には「Mark as Normal」ボタンか Result のドロップダウンがあり、最後に Save する。iPad では「**Save and Continue**」で次の検査へ進む。
- **IOP**: Measurement・Method・Reliability の3つのドロップダウン。「Attempted but not achieved」(測定を試みたができなかった)の選択肢がある。
- **VA**: 遠方と近方の Test Type を選ぶ。この項目は **sticky**(前回の選択を保持)。「Add Uncorrected」「Add Corrected」で行を追加し、VA・PH値・Other を入れる。Wearing Rx タブに入れた値は引き継がれる。
- **Refraction**
  - 値はドロップダウンで選ぶ。手入力したいときは Manual チェックを入れる。
  - 「**Copy OD to OS**」で右眼の値を左眼にコピーする。
  - 「**Set to 20/20 OU**」「**Set to J1+OU**」で視力を一括で入れる。
  - **Refraction History から過去値を取り込む**。オートレフは機器連携で自動取り込み。
  - 「Create Final Rx」から眼鏡処方を作る。有効期限は施設設定から自動で入る。
- **散瞳薬**: ドロップダウンが sticky。Copy OD to OS がある。

**手数**
- 出典のヘルプには合計数が書かれていない。手順から筆者が数えると、ルーチン検査一式でおよそ25〜35操作になる。ドロップダウン中心の UI は手数が多い典型例。

出典: https://help.eyefinity.com/eehr/Browser/visit/vision-pretesting.htm 、 https://help.eyefinity.com/eehr/iPad/visit/vision-pretesting.htm 、 https://help.eyefinity.com/eehr/Browser/visit/vision-refractions.htm 、 https://help.eyefinity.com/eehr/Browser/Performing_a_Routine_Vis.htm

### 3.6 RevolutionEHR(検眼医向けクラウド)[ユーザー]

- 好評: 「既存患者は**前回情報の pull forward**でとても時短になる」「exam flow をカスタマイズできる。作り込めば breeze」。
- 不満
  - 「**悪名高い click-heavy**。セクション間の移動に複数クリック」
  - 「書いたはずの所見が**空で表示**される。危険」
  - 「近用屈折を前回から持ち越せない」「PC 用眼鏡など特殊な処方を書けない」
- キーボード: 矢印キーで移動、Ctrl+→ で次の画面へ(2012年の情報)。
- 出典: https://www.capterra.com/p/124589/RevolutionEHR/reviews/ 、 https://insight.revolutionehr.com/?p=4376

### 3.7 MDoffice(Eye Care Leaders)

- 眼科特化の EMR/PM。チャートと問題別フォームを作れる、という程度しか公開情報がない[宣伝]。
- 画面の詳細は**未確認**。AAO 2015 の回答者は7名。

### 3.8 横断的な調査・研究

- **AAO/AAOE EHR 満足度調査 2015**(n=217)[ユーザー]
  - 出典: https://aao.org/Assets/7f1c2664-409b-4875-bc94-8850f210f1d3/635810291917200000/november-2015-practice-perfect-pdf
  - 「総合的に使いやすい」(強く同意+同意): EyeMD 91.7% / ModMed 81.9% / MDIntelliSys 66.7% / Epic 41.6% / Medflow 27.6% / NextGen 16.7% / Compulink 9.1%
  - 好まれた機能: 遠隔アクセス、判読性、他院医師とノートを共有できること
  - **最悪の機能**:
    1. 入力が面倒でワークフローが遅くなる(**クリック過多**)
    2. 診断機器と連携しない
    3. **描画機能が貧弱**
    4. **ユーザー単位でカスタマイズできない**
    5. サポートが悪い
- **AAO MIT 委員会「眼科 EHR の特別要件」**(Chiang et al., Ophthalmology 2011)
  - 必須17項目、望ましい6項目がある。
  - 主な指摘: 描画と色の注釈、DICOM での機器連携。**血圧や身長体重の必須入力をやめて眼圧を中心に置く**。**視力の測定条件**(距離、照明、眼鏡・CL・ピンホール、HM などの低視力表記)を記録する。**診察室の外でカルテを事前に確認できる**こと。
  - https://www.eweek.com/news/ehrs-fall-short-for-eye-doctors-report/
- **緑内障と EHR**(Review of Ophthalmology、UC Davis)
  - 移行後、**描画の頻度が大きく下がった**(「既存の描画プログラムは very clunky」)。
  - 推奨: 画面はできるだけ大きく(22インチ超)。厚み・最高眼圧・目標眼圧・緑内障手術を**1か所にまとめる**。医師が患者に向いたまま使える配置にする。
  - https://www.reviewofophthalmology.com/article/glaucoma-and-ehr-perfect-together
- **CRST「Hate Your EHR System?」**
  - 「EHR に診療フローを支配させるな」「紙でどうやっていたか?を問え」。
  - 推奨: 診察室の外のモニタで技師のワークアップを先に確認する。A&P はマクロとドロップダウンで入れる。画像は別ビューアに置く。
  - https://crstoday.com/topics/general/hate-your-ehr-system/43066/
- **OHSU の監査ログ研究**(Ophthalmology Science 2021、約3万件の受診)
  - 記載時間はスクライブなし 7.6分、スクライブあり 4.7分。ただしスクライブありでは受診時間が+2.9分、チャートを閉じるまでが+3.0時間、ノートも長くなった。
  - 示唆: 「入力を誰かに肩代わりさせる」だけでは解決しない。
  - https://pmc.ncbi.nlm.nih.gov/articles/PMC8765735

---

## 4. 総合

### 4.1 必須(table stakes)の UI パターン

| # | パターン | 具体的な仕様の目安 | 根拠 |
|---|---|---|---|
| T1 | **常時表示の患者ヘッダ** | 氏名・年齢・ID・アレルギーと感染症・主病名・**目標眼圧**・直近の手術(眼別) | 京都市立病院 2-8-5、Review of Ophthalmology |
| T2 | **右眼と左眼を常に同じ位置に並べる** | 日本では右を上(行)または左(列)。全画面で統一する | 日本眼科医会 眼鏡処方箋様式、京都市立病院 2-5-3、新潟大学 連携パス |
| T3 | **検査値の左右2列グリッド** | 視力(裸眼・矯正・レンズ)、眼圧(値・方法・時刻)、レフケラ | 京都市立病院 2-5-3、Eyefinity |
| T4 | **前回値を並べて表示、または pull forward** | 現在値の入力欄の横に前回値を薄く表示。「前回をコピー」は項目単位でも一括でもできる | ModMed、RevolutionEHR、Eyefinity Refraction History、京都市立病院 2-3-5 / 2-8-4 |
| T5 | **右眼→左眼コピー** | ボタン1つ | ModMed、Eyefinity |
| T6 | **「異常なし」の一括入力** | 前眼部・中間透光体・眼底をまとめて n.p. にする | Eyefinity「Mark … Normal」 |
| T7 | **sticky な既定値** | 検査方法・視力表の種類・散瞳薬などは前回選んだものを保持 | Eyefinity、ModMed |
| T8 | **セット・テンプレート(科共通と個人用)** | 病名・処置・処方・検査・次回指示を1タップで入れる | CLIPLA、京都市立病院 2-4、ModMed Protocols |
| T9 | **視力と眼圧の推移グラフ** | 眼圧グラフに点眼や手術のイベントを重ねる | 京都市立病院 1-5-8 / 2-5-4、Nextech Glaucoma Flowsheet |
| T10 | **シェーマ** | 下絵を選ぶ、よく使うものを優先表示、筆圧、色とペン幅、オブジェクトとして編集、**前回の図をコピー** | 京都市立病院 2-3、CLIPLA、NAVIS-CL |
| T11 | **機器取り込み** | レフケラ・NCT・眼軸長などを1クリックで取り込む。左右(L/R)は自動で付く | CLIPLA、京都市立病院 1-5、AAO |
| T12 | **受付・待ち一覧(ステータスボード)** | ステータスの列やカード、検査指示と終了状況、担当医や予約枠で絞り込むタブ、全端末にリアルタイム反映 | CLIPLA、京都市立病院 2-13、Epic Rooming |
| T13 | **眼鏡処方箋とCL処方箋** | 日本眼科医会の様式に合わせる | 日本眼科医会、京都市立病院 1-5-7、CLIPLA |
| T14 | **書きかけ保存と同時編集** | 検査員と医師が同じカルテを同時に開ける | CLIPLA、京都市立病院 2-1-12 |
| T15 | **完了の見える化** | 必須の検査が揃うとセクションの色が変わる | Eyefinity |

### 4.2 差別化になり、好評なパターン

| # | パターン | 内容 | 根拠 |
|---|---|---|---|
| D1 | **1画面完結**(タブ移動なし) | 検査・所見・印象・計画を縦に流れる1ページで書く | Nextech(ユーザーが称賛)、Compulink OneTab、ModMed 2023、CLIPLA「1画面完結」 |
| D2 | **1つの入力欄 + 3文字補完 + 部位の自動振り分け** | 「出血」と打つと部位ごとの候補が出る | ModMed 2023 |
| D3 | **学習するピッカー** | 医師ごとに、よく選ぶものを上に並べる | ModMed adaptive learning / sticky |
| D4 | **プロトコル**(印象→検査・処方・次回をまとめて入れる) | wet AMD を選ぶと OCT・注射・1か月後再診 | ModMed |
| D5 | **iPad・ペンでのタッチ記載** | ピンチズーム、スタンプ、描画を次回に持ち越す | ModMed(最も評価が高い)、エムスリー |
| D6 | **疾患別フローシート** | 緑内障: 眼圧・点眼・C/D・手術・目標眼圧帯・最新の検査日。抗VEGF: 注射回数 | Nextech、京都市立病院 2-7 |
| D7 | **レフケラをレシート形式で表示** | 見慣れた形で読み違いを減らす | CLIPLA |
| D8 | **暗室用ダークモード** | 細隙灯の横で眩しくない | CLIPLA |
| D9 | **紙の2号紙のような見開き + 自由配置** | 紙からの移行がしやすい | C-Note、京都市立病院 2-1-2 |
| D10 | **当日の検査から算定候補を自動で出す** | 検査を入れれば算定が埋まる | 京都市立病院 1-8-2 |
| D11 | **患者をまたいだ一括判読** | 当日の OCT・視野をまとめて判読する | Epic Imaging & Procedures Home |
| D12 | **院外や他院からの混雑状況の共有** | 分院の待ち人数がわかる | CLIPLA 事例 |

### 4.3 避けるべき典型的な不満(アンチパターン)

| # | 不満 | 出典 | 回避策 |
|---|---|---|---|
| C1 | **クリック過多、セクション間の遷移** | AAO 2015、KLAS(Nextech)、Capterra(RevolutionEHR / ModMed)、StudentDoctor | 1画面・縦スクロール、キーボードで連続入力、Save を不要にする(自動保存) |
| C2 | **ドロップダウン地獄** | Eyefinity の手順(推定25〜35操作) | よく使う値のタップピッカーとテンキー。ドロップダウンは最後の手段 |
| C3 | **描画が使いにくい**(マウス前提、色が少ない) | AAO 2011 / 2015、Review of Ophthalmology | ペン・タッチ前提、筆圧、10色以上、スタンプ、前回の図のコピー |
| C4 | **デバイス間の機能差**(iPad ではできない操作がある) | ModMed の最頻出の不満 | レスポンシブにして全機能を同じにする(Web の強み) |
| C5 | **入力したはずが消える、空で表示される** | RevolutionEHR | 自動保存と保存状態の表示、楽観ロックの競合を可視化 |
| C6 | **左クリックと右クリックの不統一など操作体系の混在** | G2(Nextech) | 一貫した操作体系。右クリック前提にしない |
| C7 | **ユーザー単位でカスタマイズできない** | AAO 2015 | 既定値・セット・並び順を個人ごとに設定できる |
| C8 | **機器と連携しない、二度打ち** | AAO 2011 / 2015 | 取り込み(アダプター)を優先する |
| C9 | **アップデートのたびに不具合** | Compulink(Capterra) | 回帰テストと段階リリース |
| C10 | **テンプレートの初期構築が重い** | Nextech、RevolutionEHR | 初期セットを同梱する(白内障・緑内障・ドライアイ・DR・結膜炎など) |
| C11 | **医師が患者に背を向けて打鍵する** | Review of Ophthalmology、CRST | タブレットで記載、音声、技師の事前入力 |
| C12 | **ノートが冗長になる**(コピペ・テンプレ由来) | OHSU 研究 | 「前回コピー」は差分をハイライトし、変化がない項目は1行に畳む |

### 4.4 日本固有の慣習(Halunasu で外せないもの)

| 項目 | 慣習 | 根拠・信頼度 |
|---|---|---|
| **左右の順序** | **右→左**。表なら右が上の行、横に並べるなら右が左の列 | 日本眼科医会 眼鏡処方箋(右の行が上、軸度の確認図も右が左)[一次]。新潟大学 連携パス「右=…、左=…」[一次] |
| **シェーマの向き** | 患者に向き合った視点で描く(患者の右眼が画面の左) | 一般的な慣習 [未検証]。眼鏡処方箋の図の配置は整合する |
| **視力表記** | 小数視力(0.1〜2.0)。例: `RV=0.1(1.2×S-3.00D=C-0.75D Ax180°)`。矯正不能は `(n.c.)`。0.1未満は 0.09〜0.01、指数弁(n.d./CF)、手動弁(m.m./HM)、光覚弁(s.l./LP)、光覚なし | 小数表記は https://kotobank.jp/word/視力検査 [二次]。具体的な書式・n.c.・n.d. などは**慣習 [未検証]**。行政様式も「裸眼・矯正 ×(  )D」の欄構成 https://www.pref.kanagawa.jp/documents/30961/003shikaku.pdf |
| **視力入力 UI への落とし込み** | 小数の階段(0.01…0.1, 0.2…1.0, 1.2, 1.5, 2.0)をタップで選ぶ。矯正レンズは S/C/Ax をテンキーで入れ、0.25D 刻みで +/− ボタン。「×」のあとにレンズ、「=」で円柱をつなぐ表記を自動生成する | 筆者の提案 |
| **眼圧** | 値に加えて**測定方法(ノンコン/アプラネーション/アイケア)**と**測定時刻**。**目標眼圧**も記載する | 新潟大学 緑内障連携パス [一次] https://www.med.niigata-u.ac.jp/oph/wp-content/uploads/2021/10/緑内障連携パス_ver2.pdf。測定方法で値が系統的に違う(NCT は GAT より低いなど): https://ir.lib.hiroshima-u.ac.jp/44566/files/12360 |
| **2号紙** | 療担規則の診療録様式。左欄が「既往症・原因・主要症状・経過等」、右欄が「処方・手術・処置等」の見開き | 様式番号には資料によって揺れがある(一般に様式第一号(一)の2とされる)https://kouseikyoku.mhlw.go.jp/tohoku/news/000269416.pdf 。眼科製品でも「見開き」「2号紙イメージ」が要求されている(京都市立病院 2-1-2、C-Note)[一次] |
| **眼鏡処方箋** | 日本眼科医会の様式: I. レンズ種類(素材・焦点・コート・カラー)/ II. レンズ値(**右・左 × 球面・円柱・軸度・加入度・プリズム・基底方向・瞳孔距離**)、軸度と基底の確認図 / III. 用法(遠用・近用・遠近、常時・必要時)/ IV. 有効期間 5・10・30日 / V. 頂間距離12mm、多焦点のPDは遠用基準 / VI. 特記 | https://production.gankaikai.or.jp/for-medical-personnel/jutsu/detail2/__icsFiles/afieldfile/2024/10/17/glasses_prescription.pdf [一次] |
| **CL処方** | 登録したレンズ一覧(銘柄・BC・DIA・度数)から選ぶ | CLIPLA [宣伝] |
| **点眼処方** | 左右の指定(両眼/右眼/左眼)が必須。残薬で継続する場合は「0日」で記録 | CLIPLA [宣伝]。左右指定は慣習 [未検証] |
| **次回指示** | 次回の検査セットをグリッドで指示し、前回からコピーする。受付指示票に前回の検査情報を印字 | 京都市立病院 2-8、2-11-3 [一次] |
| **検査員(視能訓練士)と医師の分担** | 視能訓練士が視力・屈折・眼圧・視野などを先に入力し、医師は診察室で確認して所見・処方を入れる。受付一覧に「検査指示と終了状況」を出す | 京都市立病院 2-13-4、CLIPLA の検査員用 iPad 機能、Epic Tech Work List |
| **紙からの段階的な移行** | 再診の紙カルテと並行して運用する期間が長い | 佐賀大学 [学会抄録]、横浜鶴見中央眼科 [事例] |

### 4.5 「よくある再診」の目標手数(筆者の提案。競合の実測値ではない)

**競合の再診1件あたりのタップ数は公開情報で確認できなかった。** 参考になるのは Eyefinity の手順から筆者が数えた値と、ModMed の「経過観察は数クリック」という宣伝文句だけ。

Halunasu の設計目標として、次の値を提案する。

| 役割 | 作業 | 目標 |
|---|---|---|
| 検査員 | 視力(左右・裸眼・矯正)と眼圧の取り込み・確認 | **8タップ以内** |
| 医師 | 前回コピー → 変化した点だけ修正 → セットで処方・次回指示 → 確定 | **5〜10タップ以内**、所見の自由入力1行 |

これを Playwright などで計測できる回帰指標にしておくとよい。

---

## 5. 確認できなかったこと、今後の調査の提案

1. NAVIS-CL、IMAGEnet eカルテ、Medius、eyemet's の**実際の画面**: 展示会(日本眼科学会総会や日本臨床眼科学会の機器展示)、販売代理店のデモ、YouTube の非公式デモで確認する。
2. 日本の眼科医のナマの不満: m3.com 掲示板やクローズドのコミュニティ。公開 Web には**ほぼない**。今回の検索でも見つからなかった。
3. Epic Kaleidoscope の視力・眼圧グリッドの具体像(UserWeb が必要)。
4. Reddit r/Ophthalmology・r/optometry のスレッド: 検索に出ず、未確認。
5. ModMed のタップ数の実測(動画をコマ送りで数えるなど)。
6. **右眼を赤、左眼を青とする配色**: 日本でも海外でも根拠は見つからなかった。採用するなら色だけで区別せず「R/L」ラベルと位置を併用し、設定で変えられるようにすることを推奨する。

---

## 6. 出典一覧(主要)

**日本**
- 京都市立病院 眼科カルテシステム機能仕様書: https://www.kch-org.jp/wp-content/uploads/2022/03/2d245f88d0972cb80545103558b00b98-5.pdf
- CLIPLA Eye 特長・機能: https://clipla.jp/eye/service/ 、 https://clipla.jp/eye/
- 横浜鶴見中央眼科 事例: https://www.it-hojo.jp/h30/doc/pdf/h30_medical_tsurumityuoganka.pdf
- 眼科電子カルテ比較(ITトレンド): https://it-trend.jp/emr/article/comparison_ophthalmology
- 眼科電子カルテ比較(shopowner-support): https://www.shopowner-support.net/?p=165725
- 眼科電子カルテ比較(meetsmore): https://meetsmore.com/product-services/electronic-karte/media/179598
- DONUTS × NIDEK 協業: https://donuts.ne.jp/wp-content/uploads/2024/11/PRESSRELEASE-241111_clius_nidek.pdf
- NAVIS-EX FDA: https://fda.innolitics.com/device/K181345
- C-Note(innervision): https://innervision.co.jp/03book/buhin2013/pdf/2-40.pdf
- 日本眼科医会 眼鏡処方箋様式: https://production.gankaikai.or.jp/for-medical-personnel/jutsu/detail2/__icsFiles/afieldfile/2024/10/17/glasses_prescription.pdf
- 新潟大学 緑内障連携パス: https://www.med.niigata-u.ac.jp/oph/wp-content/uploads/2021/10/緑内障連携パス_ver2.pdf
- 佐賀大学 臨床眼科 2011: https://webview.isho.jp/journal/detail/abs/10.11477/mf.1410103670
- 臨床眼科 2006: https://webview.isho.jp/journal/detail/abs/10.11477/mf.1410100955

**海外**
- ModMed exam: https://www.modmed.com/ophthjourney/exam/
- ModMed 動画: https://modmed.com/resources/videos/documenting-eye-exam-ophthalmology-ehr
- Ophthalmology Times(ModMed 2023): https://www.ophthalmologytimes.com/view/aao-2023-simplifying-the-charting-process-with-modmed-s-new-initiative
- Ophthalmology Times(ModMed 医師寄稿): https://www.ophthalmologytimes.com/view/intuitive-emr-platform-adapts-ophthalmic-workflow
- Capterra ModMed: https://capterra.com/p/124590/EMA/reviews/
- Epic Kaleidoscope(アイオワ大学): https://epicsupport.sites.uiowa.edu/node/806
- Nextech KLAS: https://klasresearch.com/comments/nextech-intellechartpro-ehr/212668
- Nextech Glaucoma Flowsheet: https://www.biospace.com/nextech-announces-new-glaucoma-flowsheet
- Compulink: https://www.compulinkadvantage.com/ophthalmology/ 、 https://www.capterra.com/p/209707/Compulink-Healthcare-Solutions/reviews/
- Eyefinity ヘルプ: https://help.eyefinity.com/eehr/Browser/visit/vision-pretesting.htm 、 https://help.eyefinity.com/eehr/Browser/visit/vision-refractions.htm 、 https://help.eyefinity.com/eehr/Browser/Performing_a_Routine_Vis.htm
- RevolutionEHR: https://www.capterra.com/p/124589/RevolutionEHR/reviews/ 、 https://insight.revolutionehr.com/?p=4376
- AAO EHR 調査 2015: https://aao.org/Assets/7f1c2664-409b-4875-bc94-8850f210f1d3/635810291917200000/november-2015-practice-perfect-pdf
- AAO 特別要件の報道: https://www.eweek.com/news/ehrs-fall-short-for-eye-doctors-report/
- Review of Ophthalmology: https://www.reviewofophthalmology.com/article/glaucoma-and-ehr-perfect-together
- CRST: https://crstoday.com/topics/general/hate-your-ehr-system/43066/
- OHSU スクライブ研究: https://pmc.ncbi.nlm.nih.gov/articles/PMC8765735
- StudentDoctor(スニペットのみ): https://forums.studentdoctor.net/threads/emrs.1431955
