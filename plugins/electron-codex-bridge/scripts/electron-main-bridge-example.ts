import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { app, BrowserWindow } from "electron";

import { BridgeRequestError, errorMessage, sendData, sendError } from "./bridge/envelope.ts";
import {
  readJsonBody,
  requireArray,
  requireNonEmptyString,
  requireOptionalBoolean,
  requirePositiveInteger,
  resolveMaxBodyBytes
} from "./bridge/validation.ts";
import {
  describeHandlers,
  getCodexBridgeHandler,
  MAX_HANDLER_NAME_LENGTH,
  registerCodexBridgeHandler,
  validateHandlerArgs
} from "./bridge/registry.ts";

export { registerCodexBridgeHandler };
export type {
  BridgeHandler,
  CodexBridgeHandlerMetadata,
  CodexBridgeHandlerParameterMetadata,
  CodexBridgeHandlerParameterType
} from "./bridge/registry.ts";

export type CodexBridgeOptions = {
  host?: string;
  port?: number;
  token?: string;
  allowUnauthenticated?: boolean;
  allowExecuteJavaScript?: boolean;
  maxBodyBytes?: number;
};

const MAX_CHANNEL_NAME_LENGTH = 160;
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
        sendError(res, 401, "UNAUTHORIZED", "Unauthorized");
        return;
      }

      const url = new URL(req.url || "/", `http://${host}:${port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendData(res, 200, {
          appVersion: app.getVersion(),
          auth: { required: !allowUnauthenticated }
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/windows") {
        sendData(res, 200, BrowserWindow.getAllWindows().map(describeWindow));
        return;
      }

      if (req.method === "GET" && url.pathname === "/handlers") {
        sendData(res, 200, describeHandlers());
        return;
      }

      if (req.method === "POST" && url.pathname === "/invoke") {
        const body = await readJsonBody(req, maxBodyBytes);
        const name = requireNonEmptyString(body.name, "name", MAX_HANDLER_NAME_LENGTH);
        const record = getCodexBridgeHandler(name);
        if (!record) {
          sendError(res, 404, "HANDLER_NOT_FOUND", `No Codex bridge handler is registered for '${name}'.`);
          return;
        }

        const args = requireArray(
          Object.prototype.hasOwnProperty.call(body, "args") ? body.args : [],
          "args"
        );
        validateHandlerArgs(record.metadata.parameters, args);
        try {
          sendData(res, 200, await record.handler(...args));
        } catch (error) {
          sendError(res, 500, "HANDLER_ERROR", errorMessage(error));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/window/focus") {
        const body = await readJsonBody(req, maxBodyBytes);
        const win = findWindow(body.windowId);
        win.focus();
        sendData(res, 200, { window: describeWindow(win) });
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
        sendData(res, 200, { window: describeWindow(win) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/renderer/send") {
        const body = await readJsonBody(req, maxBodyBytes);
        const win = findWindow(body.windowId);
        const channel = requireNonEmptyString(body.channel, "channel", MAX_CHANNEL_NAME_LENGTH);
        win.webContents.send(channel, body.payload);
        sendData(res, 200, { sent: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/renderer/execute-js") {
        if (!allowExecuteJavaScript) {
          sendError(res, 403, "EXECUTE_JAVASCRIPT_DISABLED", "renderer/execute-js is disabled. Pass allowExecuteJavaScript: true in development only.");
          return;
        }

        const body = await readJsonBody(req, maxBodyBytes);
        const win = findWindow(body.windowId);
        const expression = requireNonEmptyString(body.expression, "expression", maxBodyBytes);
        const result = await win.webContents.executeJavaScript(expression, true);
        sendData(res, 200, result);
        return;
      }

      sendError(res, 404, "NOT_FOUND", "Not found");
    } catch (error) {
      if (error instanceof BridgeRequestError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }

      sendError(res, 500, "INTERNAL_ERROR", errorMessage(error));
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

function findWindow(windowId: unknown): BrowserWindow {
  const id = requirePositiveInteger(windowId, "windowId");
  const win = BrowserWindow.fromId(id);
  if (!win) throw new BridgeRequestError(404, `No BrowserWindow found for id ${id}.`, "WINDOW_NOT_FOUND");
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
