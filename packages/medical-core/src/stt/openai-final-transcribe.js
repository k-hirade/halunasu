import { buildMedicalTranscriptionPrompt, sanitizeTranscriptionText } from "./medical-transcription.js";

function encodePcm16ToWav({ pcmBuffer, sampleRateHz = 24_000, channels = 1 }) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRateHz * blockAlign;
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

async function parseJson(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function transcribePcmAudioWithOpenAi({
  apiKey,
  pcmBuffer,
  sampleRateHz = 24_000,
  channels = 1,
  model = "gpt-4o-mini-transcribe",
  language = "ja",
  basePrompt = "",
  sessionContext = {},
  transcriptHint = ""
}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  if (!pcmBuffer?.length) {
    throw new Error("No PCM audio was provided for final retranscription");
  }

  const wavBuffer = encodePcm16ToWav({
    pcmBuffer,
    sampleRateHz,
    channels
  });

  const formData = new FormData();
  formData.set(
    "file",
    new Blob([wavBuffer], { type: "audio/wav" }),
    "encounter.wav"
  );
  formData.set("model", model);
  formData.set("language", language);
  formData.set(
    "prompt",
    buildMedicalTranscriptionPrompt({
      basePrompt,
      sessionContext,
      transcriptHint
    })
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  const payload = await parseJson(response);

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || payload?.raw || "unknown error";
    throw new Error(`OpenAI final retranscription failed (${response.status}): ${detail}`);
  }

  const rawText = payload?.text || payload?.raw || "";
  const text = sanitizeTranscriptionText(rawText);

  if (!text.trim()) {
    throw new Error("OpenAI final retranscription returned an empty transcript");
  }

  return {
    text: text.trim(),
    rawTextLength: String(rawText || "").trim().length,
    promptLeakStripped: text.trim().length !== String(rawText || "").trim().length,
    model,
    language
  };
}
