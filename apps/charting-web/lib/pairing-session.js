"use client";

const STORAGE_PREFIX = "medical.pairing.";

function getStorageKey(sessionId) {
  return `${STORAGE_PREFIX}${sessionId}`;
}

export function loadStoredPairing(sessionId) {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(getStorageKey(sessionId));

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storePairing(sessionId, pairing) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(getStorageKey(sessionId), JSON.stringify(pairing));
}

export function clearStoredPairing(sessionId) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(getStorageKey(sessionId));
}
