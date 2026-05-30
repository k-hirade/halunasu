# Audio Treatment

`audio_treatment` は、診療デモ向けの追加音声と台本をまとめるディレクトリです。

構成:

- `docs/voice-scripts.md`
  7本分の台本
- `docs/timed-voice-scripts.md`
  2分、3分、4分、5分の速度検証用台本
- `scripts/generate_treatment_audio_aivis.sh`
  AivisSpeech を使って WAV を生成するスクリプト
- `audio/generated/aivis/`
  生成済みの WAV 出力先

生成方法:

```bash
# 先に AivisSpeech.app を起動
zsh audio_treatment/scripts/generate_treatment_audio_aivis.sh
```

特定の台本だけ再生成する場合:

```bash
zsh audio_treatment/scripts/generate_treatment_audio_aivis.sh two-minute-uri three-minute-hypertension
```

前提:

- AivisSpeech Engine が `http://127.0.0.1:10101` で動作している
- 必要ツール: `curl`, `jq`, `ffmpeg`
- 患者役は `morioki / ノーマル`
- 医師役は `阿井田 茂 / Calm`

出力ファイル:

- `dm-followup-morioki-aida-calm.wav`
- `lipid-first-morioki-aida-calm.wav`
- `allergic-rhinitis-morioki-aida-calm.wav`
- `gerd-followup-morioki-aida-calm.wav`
- `acute-cystitis-morioki-aida-calm.wav`
- `low-back-pain-morioki-aida-calm.wav`
- `insomnia-stress-morioki-aida-calm.wav`
- `two-minute-uri-morioki-aida-calm.wav`
- `three-minute-hypertension-morioki-aida-calm.wav`
- `four-minute-abdominal-pain-morioki-aida-calm.wav`
- `five-minute-diabetes-complex-followup-morioki-aida-calm.wav`
