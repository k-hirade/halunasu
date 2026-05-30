import { createLiveSttConfigFromEnv } from "../packages/medical-core/src/stt/live-stt-config.js";
import { OpenAiLiveSttProvider } from "../packages/medical-core/src/stt/openai-live-stt.js";

function fail(message, error) {
  console.error(message);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const config = createLiveSttConfigFromEnv(process.env).openai;

if (!config.apiKey) {
  fail("OPENAI_API_KEY is required");
}

console.log("OpenAI realtime transcription preflight");
console.log(`  ws url: ${config.wsUrl}`);
console.log(`  client secrets url: ${config.clientSecretsUrl}`);
console.log(`  transcription model: ${config.model}`);
console.log(`  language: ${config.language}`);

let sawAsyncError = null;

const provider = new OpenAiLiveSttProvider({
  config,
  sessionId: "preflight",
  metadata: {
    encoding: "pcm16",
    sampleRateHz: config.sampleRateHz,
    channels: config.channels,
    transport: "raw_pcm",
    mimeType: "audio/pcm"
  },
  handlers: {
    onError: (error) => {
      sawAsyncError = error;
    }
  }
});

try {
  await provider.connect();
  console.log("  session: connected");

  await provider.sendAudio(Buffer.alloc(19_200));
  await wait(1_000);

  if (sawAsyncError) {
    throw sawAsyncError;
  }

  console.log("  audio append: accepted");
  await provider.close();
} catch (error) {
  fail("OpenAI realtime transcription preflight failed", error);
}
