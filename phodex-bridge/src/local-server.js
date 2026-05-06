// FILE: local-server.js
// Purpose: Hosts the direct iPhone-to-Mac WebSocket bridge for local mode.
// Layer: CLI helper
// Exports: startLocalServer, detectAdvertisedHost, detectBindHost, isTailscaleIPv4, validateUpgradeRequest
// Depends on: http, os, ws

const http = require("http");
const os = require("os");
const { createPublicKey, verify } = require("crypto");
const WebSocket = require("ws");

const TRUSTED_SESSION_RESOLVE_TAG = "remodex-trusted-session-resolve-v1";
const TRUSTED_SESSION_RESOLVE_SKEW_MS = 90_000;

function startLocalServer({
  port,
  bindHost = "",
  sessionId,
  trustedSessionInfo = null,
  now = () => Date.now(),
  onListening = () => {},
  onConnection = () => {},
  onDisconnect = () => {},
  onError = () => {},
} = {}) {
  const normalizedBindHost = normalizeBindHost(bindHost);
  let activeSocket = null;
  let isClosed = false;
  const usedResolveNonces = new Map();

  const server = http.createServer((request, response) => {
    const pathname = safePathname(request?.url);
    if (request.method === "POST" && pathname === "/v1/trusted/session/resolve") {
      handleTrustedSessionResolveRoute(request, response, {
        sessionId,
        trustedSessionInfo,
        now,
        usedResolveNonces,
      }).catch(() => {
        writeJSON(response, 500, {
          ok: false,
          error: "Internal server error",
          code: "internal_error",
        });
      });
      return;
    }

    response.writeHead(426, {
      Connection: "close",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Upgrade Required");
  });

  const webSocketServer = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const validation = validateUpgradeRequest(request, sessionId);
    if (!validation.ok) {
      writeUpgradeRejection(socket, validation.statusCode, validation.statusMessage);
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  server.on("error", onError);
  webSocketServer.on("error", onError);

  webSocketServer.on("connection", (webSocket, request) => {
    const previousSocket = activeSocket;
    activeSocket = webSocket;

    webSocket.on("error", () => {});

    if (previousSocket && previousSocket !== webSocket) {
      closeSocket(previousSocket, 4003, "replaced");
    }

    webSocket.on("close", (code) => {
      if (activeSocket === webSocket) {
        activeSocket = null;
      }
      onDisconnect(webSocket, code, request);
    });

    onConnection(webSocket, request);
  });

  server.listen(port, normalizedBindHost, () => {
    onListening(server.address());
  });

  function close() {
    if (isClosed) {
      return;
    }

    isClosed = true;
    const socketToClose = activeSocket;
    activeSocket = null;

    if (socketToClose) {
      closeSocket(socketToClose, 4002, "bridge shutdown");
    }

    webSocketServer.close();
    server.close();
  }

  return { server, close };
}

async function handleTrustedSessionResolveRoute(request, response, {
  sessionId,
  trustedSessionInfo,
  now,
  usedResolveNonces,
} = {}) {
  try {
    const body = await readJSONBody(request);
    const resolved = resolveTrustedSessionRequest(body, {
      sessionId,
      trustedSessionInfo: readTrustedSessionInfo(trustedSessionInfo),
      now,
      usedResolveNonces,
    });
    writeJSON(response, 200, resolved);
  } catch (error) {
    writeJSON(response, error.status || 500, {
      ok: false,
      error: error.message || "Internal server error",
      code: error.code || "internal_error",
    });
  }
}

function detectAdvertisedHost({
  explicitHost = "",
  networkInterfaces = os.networkInterfaces(),
} = {}) {
  const trimmedExplicitHost = typeof explicitHost === "string" ? explicitHost.trim() : "";
  if (trimmedExplicitHost) {
    return trimmedExplicitHost;
  }

  return detectPreferredBindHost({ networkInterfaces });
}

function detectBindHost({
  explicitBindHost = "",
  explicitHost = "",
  networkInterfaces = os.networkInterfaces(),
} = {}) {
  const trimmedBindHost = typeof explicitBindHost === "string" ? explicitBindHost.trim() : "";
  if (trimmedBindHost) {
    return trimmedBindHost;
  }

  const trimmedExplicitHost = typeof explicitHost === "string" ? explicitHost.trim() : "";
  if (isIPv4(trimmedExplicitHost)) {
    return trimmedExplicitHost;
  }

  return detectPreferredBindHost({ networkInterfaces });
}

function isTailscaleIPv4(address) {
  const octets = String(address).split(".").map((part) => Number.parseInt(part, 10));
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && octets[0] === 100
    && octets[1] >= 64
    && octets[1] <= 127;
}

function validateUpgradeRequest(request, sessionId) {
  const pathname = safePathname(request?.url);
  if (pathname !== `/${sessionId}`) {
    return {
      ok: false,
      statusCode: 404,
      statusMessage: "Not Found",
    };
  }

  const roleHeader = readHeaderValue(request?.headers?.["x-role"]);
  if (roleHeader !== "iphone") {
    return {
      ok: false,
      statusCode: 401,
      statusMessage: "Unauthorized",
    };
  }

  return { ok: true };
}

function resolveTrustedSessionRequest(rawRequest, {
  sessionId,
  trustedSessionInfo,
  now = () => Date.now(),
  usedResolveNonces = new Map(),
} = {}) {
  const normalizedMacDeviceId = normalizeNonEmptyString(rawRequest?.macDeviceId);
  const normalizedPhoneDeviceId = normalizeNonEmptyString(rawRequest?.phoneDeviceId);
  const normalizedPhoneIdentityPublicKey = normalizeNonEmptyString(rawRequest?.phoneIdentityPublicKey);
  const normalizedNonce = normalizeNonEmptyString(rawRequest?.nonce);
  const normalizedSignature = normalizeNonEmptyString(rawRequest?.signature);
  const normalizedTimestamp = Number(rawRequest?.timestamp);

  if (
    !normalizedMacDeviceId
    || !normalizedPhoneDeviceId
    || !normalizedPhoneIdentityPublicKey
    || !normalizedNonce
    || !normalizedSignature
    || !Number.isFinite(normalizedTimestamp)
  ) {
    throw createLocalServerError(400, "invalid_request", "The trusted-session resolve request is missing required fields.");
  }

  if (Math.abs(now() - normalizedTimestamp) > TRUSTED_SESSION_RESOLVE_SKEW_MS) {
    throw createLocalServerError(401, "resolve_request_expired", "This trusted-session resolve request has expired.");
  }

  pruneUsedResolveNonces(usedResolveNonces, now());
  const nonceKey = `${normalizedMacDeviceId}|${normalizedPhoneDeviceId}|${normalizedNonce}`;
  if (usedResolveNonces.has(nonceKey)) {
    throw createLocalServerError(409, "resolve_request_replayed", "This trusted-session resolve request was already used.");
  }

  if (
    !trustedSessionInfo
    || !sessionId
    || trustedSessionInfo.macDeviceId !== normalizedMacDeviceId
  ) {
    throw createLocalServerError(404, "session_unavailable", "The trusted Mac is offline right now.");
  }

  if (
    trustedSessionInfo.trustedPhoneDeviceId !== normalizedPhoneDeviceId
    || trustedSessionInfo.trustedPhonePublicKey !== normalizedPhoneIdentityPublicKey
  ) {
    throw createLocalServerError(403, "phone_not_trusted", "This iPhone is not trusted for the requested Mac.");
  }

  const transcriptBytes = buildTrustedSessionResolveBytes({
    macDeviceId: normalizedMacDeviceId,
    phoneDeviceId: normalizedPhoneDeviceId,
    phoneIdentityPublicKey: normalizedPhoneIdentityPublicKey,
    nonce: normalizedNonce,
    timestamp: normalizedTimestamp,
  });
  if (!verifyTrustedSessionResolveSignature(
    normalizedPhoneIdentityPublicKey,
    transcriptBytes,
    normalizedSignature
  )) {
    throw createLocalServerError(403, "invalid_signature", "The trusted-session resolve signature is invalid.");
  }

  usedResolveNonces.set(nonceKey, now() + TRUSTED_SESSION_RESOLVE_SKEW_MS);
  return {
    ok: true,
    macDeviceId: trustedSessionInfo.macDeviceId,
    macIdentityPublicKey: trustedSessionInfo.macIdentityPublicKey,
    displayName: trustedSessionInfo.displayName || null,
    sessionId,
  };
}

function normalizeBindHost(bindHost) {
  const trimmedBindHost = typeof bindHost === "string" ? bindHost.trim() : "";
  return trimmedBindHost || "127.0.0.1";
}

function detectPreferredBindHost({ networkInterfaces = os.networkInterfaces() } = {}) {
  const ipv4Addresses = collectExternalIPv4Addresses(networkInterfaces);
  const tailscaleAddress = ipv4Addresses.find((address) => isTailscaleIPv4(address));
  if (tailscaleAddress) {
    return tailscaleAddress;
  }

  const firstLanAddress = ipv4Addresses[0];
  if (firstLanAddress) {
    return firstLanAddress;
  }

  return "127.0.0.1";
}

function collectExternalIPv4Addresses(networkInterfaces) {
  const addresses = [];

  for (const entries of Object.values(networkInterfaces || {})) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (!entry) {
        continue;
      }

      const family = typeof entry.family === "string"
        ? entry.family
        : entry.family === 4
          ? "IPv4"
          : "";

      if (family !== "IPv4" || entry.internal) {
        continue;
      }

      const address = typeof entry.address === "string" ? entry.address.trim() : "";
      if (address) {
        addresses.push(address);
      }
    }
  }

  return addresses;
}

function safePathname(rawUrl) {
  try {
    const parsed = new URL(rawUrl || "/", "http://localhost");
    return parsed.pathname;
  } catch {
    return "";
  }
}

function readHeaderValue(value) {
  if (Array.isArray(value)) {
    return readHeaderValue(value[0]);
  }

  return normalizeNonEmptyString(value);
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isIPv4(value) {
  const octets = String(value).split(".").map((part) => Number.parseInt(part, 10));
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

async function readJSONBody(request) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of request) {
    totalSize += chunk.length;
    if (totalSize > 64 * 1024) {
      throw createLocalServerError(413, "request_too_large", "The trusted-session resolve request body is too large.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw createLocalServerError(400, "invalid_json", "The trusted-session resolve request body is not valid JSON.");
  }
}

function writeJSON(response, statusCode, body) {
  response.writeHead(statusCode, {
    Connection: "close",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function readTrustedSessionInfo(trustedSessionInfo) {
  if (typeof trustedSessionInfo === "function") {
    return trustedSessionInfo();
  }
  return trustedSessionInfo;
}

function buildTrustedSessionResolveBytes({
  macDeviceId,
  phoneDeviceId,
  phoneIdentityPublicKey,
  nonce,
  timestamp,
}) {
  return Buffer.concat([
    encodeLengthPrefixedUTF8(TRUSTED_SESSION_RESOLVE_TAG),
    encodeLengthPrefixedUTF8(macDeviceId),
    encodeLengthPrefixedUTF8(phoneDeviceId),
    encodeLengthPrefixedData(Buffer.from(phoneIdentityPublicKey, "base64")),
    encodeLengthPrefixedUTF8(nonce),
    encodeLengthPrefixedUTF8(String(timestamp)),
  ]);
}

function verifyTrustedSessionResolveSignature(publicKeyBase64, transcriptBytes, signatureBase64) {
  try {
    return verify(
      null,
      transcriptBytes,
      createPublicKey({
        key: {
          crv: "Ed25519",
          kty: "OKP",
          x: base64ToBase64Url(publicKeyBase64),
        },
        format: "jwk",
      }),
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}

function pruneUsedResolveNonces(usedResolveNonces, now) {
  for (const [nonceKey, expiresAt] of usedResolveNonces.entries()) {
    if (now >= expiresAt) {
      usedResolveNonces.delete(nonceKey);
    }
  }
}

function encodeLengthPrefixedUTF8(value) {
  return encodeLengthPrefixedData(Buffer.from(value, "utf8"));
}

function encodeLengthPrefixedData(value) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function base64ToBase64Url(value) {
  return String(value || "")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function createLocalServerError(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    code,
  });
}

function writeUpgradeRejection(socket, statusCode, statusMessage) {
  const response = [
    `HTTP/1.1 ${statusCode} ${statusMessage}`,
    "Connection: close",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");

  try {
    socket.write(response);
  } catch {}

  socket.destroy();
}

function closeSocket(socket, code, reason) {
  if (!socket) {
    return;
  }

  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}

module.exports = {
  startLocalServer,
  detectAdvertisedHost,
  detectBindHost,
  isTailscaleIPv4,
  resolveTrustedSessionRequest,
  validateUpgradeRequest,
};
