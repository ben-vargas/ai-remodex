// FILE: bridge.js
// Purpose: Runs Codex locally, bridges relay/local phone traffic, and coordinates desktop refreshes for Codex.app.
// Layer: CLI service
// Exports: startBridge
// Depends on: ws, uuid, ./qr, ./codex-desktop-refresher, ./codex-transport, ./rollout-watch, ./local-server

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const {
  CodexDesktopRefresher,
  readBridgeConfig,
} = require("./codex-desktop-refresher");
const { createCodexTransport } = require("./codex-transport");
const { createThreadRolloutActivityWatcher } = require("./rollout-watch");
const { startLocalServer, detectAdvertisedHost, detectBindHost } = require("./local-server");
const { printQR } = require("./qr");
const { rememberActiveThread } = require("./session-state");
const { handleGitRequest } = require("./git-handler");
const { handleThreadContextRequest } = require("./thread-context-handler");
const { handleWorkspaceRequest } = require("./workspace-handler");
const { loadOrCreateBridgeDeviceState } = require("./secure-device-state");
const { createBridgeSecureTransport } = require("./secure-transport");

function startBridge() {
  const config = readBridgeConfig();
  const sessionId = uuidv4();
  const relayBaseUrl = config.relayUrl.replace(/\/+$/, "");
  const relaySessionUrl = `${relayBaseUrl}/${sessionId}`;
  const deviceState = loadOrCreateBridgeDeviceState();
  const desktopRefresher = new CodexDesktopRefresher({
    enabled: config.refreshEnabled,
    debounceMs: config.refreshDebounceMs,
    refreshCommand: config.refreshCommand,
    bundleId: config.codexBundleId,
    appPath: config.codexAppPath,
  });

  // Keep the local Codex runtime alive across transient phone disconnects.
  let socket = null;
  let closeLocalServer = null;
  let isShuttingDown = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let lastConnectionStatus = null;
  let codexHandshakeState = config.codexEndpoint ? "warm" : "cold";
  const forwardedInitializeRequestIds = new Set();
  const secureTransport = createBridgeSecureTransport({
    sessionId,
    relayUrl: relayBaseUrl,
    deviceState,
  });
  let contextUsageWatcher = null;
  let watchedContextUsageKey = null;

  const codex = createCodexTransport({
    endpoint: config.codexEndpoint,
    env: process.env,
    logPrefix: "[remodex]",
  });

  codex.onError((error) => {
    if (config.codexEndpoint) {
      console.error(`[remodex] Failed to connect to Codex endpoint: ${config.codexEndpoint}`);
    } else {
      console.error("[remodex] Failed to start `codex app-server`.");
      console.error(`[remodex] Launch command: ${codex.describe()}`);
      console.error("[remodex] Make sure the Codex CLI is installed and that the launcher works on this OS.");
    }
    console.error(error.message);
    process.exit(1);
  });

  function clearReconnectTimer() {
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Keeps npm start output compact by emitting only high-signal connection states.
  function logConnectionStatus(status) {
    if (lastConnectionStatus === status) {
      return;
    }

    lastConnectionStatus = status;
    console.log(`[remodex] ${status}`);
  }

  function cleanupBridgeResources() {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    clearReconnectTimer();
    stopContextUsageWatcher();
    desktopRefresher.handleTransportReset();

    const activeSocket = socket;
    socket = null;

    if (closeLocalServer) {
      const closeServer = closeLocalServer;
      closeLocalServer = null;
      closeServer();
      return;
    }

    if (activeSocket?.readyState === WebSocket.OPEN || activeSocket?.readyState === WebSocket.CONNECTING) {
      activeSocket.close();
    }
  }

  // The spawned/shared Codex app-server stays warm across phone reconnects.
  // When iPhone reconnects it sends initialize again, but forwarding that to the
  // already-initialized Codex transport only produces "Already initialized".
  function handleBridgeManagedHandshakeMessage(rawMessage, sendResponse) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return false;
    }

    const method = typeof parsed?.method === "string" ? parsed.method.trim() : "";
    if (!method) {
      return false;
    }

    if (method === "initialize" && parsed.id != null) {
      if (codexHandshakeState !== "warm") {
        forwardedInitializeRequestIds.add(String(parsed.id));
        return false;
      }

      sendResponse(JSON.stringify({
        id: parsed.id,
        result: {
          bridgeManaged: true,
        },
      }));
      return true;
    }

    if (method === "initialized") {
      return codexHandshakeState === "warm";
    }

    return false;
  }

  function dispatchInbound(rawMessage, sendResponse) {
    if (handleBridgeManagedHandshakeMessage(rawMessage, sendResponse)) {
      return;
    }
    if (handleThreadContextRequest(rawMessage, sendResponse)) {
      return;
    }
    if (handleWorkspaceRequest(rawMessage, sendResponse)) {
      return;
    }
    if (handleGitRequest(rawMessage, sendResponse)) {
      return;
    }
    desktopRefresher.handleInbound(rawMessage);
    rememberThreadFromMessage("phone", rawMessage);
    codex.send(rawMessage);
  }

  function rememberThreadFromMessage(source, rawMessage) {
    const context = extractBridgeMessageContext(rawMessage);
    if (!context.threadId) {
      return;
    }

    rememberActiveThread(context.threadId, source);
    if (shouldStartContextUsageWatcher(context)) {
      ensureContextUsageWatcher(context);
    }
  }

  // Mirrors CodexMonitor's persisted token_count fallback so the phone keeps
  // receiving context-window usage even when the runtime omits live thread usage.
  function ensureContextUsageWatcher({ threadId, turnId }) {
    const normalizedThreadId = readString(threadId);
    const normalizedTurnId = readString(turnId);
    if (!normalizedThreadId) {
      return;
    }

    const nextWatcherKey = `${normalizedThreadId}|${normalizedTurnId || "pending-turn"}`;
    if (watchedContextUsageKey === nextWatcherKey && contextUsageWatcher) {
      return;
    }

    stopContextUsageWatcher();
    watchedContextUsageKey = nextWatcherKey;
    contextUsageWatcher = createThreadRolloutActivityWatcher({
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
      onUsage: ({ threadId: usageThreadId, usage }) => {
        sendContextUsageNotification(usageThreadId, usage);
      },
      onIdle: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
      onTimeout: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
      onError: () => {
        if (watchedContextUsageKey === nextWatcherKey) {
          stopContextUsageWatcher();
        }
      },
    });
  }

  function stopContextUsageWatcher() {
    if (contextUsageWatcher) {
      contextUsageWatcher.stop();
    }

    contextUsageWatcher = null;
    watchedContextUsageKey = null;
  }

  function sendContextUsageNotification(threadId, usage) {
    if (!threadId || !usage) {
      return;
    }

    sendApplicationResponse(JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        usage,
      },
    }));
  }

  // Retries the relay socket while preserving the active Codex process and session id.
  function scheduleRelayReconnect(closeCode) {
    if (isShuttingDown) {
      return;
    }

    if (closeCode === 4000 || closeCode === 4001) {
      logConnectionStatus("disconnected");
      shutdown(codex, cleanupBridgeResources);
      return;
    }

    if (reconnectTimer) {
      return;
    }

    reconnectAttempt += 1;
    const delayMs = Math.min(1_000 * reconnectAttempt, 5_000);
    logConnectionStatus("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRelay();
    }, delayMs);
  }

  function connectRelay() {
    if (isShuttingDown) {
      return;
    }

    logConnectionStatus("connecting");
    const nextSocket = new WebSocket(relaySessionUrl, {
      headers: { "x-role": "mac" },
    });
    socket = nextSocket;

    nextSocket.on("open", () => {
      clearReconnectTimer();
      reconnectAttempt = 0;
      logConnectionStatus("connected");
      secureTransport.bindLiveSendWireMessage((wireMessage) => {
        if (nextSocket.readyState === WebSocket.OPEN) {
          nextSocket.send(wireMessage);
        }
      });
    });

    nextSocket.on("message", (data) => {
      const message = typeof data === "string" ? data : data.toString("utf8");
      if (secureTransport.handleIncomingWireMessage(message, {
        sendControlMessage(controlMessage) {
          if (nextSocket.readyState === WebSocket.OPEN) {
            nextSocket.send(JSON.stringify(controlMessage));
          }
        },
        onApplicationMessage(plaintextMessage) {
          handleApplicationMessage(plaintextMessage);
        },
      })) {
        return;
      }
    });

    nextSocket.on("close", (code) => {
      if (socket === nextSocket) {
        socket = null;
      }
      stopContextUsageWatcher();
      desktopRefresher.handleTransportReset();
      logConnectionStatus("disconnected");
      scheduleRelayReconnect(code);
    });

    nextSocket.on("error", () => {
      logConnectionStatus("disconnected");
    });
  }

  function startRelayMode() {
    printQR(secureTransport.createPairingPayload());
    connectRelay();
  }

  function startLocalMode() {
    const advertisedHost = detectAdvertisedHost({ explicitHost: config.localHost });
    const bindHost = detectBindHost({
      explicitBindHost: config.localBindHost,
      explicitHost: config.localHost,
    });
    const port = config.localPort;
    const localUrl = `ws://${advertisedHost}:${port}`;
    const pairingPayload = {
      ...secureTransport.createPairingPayload(),
      relay: localUrl,
    };

    const { close } = startLocalServer({
      port,
      bindHost,
      sessionId,
      onListening() {
        printQR(pairingPayload, { label: "Local" });
        console.log(
          `[remodex] Local server listening on ${bindHost}:${port}`
        );
        if (bindHost === "0.0.0.0") {
          console.warn(
            "[remodex] Local server is bound to all IPv4 interfaces; only use this on networks you trust."
          );
        }
        if (advertisedHost === "127.0.0.1") {
          console.warn(
            "[remodex] Advertised host fell back to 127.0.0.1; set REMODEX_LOCAL_HOST for physical-device pairing."
          );
        }
        logConnectionStatus("waiting for phone (local)");
      },
      onConnection(phoneSocket) {
        socket = phoneSocket;
        logConnectionStatus("connected (local)");
        secureTransport.bindLiveSendWireMessage((wireMessage) => {
          if (phoneSocket.readyState === WebSocket.OPEN) {
            phoneSocket.send(wireMessage);
          }
        });

        phoneSocket.on("message", (data) => {
          const message = typeof data === "string" ? data : data.toString("utf8");
          if (secureTransport.handleIncomingWireMessage(message, {
            sendControlMessage(controlMessage) {
              if (phoneSocket.readyState === WebSocket.OPEN) {
                phoneSocket.send(JSON.stringify(controlMessage));
              }
            },
            onApplicationMessage(plaintextMessage) {
              handleApplicationMessage(plaintextMessage);
            },
          })) {
            return;
          }
        });
      },
      onDisconnect(phoneSocket) {
        if (socket === phoneSocket) {
          socket = null;
          desktopRefresher.handleTransportReset();
          logConnectionStatus("disconnected (local)");
        }
      },
      onError(error) {
        if (error.code === "EADDRINUSE") {
          console.error(
            `[remodex] Port ${port} already in use. Set REMODEX_LOCAL_PORT to change.`
          );
        } else {
          console.error(`[remodex] Local server error: ${error.message}`);
        }

        cleanupBridgeResources();
        codex.shutdown();
        process.exit(1);
      },
    });

    closeLocalServer = close;
  }

  if (config.localMode) {
    startLocalMode();
  } else {
    startRelayMode();
  }

  codex.onMessage((message) => {
    trackCodexHandshakeState(message);
    desktopRefresher.handleOutbound(message);
    rememberThreadFromMessage("codex", message);
    secureTransport.queueOutboundApplicationMessage(message, (wireMessage) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(wireMessage);
      }
    });
  });

  codex.onClose(() => {
    logConnectionStatus("disconnected");
    cleanupBridgeResources();
  });

  process.on("SIGINT", () => shutdown(codex, cleanupBridgeResources));
  process.on("SIGTERM", () => shutdown(codex, cleanupBridgeResources));

  // Routes decrypted app payloads through the same bridge handlers as before.
  function handleApplicationMessage(rawMessage) {
    dispatchInbound(rawMessage, sendApplicationResponse);
  }

  // Encrypts bridge-generated responses instead of letting the relay/local transport see plaintext.
  function sendApplicationResponse(rawMessage) {
    secureTransport.queueOutboundApplicationMessage(rawMessage, (wireMessage) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(wireMessage);
      }
    });
  }

  // Learns whether the underlying Codex transport has already completed its own MCP handshake.
  function trackCodexHandshakeState(rawMessage) {
    let parsed = null;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const responseId = parsed?.id;
    if (responseId == null) {
      return;
    }

    const responseKey = String(responseId);
    if (!forwardedInitializeRequestIds.has(responseKey)) {
      return;
    }

    forwardedInitializeRequestIds.delete(responseKey);

    if (parsed?.result != null) {
      codexHandshakeState = "warm";
      return;
    }

    const errorMessage = typeof parsed?.error?.message === "string"
      ? parsed.error.message.toLowerCase()
      : "";
    if (errorMessage.includes("already initialized")) {
      codexHandshakeState = "warm";
    }
  }
}

