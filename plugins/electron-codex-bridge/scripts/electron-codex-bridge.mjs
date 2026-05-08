#!/usr/bin/env node
import crypto from "node:crypto";
import net from "node:net";
import readline from "node:readline";
import tls from "node:tls";

const SERVER_NAME = "electron-codex-bridge";
const SERVER_VERSION = "0.1.0";
const DEFAULT_CDP_URL = process.env.CODEX_ELECTRON_CDP_URL || "http://127.0.0.1:9223";
const DEFAULT_BRIDGE_URL =
  process.env.CODEX_ELECTRON_BRIDGE_URL || "http://127.0.0.1:17345";
const BRIDGE_TOKEN = process.env.CODEX_ELECTRON_BRIDGE_TOKEN || "";

const tools = [
  {
    name: "electron_cdp_get_version",
    description: "Read Chrome DevTools Protocol version metadata from the Electron debugging port.",
    inputSchema: {
      type: "object",
      properties: {
        cdpUrl: {
          type: "string",
          description: "CDP base URL. Defaults to CODEX_ELECTRON_CDP_URL or http://127.0.0.1:9223."
        }
      }
    }
  },
  {
    name: "electron_cdp_list_targets",
    description: "List Electron BrowserWindow, webview, and other CDP targets exposed by the debugging port.",
    inputSchema: {
      type: "object",
      properties: {
        cdpUrl: {
          type: "string",
          description: "CDP base URL. Defaults to CODEX_ELECTRON_CDP_URL or http://127.0.0.1:9223."
        }
      }
    }
  },
  {
    name: "electron_cdp_evaluate",
    description: "Evaluate JavaScript in a renderer target through CDP. Development-only; prefer app bridge handlers for trusted operations.",
    inputSchema: {
      type: "object",
      required: ["expression"],
      properties: {
        cdpUrl: { type: "string" },
        targetId: { type: "string", description: "Target id from electron_cdp_list_targets." },
        urlIncludes: { type: "string", description: "Choose the first target whose URL or title includes this text." },
        expression: { type: "string", description: "JavaScript expression to evaluate in the renderer." },
        awaitPromise: { type: "boolean", default: true },
        returnByValue: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "electron_cdp_capture_screenshot",
    description: "Capture a screenshot from an Electron renderer target through CDP.",
    inputSchema: {
      type: "object",
      properties: {
        cdpUrl: { type: "string" },
        targetId: { type: "string" },
        urlIncludes: { type: "string" },
        format: { type: "string", enum: ["png", "jpeg"], default: "png" },
        quality: { type: "number", minimum: 0, maximum: 100, description: "JPEG quality only." }
      }
    }
  },
  {
    name: "electron_cdp_click",
    description: "Dispatch a mouse click at viewport coordinates in an Electron renderer target.",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: {
        cdpUrl: { type: "string" },
        targetId: { type: "string" },
        urlIncludes: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
        clickCount: { type: "number", default: 1 }
      }
    }
  },
  {
    name: "electron_cdp_type",
    description: "Insert text into the focused element of an Electron renderer target through CDP.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        cdpUrl: { type: "string" },
        targetId: { type: "string" },
        urlIncludes: { type: "string" },
        text: { type: "string" }
      }
    }
  },
  {
    name: "electron_bridge_health",
    description: "Check the local Electron main-process bridge health endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        bridgeUrl: {
          type: "string",
          description: "Bridge base URL. Defaults to CODEX_ELECTRON_BRIDGE_URL or http://127.0.0.1:17345."
        }
      }
    }
  },
  {
    name: "electron_bridge_list_windows",
    description: "List BrowserWindow instances through the explicit Electron main-process bridge.",
    inputSchema: {
      type: "object",
      properties: {
        bridgeUrl: { type: "string" }
      }
    }
  },
  {
    name: "electron_bridge_invoke",
    description: "Invoke an allowlisted handler registered in the Electron main-process bridge.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        bridgeUrl: { type: "string" },
        name: { type: "string", description: "Allowlisted bridge handler name." },
        args: { type: "array", items: {}, default: [] }
      }
    }
  },
  {
    name: "electron_bridge_request",
    description: "Send a JSON request to the local Electron bridge for custom development endpoints.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        bridgeUrl: { type: "string" },
        path: { type: "string", description: "Absolute bridge path, for example /windows." },
        method: { type: "string", enum: ["GET", "POST"], default: "GET" },
        body: { description: "JSON-serializable request body." }
      }
    }
  }
];

function baseUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, "");
}

function bridgeHeaders(extra = {}) {
  const headers = { ...extra };
  if (BRIDGE_TOKEN) {
    headers.authorization = `Bearer ${BRIDGE_TOKEN}`;
    headers["x-codex-bridge-token"] = BRIDGE_TOKEN;
  }
  return headers;
}

