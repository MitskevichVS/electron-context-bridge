import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { app, BrowserWindow } from "electron";

type BridgeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export type CodexBridgeHandlerParameterType =
  | "any"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export type CodexBridgeHandlerParameterMetadata = {
  name: string;
  type?: CodexBridgeHandlerParameterType;
  required?: boolean;
  description?: string;
  enum?: Array<string | number | boolean | null>;
};

export type CodexBridgeHandlerMetadata = {
  description?: string;
  args?: string[];
  parameters?: CodexBridgeHandlerParameterMetadata[];
  returns?: string;
};

type BridgeHandlerRecord = {
  handler: BridgeHandler;
  metadata: CodexBridgeHandlerMetadata;
};

export type CodexBridgeOptions = {
  host?: string;
  port?: number;
  token?: string;
  allowUnauthenticated?: boolean;
  allowExecuteJavaScript?: boolean;
  maxBodyBytes?: number;
};

const handlers = new Map<string, BridgeHandlerRecord>();
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_HANDLER_NAME_LENGTH = 120;
const MAX_CHANNEL_NAME_LENGTH = 160;
const MAX_HANDLER_DESCRIPTION_LENGTH = 500;
const MAX_HANDLER_ARG_DESCRIPTION_LENGTH = 160;
const MAX_HANDLER_PARAMETER_COUNT = 20;
const MAX_HANDLER_PARAMETER_NAME_LENGTH = 80;
const MAX_HANDLER_PARAMETER_ENUM_VALUES = 100;
const MAX_HANDLER_RETURNS_LENGTH = 160;
const HANDLER_PARAMETER_TYPES = new Set([
  "any",
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null"
]);
const ELECTRON_APP_PATH_NAMES = [
  "home",
  "appData",
  "userData",
  "sessionData",
  "temp",
  "exe",
  "module",
  "desktop",
  "documents",
  "downloads",
  "music",
  "pictures",
  "videos",
  "recent",
  "logs",
  "crashDumps"
];

export function registerCodexBridgeHandler(
  name: string,
  handler: BridgeHandler,
  metadata: CodexBridgeHandlerMetadata = {}
): void {
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_HANDLER_NAME_LENGTH) {
    throw new Error(`Codex bridge handler name must be 1-${MAX_HANDLER_NAME_LENGTH} characters.`);
  }
  if (typeof handler !== "function") {
    throw new Error("Codex bridge handler must be a function.");
  }
  handlers.set(name, {
    handler,
    metadata: normalizeHandlerMetadata(metadata)
  });
}

