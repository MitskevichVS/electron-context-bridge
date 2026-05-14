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
const MAX_BRIDGE_PATH_LENGTH = 240;
const MAX_HANDLER_NAME_LENGTH = 120;
const MAX_TARGET_SELECTOR_LENGTH = 500;
const MAX_RENDERER_EXPRESSION_LENGTH = 256 * 1024;
const MAX_TYPED_TEXT_LENGTH = 64 * 1024;

const tools = [
  {
    name: "electron_orchestrator_inspect",
    description: "Run the standard Electron inspection flow in one tool call: bridge health, windows, handler list, CDP version, CDP targets, renderer probe, and optional screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        cdpUrl: {
          type: "string",
          format: "uri",
          description: "CDP base URL. Defaults to CODEX_ELECTRON_CDP_URL or http://127.0.0.1:9223."
        },
        bridgeUrl: {
          type: "string",
          format: "uri",
          description: "Bridge base URL. Defaults to CODEX_ELECTRON_BRIDGE_URL or http://127.0.0.1:17345."
        },
        targetId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TARGET_SELECTOR_LENGTH,
          description: "Renderer target id from electron_cdp_list_targets."
        },
        urlIncludes: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TARGET_SELECTOR_LENGTH,
          description: "Choose the first target whose URL or title includes this text."
        },
        includeRendererProbe: {
          type: "boolean",
          default: true,
          description: "Evaluate a small read-only renderer probe for title, URL, readyState, viewport, and active element."
        },
        includeScreenshot: {
          type: "boolean",
          default: true,
          description: "Capture a screenshot from the selected renderer target."
        },
        screenshotFormat: {
          type: "string",
          enum: ["png", "jpeg"],
          default: "png"
        },
        screenshotQuality: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "JPEG quality only."
        }
      }
    }
  },
  {
    name: "electron_cdp_get_version",
    description: "Read Chrome DevTools Protocol version metadata from the Electron debugging port.",
    inputSchema: {
      type: "object",
      properties: {
        cdpUrl: {
          type: "string",
          format: "uri",
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
          format: "uri",
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
        cdpUrl: { type: "string", format: "uri" },
        targetId: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH, description: "Target id from electron_cdp_list_targets." },
        urlIncludes: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH, description: "Choose the first target whose URL or title includes this text." },
        expression: { type: "string", minLength: 1, maxLength: MAX_RENDERER_EXPRESSION_LENGTH, description: "JavaScript expression to evaluate in the renderer." },
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
        cdpUrl: { type: "string", format: "uri" },
        targetId: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH },
        urlIncludes: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH },
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
        cdpUrl: { type: "string", format: "uri" },
        targetId: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH },
        urlIncludes: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH },
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
        cdpUrl: { type: "string", format: "uri" },
        targetId: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH },
        urlIncludes: { type: "string", minLength: 1, maxLength: MAX_TARGET_SELECTOR_LENGTH },
        text: { type: "string", minLength: 1, maxLength: MAX_TYPED_TEXT_LENGTH }
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
          format: "uri",
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
        bridgeUrl: { type: "string", format: "uri" }
      }
    }
  },
  {
    name: "electron_bridge_list_handlers",
    description: "List allowlisted handlers registered in the Electron main-process bridge.",
    inputSchema: {
      type: "object",
      properties: {
        bridgeUrl: { type: "string", format: "uri" }
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
        bridgeUrl: { type: "string", format: "uri" },
        name: { type: "string", minLength: 1, maxLength: MAX_HANDLER_NAME_LENGTH, description: "Allowlisted bridge handler name." },
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
        bridgeUrl: { type: "string", format: "uri" },
        path: { type: "string", minLength: 1, maxLength: MAX_BRIDGE_PATH_LENGTH, description: "Absolute bridge path, for example /windows." },
        method: { type: "string", enum: ["GET", "POST"], default: "GET" },
        body: { description: "JSON-serializable request body." }
      }
    }
  }
];

