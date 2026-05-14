import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "..");
const MCP_SERVER_PATH = path.join(PLUGIN_DIR, "scripts", "electron-codex-bridge.mjs");
const MAIN_BRIDGE_EXAMPLE_PATH = path.join(
  PLUGIN_DIR,
  "scripts",
  "electron-main-bridge-example.ts"
);

test("main bridge refuses to start without token unless unauthenticated mode is explicit", async () => {
  const { module, cleanup } = await loadMainBridgeExample();
  try {
    withEnv({ ENABLE_CODEX_BRIDGE: "1" }, () => {
      assert.throws(
        () => module.startCodexBridge({ port: 0 }),
        /auth token is required/
      );
    });

    let server;
    await withEnv({ ENABLE_CODEX_BRIDGE: "1" }, async () => {
      server = module.startCodexBridge({
        allowUnauthenticated: true,
        port: 0
      });
      await once(server, "listening");
    });

    try {
      const response = await bridgeFetch(server, "/health");
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.data.auth.required, false);
    } finally {
      await closeServer(server);
    }
  } finally {
    await cleanup();
  }
});

test("main bridge enforces token auth and allows matching token", async () => {
  const { module, cleanup } = await loadMainBridgeExample();
  let server;

  try {
    await withEnv({ ENABLE_CODEX_BRIDGE: "1" }, async () => {
      server = module.startCodexBridge({
        token: "test-secret",
        port: 0
      });
      await once(server, "listening");
    });

    const unauthorized = await bridgeFetch(server, "/health");
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.ok, false);
    assert.equal(unauthorized.body.error.code, "UNAUTHORIZED");
    assert.equal(unauthorized.body.error.message, "Unauthorized");

    const authorized = await bridgeFetch(server, "/health", {
      headers: { "x-codex-bridge-token": "test-secret" }
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body.ok, true);
    assert.equal(authorized.body.data.auth.required, true);
  } finally {
    await closeServer(server);
    await cleanup();
  }
});

test("main bridge validates JSON bodies and invoke args", async () => {
  const { module, cleanup } = await loadMainBridgeExample();
  let server;

  try {
    await withEnv({ ENABLE_CODEX_BRIDGE: "1" }, async () => {
      server = module.startCodexBridge({
        token: "test-secret",
        port: 0
      });
      await once(server, "listening");
    });

    const auth = { "x-codex-bridge-token": "test-secret" };
    const malformed = await bridgeFetch(server, "/invoke", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_REQUEST");
    assert.match(malformed.body.error.message, /valid JSON/);

    const badArgs = await bridgeFetch(server, "/invoke", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "app.getVersion", args: "not-array" })
    });
    assert.equal(badArgs.status, 400);
    assert.match(badArgs.body.error.message, /args must be an array/);

    const extraArgs = await bridgeFetch(server, "/invoke", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "app.getVersion", args: ["extra"] })
    });
    assert.equal(extraArgs.status, 400);
    assert.match(extraArgs.body.error.message, /at most 0 value/);

    const badWindowId = await bridgeFetch(server, "/window/focus", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ windowId: "1" })
    });
    assert.equal(badWindowId.status, 400);
    assert.match(badWindowId.body.error.message, /windowId must be a positive integer/);
  } finally {
    await closeServer(server);
    await cleanup();
  }
});

test("main bridge rejects oversized request bodies", async () => {
  const { module, cleanup } = await loadMainBridgeExample();
  let server;

  try {
    await withEnv({ ENABLE_CODEX_BRIDGE: "1" }, async () => {
      server = module.startCodexBridge({
        token: "test-secret",
        maxBodyBytes: 8,
        port: 0
      });
      await once(server, "listening");
    });

    const response = await bridgeFetch(server, "/invoke", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-bridge-token": "test-secret"
      },
      body: JSON.stringify({ name: "app.getVersion", args: [] })
    });

    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "PAYLOAD_TOO_LARGE");
    assert.match(response.body.error.message, /exceeds 8 bytes/);
  } finally {
    await closeServer(server);
    await cleanup();
  }
});