export function startCodexBridge(options: CodexBridgeOptions = {}): http.Server | undefined {
  if (process.env.ENABLE_CODEX_BRIDGE !== "1") return undefined;

  const host = options.host || "127.0.0.1";
  const port = options.port ?? Number(process.env.CODEX_ELECTRON_BRIDGE_PORT || 17345);
  const token = options.token || process.env.CODEX_ELECTRON_BRIDGE_TOKEN || "";
  const allowUnauthenticated =
    options.allowUnauthenticated === true ||
    process.env.CODEX_ELECTRON_BRIDGE_ALLOW_UNAUTHENTICATED === "1";
  const allowExecuteJavaScript = options.allowExecuteJavaScript === true;
  const maxBodyBytes = resolveMaxBodyBytes(options.maxBodyBytes);

  if (!token && !allowUnauthenticated) {
    throw new Error(
      "Codex bridge auth token is required. Set CODEX_ELECTRON_BRIDGE_TOKEN, " +
        "or pass allowUnauthenticated: true for local development only. " +
        "CODEX_ELECTRON_BRIDGE_ALLOW_UNAUTHENTICATED=1 is also available for short-lived local debugging."
    );
  }

  registerCodexBridgeHandler("app.getVersion", () => app.getVersion(), {
    description: "Return the Electron app version.",
    args: [],
    parameters: [],
    returns: "string"
  });
  registerCodexBridgeHandler("app.getPath", (name) => app.getPath(String(name) as Parameters<typeof app.getPath>[0]), {
    description: "Return a path from Electron app.getPath.",
    args: ["name: Electron app path name"],
    parameters: [
      {
        name: "name",
        type: "string",
        description: "Electron app path name.",
        enum: ELECTRON_APP_PATH_NAMES
      }
    ],
    returns: "string"
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowUnauthenticated && !isAuthorized(req, token)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const url = new URL(req.url || "/", `http://${host}:${port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          appVersion: app.getVersion(),
          auth: { required: !allowUnauthenticated }
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/windows") {
        sendJson(res, 200, BrowserWindow.getAllWindows().map(describeWindow));
        return;
      }

      if (req.method === "GET" && url.pathname === "/handlers") {
        sendJson(res, 200, describeHandlers());
        return;
      }

      if (req.method === "POST" && url.pathname === "/invoke") {
        const body = await readJsonBody(req, maxBodyBytes);
        const name = requireNonEmptyString(body.name, "name", MAX_HANDLER_NAME_LENGTH);
        const record = handlers.get(name);
        if (!record) {
          sendJson(res, 404, { error: `No Codex bridge handler is registered for '${name}'.` });
          return;
        }

        const args = requireArray(
          Object.prototype.hasOwnProperty.call(body, "args") ? body.args : [],
          "args"
        );
        validateHandlerArgs(record.metadata.parameters, args);
        sendJson(res, 200, { result: await record.handler(...args) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/window/focus") {
        const body = await readJsonBody(req, maxBodyBytes);
        const win = findWindow(body.windowId);
        win.focus();
        sendJson(res, 200, { ok: true, window: describeWindow(win) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/window/devtools") {
        const body = await readJsonBody(req, maxBodyBytes);
        const win = findWindow(body.windowId);
        const open = requireOptionalBoolean(body.open, "open");
        if (open === false) {
          win.webContents.closeDevTools();
        } else {
          win.webContents.openDevTools({ mode: "detach" });
        }
        sendJson(res, 200, { ok: true, window: describeWindow(win) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/renderer/send") {
        const body = await readJsonBody(req, maxBodyBytes);
        const win = findWindow(body.windowId);
        const channel = requireNonEmptyString(body.channel, "channel", MAX_CHANNEL_NAME_LENGTH);
        win.webContents.send(channel, body.payload);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/renderer/execute-js") {
        if (!allowExecuteJavaScript) {
          sendJson(res, 403, { error: "renderer/execute-js is disabled. Pass allowExecuteJavaScript: true in development only." });
          return;
        }

        const body = await readJsonBody(req, maxBodyBytes);
        const win = findWindow(body.windowId);
        const expression = requireNonEmptyString(body.expression, "expression", maxBodyBytes);
        const result = await win.webContents.executeJavaScript(expression, true);
        sendJson(res, 200, { result });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof BridgeRequestError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }

      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(port, host);
  return server;
}

function describeWindow(win: BrowserWindow) {
  return {
    id: win.id,
    title: win.getTitle(),
    url: win.webContents.getURL(),
    focused: win.isFocused(),
    visible: win.isVisible(),
    destroyed: win.isDestroyed(),
    bounds: win.getBounds()
  };
}

function describeHandlers() {
  return [...handlers.entries()]
    .map(([name, record]) => ({
      name,
      ...record.metadata
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function validateHandlerArgs(
  parameters: CodexBridgeHandlerParameterMetadata[] | undefined,
  args: unknown[]
): void {
  if (parameters === undefined) return;
  if (args.length > parameters.length) {
    throw new BridgeRequestError(400, `args must contain at most ${parameters.length} value(s) for this handler.`);
  }

  parameters.forEach((parameter, index) => {
    if (index >= args.length) {
      if (parameter.required !== false) {
        throw new BridgeRequestError(400, `args[${index}] (${parameter.name}) is required.`);
      }
      return;
    }

    validateHandlerArg(parameter, args[index], index);
  });
}

function validateHandlerArg(
  parameter: CodexBridgeHandlerParameterMetadata,
  value: unknown,
  index: number
): void {
  const label = `args[${index}] (${parameter.name})`;
  const type = parameter.type || "any";

  if (!matchesParameterType(type, value)) {
    throw new BridgeRequestError(400, `${label} must be ${expectedTypeLabel(type)}.`);
  }

  if (parameter.enum && !parameter.enum.some((item) => Object.is(item, value))) {
    throw new BridgeRequestError(400, `${label} must be one of: ${parameter.enum.map(formatJsonLiteral).join(", ")}.`);
  }
}

function matchesParameterType(type: CodexBridgeHandlerParameterType, value: unknown): boolean {
  switch (type) {
    case "any":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isJsonObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
  }
}

function expectedTypeLabel(type: CodexBridgeHandlerParameterType): string {
  switch (type) {
    case "number":
      return "a finite number";
    case "integer":
      return "a safe integer";
    case "object":
      return "a JSON object";
    case "array":
      return "an array";
    case "null":
      return "null";
    case "any":
      return "any JSON value";
    default:
      return `a ${type}`;
  }
}

function findWindow(windowId: unknown): BrowserWindow {
  const id = requirePositiveInteger(windowId, "windowId");
  const win = BrowserWindow.fromId(id);
  if (!win) throw new Error(`No BrowserWindow found for id ${id}.`);
  return win;
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const authorization = req.headers.authorization || "";
  const headerToken = req.headers["x-codex-bridge-token"];
  return (
    constantTimeEquals(authorization, `Bearer ${token}`) ||
    (typeof headerToken === "string" && constantTimeEquals(headerToken, token))
  );
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

class BridgeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, BridgeRequestError.prototype);
  }
}

function resolveMaxBodyBytes(optionValue: number | undefined): number {
  const envValue = process.env.CODEX_ELECTRON_BRIDGE_MAX_BODY_BYTES;
  const value = optionValue ?? (envValue ? Number(envValue) : DEFAULT_MAX_BODY_BYTES);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Codex bridge maxBodyBytes must be a positive safe integer.");
  }
  return value;
}

function normalizeHandlerMetadata(metadata: CodexBridgeHandlerMetadata): CodexBridgeHandlerMetadata {
  if (!isJsonObject(metadata)) {
    throw new Error("Codex bridge handler metadata must be an object.");
  }

  return {
    description: normalizeOptionalMetadataString(
      metadata.description,
      "description",
      MAX_HANDLER_DESCRIPTION_LENGTH
    ),
    args: normalizeHandlerArgDescriptions(metadata.args),
    parameters: normalizeHandlerParameters(metadata.parameters),
    returns: normalizeOptionalMetadataString(
      metadata.returns,
      "returns",
      MAX_HANDLER_RETURNS_LENGTH
    )
  };
}

function normalizeOptionalMetadataString(
  value: unknown,
  fieldName: string,
  maxLength: number
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be at most ${maxLength} characters.`);
  }
  return value;
}

function normalizeHandlerArgDescriptions(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Codex bridge handler metadata args must be an array.");
  }

  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`Codex bridge handler metadata args[${index}] must be a non-empty string.`);
    }
    if (item.length > MAX_HANDLER_ARG_DESCRIPTION_LENGTH) {
      throw new Error(`Codex bridge handler metadata args[${index}] must be at most ${MAX_HANDLER_ARG_DESCRIPTION_LENGTH} characters.`);
    }
    return item;
  });
}

