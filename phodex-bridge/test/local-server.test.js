const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectAdvertisedHost,
  detectBindHost,
  isTailscaleIPv4,
  validateUpgradeRequest,
} = require("../src/local-server");
const { readBridgeConfig } = require("../src/codex-desktop-refresher");

test("isTailscaleIPv4 recognizes addresses in 100.64.0.0/10", () => {
  assert.equal(isTailscaleIPv4("100.64.0.1"), true);
  assert.equal(isTailscaleIPv4("100.127.255.255"), true);
  assert.equal(isTailscaleIPv4("100.63.255.255"), false);
  assert.equal(isTailscaleIPv4("192.168.1.20"), false);
});

test("detectAdvertisedHost prefers an explicit override", () => {
  const host = detectAdvertisedHost({
    explicitHost: "macbook.tail1234.ts.net",
    networkInterfaces: {},
  });

  assert.equal(host, "macbook.tail1234.ts.net");
});

test("detectAdvertisedHost prefers Tailscale over LAN addresses", () => {
  const host = detectAdvertisedHost({
    networkInterfaces: {
      en0: [
        { family: "IPv4", address: "192.168.1.20", internal: false },
      ],
      utun4: [
        { family: "IPv4", address: "100.88.3.7", internal: false },
      ],
    },
  });

  assert.equal(host, "100.88.3.7");
});

test("detectBindHost prefers an explicit bind override", () => {
  const host = detectBindHost({
    explicitBindHost: "0.0.0.0",
    explicitHost: "100.88.3.7",
    networkInterfaces: {},
  });

  assert.equal(host, "0.0.0.0");
});

test("detectBindHost uses an explicit IPv4 host when present", () => {
  const host = detectBindHost({
    explicitHost: "100.88.3.7",
    networkInterfaces: {},
  });

  assert.equal(host, "100.88.3.7");
});

test("detectBindHost falls back to the preferred local interface for hostnames", () => {
  const host = detectBindHost({
    explicitHost: "macbook.tail1234.ts.net",
    networkInterfaces: {
      en0: [
        { family: "IPv4", address: "192.168.1.20", internal: false },
      ],
      utun4: [
        { family: "IPv4", address: "100.88.3.7", internal: false },
      ],
    },
  });

  assert.equal(host, "100.88.3.7");
});

test("detectBindHost defaults to a single preferred interface instead of all interfaces", () => {
  const host = detectBindHost({
    networkInterfaces: {
      en0: [
        { family: "IPv4", address: "192.168.1.20", internal: false },
      ],
      utun4: [
        { family: "IPv4", address: "100.88.3.7", internal: false },
      ],
    },
  });

  assert.equal(host, "100.88.3.7");
});

test("detectAdvertisedHost falls back to the first external IPv4 address", () => {
  const host = detectAdvertisedHost({
    networkInterfaces: {
      lo0: [
        { family: "IPv4", address: "127.0.0.1", internal: true },
      ],
      en0: [
        { family: "IPv4", address: "10.0.0.42", internal: false },
      ],
    },
  });

  assert.equal(host, "10.0.0.42");
});

test("detectAdvertisedHost falls back to loopback when no external IPv4 address exists", () => {
  const host = detectAdvertisedHost({
    networkInterfaces: {
      lo0: [
        { family: "IPv4", address: "127.0.0.1", internal: true },
      ],
    },
  });

  assert.equal(host, "127.0.0.1");
});

test("validateUpgradeRequest accepts the current iPhone transport contract", () => {
  const result = validateUpgradeRequest(
    {
      url: "/session-123",
      headers: {
        "x-role": "iphone",
      },
    },
    "session-123"
  );

  assert.deepEqual(result, { ok: true });
});

test("validateUpgradeRequest rejects the wrong session path", () => {
  const result = validateUpgradeRequest(
    {
      url: "/wrong-session",
      headers: {
        "x-role": "iphone",
      },
    },
    "session-123"
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
});

test("validateUpgradeRequest rejects missing or incorrect x-role headers", () => {
  const result = validateUpgradeRequest(
    {
      url: "/session-123",
      headers: {
        "x-role": "mac",
      },
    },
    "session-123"
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
});

test("readBridgeConfig exposes local mode defaults", () => {
  withEnv({}, () => {
    const config = readBridgeConfig();
    assert.equal(config.localMode, false);
    assert.equal(config.localPort, 9000);
    assert.equal(config.localHost, "");
    assert.equal(config.localBindHost, "");
  });
});

test("readBridgeConfig reads local mode overrides from the environment", () => {
  withEnv({
    REMODEX_LOCAL: "true",
    REMODEX_LOCAL_PORT: "8123",
    REMODEX_LOCAL_HOST: "macbook.tail1234.ts.net",
    REMODEX_LOCAL_BIND_HOST: "100.101.102.103",
  }, () => {
    const config = readBridgeConfig();
    assert.equal(config.localMode, true);
    assert.equal(config.localPort, 8123);
    assert.equal(config.localHost, "macbook.tail1234.ts.net");
    assert.equal(config.localBindHost, "100.101.102.103");
  });
});

function withEnv(overrides, callback) {
  const envKeys = [
    "REMODEX_LOCAL",
    "REMODEX_LOCAL_PORT",
    "REMODEX_LOCAL_HOST",
    "REMODEX_LOCAL_BIND_HOST",
  ];
  const previousValues = new Map();

  for (const key of envKeys) {
    previousValues.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  try {
    callback();
  } finally {
    for (const key of envKeys) {
      const previousValue = previousValues.get(key);
      if (previousValue == null) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}
