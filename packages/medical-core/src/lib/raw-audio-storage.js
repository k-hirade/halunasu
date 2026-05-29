import { createHash } from "node:crypto";
import { getStorage } from "firebase-admin/storage";

function normalizePrefix(prefix = "raw-audio") {
  return String(prefix || "raw-audio").replace(/^\/+|\/+$/g, "") || "raw-audio";
}

function getRawAudioByteLength(rawAudio) {
  return rawAudio?.byteLength || rawAudio?.pcmBuffer?.length || 0;
}

function getRawAudioDurationMs(rawAudio) {
  const byteLength = getRawAudioByteLength(rawAudio);
  const bytesPerSecond = Math.max(1, (rawAudio?.sampleRateHz || 24_000) * (rawAudio?.channels || 1) * 2);
  return byteLength ? Math.round((byteLength / bytesPerSecond) * 1000) : null;
}

function parseGsPath(rawAudioPath) {
  const match = String(rawAudioPath || "").match(/^gs:\/\/([^/]+)\/(.+)$/);

  if (!match) {
    const error = new Error("rawAudioPath must be a gs:// path");
    error.statusCode = 400;
    throw error;
  }

  return {
    bucketName: match[1],
    objectPath: match[2]
  };
}

export function isRawAudioStorageConfigured({
  bucketName = process.env.RAW_AUDIO_GCS_BUCKET || "",
  bucket = bucketName
} = {}) {
  return Boolean(bucket);
}

export async function uploadRawAudioToGcs({
  sessionId,
  rawAudio,
  bucketName = process.env.RAW_AUDIO_GCS_BUCKET || "",
  prefix = process.env.RAW_AUDIO_GCS_PREFIX || "raw-audio"
} = {}) {
  if (!bucketName) {
    const error = new Error("RAW_AUDIO_GCS_BUCKET is required to store raw audio");
    error.statusCode = 500;
    throw error;
  }

  if (!sessionId || !rawAudio?.pcmBuffer?.length) {
    const error = new Error("sessionId and rawAudio.pcmBuffer are required");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.isBuffer(rawAudio.pcmBuffer) ? rawAudio.pcmBuffer : Buffer.from(rawAudio.pcmBuffer);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const createdAt = new Date().toISOString();
  const safePrefix = normalizePrefix(prefix);
  const objectPath = `${safePrefix}/${encodeURIComponent(sessionId)}/${Date.now()}-${sha256.slice(0, 16)}.pcm`;
  const metadataPath = `${objectPath}.json`;
  const bucket = getStorage().bucket(bucketName);
  const metadata = {
    sessionId,
    sampleRateHz: Number(rawAudio.sampleRateHz || 24_000),
    channels: Number(rawAudio.channels || 1),
    byteLength: buffer.length,
    durationMs: getRawAudioDurationMs({ ...rawAudio, pcmBuffer: buffer, byteLength: buffer.length }),
    chunkCount: rawAudio.chunkCount || null,
    sha256,
    createdAt
  };

  await bucket.file(objectPath).save(buffer, {
    resumable: false,
    contentType: "application/octet-stream",
    metadata: {
      metadata: Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, value == null ? "" : String(value)]))
    }
  });
  await bucket.file(metadataPath).save(JSON.stringify(metadata, null, 2), {
    resumable: false,
    contentType: "application/json"
  });

  return {
    rawAudioPath: `gs://${bucketName}/${objectPath}`,
    metadataPath: `gs://${bucketName}/${metadataPath}`,
    ...metadata
  };
}

export async function downloadRawAudioFromGcs({ rawAudioPath } = {}) {
  const { bucketName, objectPath } = parseGsPath(rawAudioPath);
  const file = getStorage().bucket(bucketName).file(objectPath);
  const [buffer] = await file.download();
  const [metadata] = await file.getMetadata();
  const custom = metadata?.metadata || {};

  return {
    pcmBuffer: buffer,
    byteLength: buffer.length,
    sampleRateHz: Number(custom.sampleRateHz || 24_000),
    channels: Number(custom.channels || 1),
    chunkCount: Number(custom.chunkCount || 0) || null,
    context: {
      sessionId: custom.sessionId || null
    }
  };
}

export async function deleteRawAudioFromGcs({ rawAudioPath } = {}) {
  const { bucketName, objectPath } = parseGsPath(rawAudioPath);
  const bucket = getStorage().bucket(bucketName);

  await Promise.all([
    bucket.file(objectPath).delete({ ignoreNotFound: true }),
    bucket.file(`${objectPath}.json`).delete({ ignoreNotFound: true })
  ]);
}