function normalizeHandlerParameters(value: unknown): CodexBridgeHandlerParameterMetadata[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Codex bridge handler metadata parameters must be an array.");
  }
  if (value.length > MAX_HANDLER_PARAMETER_COUNT) {
    throw new Error(`Codex bridge handler metadata parameters must contain at most ${MAX_HANDLER_PARAMETER_COUNT} entries.`);
  }

  return value.map(normalizeHandlerParameter);
}

function normalizeHandlerParameter(value: unknown, index: number): CodexBridgeHandlerParameterMetadata {
  if (!isJsonObject(value)) {
    throw new Error(`Codex bridge handler metadata parameters[${index}] must be an object.`);
  }

  const name = normalizeRequiredMetadataString(
    value.name,
    `parameters[${index}].name`,
    MAX_HANDLER_PARAMETER_NAME_LENGTH
  );
  const type = normalizeHandlerParameterType(value.type, index);
  const required = normalizeOptionalMetadataBoolean(
    value.required,
    `parameters[${index}].required`,
    true
  );
  const description = normalizeOptionalMetadataString(
    value.description,
    `parameters[${index}].description`,
    MAX_HANDLER_ARG_DESCRIPTION_LENGTH
  );
  const enumValues = normalizeHandlerEnumValues(value.enum, `parameters[${index}].enum`);

  return {
    name,
    type,
    required,
    description,
    enum: enumValues
  };
}

