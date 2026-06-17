// コア2機能(カルテ自動作成 / 診療報酬算定)の処理パイプラインを
// 「人にわかりやすく」説明するためのキュレーション型データ。
// コード走査(/api/architecture)とは別レイヤー。sourceFile は実コードへのリンクに使う。
//
// step.kind: frontend | llm | deterministic | master | engine | store | review
//   frontend     … 画面/UI
//   llm          … LLM(OpenAI)による生成・抽出(=「事実」を取り出す層)
//   deterministic… 決定論ロジック(=「判定」を下す層)
//   master       … 算定マスタ参照
//   engine       … 計算エンジン
//   store        … 永続化(Firestore等)
//   review       … 人による確認・確定

export const KIND_META = {
  frontend: { label: "画面", color: "#818cf8" },
  llm: { label: "LLM", color: "#f472b6" },
  deterministic: { label: "決定論", color: "#34d399" },
  master: { label: "マスタ", color: "#fbbf24" },
  engine: { label: "計算エンジン", color: "#38bdf8" },
  store: { label: "保存", color: "#a78bfa" },
  review: { label: "確認", color: "#fb923c" },
};

export const CORE_FLOWS = {
  fee: {
    id: "fee",
    title: "診療報酬算定",
    tagline: "カルテ(SOAP)から算定点数を組み立てる",
    summary:
      "医師が書いたカルテ本文(SOAP)を入力に、AIが「診療で何をしたか」という事実だけを構造化して取り出し、" +
      "その事実をもとに決定論ロジックが算定マスタを引き当て、計算エンジンが点数を算出します。" +
      "最後に医療事務が要確認項目をレビューして確定します。",
    principle:
      "「事実はLLM・判定は決定論」は設計思想です。ただし実態の事実抽出はLLM単独ではありません。" +
      "LLMの前段に決定論的なNLP前処理(セクション分割・否定/時制の手がかり抽出・概念候補・チェックリスト生成)が走ってLLMを補助し、" +
      "LLMが使えない/失敗したときは正規表現ベースのルール抽出に全面フォールバックします。" +
      "一方で点数を算定して良いか・いくらかの判断(Step5以降)はAIに任せず、再現性のあるロジックで決めます。",
    steps: [
      {
        no: 1,
        title: "カルテ入力(SOAP)",
        kind: "frontend",
        actor: "fee-web",
        oneLiner: "セッション画面でカルテ本文・受診日・患者/施設を入力する。",
        input: "医師のSOAPカルテ本文、受診日、患者・施設・診療科",
        output: "算定対象のセッション(計算リクエスト)",
        detail: [
          "診療報酬算定は1回の受診=1セッションを単位に進めます。利用者(医療事務)はセッション画面でカルテ本文を貼り付け、受診日・患者・施設・診療科を選びます。",
          "ここで確定する受診日・施設・患者の保険などは、後段の初再診判定や負担金計算の前提になるため、受診時点の値としてセッションに固定されます。",
        ],
        sourceFile: "apps/fee-web/app/sessions/[sessionId]/page.js",
      },
      {
        no: 2,
        title: "NLP前処理(決定論)",
        kind: "deterministic",
        actor: "fee-api(buildClinicalTextPreprocessing)",
        oneLiner: "LLMに渡す前に、カルテ本文を正規表現ベースで構造化・注釈づけする。",
        input: "SOAPカルテ本文(正規化済みテキスト)",
        output: "行単位の前処理結果(preprocessedLines)・チェックリストメニュー",
        detail: [
          "LLMを呼ぶ前に決定論的なNLP前処理が必ず走ります。具体的には ①S/O/A/Pのセクション分割、②行ごとの手がかり抽出(clinicalLineCues:否定『未実施/施行せず/中止』、未来・予定のみ、過去・院外、現在受診の根拠、メタ文の判定)、③概念候補の抽出、④チェックリストメニュー生成 です。",
          "これらの前処理結果(preprocessedLines / checklistMenu)はそのままLLMのプロンプトに渡され、抽出精度を底上げします。つまりLLMは“素のカルテ”ではなく“前処理済みの構造”を見ます。",
        ],
        sourceFile: "services/fee-api/src/clinical-calculation-input.js",
      },
      {
        no: 3,
        title: "事実抽出(分岐あり)",
        kind: "llm",
        actor: "fee-api → OpenAI / ルールベース抽出器",
        oneLiner: "前処理済みカルテから「診療で起きた事実」を取り出す。経路は状況で分岐する。",
        input: "preprocessedLines・checklistMenu・セッション文脈",
        output: "clinical_events / visit_facts / checklist_findings(構造化された事実)",
        detail: [
          "事実抽出はLLM単独ではなく、状況に応じて経路が分岐します(buildClinicalCalculationPreparation)。",
          "LLMが取り出すのは「何を実施したか(clinical_events)」「受診の属性(visit_facts)」「チェック観点の所見(checklist_findings)」という事実で、点数や算定可否は判断させません。",
          "LLMが成功した場合でも、客観(O)所見に対する決定論的な補完抽出(画像・入院基本料)が併走し、LLM結果とマージされます(objective_supplement)。",
        ],
        branches: [
          { cond: "claimContext / 手動指定あり", path: "抽出をスキップし手動オプションを使用(source: manual)" },
          { cond: "LLM成功", path: "LLM構造化抽出 + 客観所見の決定論補完をマージ(source: openai + objective_supplement)" },
          { cond: "APIキー無し", path: "LLMを呼ばず、正規表現ベースのルール抽出に全面フォールバック(source: rules_no_openai)" },
          { cond: "LLM呼び出しが失敗", path: "ルール抽出にフォールバックし、警告を残す(source: fallback_rules)" },
        ],
        sourceFile: "packages/medical-core/src/fee/openai-fee-clinical-facts.js",
      },
      {
        no: 4,
        title: "決定論変換(事実 → 算定オプション)",
        kind: "deterministic",
        actor: "fee-api(clinicalFactsToCalculationOptions)",
        oneLiner: "抽出された事実を、再現性のあるルールで算定の入力条件へ変換する。",
        input: "clinical_events / visit_facts / checklist_findings(+ ルール抽出結果)",
        output: "calculationOptions(算定エンジンへの入力条件)",
        detail: [
          "clinicalFactsToCalculationOptions が、抽出された事実を「算定エンジンに渡す条件」へ機械的に変換します。ここからはAIを使わず、同じ入力なら必ず同じ出力になります。",
          "visit_facts の整合チェック(例:投薬の有無)や、受診履歴(priorSessions)からの初診/再診推定(inferOutpatientBasicFromPatientHistory)もこの層で行います。矛盾はトレースに残します。",
        ],
        sourceFile: "services/fee-api/src/clinical-calculation-input.js",
      },
      {
        no: 5,
        title: "算定マスタ検索",
        kind: "master",
        actor: "算定マスタ(SQLite)",
        oneLiner: "実施内容を、公的な算定マスタの正式コード・点数に引き当てる。",
        input: "算定オプション(実施内容)",
        output: "解決済みの診療行為コード・点数・算定ルール",
        detail: [
          "診療行為・医薬品・特定器材を、令和8(2026年)改定対応の算定マスタから正式コードと点数に引き当てます。マスタ検索は前処理/変換の段でも行われます。",
          "併算定不可(electronic_exclusions)・算定回数制限(frequency_limits)などのルールもマスタ側に持ち、後段の計算で参照します。",
        ],
        sourceFile: "python/medical_fee_calculation/master_browser.py",
      },
      {
        no: 6,
        title: "算定エンジン(点数計算)",
        kind: "engine",
        actor: "fee 計算エンジン(Python)",
        oneLiner: "コードと条件から、点数・加算・併算定/回数制限を計算する。",
        input: "解決済みコード・点数・算定ルール・受診条件",
        output: "計算結果(明細・合計点数・警告)",
        detail: [
          "引き当てたコードに、初再診・各種加算・併算定不可・同月回数制限などのルールを適用して点数を確定します。",
          "判断に必要な事実が足りない/競合する場合は、無理に確定せず警告(後段の要確認)として残し、過小・過大請求を断定しないように縮退します。",
        ],
        sourceFile: "python/medical_fee_calculation/worker.py",
      },
      {
        no: 7,
        title: "表示モデル生成",
        kind: "deterministic",
        actor: "fee-core",
        oneLiner: "計算結果を、画面で扱える3つの表示モデルに組み立てる。",
        input: "計算結果(明細・合計・警告)",
        output: "candidateWorkbench / receiptDraft / reviewIssues",
        detail: [
          "計算結果を、確認作業用の candidateWorkbench(算定候補)、receiptDraft(区分別のレセプト下書き)、reviewIssues(要確認項目)に整形します。",
          "これらは純粋な変換関数として fee-core にまとまっており、API・画面に依存せず単体でテストできます。",
        ],
        sourceFile: "packages/fee-core/src/index.js",
      },
      {
        no: 8,
        title: "レビュー & 確定",
        kind: "review",
        actor: "fee-web",
        oneLiner: "医療事務が要確認項目を見て、算定する/しないを確定する。",
        input: "candidateWorkbench / receiptDraft / reviewIssues",
        output: "確定したレセプト下書き・算定点数",
        detail: [
          "AIや決定論が確定しきれなかった項目は「要確認」として提示され、医療事務が算定する/算定しないを選んで最終確定します。要確認の分類自体も正規表現ベースのルール(reviewTopicCode)で行われます。",
          "確定結果はセッションに反映され、レセプト下書き・会計(窓口負担)などの後続に渡ります。",
        ],
        sourceFile: "apps/fee-web/components/fee-workspace.js",
      },
    ],
  },

  charting: {
    id: "charting",
    title: "カルテ自動作成",
    tagline: "診察の音声・メモからSOAPカルテを下書きする",
    summary:
      "診察中の音声(またはテキストメモ)を入力に、AIが文字起こしを行い、" +
      "その内容からSOAP形式のカルテ下書きを生成します。生成物は構造化して保存され、" +
      "最後に医師が編集・確定します。",
    principle:
      "AIが作るのはあくまで“下書き”です。文字起こし・SOAP生成はAIに任せますが、" +
      "医療記録としての確定は必ず医師が行う(Step5)前提で設計されています。",
    steps: [
      {
        no: 1,
        title: "音声 / テキスト入力",
        kind: "frontend",
        actor: "charting-web",
        oneLiner: "診察の音声を録音、またはメモを入力してセッションを開始する。",
        input: "診察の音声ストリーム、またはテキストメモ",
        output: "文字起こし対象のセッション",
        detail: [
          "医師は診察の様子を録音するか、メモを入力してカルテ作成セッションを始めます。音声は逐次サーバーへ送られます。",
        ],
        sourceFile: "apps/charting-web/app",
      },
      {
        no: 2,
        title: "文字起こし(音声 → テキスト)",
        kind: "llm",
        actor: "charting-gateway → OpenAI",
        oneLiner: "音声をAIで文字起こしし、発話テキストに変換する。",
        input: "音声(PCM)ストリーム",
        output: "発話テキスト(逐次 + 確定)",
        detail: [
          "音声はチャンク単位でAIの文字起こしモデルに送られ、リアルタイムの暫定テキストと、区切りごとの確定テキストを得ます。",
          "直前の発話をヒントに与えることで、固有名詞や医療用語の認識精度を上げています。",
        ],
        sourceFile: "services/charting-gateway/src/server.js",
      },
      {
        no: 3,
        title: "SOAP生成(テキスト → カルテ下書き)",
        kind: "llm",
        actor: "charting-gateway → OpenAI",
        oneLiner: "文字起こしから、SOAP形式のカルテ下書きをAIが生成する。",
        input: "確定した発話テキスト、フォーマット設定",
        output: "SOAP下書き(S/O/A/P)",
        detail: [
          "文字起こし結果を入力に、施設ごとのフォーマット設定に沿ってSOAP(主観/客観/評価/計画)形式の下書きを生成します。",
          "生成は段階的にプレビュー表示され、確定前でも内容を確認できます。",
        ],
        sourceFile: "services/charting-gateway/src/server.js",
      },
      {
        no: 4,
        title: "構造化 & 保存",
        kind: "store",
        actor: "charting-gateway → Firestore",
        oneLiner: "生成したSOAPと発話を構造化し、セッションに永続化する。",
        input: "SOAP下書き、文字起こし、メタ情報",
        output: "保存済みのカルテセッション",
        detail: [
          "SOAP下書き・文字起こし・生成のメタ情報を構造化してFirestoreに保存します。再開や履歴参照、後からの再生成に使えます。",
        ],
        sourceFile: "services/charting-gateway/src/server.js",
      },
      {
        no: 5,
        title: "編集 & 確定",
        kind: "review",
        actor: "charting-web",
        oneLiner: "医師が下書きを編集し、カルテとして確定する。",
        input: "SOAP下書き",
        output: "確定したカルテ",
        detail: [
          "AIが作るのは下書きまで。医師が内容を編集・修正し、医療記録として確定します。確定したカルテが診療報酬算定の入力にもなります。",
        ],
        sourceFile: "apps/charting-web/app",
      },
    ],
  },
};
