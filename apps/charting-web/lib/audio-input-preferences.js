"use client";

export const BROWSER_DEFAULT_AUDIO_INPUT = "__browser_default__";

const STORAGE_PREFIX = "medical.audioInputPreference";

export function audioInputPreferenceStorageKey({ orgId, memberId } = {}) {
  const scopedOrgId = orgId || "unknown-org";
  const scopedMemberId = memberId || "unknown-member";
  return `${STORAGE_PREFIX}.${scopedOrgId}.${scopedMemberId}`;
}

export function readAudioInputPreference(scope) {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(audioInputPreferenceStorageKey(scope));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return {
      deviceId: parsed.deviceId || "",
      label: parsed.label || "",
      lastStatus: parsed.lastStatus || "",
      savedAt: parsed.savedAt || ""
    };
  } catch {
    return null;
  }
}

export function saveAudioInputPreference(scope, preference) {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(audioInputPreferenceStorageKey(scope), JSON.stringify({
      deviceId: preference.deviceId || "",
      label: preference.label || "",
      lastStatus: preference.lastStatus || "",
      savedAt: new Date().toISOString()
    }));
    return true;
  } catch {
    return false;
  }
}

export function buildAudioInputConstraints(deviceId) {
  const constraints = {
    channelCount: { ideal: 1 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true
  };

  if (deviceId && deviceId !== BROWSER_DEFAULT_AUDIO_INPUT) {
    constraints.deviceId = { exact: deviceId };
  }

  return constraints;
}