test("main bridge lists registered handler metadata", async () => {
  const { module, cleanup } = await loadMainBridgeExample();
  let server;

  try {
    module.registerCodexBridgeHandler(
      "settings.snapshot",
      () => ({ theme: "dark" }),
      {
        description: "Return current settings.",
        args: [],
        returns: "object"
      }
    );

    await withEnv({ ENABLE_CODEX_BRIDGE: "1" }, async () => {
      server = module.startCodexBridge({
        token: "test-secret",
        port: 0
      });
      await once(server, "listening");
    });

    const response = await bridgeFetch(server, "/handlers", {
      headers: { "x-codex-bridge-token": "test-secret" }
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    const handlers = response.body.data;
    assert.deepEqual(
      handlers.map((handler) => handler.name),
      ["app.getPath", "app.getVersion", "settings.snapshot"]
    );
    assert.deepEqual(
      handlers.find((handler) => handler.name === "settings.snapshot"),
      {
        name: "settings.snapshot",
        description: "Return current settings.",
        args: [],
        returns: "object"
      }
    );
    const appGetPath = handlers.find((handler) => handler.name === "app.getPath");
    assert.equal(appGetPath.parameters[0].name, "name");
    assert.equal(appGetPath.parameters[0].type, "string");
    assert.ok(appGetPath.parameters[0].enum.includes("userData"));
  } finally {
    await closeServer(server);
    await cleanup();
  }
});

test("main bridge enforces handler parameter metadata", async () => {
  const { module, cleanup } = await loadMainBridgeExample();
  let server;

  try {
    module.registerCodexBridgeHandler(
      "math.add",
      (left, right) => Number(left) + Number(right),
      {
        description: "Add two numbers.",
        args: ["left: first addend", "right: second addend"],
        parameters: [
          { name: "left", type: "number", description: "First addend." },
          { name: "right", type: "number", description: "Second addend." }
        ],
        returns: "number"
      }
    );

    await withEnv({ ENABLE_CODEX_BRIDGE: "1" }, async () => {
      server = module.startCodexBridge({
        token: "test-secret",
        port: 0
      });
      await once(server, "listening");
    });

    const auth = { "x-codex-bridge-token": "test-secret" };
    const invoke = (name, args) => bridgeFetch(server, "/invoke", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name, args })
    });

    const ok = await invoke("math.add", [2, 3]);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data, 5);

    const badType = await invoke("math.add", ["2", 3]);
    assert.equal(badType.status, 400);
    assert.match(badType.body.error.message, /args\[0\] \(left\) must be a finite number/);

    const missing = await invoke("math.add", [2]);
    assert.equal(missing.status, 400);
    assert.match(missing.body.error.message, /args\[1\] \(right\) is required/);

    const extra = await invoke("math.add", [2, 3, 4]);
    assert.equal(extra.status, 400);
    assert.match(extra.body.error.message, /at most 2 value/);

    const badEnum = await invoke("app.getPath", ["not-real"]);
    assert.equal(badEnum.status, 400);
    assert.match(badEnum.body.error.message, /args\[0\] \(name\) must be one of/);
  } finally {
    await closeServer(server);
    await cleanup();
  }
});

test("main bridge validates handler registry metadata", async () => {
  const { module, cleanup } = await loadMainBridgeExample();

  try {
    assert.throws(
      () => module.registerCodexBridgeHandler(null, () => null),
      /handler name/
    );
    assert.throws(
      () => module.registerCodexBridgeHandler("bad.description", () => null, { description: "" }),
      /metadata description/
    );
    assert.throws(
      () => module.registerCodexBridgeHandler("bad.args", () => null, { args: ["ok", ""] }),
      /metadata args\[1\]/
    );
    assert.throws(
      () => module.registerCodexBridgeHandler("bad.returns", () => null, { returns: 42 }),
      /metadata returns/
    );
    assert.throws(
      () => module.registerCodexBridgeHandler("bad.parameters", () => null, { parameters: "nope" }),
      /metadata parameters/
    );
    assert.throws(
      () => module.registerCodexBridgeHandler("bad.parameter.name", () => null, { parameters: [{ type: "string" }] }),
      /parameters\[0\]\.name/
    );
    assert.throws(
      () => module.registerCodexBridgeHandler("bad.parameter.enum", () => null, { parameters: [{ name: "kind", enum: [{}] }] }),
      /parameters\[0\]\.enum\[0\]/
    );
  } finally {
    await cleanup();
  }
});

