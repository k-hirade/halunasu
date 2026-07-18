import { memberRequiresMfa } from "../../platform-contracts/src/index.js";

export function platformSessionAuthAction(session) {
  if (!session) {
    return "unauthenticated";
  }

  const mfaRequired = Boolean(session.mfaRequired) || memberRequiresMfa(session);
  if (!mfaRequired) {
    return "authenticated";
  }

  const enrollmentKnownMissing = session.mfaEnrolled === false;
  if (session.mfaVerified === true && !enrollmentKnownMissing) {
    return "authenticated";
  }
  if (session.mfaEnrolled === true) {
    return "reauthenticate";
  }
  return "enroll";
}

export function shouldPromptMfaEnrollment(session) {
  return platformSessionAuthAction(session) === "enroll";
}

export function isPlatformSessionFullyAuthenticated(session) {
  return platformSessionAuthAction(session) === "authenticated";
}
