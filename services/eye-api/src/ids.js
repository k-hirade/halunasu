import { randomBytes } from "node:crypto";

export function createId(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
