import fs from "node:fs/promises";
import path from "node:path";
import { transcribePcmAudioWithOpenAi } from "../packages/medical-core/src/stt/openai-final-transcribe.js";

function fail(message, error) {
  console.error(message);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function parseWavPcm16(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Unsupported WAV container");
  }

  let offset = 12;
  let channels = null;
  let sampleRateHz = null;
  let dataStart = null;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === "fmt ") {
      const format = buffer.readUInt16LE(chunkDataStart);
      channels = buffer.readUInt16LE(chunkDataStart + 2);
      sampleRateHz = buffer.readUInt32LE(chunkDataStart + 4);
      const bitsPerSample = buffer.readUInt16LE(chunkDataStart + 14);

      if (format !== 1 || bitsPerSample !== 16) {
        throw new Error("Only PCM16 WAV files are supported");
      }
    }

    if (chunkId === "data") {
      dataStart = chunkDataStart;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (dataStart == null || dataSize == null || !sampleRateHz || !channels) {
    throw new Error("Failed to parse WAV metadata");
  }

  return {
    pcmBuffer: buffer.subarray(dataStart, dataStart + dataSize),
    sampleRateHz,
    channels
  };
}

const filePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve("audio_treatment/audio/generated/aivis/acute-cystitis-morioki-aida-calm.wav");
const apiKey = process.env.OPENAI_API_KEY || "";
const model = process.env.OPENAI_FINAL_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
const language = process.env.OPENAI_FINAL_TRANSCRIBE_LANGUAGE || "ja";

if (!apiKey) {
  fail("OPENAI_API_KEY is required");
}

try {
  const file = await fs.readFile(filePath);
  const { pcmBuffer, sampleRateHz, channels } = parseWavPcm16(file);

  console.log("OpenAI final retranscription check");
  console.log(`  file: ${filePath}`);
  console.log(`  model: ${model}`);
  console.log(`  sampleRateHz: ${sampleRateHz}`);
  console.log(`  channels: ${channels}`);

  const result = await transcribePcmAudioWithOpenAi({
    apiKey,
    pcmBuffer,
    sampleRateHz,
    channels,
    model,
    language,
    sessionContext: {
      title: "acute-cystitis",
      visitReason: "排尿時痛と頻尿"
    }
  });

  console.log("  transcript:");
  console.log(result.text);
} catch (error) {
  fail("OpenAI final retranscription check failed", error);
}
