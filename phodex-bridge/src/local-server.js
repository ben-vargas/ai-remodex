// FILE: local-server.js
// Purpose: Hosts the direct iPhone-to-Mac WebSocket bridge for local mode.
// Layer: CLI helper
// Exports: startLocalServer, detectAdvertisedHost, detectBindHost, isTailscaleIPv4, validateUpgradeRequest
// Depends on: http, os, ws

const http = require("http");
const os = require("os");
const WebSocket = require("ws");

function startLocalServer({
  port,
  bindHost = "",
  sessionId,
  onListening = () => {},
  onConnection = () => {},
  onDisconnect = () => {},
  onError = () => {},
} = {}) {
  const normalizedBindHost = normalizeBindHost(bindHost);
  let activeSocket = null;
  let isClosed = false;

  const server = http.createServer((request, response) => {
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

    // Avoid crashing on transient network failures from the phone socket.
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

  return typeof value === "string" ? value.trim() : "";
}

function isIPv4(value) {
  const octets = String(value).split(".").map((part) => Number.parseInt(part, 10));
  return octets.length === 4
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
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
  validateUpgradeRequest,
};