test("MCP server rejects malformed bridge and CDP tool calls cleanly", async () => {
  const invokeResult = await callMcpTool("electron_bridge_invoke", {
    name: "",
    args: []
  });
  assert.equal(invokeResult.isError, true);
  assert.match(invokeResult.content[0].text, /name must be a non-empty string/);

  const clickResult = await callMcpTool("electron_cdp_click", {
    x: "bad",
    y: 2
  });
  assert.equal(clickResult.isError, true);
  assert.match(clickResult.content[0].text, /x must be a finite number/);

  const getBodyResult = await callMcpTool("electron_bridge_request", {
    path: "/health",
    method: "GET",
    body: { unsupported: true }
  });
  assert.equal(getBodyResult.isError, true);
  assert.match(getBodyResult.content[0].text, /body is only supported for POST/);
});

test("MCP server reports tools and can run text-only orchestrator smoke", async () => {
  const responses = await runMcp([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "electron_orchestrator_inspect",
        arguments: {
          includeRendererProbe: false,
          includeScreenshot: false
        }
      }
    }
  ]);

  assert.equal(responses.get(1).result.serverInfo.name, "electron-codex-bridge");
  assert.ok(
    responses.get(2).result.tools.some(
      (tool) => tool.name === "electron_orchestrator_inspect"
    )
  );
  assert.ok(
    responses.get(2).result.tools.some(
      (tool) => tool.name === "electron_bridge_list_handlers"
    )
  );

  const report = JSON.parse(responses.get(3).result.content[0].text);
  assert.equal(report.bridge.auth.tokenConfigured, false);
  assert.equal(report.cdp.url, "http://127.0.0.1:9223");
});

test("target selection prefers focused BrowserWindow matches when no targetId is set", async () => {
  const { module, cleanup } = await loadMcpInternals();
  try {
    const targets = [
      createCdpTarget({ id: "background", url: "app://background", title: "Background" }),
      createCdpTarget({ id: "focused", url: "app://focused", title: "Focused Window" })
    ];

    const result = await module.selectTarget({}, {
      targets,
      windows: [
        { id: 1, url: "app://focused", title: "Focused Window", focused: true, visible: true }
      ]
    });

    assert.equal(result.target.id, "focused");
    assert.equal(result.selection.reason, "focused BrowserWindow matched by url");
    assert.equal(result.selection.matchedFocusedWindow, true);
  } finally {
    await cleanup();
  }
});

test("target selection keeps explicit targetId stronger than focused window", async () => {
  const { module, cleanup } = await loadMcpInternals();
  try {
    const targets = [
      createCdpTarget({ id: "explicit", url: "app://explicit", title: "Explicit" }),
      createCdpTarget({ id: "focused", url: "app://focused", title: "Focused Window" })
    ];

    const result = await module.selectTarget({ targetId: "explicit" }, {
      targets,
      windows: [
        { id: 1, url: "app://focused", title: "Focused Window", focused: true, visible: true }
      ]
    });

    assert.equal(result.target.id, "explicit");
    assert.equal(result.selection.reason, "explicit targetId matched");
    assert.equal(result.selection.matchedFocusedWindow, false);
  } finally {
    await cleanup();
  }
});

test("target selection reports ambiguity for multiple urlIncludes matches", async () => {
  const { module, cleanup } = await loadMcpInternals();
  try {
    const targets = [
      createCdpTarget({ id: "settings-one", url: "app://settings/one", title: "Settings" }),
      createCdpTarget({ id: "settings-two", url: "app://settings/two", title: "Settings - Focused" })
    ];

    const result = await module.selectTarget({ urlIncludes: "settings" }, {
      targets,
      windows: [
        { id: 1, url: "app://settings/two", title: "Settings - Focused", focused: true, visible: true }
      ]
    });

    assert.equal(result.target.id, "settings-two");
    assert.equal(result.selection.reason, "focused BrowserWindow matched by url");
    assert.ok(result.selection.notes.some((note) => note.includes("urlIncludes matched 2")));
  } finally {
    await cleanup();
  }
});

