#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_URL="${AIVIS_ENGINE_URL:-http://127.0.0.1:10101}"
OUT_DIR="${AIVIS_OUT_DIR:-$ROOT_DIR/audio/generated/aivis}"
WORK_DIR="${AIVIS_WORK_DIR:-/tmp/medical-audio-treatment-build/aivis}"
VARIANT_SLUG="morioki-aida-calm"
SELECTED_SCENARIOS=("$@")

mkdir -p "$OUT_DIR" "$WORK_DIR"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

require_tool curl
require_tool jq
require_tool ffmpeg

if ! curl -fsS "$ENGINE_URL/version" >/dev/null 2>&1; then
  echo "AivisSpeech Engine is not reachable at $ENGINE_URL" >&2
  echo "Start AivisSpeech first, then rerun this script." >&2
  exit 1
fi

MORIOKI_MODEL_UUID="baaae3c0-7b22-4605-8ba5-80c959b41a48"
AIDA_MODEL_UUID="47e53151-a378-46f3-abee-ce13aa07feb1"

ensure_model_installed() {
  local model_uuid="$1"

  if curl -fsS "$ENGINE_URL/aivm_models" | jq -e --arg model_uuid "$model_uuid" 'has($model_uuid)' >/dev/null 2>&1; then
    return
  fi

  echo "Installing model $model_uuid..." >&2
  curl -fsS -X POST \
    -F "url=https://api.aivis-project.com/v1/aivm-models/${model_uuid}/download?model_type=AIVMX" \
    "$ENGINE_URL/aivm_models/install" >/dev/null
}

speaker_style_id() {
  local speaker_name="$1"
  local style_name="$2"

  curl -fsS "$ENGINE_URL/speakers" \
    | jq -r --arg speaker_name "$speaker_name" --arg style_name "$style_name" '
        .[]
        | select(.name == $speaker_name)
        | .styles[]
        | select(.name == $style_name)
        | .id
      '
}

synth_segment() {
  local speaker_id="$1"
  local speed_scale="$2"
  local intonation_scale="$3"
  local pause_scale="$4"
  local pitch_scale="$5"
  local volume_scale="$6"
  local text="$7"
  local out_path="$8"
  local query_path="${out_path%.wav}.query.json"
  local tuned_query_path="${out_path%.wav}.tuned.json"

  curl -fsS -X POST \
    --get \
    --data-urlencode "text=$text" \
    --data "speaker=$speaker_id" \
    "$ENGINE_URL/audio_query" > "$query_path"

  jq \
    --argjson speed "$speed_scale" \
    --argjson intonation "$intonation_scale" \
    --argjson pause "$pause_scale" \
    --argjson pitch "$pitch_scale" \
    --argjson volume "$volume_scale" \
    '
      .speedScale = $speed
      | .intonationScale = $intonation
      | .pauseLengthScale = $pause
      | .pitchScale = $pitch
      | .volumeScale = $volume
      | .prePhonemeLength = 0.12
      | .postPhonemeLength = 0.18
    ' \
    "$query_path" > "$tuned_query_path"

  curl -fsS -X POST \
    -H "Content-Type: application/json" \
    --data-binary "@$tuned_query_path" \
    "$ENGINE_URL/synthesis?speaker=$speaker_id" > "$out_path"
}

