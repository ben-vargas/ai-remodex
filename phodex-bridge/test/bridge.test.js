const test = require("node:test");
const assert = require("node:assert/strict");

const { describeSecureControlMessage } = require("../src/bridge");

test("describeSecureControlMessage formats secure bridge errors for the CLI", () => {
  const description = describeSecureControlMessage("local", {
    kind: "secureError",
    code: "phone_replacement_required",
    message: "This Mac is already paired with another iPhone.",
  });

  assert.deepEqual(description, {
    level: "warn",
    line: "[remodex] Secure pairing failed (local, phone_replacement_required): This Mac is already paired with another iPhone.",
  });
});

test("describeSecureControlMessage formats secure-ready events for the CLI", () => {
  const description = describeSecureControlMessage("relay", {
    kind: "secureReady",
    macDeviceId: "mac-4",
  });

  assert.deepEqual(description, {
    level: "info",
    line: "[remodex] Secure pairing established (relay, mac=mac-4)",
  });
});

test("describeSecureControlMessage ignores unrelated secure control payloads", () => {
  assert.equal(
    describeSecureControlMessage("local", { kind: "serverHello" }),
    null
  );
});