function baseUrl(value, fallback, fieldName = "url") {
  const url = String(value || fallback).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${fieldName} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http or https.`);
  }
  return url;
}

function bridgeHeaders(extra = {}) {
  const headers = { ...extra };
  if (BRIDGE_TOKEN) {
    headers.authorization = `Bearer ${BRIDGE_TOKEN}`;
    headers["x-codex-bridge-token"] = BRIDGE_TOKEN;
  }
  return headers;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value, fieldName) {
  if (!isObject(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value;
}

function requireString(value, fieldName, maxLength) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} must be at most ${maxLength} characters.`);
  }
  return value;
}

function optionalBoolean(value, fieldName, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be a boolean.`);
  }
  return value;
}

function requireFiniteNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return value;
}

function optionalPositiveInteger(value, fieldName, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
}

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
  return value;
}

function requireEnum(value, fieldName, allowedValues, defaultValue) {
  const resolved = value === undefined ? defaultValue : value;
  if (!allowedValues.includes(resolved)) {
    throw new Error(`${fieldName} must be one of: ${allowedValues.join(", ")}.`);
  }
  return resolved;
}

function validateTargetSelectorArgs(args) {
  if (args.targetId !== undefined) {
    args.targetId = requireString(args.targetId, "targetId", MAX_TARGET_SELECTOR_LENGTH);
  }
  if (args.urlIncludes !== undefined) {
    args.urlIncludes = requireString(args.urlIncludes, "urlIncludes", MAX_TARGET_SELECTOR_LENGTH);
  }
}

function findFocusedWindow(windows) {
  if (!Array.isArray(windows)) return null;
  return windows.find((window) => {
    return window && window.focused === true && window.destroyed !== true;
  }) || null;
}

function chooseFocusedWindowTarget(targets, focusedWindow) {
  const matches = targets
    .map((target) => ({
      target,
      matchField: getTargetWindowMatchField(target, focusedWindow)
    }))
    .filter((match) => match.matchField);

  if (!matches.length) return null;

  const selected = chooseTargetByType(matches.map((match) => match.target));
  const selectedMatch = matches.find((match) => match.target === selected);
  return {
    target: selected,
    matchField: selectedMatch?.matchField || "window"
  };
}

function chooseTargetByType(targets) {
  return (
    targets.find((target) => target.type === "page") ||
    targets.find((target) => target.type === "webview") ||
    targets[0]
  );
}

function getTargetWindowMatchField(target, window) {
  const targetUrl = normalizeComparable(target?.url);
  const windowUrl = normalizeComparable(window?.url);
  if (targetUrl && windowUrl && targetUrl === windowUrl) {
    return "url";
  }

  const targetTitle = normalizeComparable(target?.title);
  const windowTitle = normalizeComparable(window?.title);
  if (targetTitle && windowTitle && targetTitle === windowTitle) {
    return "title";
  }

  return "";
}

function normalizeComparable(value) {
  return typeof value === "string" ? value.trim() : "";
}

function describeTargetSelection({
  args,
  candidates,
  debuggable,
  focusedWindow,
  focusedMatch,
  selected,
  notes
}) {
  const selectionNotes = [...notes];
  let reason;

  if (args.targetId) {
    reason = "explicit targetId matched";
  } else if (focusedMatch) {
    reason = `focused BrowserWindow matched by ${focusedMatch.matchField}`;
  } else if (args.urlIncludes) {
    reason = "urlIncludes matched; selected preferred target type";
  } else {
    reason = "selected preferred target type";
  }

  if (!args.targetId && focusedWindow && !focusedMatch) {
    selectionNotes.push("Focused BrowserWindow did not match any candidate CDP target by URL or title.");
  }

  if (!args.targetId && !args.urlIncludes && candidates.length > 1 && !focusedMatch) {
    selectionNotes.push(`Multiple debuggable targets were available; selected first preferred target type from ${candidates.length} candidates.`);
  }

  return {
    reason,
    candidateCount: candidates.length,
    debuggableTargetCount: debuggable.length,
    selectedTargetId: selected.id,
    focusedWindow: focusedWindow ? summarizeWindow(focusedWindow) : null,
    matchedFocusedWindow: Boolean(focusedMatch),
    notes: selectionNotes
  };
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
      throw new Error(`HTTP ${response.status} from ${url}: ${formatHttpErrorBody(body)}`);
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

function formatHttpErrorBody(body) {
  if (isObject(body) && body.ok === false && isObject(body.error)) {
    const code = typeof body.error.code === "string" ? `${body.error.code}: ` : "";
    const message = typeof body.error.message === "string"
      ? body.error.message
      : JSON.stringify(body.error);
    return `${code}${message}`;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function getCdpVersion(args) {
  const cdpUrl = baseUrl(args.cdpUrl, DEFAULT_CDP_URL, "cdpUrl");
  return (await request(`${cdpUrl}/json/version`)).body;
}

async function listCdpTargets(args) {
  const cdpUrl = baseUrl(args.cdpUrl, DEFAULT_CDP_URL, "cdpUrl");
  const payload = (await request(`${cdpUrl}/json`)).body;
  if (!Array.isArray(payload)) {
    throw new Error(`Expected ${cdpUrl}/json to return an array.`);
  }
  return payload;
}

async function selectTarget(args, context = {}) {
  validateTargetSelectorArgs(args);
  const targets = Array.isArray(context.targets)
    ? context.targets
    : await listCdpTargets(args);
  const debuggable = targets.filter((target) => target.webSocketDebuggerUrl);
  let candidates = debuggable;
  const notes = [];

  if (args.targetId) {
    candidates = candidates.filter((target) => target.id === args.targetId);
  }

  if (args.urlIncludes) {
    candidates = candidates.filter((target) => {
      const haystack = `${target.url || ""}\n${target.title || ""}`;
      return haystack.includes(args.urlIncludes);
    });
  }

  if (args.urlIncludes && candidates.length > 1) {
    notes.push(`urlIncludes matched ${candidates.length} debuggable targets.`);
  }

  const focusedWindow = findFocusedWindow(context.windows);
  const focusedMatch = !args.targetId && focusedWindow
    ? chooseFocusedWindowTarget(candidates, focusedWindow)
    : null;

  const selected = focusedMatch?.target || chooseTargetByType(candidates);

  if (!selected) {
    throw new Error("No matching CDP target with a webSocketDebuggerUrl was found.");
  }

  const selection = describeTargetSelection({
    args,
    candidates,
    debuggable,
    focusedWindow,
    focusedMatch,
    selected,
    notes
  });

  return { target: selected, selection };
}

async function withCdpTarget(args, callback) {
  const { target, selection } = await selectTarget(args);
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
    return await callback(call, target, selection);
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
  args.expression = requireString(args.expression, "expression", MAX_RENDERER_EXPRESSION_LENGTH);
  args.awaitPromise = optionalBoolean(args.awaitPromise, "awaitPromise", true);
  args.returnByValue = optionalBoolean(args.returnByValue, "returnByValue", true);

  return withCdpTarget(args, async (call, target, selection) => {
    await call("Runtime.enable");
    const result = await call("Runtime.evaluate", {
      expression: args.expression,
      awaitPromise: args.awaitPromise,
      returnByValue: args.returnByValue,
      userGesture: true
    });
    return { target: summarizeTarget(target), selection, result };
  });
}

async function cdpScreenshot(args) {
  args.format = requireEnum(args.format, "format", ["png", "jpeg"], "png");
  if (args.quality !== undefined) {
    args.quality = requireFiniteNumber(args.quality, "quality");
    if (args.quality < 0 || args.quality > 100) {
      throw new Error("quality must be between 0 and 100.");
    }
  }

  return withCdpTarget(args, async (call, target, selection) => {
    await call("Page.enable");
    const format = args.format;
    const params = { format, captureBeyondViewport: true };
    if (format === "jpeg" && typeof args.quality === "number") {
      params.quality = args.quality;
    }
    const result = await call("Page.captureScreenshot", params, 15000);
    return {
      target: summarizeTarget(target),
      selection,
      data: result.data,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png"
    };
  });
}

async function cdpClick(args) {
  args.x = requireFiniteNumber(args.x, "x");
  args.y = requireFiniteNumber(args.y, "y");
  args.button = requireEnum(args.button, "button", ["left", "middle", "right"], "left");
  args.clickCount = optionalPositiveInteger(args.clickCount, "clickCount", 1);

  return withCdpTarget(args, async (call, target, selection) => {
    const button = args.button;
    const clickCount = args.clickCount;
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
    return { target: summarizeTarget(target), selection, clicked: { x: args.x, y: args.y, button, clickCount } };
  });
}

async function cdpType(args) {
  args.text = requireString(args.text, "text", MAX_TYPED_TEXT_LENGTH);

  return withCdpTarget(args, async (call, target, selection) => {
    await call("Input.insertText", { text: args.text });
    return { target: summarizeTarget(target), selection, insertedTextLength: args.text.length };
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

function summarizeWindow(window) {
  return {
    id: window.id,
    title: window.title,
    url: window.url,
    focused: window.focused,
    visible: window.visible
  };
}

async function orchestratorInspect(args) {
  args.includeRendererProbe = optionalBoolean(args.includeRendererProbe, "includeRendererProbe", true);
  args.includeScreenshot = optionalBoolean(args.includeScreenshot, "includeScreenshot", true);

  const report = {
    generatedAt: new Date().toISOString(),
    cdp: {
      url: baseUrl(args.cdpUrl, DEFAULT_CDP_URL, "cdpUrl")
    },
    bridge: {
      url: baseUrl(args.bridgeUrl, DEFAULT_BRIDGE_URL, "bridgeUrl"),
      auth: {
        tokenConfigured: Boolean(BRIDGE_TOKEN)
      }
    },
    notes: []
  };
  const content = [];

  const bridgeHealth = await attempt(() =>
    bridgeRequest({ ...args, path: "/health", method: "GET" })
  );
  report.bridge.health = unwrapAttempt(bridgeHealth, bridgeResponseData);

  const bridgeWindows = await attempt(() =>
    bridgeRequest({ ...args, path: "/windows", method: "GET" })
  );
  report.bridge.windows = unwrapAttempt(bridgeWindows, bridgeResponseData);

  const bridgeHandlers = await attempt(() =>
    bridgeRequest({ ...args, path: "/handlers", method: "GET" })
  );
  report.bridge.handlers = unwrapAttempt(bridgeHandlers, bridgeResponseData);

  const cdpVersion = await attempt(() => getCdpVersion(args));
  report.cdp.version = unwrapAttempt(cdpVersion);

  const cdpTargets = await attempt(() => listCdpTargets(args));
  report.cdp.targets = unwrapAttempt(cdpTargets, (value) => value.map(summarizeTarget));

  const selectedTarget = await attempt(() => selectTarget(args, {
    targets: cdpTargets.ok ? cdpTargets.value : undefined,
    windows: bridgeWindows.ok ? bridgeResponseData(bridgeWindows.value) : undefined
  }));
  report.cdp.selectedTarget = unwrapAttempt(selectedTarget, (value) => summarizeTarget(value.target));
  report.cdp.targetSelection = unwrapAttempt(selectedTarget, (value) => value.selection);

  if (!cdpTargets.ok) {
    report.notes.push("CDP is not reachable. Confirm the Electron app started with remote-debugging-port=9223.");
  }

  if (!bridgeHealth.ok) {
    report.notes.push("The main-process bridge is not reachable. Confirm ENABLE_CODEX_BRIDGE=1 and startCodexBridge() are active.");
  }

  if (!BRIDGE_TOKEN) {
    report.notes.push(
      "No CODEX_ELECTRON_BRIDGE_TOKEN is configured for this MCP server. Authenticated bridge requests will fail unless the Electron bridge explicitly allows unauthenticated local access."
    );
  }

  if (selectedTarget.ok) {
    for (const note of selectedTarget.value.selection.notes) {
      report.notes.push(note);
    }
  }

  const selectedTargetArgs = selectedTarget.ok
    ? { ...args, targetId: selectedTarget.value.target.id }
    : args;

  if (args.includeRendererProbe) {
    const rendererProbe = await attempt(() =>
      cdpEvaluate({
        ...selectedTargetArgs,
        expression: rendererProbeExpression(),
        awaitPromise: true,
        returnByValue: true
      })
    );
    report.cdp.rendererProbe = unwrapAttempt(rendererProbe, unwrapRuntimeEvaluation);
  }

  if (args.includeScreenshot) {
    const screenshot = await attempt(() =>
      cdpScreenshot({
        ...selectedTargetArgs,
        format: args.screenshotFormat || "png",
        quality: args.screenshotQuality
      })
    );

    report.cdp.screenshot = unwrapAttempt(screenshot, (value) => ({
      target: value.target,
      mimeType: value.mimeType,
      includedAsImage: true
    }));

    if (screenshot.ok) {
      content.push({
        type: "image",
        data: screenshot.value.data,
        mimeType: screenshot.value.mimeType
      });
    }
  }

  content.unshift({
    type: "text",
    text: JSON.stringify(report, null, 2)
  });

  return { content };
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function unwrapAttempt(attemptResult, mapValue = (value) => value) {
  if (attemptResult.ok) {
    return {
      ok: true,
      value: mapValue(attemptResult.value)
    };
  }

  return {
    ok: false,
    error: attemptResult.error
  };
}

function bridgeResponseData(response) {
  return bridgeEnvelopeData(response.body);
}

function bridgeEnvelopeData(body) {
  if (isObject(body) && body.ok === true && Object.prototype.hasOwnProperty.call(body, "data")) {
    return body.data;
  }
  return body;
}

function unwrapRuntimeEvaluation(value) {
  const runtimeResult = value.result?.result;
  const exceptionDetails = value.result?.exceptionDetails;
  return {
    target: value.target,
    value: runtimeResult?.value ?? runtimeResult,
    exceptionDetails
  };
}

function rendererProbeExpression() {
  return `(() => ({
    title: document.title,
    href: location.href,
    readyState: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    },
    activeElement: document.activeElement
      ? {
          tagName: document.activeElement.tagName,
          id: document.activeElement.id || "",
          className: String(document.activeElement.className || ""),
          name: document.activeElement.getAttribute("name") || "",
          type: document.activeElement.getAttribute("type") || "",
          role: document.activeElement.getAttribute("role") || "",
          ariaLabel: document.activeElement.getAttribute("aria-label") || ""
        }
      : null
  }))()`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function bridgeRequest(args) {
  const bridgeUrl = baseUrl(args.bridgeUrl, DEFAULT_BRIDGE_URL, "bridgeUrl");
  const rawPath = args.path === undefined
    ? "/"
    : requireString(args.path, "path", MAX_BRIDGE_PATH_LENGTH);
  if (!rawPath.startsWith("/")) {
    throw new Error("Bridge path must start with '/'.");
  }

  const method = requireEnum(args.method, "method", ["GET", "POST"], "GET");
  if (method === "GET" && Object.prototype.hasOwnProperty.call(args, "body")) {
    throw new Error("body is only supported for POST bridge requests.");
  }

  const hasBody = method === "POST" && Object.prototype.hasOwnProperty.call(args, "body");
  return request(`${bridgeUrl}${rawPath}`, {
    method,
    headers: bridgeHeaders(hasBody ? { "content-type": "application/json" } : {}),
    body: hasBody ? stringifyJsonBody(args.body) : undefined
  });
}

function stringifyJsonBody(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(`body must be JSON-serializable: ${errorMessage(error)}`);
  }
}

async function callTool(name, args) {
  switch (name) {
    case "electron_orchestrator_inspect":
      return orchestratorInspect(args);
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
            text: JSON.stringify({
              target: screenshot.target,
              selection: screenshot.selection,
              mimeType: screenshot.mimeType
            }, null, 2)
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
    case "electron_bridge_list_handlers":
      return textResult(await bridgeRequest({ ...args, path: "/handlers", method: "GET" }));
    case "electron_bridge_invoke": {
      const handlerName = requireString(args.name, "name", MAX_HANDLER_NAME_LENGTH);
      const handlerArgs = Object.prototype.hasOwnProperty.call(args, "args")
        ? requireArray(args.args, "args")
        : [];
      return textResult(await bridgeRequest({
        bridgeUrl: args.bridgeUrl,
        path: "/invoke",
        method: "POST",
        body: { name: handlerName, args: handlerArgs }
      }));
    }
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
        const toolName = requireString(params.name, "name", MAX_HANDLER_NAME_LENGTH);
        const toolArgs = params.arguments === undefined ? {} : requireObject(params.arguments, "arguments");
        const result = await callTool(toolName, toolArgs);
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