should_build_dialogue() {
  local scenario_slug="$1"

  if (( ${#SELECTED_SCENARIOS[@]} == 0 )); then
    return 0
  fi

  local selected
  for selected in "${SELECTED_SCENARIOS[@]}"; do
    if [[ "$selected" == "$scenario_slug" ]]; then
      return 0
    fi
  done

  return 1
}

build_dialogue() {
  local scenario_slug="$1"
  local patient_speaker_id="$2"
  local patient_speed="$3"
  local patient_intonation="$4"
  local patient_pause="$5"
  local patient_pitch="$6"
  local patient_volume="$7"
  local doctor_speaker_id="$8"
  local doctor_speed="$9"
  local doctor_intonation="${10}"
  local doctor_pause="${11}"
  local doctor_pitch="${12}"
  local doctor_volume="${13}"
  shift 13

  if ! should_build_dialogue "$scenario_slug"; then
    return 0
  fi

  local scenario_dir="$WORK_DIR/${scenario_slug}_${VARIANT_SLUG}"
  local manifest="$scenario_dir/concat.txt"
  local silence_path="$scenario_dir/silence.wav"

  rm -rf "$scenario_dir"
  mkdir -p "$scenario_dir"
  : > "$manifest"

  ffmpeg -y -f lavfi -t 0.34 -i anullsrc=r=24000:cl=mono -c:a pcm_s16le "$silence_path" >/dev/null 2>&1

  local index=0
  while (( "$#" )); do
    local speaker="$1"
    local text="$2"
    shift 2

    local raw_segment="$scenario_dir/segment_$(printf '%02d' "$index").wav"
    local normalized_segment="$scenario_dir/segment_$(printf '%02d' "$index").norm.wav"

    if [[ "$speaker" == "patient" ]]; then
      synth_segment \
        "$patient_speaker_id" \
        "$patient_speed" \
        "$patient_intonation" \
        "$patient_pause" \
        "$patient_pitch" \
        "$patient_volume" \
        "$text" \
        "$raw_segment"
    else
      synth_segment \
        "$doctor_speaker_id" \
        "$doctor_speed" \
        "$doctor_intonation" \
        "$doctor_pause" \
        "$doctor_pitch" \
        "$doctor_volume" \
        "$text" \
        "$raw_segment"
    fi

    ffmpeg -y -i "$raw_segment" -ar 24000 -ac 1 "$normalized_segment" >/dev/null 2>&1
    printf "file '%s'\n" "$normalized_segment" >> "$manifest"
    if (( "$#" )); then
      printf "file '%s'\n" "$silence_path" >> "$manifest"
    fi
    index=$((index + 1))
  done

  ffmpeg -y -f concat -safe 0 -i "$manifest" -ar 24000 -ac 1 "$OUT_DIR/${scenario_slug}-${VARIANT_SLUG}.wav" >/dev/null 2>&1
}

ensure_model_installed "$MORIOKI_MODEL_UUID"
ensure_model_installed "$AIDA_MODEL_UUID"

PATIENT_MORIOKI="$(speaker_style_id "morioki" "ノーマル")"
DOCTOR_AIDA_CALM="$(speaker_style_id "阿井田 茂" "Calm")"

if [[ -z "$PATIENT_MORIOKI" || -z "$DOCTOR_AIDA_CALM" ]]; then
  echo "Failed to resolve one or more speaker/style IDs from the local AivisSpeech engine." >&2
  exit 1
fi

build_dialogue \
  "dm-followup" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.05" \
  "1.14" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.91" \
  "0.94" \
  "1.08" \
  "-0.02" \
  "1.00" \
  patient "ここ1か月、夕食が遅い日が続いていて、朝の血糖が140台の日が増えています。口の渇きも少しあります。" \
  doctor "食後の眠気や、夜中のトイレの回数はどうですか。薬の飲み忘れも確認させてください。" \
  patient "飲み忘れは月に1回あるかないかです。夜中のトイレは1回くらいで、前より少し増えた気がします。" \
  doctor "今回の HbA1c は 7.4 で、前回の 6.9 より上がっています。体重も 2 キロ増えているので、食事と運動の影響が大きそうです。" \
  patient "忙しくて歩けていないのと、帰りが遅い日にコンビニで甘い物を足してしまいます。" \
  doctor "まず夕食後の菓子を週2回までにして、食後10分でも歩きましょう。薬は今のままで、内服の時間だけ固定してください。" \
  patient "わかりました。家の血糖と体重をメモして持ってきた方がいいですか。" \
  doctor "はい、それがあると調整しやすいです。200 を超える値が続く、強い口渇やだるさが出る場合は次回を待たずに連絡してください。"

build_dialogue \
  "lipid-first" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.03" \
  "1.13" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.91" \
  "0.94" \
  "1.09" \
  "-0.02" \
  "1.00" \
  patient "健診でコレステロールが高いと言われて来ました。自覚症状はないんですが、放っておいて大丈夫か心配で。" \
  doctor "結果では LDL が 178 で、中性脂肪も少し高めです。ご家族に心筋梗塞や脳梗塞の方はいますか。" \
  patient "父が 62 歳で心筋梗塞になっています。私は夜遅くに食べることと、揚げ物が多いです。" \
  doctor "家族歴があるので、食事改善だけより薬を併用した方が安全です。筋肉痛が出やすい体質や、肝機能異常の指摘はありますか。" \
  patient "それは特にないです。お酒は週に3回、ビールを1本か2本くらいです。" \
  doctor "では少量のスタチンから始めましょう。揚げ物を減らして、夜食はできれば控えてください。飲酒は量を増やさなければ大丈夫です。" \
  patient "薬はずっと続けることになりますか。副作用が出たらどうしたらいいですか。" \
  doctor "まず2か月で採血を見ます。筋肉痛や濃い尿が出たら中止して連絡してください。その時点で量の調整や中止を判断します。"

build_dialogue \
  "allergic-rhinitis" \
  "$PATIENT_MORIOKI" \
  "0.96" \
  "1.05" \
  "1.12" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.92" \
  "0.95" \
  "1.08" \
  "-0.02" \
  "1.00" \
  patient "2週間前くらいから、くしゃみと鼻水が止まらなくて、夜も鼻づまりで何回か起きてしまいます。" \
  doctor "目のかゆみはありますか。熱や、のどの強い痛みがないかも確認させてください。" \
  patient "目も少しかゆいです。熱はなくて、風邪みたいなだるさはないです。" \
  doctor "症状の出方から花粉症が一番考えやすいです。市販薬は使いましたか。" \
  patient "飲みましたが、昼間すごく眠くなってしまって。仕事中につらかったです。" \
  doctor "眠気が出にくい内服に替えて、鼻づまりには点鼻薬を併用しましょう。帰宅後に顔を洗うのと、寝る前の洗鼻も役立ちます。" \
  patient "点鼻薬は毎日使っても大丈夫ですか。効くまでどれくらいかかりますか。" \
  doctor "用法通りなら問題ありません。数日から1週間で変わってくることが多いので、不十分なら次回さらに調整しましょう。"

build_dialogue \
  "gerd-followup" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.04" \
  "1.14" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.91" \
  "0.94" \
  "1.09" \
  "-0.02" \
  "1.00" \
  patient "食後に胸やけがして、横になると酸っぱいものが上がってくる感じがあります。最近は喉の違和感も少しあります。" \
  doctor "いつから続いていますか。体重減少、黒い便、飲み込みづらさはありませんか。" \
  patient "1か月くらい前からです。体重は変わらず、黒い便もないです。飲み込みにくさも今のところないです。" \
  doctor "強い警戒所見はなさそうです。夕食が遅いことや、コーヒー、脂っこい物は多いですか。" \
  patient "帰宅が遅くて夜10時過ぎに食べることが多いです。コーヒーは1日3杯くらい飲みます。" \
  doctor "胃酸を抑える薬を2週間使ってみましょう。食後すぐ横にならないことと、夜食とコーヒーを少し減らすのが大事です。" \
  patient "薬を飲めばすぐ良くなりますか。生活の工夫もかなり効きますか。" \
  doctor "数日で楽になることは多いですが、生活面もかなり重要です。改善しない、飲み込みづらい、体重が落ちる場合は胃カメラも検討します。"

build_dialogue \
  "acute-cystitis" \
  "$PATIENT_MORIOKI" \
  "0.96" \
  "1.05" \
  "1.13" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.92" \
  "0.94" \
  "1.09" \
  "-0.02" \
  "1.00" \
  patient "昨日から排尿のときにしみる感じがあって、何回もトイレに行きたくなります。下腹部も少し重いです。" \
  doctor "発熱や背中の痛みはありますか。尿に血が混じった感じはありませんでしたか。" \
  patient "熱はなくて、背中の痛みもないです。少し濁っている感じはありますが、真っ赤ではないです。" \
  doctor "膀胱炎の可能性が高そうです。最近、水分が少ないとか、トイレを我慢することはありましたか。" \
  patient "忙しくてあまり飲めていなくて、外出中は我慢することも多かったです。" \
  doctor "尿検査を確認して抗菌薬を出します。今日は水分をしっかり取って、できるだけ我慢しないようにしてください。" \
  patient "どれくらいで良くなりますか。仕事は普通にしていて大丈夫ですか。" \
  doctor "早ければ1日から2日で楽になります。熱が出る、背中が痛む、吐き気が出る場合は腎盂腎炎のことがあるので早めに受診してください。"

build_dialogue \
  "low-back-pain" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.04" \
  "1.14" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.91" \
  "0.94" \
  "1.09" \
  "-0.02" \
  "1.00" \
  patient "3日前に重い荷物を運んだあとから腰が痛くて、前かがみになると特に響きます。朝起きたときがいちばん固いです。" \
  doctor "足のしびれや力の入りにくさはありますか。排尿や排便の異常はありませんか。" \
  patient "しびれはなくて、足にも力は入ります。痛みは腰だけで、お尻から下には広がっていません。" \
  doctor "重い神経症状はなさそうです。筋肉や関節まわりの腰痛の可能性が高いです。発熱もないですね。" \
  patient "はい、熱はないです。仕事で座りっぱなしなのも関係ありますか。" \
  doctor "関係します。痛み止めを数日使って、無理のない範囲で歩いた方が回復は早いです。長時間同じ姿勢は避けてください。" \
  patient "安静にしすぎない方がいいんですね。湿布も使って大丈夫ですか。" \
  doctor "はい、湿布は併用して構いません。しびれが出る、歩きにくい、排尿排便に異常が出るときはすぐ再受診してください。"

build_dialogue \
  "insomnia-stress" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.03" \
  "1.13" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.90" \
  "0.94" \
  "1.10" \
  "-0.02" \
  "1.00" \
  patient "この1か月くらい寝つきが悪くて、夜中に2回くらい目が覚めます。朝もすっきりしません。" \
  doctor "気分の落ち込みや食欲低下はありますか。寝る前の飲酒やスマホの使用も教えてください。" \
  patient "食欲はありますが、疲れやすいです。寝る前にスマホを見て、そのまま缶ビールを飲む日があります。" \
  doctor "アルコールは寝つきを一時的に良くしても、途中で目が覚めやすくなります。仕事のストレスは最近強いですか。" \
  patient "人手が足りなくて残業が増えていて、頭が休まらない感じがあります。" \
  doctor "まず起きる時間を固定して、寝る1時間前は画面と飲酒を避けましょう。必要なら短期間だけ使う睡眠薬を少量使う方法もあります。" \
  patient "薬に頼りすぎるのは少し心配です。癖になったりしませんか。" \
  doctor "毎日ずっと使う前提ではなく、短期間で様子を見る形です。気分の落ち込みが強くなる、日中の支障が増える場合は早めに相談してください。"

build_dialogue \
  "two-minute-uri" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.05" \
  "1.14" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.91" \
  "0.94" \
  "1.08" \
  "-0.02" \
  "1.00" \
  patient "3日前から喉が痛くて、昨日から咳と鼻水が出ています。今朝は37度8分まで熱が上がりました。" \
  doctor "咳は乾いた咳ですか、それとも痰が絡みますか。息苦しさや胸の痛みも確認させてください。" \
  patient "最初は乾いた咳でしたが、今日は少し黄色っぽい痰が出ます。息苦しさや胸の痛みはありません。" \
  doctor "食事や水分は取れていますか。周りに同じような症状の方はいますか。" \
  patient "食欲は少し落ちていますが、水分は取れています。職場で風邪っぽい人が何人かいました。" \
  doctor "今のところ肺炎を強く疑う所見はなさそうですが、発熱と咳があるので感染症として対応しましょう。念のため酸素の値と胸の音も確認します。" \
  patient "インフルエンザやコロナの検査はした方がいいですか。" \
  doctor "発症からの時間を考えると検査はできます。結果で治療方針が変わる可能性があるので、今日は検査をしましょう。" \
  patient "検査の結果が陰性でも、周りにうつす可能性はありますか。家に高齢の母がいるので心配です。" \
  doctor "陰性でも一般的な風邪や他のウイルス感染はあります。数日はマスク、手洗い、換気を意識して、食器やタオルは分けましょう。" \
  patient "咳で夜に眠りづらい日があります。横になると少し咳き込みます。" \
  doctor "寝る前に水分を少し取り、上半身を少し起こすと楽になることがあります。咳止めは眠前にも使える形で出します。" \
  patient "薬はどんなものになりますか。仕事は休んだ方がいいですか。" \
  doctor "解熱鎮痛薬と咳止め、痰を出しやすくする薬を出します。熱がある間は休んでください。息苦しさ、胸痛、39度以上の熱が続く場合は早めに再受診してください。"

build_dialogue \
  "three-minute-hypertension" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.04" \
  "1.14" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.91" \
  "0.94" \
  "1.09" \
  "-0.02" \
  "1.00" \
  patient "家で血圧を測ると、朝が150台、夜が140台くらいの日が多いです。薬は毎日飲んでいます。" \
  doctor "測る時間は起床後と就寝前で固定できていますか。測る前に喫煙やコーヒーはありますか。" \
  patient "朝は起きてトイレに行ったあとに測っています。コーヒーはその後です。夜は帰宅後すぐ測ることもあります。" \
  doctor "夜は少し落ち着いてから測った方が安定します。頭痛、胸の痛み、息切れ、足のむくみはありますか。" \
  patient "頭痛はたまにありますが、強くはないです。胸の痛みや息切れ、むくみはありません。" \
  doctor "今日の診察室血圧は148の92です。家庭血圧も高めなので、今の薬だけでは少し足りない可能性があります。" \
  patient "最近、外食が多くて味の濃いものが続いています。運動もあまりできていません。" \
  doctor "塩分の影響はありそうです。汁物を残す、漬物や加工食品を減らす、外食では大盛りを避けるところから始めましょう。" \
  patient "薬を増やす必要がありますか。できれば生活で何とかしたい気持ちもあります。" \
  doctor "今すぐ大きく増やす必要はありませんが、数値は治療域です。今回は少量の薬を追加して、生活改善も同時に進めるのが安全です。" \
  patient "副作用はありますか。" \
  doctor "ふらつき、むくみ、動悸が出ることがあります。強い症状があれば中止せず、まず連絡してください。" \
  patient "家の血圧はどう記録すればいいですか。" \
  doctor "朝と夜に2回ずつ測って、平均に近い値をメモしてください。次回4週間後に手帳を見て、薬の量を調整しましょう。" \
  patient "食事は朝昼夜で、どこから変えるのが一番いいですか。" \
  doctor "まず朝食を抜かないことと、昼の麺類や丼ものを減らすことです。野菜やたんぱく質を先に食べる形にしましょう。" \
  patient "仕事中はついカップ麺やコンビニ弁当が多くなります。" \
  doctor "カップ麺は汁を残しても塩分が多めです。選ぶならサラダ、ゆで卵、焼き魚、豆腐などを足して、味の濃いおかずを減らしましょう。" \
  patient "睡眠時間も関係しますか。最近は5時間くらいの日が多いです。" \
  doctor "睡眠不足は血圧を上げやすくします。まず就寝時刻を30分だけ早める日を週に数回作るところから始めましょう。" \
  patient "目標の血圧はどれくらいですか。" \
  doctor "家庭血圧ではまず135未満を目指します。急に下げるより、記録を見ながら安全に調整します。" \
  patient "わかりました。急に病院に来た方がいい症状はありますか。" \
  doctor "強い胸痛、片側の手足の動かしにくさ、ろれつが回らない、激しい頭痛があれば救急受診してください。"

build_dialogue \
  "four-minute-abdominal-pain" \
  "$PATIENT_MORIOKI" \
  "0.95" \
  "1.04" \
  "1.14" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.91" \
  "0.94" \
  "1.09" \
  "-0.02" \
  "1.00" \
  patient "昨日の夜からお腹が痛くて、下痢が5回くらいあります。今朝も水っぽい便が出ました。" \
  doctor "痛みはお腹のどのあたりですか。ずっと痛いのか、波があるのかも教えてください。" \
  patient "おへその周りから下腹部にかけてです。ずっと重い感じがあって、時々きゅっと痛みます。" \
  doctor "吐き気や嘔吐、発熱はありますか。便に血が混じる感じはありませんか。" \
  patient "吐き気は少しありますが、吐いてはいません。熱は37度3分くらいで、血は見えていません。" \
  doctor "昨日から今日にかけて、生ものや普段と違う食事はありましたか。周囲に同じ症状の人はいますか。" \
  patient "昨日の昼に鶏肉の定食を食べました。家族は同じものを食べていないので、周りに同じ症状はいません。" \
  doctor "水分は取れていますか。尿の回数が減った、口が乾く、立つとふらつく感じはありますか。" \
  patient "水は飲めていますが、食事はあまり取れていません。尿は少し少ない気がします。立つと少しふらっとします。" \
  doctor "脱水が少しありそうです。お腹を診察して、強い圧痛や反跳痛がないか確認します。今の話では感染性胃腸炎が考えやすいですが、虫垂炎なども見逃さないようにします。" \
  patient "検査は必要ですか。" \
  doctor "強い腹膜刺激症状がなければ、今日は血液検査までは必須ではありません。ただ、痛みが右下腹部に移る、熱が上がる、血便が出る場合は検査が必要です。" \
  patient "薬は下痢止めを飲んでもいいですか。" \
  doctor "血便や高熱がある時は強い下痢止めは避けます。今回は整腸剤と吐き気止めを中心にして、脱水予防を優先しましょう。" \
  patient "食事はどうすればいいですか。" \
  doctor "今日は経口補水液や薄い味噌汁などで水分と塩分を取ってください。食べられるようなら、おかゆ、うどん、バナナなど消化の良いものにしましょう。" \
  patient "仕事は行かない方がいいですか。" \
  doctor "下痢が続いている間は無理しないでください。食品を扱う仕事なら特に休んだ方が安全です。" \
  patient "市販の痛み止めは飲んでもいいですか。" \
  doctor "胃腸が弱っている時は薬で悪化することがあります。今回は自己判断で強い痛み止めを足さず、処方薬を使って様子を見てください。" \
  patient "家族にうつる可能性はありますか。小さい子どもがいます。" \
  doctor "感染性胃腸炎ならうつることがあります。トイレ後の手洗い、タオルの共有を避けること、便で汚れた場所の消毒を意識してください。" \
  patient "水分は一度にたくさん飲んだ方がいいですか。" \
  doctor "一度に多く飲むと吐き気が強くなることがあります。少量をこまめに、5分から10分おきに飲む方が続けやすいです。" \
  patient "痛みが右下に移るというのは、どんな感じなら危ないですか。" \
  doctor "右下腹部を押すと強く痛む、歩くと響く、咳でお腹に響く、熱が上がる場合は虫垂炎なども考えるので早めに連絡してください。" \
  patient "明日も下痢が続いたら、すぐ来た方がいいですか。" \
  doctor "回数が減って水分が取れていれば様子を見られます。悪化する、尿が出ない、血便がある、強い腹痛がある時は早めに受診してください。" \
  patient "吐き気が強くなって薬が飲めない場合はどうしたらいいですか。" \
  doctor "水分も薬も入らない状態が続くなら点滴が必要になることがあります。半日以上続く時は我慢せず連絡してください。" \
  patient "どのくらいで良くなりますか。" \
  doctor "多くは1日から3日で改善します。水分が取れない、尿が半日以上出ない、強い腹痛、血便、38度以上の熱が続く場合は早めに受診してください。"

build_dialogue \
  "five-minute-diabetes-complex-followup" \
  "$PATIENT_MORIOKI" \
  "0.94" \
  "1.03" \
  "1.14" \
  "0.00" \
  "1.00" \
  "$DOCTOR_AIDA_CALM" \
  "0.90" \
  "0.94" \
  "1.10" \
  "-0.02" \
  "1.00" \
  patient "今日は糖尿病の定期受診です。最近、朝の血糖が少し高くて、140から160くらいの日があります。" \
  doctor "食後の血糖や、低血糖のような冷や汗、手の震え、強い空腹感はありましたか。" \
  patient "低血糖っぽい感じはありません。食後はあまり測れていませんが、夕食が遅い日の翌朝は高いです。" \
  doctor "内服は毎日飲めていますか。飲む時間がずれることはありますか。" \
  patient "飲み忘れはほとんどありません。ただ、夜の薬は帰宅が遅くなると深夜近くになることがあります。" \
  doctor "今回の HbA1c は7.3です。前回が7.0だったので少し上がっています。体重は1.5キロ増えています。" \
  patient "年度末で残業が増えて、夕食が22時過ぎになる日が多かったです。コンビニで麺類とおにぎりを一緒に買うこともあります。" \
  doctor "炭水化物が重なっているのと、食事時間が遅い影響がありそうです。運動はできていますか。" \
  patient "以前は週に2回歩いていましたが、最近はほとんどできていません。休日も疲れて寝てしまいます。" \
  doctor "血圧手帳を見ると、朝が145前後で、夜は135前後ですね。塩分が多い食事や外食も増えていますか。" \
  patient "はい、ラーメンや丼ものが多いです。汁は残すようにしていますが、完全にはできていません。" \
  doctor "LDLコレステロールは112で、前回より少し下がっています。脂質の薬は効いています。筋肉痛や濃い尿はありませんか。" \
  patient "それはありません。薬の副作用らしいものは特に感じていません。" \
  doctor "目のかすみ、足のしびれ、傷が治りにくい感じはありますか。" \
  patient "目のかすみは疲れた時に少しあります。足のしびれはありません。傷も特にないです。" \
  doctor "眼科の糖尿病チェックはいつ受けましたか。" \
  patient "半年前くらいです。次はまだ予約していません。" \
  doctor "年1回は必要なので、次回までに予約しておきましょう。腎機能と尿検査は今日確認します。" \
  patient "薬は増えますか。できれば増やしたくないですが、数値が悪いなら仕方ないと思っています。" \
  doctor "いきなり大きく増やすより、まず夕食の炭水化物を重ねないこと、食後10分歩くこと、夜の薬の時間を固定することを優先しましょう。ただし血圧は少し高いので、降圧薬は少量調整します。" \
  patient "糖尿病の薬は今回はそのままですか。" \
  doctor "はい、今回は糖尿病薬はそのままにします。4週間から6週間で生活の変化を見て、HbA1cの流れで追加を考えます。" \
  patient "食事で具体的に何を変えるのが一番効果的ですか。" \
  doctor "夜遅い日は、麺とおにぎりを両方にしないことです。麺ならおにぎりをやめる、おにぎりならサラダチキンや豆腐を足す形にしましょう。" \
  patient "運動はどのくらい必要ですか。" \
  doctor "まず毎日でなくていいです。夕食後に10分歩く日を週4回作りましょう。雨の日は室内で足踏みでも構いません。" \
  patient "家で測るものは血糖と血圧の両方ですか。" \
  doctor "可能なら朝の血糖を週3回、血圧は朝晩で記録してください。全部できなくても、続けられる範囲で大丈夫です。" \
  patient "仕事が忙しい時に全部やろうとすると続かない気がします。" \
  doctor "完璧にやる必要はありません。まず血圧は週3日、血糖も週3回で構いません。記録が空いた日があっても再開できれば十分です。" \
  patient "夜の薬を飲む時間は、夕食が遅い日でも同じ方がいいですか。" \
  doctor "できるだけ時間をそろえます。夕食がかなり遅い日は、薬の種類によって調整が必要なので、今日の処方に合わせた飲み方を紙に書いて渡します。" \
  patient "次回までの目標は何を一番優先すればいいですか。" \
  doctor "夜の炭水化物を重ねないこと、食後10分歩くこと、血圧と血糖を週3回以上記録することです。次回はその3点を見て薬を調整します。" \
  patient "受診を早めた方がいい時はありますか。" \
  doctor "血糖が250を超える日が続く、強い口渇や体重減少がある、胸痛や息切れがある、血圧が180を超えて頭痛が強い場合は早めに連絡してください。" \
  patient "わかりました。次回はいつ来ればいいですか。" \
  doctor "6週間後にしましょう。採血と尿検査の結果を見て、糖尿病薬と血圧薬の調整を決めます。"

echo "Generated treatment audio files in $OUT_DIR"
