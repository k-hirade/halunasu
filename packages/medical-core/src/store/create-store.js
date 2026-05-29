import { FirestoreStore } from "./firestore-store.js";
import { InMemoryStore } from "./in-memory-store.js";

export function createStore(options = {}) {
  const backend = options.backend || process.env.STORE_BACKEND || "memory";
  const isProduction = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";

  if (isProduction && backend !== "firestore") {
    throw new Error("STORE_BACKEND=firestore is required in production");
  }

  if (backend === "firestore") {
    return new FirestoreStore(options);
  }

  return new InMemoryStore(options);
}