async function request(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("This MCP server requires Node.js 18+ with global fetch support.");
  }

  const timeoutMs = options.timeoutMs || 8000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch ${url}: ${detail}`);
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") && text ? JSON.parse(text) : text;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getCdpVersion(args) {
  const cdpUrl = baseUrl(args.cdpUrl, DEFAULT_CDP_URL);
  return (await request(`${cdpUrl}/json/version`)).body;
}

async function listCdpTargets(args) {
  const cdpUrl = baseUrl(args.cdpUrl, DEFAULT_CDP_URL);
  const payload = (await request(`${cdpUrl}/json`)).body;
  if (!Array.isArray(payload)) {
    throw new Error(`Expected ${cdpUrl}/json to return an array.`);
  }
  return payload;
}

async function selectTarget(args) {
  const targets = await listCdpTargets(args);
  const debuggable = targets.filter((target) => target.webSocketDebuggerUrl);
  let candidates = debuggable;

  if (args.targetId) {
    candidates = candidates.filter((target) => target.id === args.targetId);
  }

  if (args.urlIncludes) {
    candidates = candidates.filter((target) => {
      const haystack = `${target.url || ""}\n${target.title || ""}`;
      return haystack.includes(args.urlIncludes);
    });
  }

  const selected =
    candidates.find((target) => target.type === "page") ||
    candidates.find((target) => target.type === "webview") ||
    candidates[0];

  if (!selected) {
    throw new Error("No matching CDP target with a webSocketDebuggerUrl was found.");
  }

  return selected;
}

async function withCdpTarget(args, callback) {
  const target = await selectTarget(args);
  const socket = await connectWebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  socket.onMessage((data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }

    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);

    if (message.error) {
      reject(new Error(message.error.message || JSON.stringify(message.error)));
      return;
    }

    resolve(message.result);
  });

  const call = (method, params = {}, timeoutMs = 8000) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  };

  try {
    return await callback(call, target);
  } finally {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP connection closed."));
    }
    pending.clear();
    socket.close();
  }
}

async function connectWebSocket(urlString) {
  const url = new URL(urlString);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported CDP WebSocket protocol: ${url.protocol}`);
  }

  const isSecure = url.protocol === "wss:";
  const port = Number(url.port || (isSecure ? 443 : 80));
  const host = url.hostname;
  const key = crypto.randomBytes(16).toString("base64");
  const path = `${url.pathname}${url.search}`;
  const hostHeader = url.port ? `${host}:${url.port}` : host;
  const messageListeners = new Set();
  const closeListeners = new Set();
  let connected = false;
  let handshakeBuffer = Buffer.alloc(0);
  let frameBuffer = Buffer.alloc(0);

  const socket = isSecure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });

  const client = {
    send(payload) {
      socket.write(encodeWebSocketFrame(Buffer.from(payload), 0x1));
    },
    close() {
      if (!socket.destroyed) {
        socket.end(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
      }
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    }
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to CDP WebSocket ${urlString}.`));
    }, 8000);

    socket.once("connect", () => {
      socket.write([
        `GET ${path || "/"} HTTP/1.1`,
        `Host: ${hostHeader}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });

    socket.on("data", (chunk) => {
      if (!connected) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headers = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
        if (!headers.startsWith("HTTP/1.1 101") && !headers.startsWith("HTTP/1.0 101")) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`CDP WebSocket handshake failed: ${headers.split("\r\n")[0]}`));
          return;
        }

        connected = true;
        clearTimeout(timer);
        frameBuffer = handshakeBuffer.subarray(headerEnd + 4);
        handshakeBuffer = Buffer.alloc(0);
        resolve(client);
        drainFrames();
        return;
      }

      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      drainFrames();
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      if (!connected) {
        reject(error);
      }
    });

    socket.once("close", () => {
      for (const listener of closeListeners) listener();
    });
  });

  function drainFrames() {
    while (frameBuffer.length >= 2) {
      const first = frameBuffer[0];
      const second = frameBuffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (frameBuffer.length < offset + 2) return;
        length = frameBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (frameBuffer.length < offset + 8) return;
        const bigLength = frameBuffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          socket.destroy(new Error("CDP WebSocket frame is too large."));
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      let mask;
      if (masked) {
        if (frameBuffer.length < offset + 4) return;
        mask = frameBuffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (frameBuffer.length < offset + length) return;

      let payload = frameBuffer.subarray(offset, offset + length);
      frameBuffer = frameBuffer.subarray(offset + length);

      if (masked && mask) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      if (opcode === 0x1) {
        const text = payload.toString("utf8");
        for (const listener of messageListeners) listener(text);
      } else if (opcode === 0x8) {
        socket.end();
        return;
      } else if (opcode === 0x9) {
        socket.write(encodeWebSocketFrame(payload, 0xA));
      }
    }
  }
}

