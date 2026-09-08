import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  DEVICE_PUSH_TOKEN_REDACTION,
  DevicePushTokenContractError,
  MAX_DEVICE_PUSH_TOKEN_IDEMPOTENCY_KEY_UTF8_BYTES,
  formatDevicePushTokenDiagnostic,
  parseDevicePushTokenInput,
  parseDevicePushTokenResult,
  redactDevicePushTokenDiagnostics,
} from "../src/contracts/device-push-token.ts";

const fixtures = JSON.parse(await readFile(resolve("conformance-tests/device-push-token/fixtures.json"), "utf8"));
const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const contractError = (code) => (error) => error instanceof DevicePushTokenContractError && (!code || error.code === code);

test("shared register, refresh, and unregister fixtures strictly round trip", () => {
  for (const fixture of fixtures.valid) {
    const input = parseDevicePushTokenInput(roundTrip(fixture.input), { currentTokenRevision: fixture.currentTokenRevision });
    assert.deepEqual(input, fixture.input, fixture.name);
    assert.deepEqual(parseDevicePushTokenResult(roundTrip(fixture.result), input), fixture.result, fixture.name);
  }
});

test("shared invalid coherence, revision, idempotency, identity, and exact-key fixtures are rejected", () => {
  for (const fixture of fixtures.invalidInputs) {
    assert.throws(
      () => parseDevicePushTokenInput(roundTrip(fixture.input), { currentTokenRevision: fixture.currentTokenRevision }),
      contractError(),
      fixture.name,
    );
  }
  const register = fixtures.valid[0].input;
  assert.throws(
    () => parseDevicePushTokenInput({ ...register, idempotencyKey: "é".repeat(MAX_DEVICE_PUSH_TOKEN_IDEMPOTENCY_KEY_UTF8_BYTES) }),
    contractError("invalid_idempotency_key"),
  );
  assert.throws(
    () => parseDevicePushTokenInput({ ...register, nested: { session: { userId: "spoofed" } } }),
    contractError("trusted_identity_field"),
  );
});

test("canonical results are exact, server-shaped, and coherent with their input", () => {
  const fixture = fixtures.valid[0];
  const input = parseDevicePushTokenInput(fixture.input);
  for (const invalid of [
    { ...fixture.result, idempotencyKey: "other" },
    { ...fixture.result, unexpected: true },
    { ...fixture.result, devicePushToken: { ...fixture.result.devicePushToken, token: fixture.input.token } },
    { ...fixture.result, devicePushToken: { ...fixture.result.devicePushToken, provider: "fcm" } },
    { ...fixture.result, devicePushToken: { ...fixture.result.devicePushToken, tokenRevision: 2 } },
  ]) {
    assert.throws(() => parseDevicePushTokenResult(invalid, input), contractError());
  }
});

test("diagnostic-safe structures and strings redact every token alias", () => {
  const input = fixtures.valid[0].input;
  const nested = { input, details: { registrationToken: "SECOND_SECRET", safe: "visible" } };
  const safe = redactDevicePushTokenDiagnostics(nested);
  assert.equal(safe.input.token, DEVICE_PUSH_TOKEN_REDACTION);
  assert.equal(safe.details.registrationToken, DEVICE_PUSH_TOKEN_REDACTION);
  assert.equal(safe.details.safe, "visible");
  const formatted = formatDevicePushTokenDiagnostic(nested);
  assert.doesNotMatch(formatted, /SECRET_APNS_DEVICE_TOKEN|SECOND_SECRET/);
  assert.match(formatted, /\[REDACTED\]/);
});