function normalizeHandlerParameterType(
  value: unknown,
  index: number
): CodexBridgeHandlerParameterType {
  if (value === undefined) return "any";
  if (typeof value !== "string" || !HANDLER_PARAMETER_TYPES.has(value)) {
    throw new Error(`Codex bridge handler metadata parameters[${index}].type must be one of: ${[...HANDLER_PARAMETER_TYPES].join(", ")}.`);
  }
  return value as CodexBridgeHandlerParameterType;
}

function normalizeRequiredMetadataString(
  value: unknown,
  fieldName: string,
  maxLength: number
): string {
  const normalized = normalizeOptionalMetadataString(value, fieldName, maxLength);
  if (normalized === undefined) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeOptionalMetadataBoolean(
  value: unknown,
  fieldName: string,
  defaultValue: boolean
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be a boolean.`);
  }
  return value;
}

function normalizeHandlerEnumValues(
  value: unknown,
  fieldName: string
): Array<string | number | boolean | null> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must be an array.`);
  }
  if (value.length > MAX_HANDLER_PARAMETER_ENUM_VALUES) {
    throw new Error(`Codex bridge handler metadata ${fieldName} must contain at most ${MAX_HANDLER_PARAMETER_ENUM_VALUES} values.`);
  }

  return value.map((item, index) => {
    if (!isJsonPrimitive(item)) {
      throw new Error(`Codex bridge handler metadata ${fieldName}[${index}] must be a string, number, boolean, or null.`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error(`Codex bridge handler metadata ${fieldName}[${index}] must be a finite number.`);
    }
    return item;
  });
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBodyBytes: number
): Promise<Record<string, unknown>> {
  const contentLength = Array.isArray(req.headers["content-length"])
    ? req.headers["content-length"][0]
    : req.headers["content-length"];

  if (contentLength !== undefined) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new BridgeRequestError(400, "Invalid content-length header.");
    }
    if (declaredLength > maxBodyBytes) {
      throw new BridgeRequestError(413, `Request body exceeds ${maxBodyBytes} bytes.`);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new BridgeRequestError(413, `Request body exceeds ${maxBodyBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeRequestError(400, "Request body must be valid JSON.");
  }

  if (!isJsonObject(parsed)) {
    throw new BridgeRequestError(400, "Request body must be a JSON object.");
  }

  return parsed;
}

function requireNonEmptyString(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BridgeRequestError(400, `${fieldName} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new BridgeRequestError(400, `${fieldName} must be at most ${maxLength} characters.`);
  }
  return value;
}

function requireArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new BridgeRequestError(400, `${fieldName} must be an array.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BridgeRequestError(400, `${fieldName} must be a positive integer.`);
  }
  return value;
}

function requireOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new BridgeRequestError(400, `${fieldName} must be a boolean.`);
  }
  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function formatJsonLiteral(value: string | number | boolean | null): string {
  return JSON.stringify(value);
}