function encodeWebSocketFrame(payload, opcode) {
  const mask = crypto.randomBytes(4);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const maskedPayload = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = payload[index] ^ mask[index % 4];
  }

  return Buffer.concat([header, mask, maskedPayload]);
}

async function cdpEvaluate(args) {
  return withCdpTarget(args, async (call, target) => {
    await call("Runtime.enable");
    const result = await call("Runtime.evaluate", {
      expression: args.expression,
      awaitPromise: args.awaitPromise !== false,
      returnByValue: args.returnByValue !== false,
      userGesture: true
    });
    return { target: summarizeTarget(target), result };
  });
}

async function cdpScreenshot(args) {
  return withCdpTarget(args, async (call, target) => {
    await call("Page.enable");
    const format = args.format || "png";
    const params = { format, captureBeyondViewport: true };
    if (format === "jpeg" && typeof args.quality === "number") {
      params.quality = args.quality;
    }
    const result = await call("Page.captureScreenshot", params, 15000);
    return {
      target: summarizeTarget(target),
      data: result.data,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png"
    };
  });
}

async function cdpClick(args) {
  return withCdpTarget(args, async (call, target) => {
    const button = args.button || "left";
    const clickCount = args.clickCount || 1;
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: args.x,
      y: args.y,
      button,
      clickCount
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: args.x,
      y: args.y,
      button,
      clickCount
    });
    return { target: summarizeTarget(target), clicked: { x: args.x, y: args.y, button, clickCount } };
  });
}

async function cdpType(args) {
  return withCdpTarget(args, async (call, target) => {
    await call("Input.insertText", { text: args.text });
    return { target: summarizeTarget(target), insertedTextLength: args.text.length };
  });
}

function summarizeTarget(target) {
  return {
    id: target.id,
    type: target.type,
    title: target.title,
    url: target.url
  };
}

async function bridgeRequest(args) {
  const bridgeUrl = baseUrl(args.bridgeUrl, DEFAULT_BRIDGE_URL);
  const rawPath = args.path || "/";
  if (!rawPath.startsWith("/")) {
    throw new Error("Bridge path must start with '/'.");
  }

  const method = args.method || "GET";
  const hasBody = method !== "GET" && Object.prototype.hasOwnProperty.call(args, "body");
  return request(`${bridgeUrl}${rawPath}`, {
    method,
    headers: bridgeHeaders(hasBody ? { "content-type": "application/json" } : {}),
    body: hasBody ? JSON.stringify(args.body) : undefined
  });
}

async function callTool(name, args) {
  switch (name) {
    case "electron_cdp_get_version":
      return textResult(await getCdpVersion(args));
    case "electron_cdp_list_targets":
      return textResult(await listCdpTargets(args));
    case "electron_cdp_evaluate":
      return textResult(await cdpEvaluate(args));
    case "electron_cdp_capture_screenshot": {
      const screenshot = await cdpScreenshot(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ target: screenshot.target, mimeType: screenshot.mimeType }, null, 2)
          },
          {
            type: "image",
            data: screenshot.data,
            mimeType: screenshot.mimeType
          }
        ]
      };
    }
    case "electron_cdp_click":
      return textResult(await cdpClick(args));
    case "electron_cdp_type":
      return textResult(await cdpType(args));
    case "electron_bridge_health":
      return textResult(await bridgeRequest({ ...args, path: "/health", method: "GET" }));
    case "electron_bridge_list_windows":
      return textResult(await bridgeRequest({ ...args, path: "/windows", method: "GET" }));
    case "electron_bridge_invoke":
      return textResult(await bridgeRequest({
        bridgeUrl: args.bridgeUrl,
        path: "/invoke",
        method: "POST",
        body: { name: args.name, args: args.args || [] }
      }));
    case "electron_bridge_request":
      return textResult(await bridgeRequest(args));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function sendError(id, code, message, data) {
  send({ id, error: { code, message, data } });
}

async function handleRequest(message) {
  const id = message.id;
  const params = message.params || {};

  try {
    switch (message.method) {
      case "initialize":
        send({
          id,
          result: {
            protocolVersion: params.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
          }
        });
        break;
      case "tools/list":
        send({ id, result: { tools } });
        break;
      case "tools/call": {
        const result = await callTool(params.name, params.arguments || {});
        send({ id, result });
        break;
      }
      case "resources/list":
        send({ id, result: { resources: [] } });
        break;
      case "prompts/list":
        send({ id, result: { prompts: [] } });
        break;
      case "ping":
        send({ id, result: {} });
        break;
      default:
        sendError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    send({
      id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error)
          }
        ]
      }
    });
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stderr,
  terminal: false
});

rl.on("line", (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    sendError(null, -32700, "Parse error", error instanceof Error ? error.message : String(error));
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    void handleRequest(message);
  }
});