async function loadMainBridgeExample() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "electron-codex-bridge-test-"));
  const modulePath = path.join(tempDir, "electron-main-bridge-example.mjs");
  const source = await readFile(MAIN_BRIDGE_EXAMPLE_PATH, "utf8");

  await writeFile(modulePath, toRunnableMainBridgeModule(source), "utf8");

  const stubs = createElectronStubs();
  globalThis.__electronBridgeTest = stubs;

  const module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
  return {
    module,
    stubs,
    async cleanup() {
      delete globalThis.__electronBridgeTest;
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

async function loadMcpInternals() {
  const tempDir = await mkdtemp(path.join(tmpdir(), "electron-codex-bridge-mcp-test-"));
  const modulePath = path.join(tempDir, "electron-codex-bridge-internals.mjs");
  const source = await readFile(MCP_SERVER_PATH, "utf8");
  const transformed = source.replace(
    /const rl = readline\.createInterface\([\s\S]*$/m,
    "export { selectTarget };\n"
  );

  await writeFile(modulePath, transformed, "utf8");

  const module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
  return {
    module,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

function createCdpTarget(overrides) {
  return {
    id: "target",
    type: "page",
    title: "",
    url: "",
    webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/target",
    ...overrides
  };
}

function toRunnableMainBridgeModule(source) {
  let transformed = source
    .replace(
      'import http from "node:http";',
      "const http = globalThis.__electronBridgeTest.http;"
    )
    .replace(
      'import { app, BrowserWindow } from "electron";',
      [
        "const { app, BrowserWindow } = globalThis.__electronBridgeTest;",
        'if (!app || !BrowserWindow) throw new Error("Electron bridge test stubs are not installed.");'
      ].join("\n")
    )
    .replace(/^type BridgeHandler = .*\n\n/m, "")
    .replace(/export type CodexBridgeHandlerParameterType =[\s\S]*?;\n\n/, "")
    .replace(/export type CodexBridgeHandlerParameterMetadata = \{[\s\S]*?\};\n\n/, "")
    .replace(/export type CodexBridgeHandlerMetadata = \{[\s\S]*?\};\n\n/, "")
    .replace(/type BridgeHandlerRecord = \{[\s\S]*?\};\n\n/, "")
    .replace(/export type CodexBridgeOptions = \{[\s\S]*?\};\n\n/, "")
    .replace(/new Map<string, BridgeHandlerRecord>\(\)/g, "new Map()")
    .replace(/export function registerCodexBridgeHandler\(\s*name: string,\s*handler: BridgeHandler,\s*metadata: CodexBridgeHandlerMetadata = \{\}\s*\): void/m, "function registerCodexBridgeHandler(name, handler, metadata = {})")
    .replace(/export function startCodexBridge\(options: CodexBridgeOptions = \{\}\): http\.Server \| undefined/g, "function startCodexBridge(options = {})")
    .replace(/app\.getPath\(String\(name\) as Parameters<typeof app\.getPath>\[0\]\)/g, "app.getPath(String(name))")
    .replace(/function describeWindow\(win: BrowserWindow\)/g, "function describeWindow(win)")
    .replace(/function validateHandlerArgs\(\s*parameters: CodexBridgeHandlerParameterMetadata\[\] \| undefined,\s*args: unknown\[\]\s*\): void/m, "function validateHandlerArgs(parameters, args)")
    .replace(/function validateHandlerArg\(\s*parameter: CodexBridgeHandlerParameterMetadata,\s*value: unknown,\s*index: number\s*\): void/m, "function validateHandlerArg(parameter, value, index)")
    .replace(/function matchesParameterType\(type: CodexBridgeHandlerParameterType, value: unknown\): boolean/g, "function matchesParameterType(type, value)")
    .replace(/function expectedTypeLabel\(type: CodexBridgeHandlerParameterType\): string/g, "function expectedTypeLabel(type)")
    .replace(/function findWindow\(windowId: unknown\): BrowserWindow/g, "function findWindow(windowId)")
    .replace(/function isAuthorized\(req: http\.IncomingMessage, token: string\): boolean/g, "function isAuthorized(req, token)")
    .replace(/function constantTimeEquals\(actual: string, expected: string\): boolean/g, "function constantTimeEquals(actual, expected)")
    .replace(/constructor\(\s*readonly status: number,\s*message: string,\s*readonly code: string = bridgeErrorCodeForStatus\(status\)\s*\) \{/m, "constructor(status, message, code = bridgeErrorCodeForStatus(status)) {")
    .replace(/super\(message\);/g, "super(message);\n    this.status = status;\n    this.code = code;")
    .replace(/function bridgeErrorCodeForStatus\(status: number\): string/g, "function bridgeErrorCodeForStatus(status)")
    .replace(/function resolveMaxBodyBytes\(optionValue: number \| undefined\): number/g, "function resolveMaxBodyBytes(optionValue)")
    .replace(/function normalizeHandlerMetadata\(metadata: CodexBridgeHandlerMetadata\): CodexBridgeHandlerMetadata/g, "function normalizeHandlerMetadata(metadata)")
    .replace(/function normalizeOptionalMetadataString\(\s*value: unknown,\s*fieldName: string,\s*maxLength: number\s*\): string \| undefined/m, "function normalizeOptionalMetadataString(value, fieldName, maxLength)")
    .replace(/function normalizeHandlerArgDescriptions\(value: unknown\): string\[\] \| undefined/g, "function normalizeHandlerArgDescriptions(value)")
    .replace(/function normalizeHandlerParameters\(value: unknown\): CodexBridgeHandlerParameterMetadata\[\] \| undefined/g, "function normalizeHandlerParameters(value)")
    .replace(/function normalizeHandlerParameter\(value: unknown, index: number\): CodexBridgeHandlerParameterMetadata/g, "function normalizeHandlerParameter(value, index)")
    .replace(/function normalizeHandlerParameterType\(\s*value: unknown,\s*index: number\s*\): CodexBridgeHandlerParameterType/m, "function normalizeHandlerParameterType(value, index)")
    .replace(/return value as CodexBridgeHandlerParameterType;/g, "return value;")
    .replace(/function normalizeRequiredMetadataString\(\s*value: unknown,\s*fieldName: string,\s*maxLength: number\s*\): string/m, "function normalizeRequiredMetadataString(value, fieldName, maxLength)")
    .replace(/function normalizeOptionalMetadataBoolean\(\s*value: unknown,\s*fieldName: string,\s*defaultValue: boolean\s*\): boolean/m, "function normalizeOptionalMetadataBoolean(value, fieldName, defaultValue)")
    .replace(/function normalizeHandlerEnumValues\(\s*value: unknown,\s*fieldName: string\s*\): Array<string \| number \| boolean \| null> \| undefined/m, "function normalizeHandlerEnumValues(value, fieldName)")
    .replace(/async function readJsonBody\(\s*req: http\.IncomingMessage,\s*maxBodyBytes: number\s*\): Promise<Record<string, unknown>>/m, "async function readJsonBody(req, maxBodyBytes)")
    .replace(/const chunks: Buffer\[\] = \[\];/g, "const chunks = [];")
    .replace(/let parsed: unknown;/g, "let parsed;")
    .replace(/function requireNonEmptyString\(value: unknown, fieldName: string, maxLength: number\): string/g, "function requireNonEmptyString(value, fieldName, maxLength)")
    .replace(/function requireArray\(value: unknown, fieldName: string\): unknown\[\]/g, "function requireArray(value, fieldName)")
    .replace(/function requirePositiveInteger\(value: unknown, fieldName: string\): number/g, "function requirePositiveInteger(value, fieldName)")
    .replace(/function requireOptionalBoolean\(value: unknown, fieldName: string\): boolean \| undefined/g, "function requireOptionalBoolean(value, fieldName)")
    .replace(/function isJsonObject\(value: unknown\): value is Record<string, unknown>/g, "function isJsonObject(value)")
    .replace(/function isJsonPrimitive\(value: unknown\): value is string \| number \| boolean \| null/g, "function isJsonPrimitive(value)")
    .replace(/function errorMessage\(error: unknown\): string/g, "function errorMessage(error)")
    .replace(/function sendData\(res: http\.ServerResponse, status: number, data: unknown\): void/g, "function sendData(res, status, data)")
    .replace(/function sendError\(res: http\.ServerResponse, status: number, code: string, message: string\): void/g, "function sendError(res, status, code, message)")
    .replace(/function formatJsonLiteral\(value: string \| number \| boolean \| null\): string/g, "function formatJsonLiteral(value)")
    .replace(/function sendJson\(res: http\.ServerResponse, status: number, payload: unknown\): void/g, "function sendJson(res, status, payload)");

  transformed += "\nexport { registerCodexBridgeHandler, startCodexBridge };\n";
  return transformed;
}

function createElectronStubs() {
  const windows = new Map();
  const sentMessages = [];
  const devToolsEvents = [];

  const app = {
    getVersion: () => "9.9.9-test",
    getPath: (name) => `/test/${name}`
  };

  const BrowserWindow = {
    getAllWindows: () => [...windows.values()],
    fromId: (id) => windows.get(id)
  };

  windows.set(1, {
    id: 1,
    getTitle: () => "Test Window",
    isFocused: () => true,
    isVisible: () => true,
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    focus() {
      this.focused = true;
    },
    webContents: {
      getURL: () => "app://test",
      send: (...args) => sentMessages.push(args),
      openDevTools: (options) => devToolsEvents.push(["open", options]),
      closeDevTools: () => devToolsEvents.push(["close"]),
      executeJavaScript: async (expression) => ({ expression })
    }
  });

  return {
    app,
    BrowserWindow,
    http: createFakeHttp(),
    sentMessages,
    devToolsEvents
  };
}

function createFakeHttp() {
  let nextPort = 20000;

  return {
    createServer(listener) {
      return new FakeServer(listener, () => nextPort++);
    }
  };
}

class FakeServer extends EventEmitter {
  constructor(listener, nextPort) {
    super();
    this.listener = listener;
    this.nextPort = nextPort;
    this.listening = false;
    this.serverAddress = null;
  }

  listen(port, host) {
    this.listening = true;
    this.serverAddress = {
      address: host,
      family: "IPv4",
      port: port === 0 ? this.nextPort() : port
    };
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  address() {
    return this.serverAddress;
  }

  close(callback) {
    this.listening = false;
    queueMicrotask(() => {
      this.emit("close");
      callback?.();
    });
  }

  async fetch(pathname, options = {}) {
    let finish;
    const response = new Promise((resolve) => {
      finish = resolve;
    });
    const request = new FakeRequest(pathname, options);
    const serverResponse = new FakeResponse(finish);

    await this.listener(request, serverResponse);
    return response;
  }
}

class FakeRequest extends Readable {
  constructor(pathname, options) {
    super();
    this.method = options.method || "GET";
    this.url = pathname;
    this.headers = normalizeHeaders(options.headers || {});
    this.body = options.body === undefined ? undefined : Buffer.from(String(options.body));
    this.didRead = false;
  }

  _read() {
    if (this.didRead) {
      this.push(null);
      return;
    }

    this.didRead = true;
    if (this.body) {
      this.push(this.body);
    }
    this.push(null);
  }
}

class FakeResponse {
  constructor(finish) {
    this.finish = finish;
    this.status = 200;
    this.headers = {};
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers || {};
  }

  end(payload = "") {
    this.finish({
      status: this.status,
      body: payload ? JSON.parse(String(payload)) : undefined,
      headers: this.headers
    });
  }
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

async function bridgeFetch(server, pathname, options = {}) {
  return server.fetch(pathname, options);
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withEnv(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function callMcpTool(name, args) {
  const responses = await runMcp([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    }
  ]);
  return responses.get(1).result;
}

async function runMcp(messages) {
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      CODEX_ELECTRON_BRIDGE_TOKEN: ""
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin.end();

  const [code, signal] = await once(child, "close");
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);

  const responses = new Map();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line);
    responses.set(parsed.id, parsed);
  }
  return responses;
}
