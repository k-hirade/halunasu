import crypto from "node:crypto";

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function addMinutes(isoString, minutes) {
  return new Date(Date.parse(isoString) + minutes * 60_000).toISOString();
}
