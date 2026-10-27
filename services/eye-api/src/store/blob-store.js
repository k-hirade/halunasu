import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ファイル本体の保管。本番は GCS へブラウザから署名付き URL で直接アップロードする
// （Netlify の関数を通すと約6MBの上限があるため）。開発・テストはメモリで同じ流れを再現する。

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_CONTENT_TYPES = Object.freeze(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_TTL_MS = 5 * 60 * 1000;

export function createBlobStoreFromEnv(env = process.env) {
  const bucket = env.EYE_FILES_BUCKET || "";
  if (bucket) return new GcsBlobStore({ bucket, projectId: env.EYE_GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT });
  if ((env.EYE_STORE_BACKEND || "memory").toLowerCase() === "memory") return new MemoryBlobStore();
  return new UnconfiguredBlobStore();
}

export class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
    this.tokens = new Map();
    this.configured = true;
  }

  async createUploadUrl({ storagePath, contentType, fileId }) {
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, { storagePath, contentType, fileId, expiresAt: Date.now() + UPLOAD_TTL_MS, method: "PUT" });
    return { url: `v1/eye/files/${fileId}/blob?token=${token}`, method: "PUT", headers: { "content-type": contentType }, expiresAt: new Date(Date.now() + UPLOAD_TTL_MS).toISOString() };
  }

  // 開発用のアップロード受け口。署名の代わりに一度きりのトークンを照合する。
  async acceptUpload({ fileId, token, contentType, body }) {
    const grant = this.tokens.get(token);
    if (!grant || grant.fileId !== fileId || grant.expiresAt < Date.now() || !safeEqual(grant.contentType, contentType)) {
      throw blobError(403, "upload token is invalid or expired");
    }
    if (body.length > MAX_FILE_BYTES) throw blobError(413, "file is too large");
    this.tokens.delete(token);
    this.objects.set(grant.storagePath, { body, contentType, size: body.length, md5Hash: createHash("md5").update(body).digest("base64") });
  }

  async describe(storagePath) {
    const object = this.objects.get(storagePath);
    return object ? { size: object.size, contentType: object.contentType, md5Hash: object.md5Hash, head: object.body.subarray(0, 16) } : null;
  }

  async createDownloadUrl({ storagePath, fileId }) {
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, { storagePath, fileId, expiresAt: Date.now() + DOWNLOAD_TTL_MS, method: "GET" });
    return { url: `v1/eye/files/${fileId}/blob?token=${token}`, expiresAt: new Date(Date.now() + DOWNLOAD_TTL_MS).toISOString() };
  }

  async readForDownload({ fileId, token }) {
    const grant = this.tokens.get(token);
    if (!grant || grant.method !== "GET" || grant.fileId !== fileId || grant.expiresAt < Date.now()) throw blobError(403, "download token is invalid or expired");
    const object = this.objects.get(grant.storagePath);
    if (!object) throw blobError(404, "file not found");
    return object;
  }
}

export class GcsBlobStore {
  constructor({ bucket, projectId }) {
    this.bucketName = bucket;
    this.projectId = projectId;
    this.configured = true;
    this.bucketPromise = null;
  }

  async bucket() {
    if (!this.bucketPromise) {
      this.bucketPromise = Promise.all([import("firebase-admin/app"), import("firebase-admin/storage")]).then(([{ initializeApp, getApps }, { getStorage }]) => {
        const name = "halunasu-eye-api-storage";
        const app = getApps().find((candidate) => candidate.name === name) || initializeApp({ projectId: this.projectId }, name);
        return getStorage(app).bucket(this.bucketName);
      });
    }
    return this.bucketPromise;
  }

  async createUploadUrl({ storagePath, contentType }) {
    const file = (await this.bucket()).file(storagePath);
    const expires = Date.now() + UPLOAD_TTL_MS;
    const lengthRange = `0,${MAX_FILE_BYTES}`;
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires,
      contentType,
      extensionHeaders: { "x-goog-content-length-range": lengthRange }
    });
    return { url, method: "PUT", headers: { "content-type": contentType, "x-goog-content-length-range": lengthRange }, expiresAt: new Date(expires).toISOString() };
  }

  async describe(storagePath) {
    const file = (await this.bucket()).file(storagePath);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [metadata] = await file.getMetadata();
    const [head] = await file.download({ start: 0, end: 15 });
    return { size: Number(metadata.size), contentType: metadata.contentType, md5Hash: metadata.md5Hash, head };
  }

  async createDownloadUrl({ storagePath }) {
    const file = (await this.bucket()).file(storagePath);
    const expires = Date.now() + DOWNLOAD_TTL_MS;
    const [url] = await file.getSignedUrl({ version: "v4", action: "read", expires, responseDisposition: "inline" });
    return { url, expiresAt: new Date(expires).toISOString() };
  }
}

export class UnconfiguredBlobStore {
  constructor() {
    this.configured = false;
  }

  async createUploadUrl() {
    throw blobError(503, "file storage is not configured");
  }

  async describe() {
    throw blobError(503, "file storage is not configured");
  }

  async createDownloadUrl() {
    throw blobError(503, "file storage is not configured");
  }
}

// 先頭のバイト列で実際の形式を確かめる（拡張子や申告だけを信用しない）。
export function sniffContentType(head) {
  const bytes = Buffer.from(head || []);
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "";
}

function blobError(statusCode, message) {
  const error = new Error(message);
  error.name = statusCode === 503 ? "ServiceUnavailableError" : statusCode === 404 ? "NotFoundError" : statusCode === 413 ? "PayloadTooLargeError" : "ForbiddenError";
  error.statusCode = statusCode;
  return error;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
