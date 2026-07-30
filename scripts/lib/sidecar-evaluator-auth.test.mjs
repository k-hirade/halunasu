import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  createStaticSidecarEvaluatorAuth,
  createTemporarySidecarEvaluatorAuth
} from "./sidecar-evaluator-auth.mjs";

test("creates, refreshes, and revokes a temporary MFA-approved sidecar grant", async () => {
  let clock = new Date("2026-07-30T05:00:00.000Z");
  const calls = [];
  let issuedChallenge = "";
  let refreshChallenge = "";
  const requestJson = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/v1/auth/sidecar-device-authorizations")) {
      return {
        statusCode: 201,
        body: {
          deviceAuthId: "sda_evaluator_test",
          userCode: "ABCD-EFGH"
        }
      };
    }
    if (url.endsWith("/v1/auth/login")) {
      return {
        statusCode: 200,
        body: { csrfToken: "csrf_evaluator_test" }
      };
    }
    if (url.endsWith("/sda_evaluator_test/approve")) {
      return {
        statusCode: 200,
        body: { deviceAuthorization: { status: "approved" } }
      };
    }
    if (url.endsWith("/v1/auth/sidecar-token") && options.body.deviceAuthId) {
      issuedChallenge = options.body.codeChallenge;
      return {
        statusCode: 201,
        body: {
          accessToken: "access_token_1",
          expiresAt: "2026-07-30T05:05:00.000Z",
          grantId: "sgr_evaluator_test.secret",
          sidecarContext: {
            facilityId: "fac_test",
            departmentId: "dep_test"
          }
        }
      };
    }
    if (url.endsWith("/v1/auth/sidecar-token") && options.body.grantId) {
      refreshChallenge = options.body.codeChallenge;
      return {
        statusCode: 201,
        body: {
          accessToken: "access_token_2",
          expiresAt: "2026-07-30T05:10:00.000Z",
          grantId: options.body.grantId,
          sidecarContext: {
            facilityId: "fac_test",
            departmentId: "dep_test"
          }
        }
      };
    }
    if (url.endsWith("/v1/auth/sidecar-grants/sgr_evaluator_test/revoke")) {
      return { statusCode: 200, body: { sidecarGrant: { status: "revoked" } } };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const auth = await createTemporarySidecarEvaluatorAuth({
    platformBaseUrl: "https://platform-api-stg.example.test",
    organizationCode: "test-stg",
    loginId: "admin",
    password: "test-password",
    mfaCode: "123456",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    requestJson,
    now: () => clock
  });

  assert.equal(auth.mode, "temporary_device_grant");
  assert.deepEqual(auth.sidecarContext, {
    facilityId: "fac_test",
    departmentId: "dep_test"
  });
  assert.equal(Object.hasOwn(auth.metadata, "accessToken"), false);
  assert.equal(Object.hasOwn(auth.metadata, "verifier"), false);

  const first = await auth.credentials();
  assert.equal(first.accessToken, "access_token_1");
  assert.equal(
    crypto.createHash("sha256").update(first.verifier).digest("base64url"),
    issuedChallenge
  );

  clock = new Date("2026-07-30T05:04:30.000Z");
  const second = await auth.credentials();
  assert.equal(second.accessToken, "access_token_2");
  assert.equal(
    crypto.createHash("sha256").update(second.verifier).digest("base64url"),
    refreshChallenge
  );
  assert.notEqual(second.verifier, first.verifier);

  const loginCall = calls.find((entry) => entry.url.endsWith("/v1/auth/login"));
  assert.deepEqual(loginCall.options.body, {
    organizationCode: "test-stg",
    loginId: "admin",
    password: "test-password",
    mfaCode: "123456"
  });
  const approvalCall = calls.find((entry) => entry.url.endsWith("/approve"));
  assert.equal(approvalCall.options.headers["x-csrf-token"], "csrf_evaluator_test");

  assert.deepEqual(await auth.close(), { revoked: true, alreadyClosed: false });
  assert.deepEqual(await auth.close(), { revoked: true, alreadyClosed: true });
});

test("keeps the legacy static token mode available", async () => {
  const auth = createStaticSidecarEvaluatorAuth({
    accessToken: "static-access",
    verifier: "static-verifier"
  });
  assert.deepEqual(await auth.credentials(), {
    accessToken: "static-access",
    verifier: "static-verifier",
    expiresAt: null
  });
  assert.deepEqual(await auth.close(), {
    revoked: false,
    notApplicable: true
  });
});

test("requires a current six-digit MFA code for temporary authorization", async () => {
  await assert.rejects(
    createTemporarySidecarEvaluatorAuth({
      platformBaseUrl: "https://platform-api-stg.example.test",
      organizationCode: "test-stg",
      loginId: "admin",
      password: "test-password",
      mfaCode: "",
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      requestJson: async () => {
        throw new Error("must not call network");
      }
    }),
    /mfaCode is required/
  );
});