function shutdown(codex, cleanupBridgeResources) {
  cleanupBridgeResources();
  codex.shutdown();

  setTimeout(() => process.exit(0), 100);
}

function extractBridgeMessageContext(rawMessage) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { method: "", threadId: null, turnId: null };
  }

  const method = parsed?.method;
  const params = parsed?.params;
  const threadId = extractThreadId(method, params);
  const turnId = extractTurnId(method, params);

  return {
    method: typeof method === "string" ? method : "",
    threadId,
    turnId,
  };
}

function shouldStartContextUsageWatcher(context) {
  if (!context?.threadId) {
    return false;
  }

  return context.method === "turn/start"
    || context.method === "turn/started";
}

function extractThreadId(method, params) {
  if (method === "turn/start" || method === "turn/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  if (method === "thread/start" || method === "thread/started") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.thread?.id)
      || readString(params?.thread?.threadId)
      || readString(params?.thread?.thread_id)
    );
  }

  if (method === "turn/completed") {
    return (
      readString(params?.threadId)
      || readString(params?.thread_id)
      || readString(params?.turn?.threadId)
      || readString(params?.turn?.thread_id)
    );
  }

  return null;
}

function extractTurnId(method, params) {
  if (method === "turn/started" || method === "turn/completed") {
    return (
      readString(params?.turnId)
      || readString(params?.turn_id)
      || readString(params?.id)
      || readString(params?.turn?.id)
      || readString(params?.turn?.turnId)
      || readString(params?.turn?.turn_id)
    );
  }

  return null;
}

function readString(value) {
  return typeof value === "string" && value ? value : null;
}

module.exports = { startBridge };
