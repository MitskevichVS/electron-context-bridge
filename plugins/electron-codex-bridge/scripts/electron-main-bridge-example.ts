import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { app, BrowserWindow } from "electron";

type BridgeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export type CodexBridgeOptions = {
  host?: string;
  port?: number;
  token?: string;
  allowUnauthenticated?: boolean;
  allowExecuteJavaScript?: boolean;
};

const handlers = new Map<string, BridgeHandler>();

export function registerCodexBridgeHandler(name: string, handler: BridgeHandler): void {
  handlers.set(name, handler);
}

export function startCodexBridge(options: CodexBridgeOptions = {}): http.Server | undefined {
  if (process.env.ENABLE_CODEX_BRIDGE !== "1") return undefined;

  const host = options.host || "127.0.0.1";
  const port = options.port || Number(process.env.CODEX_ELECTRON_BRIDGE_PORT || 17345);
  const token = options.token || process.env.CODEX_ELECTRON_BRIDGE_TOKEN || "";
  const allowUnauthenticated =
    options.allowUnauthenticated === true ||
    process.env.CODEX_ELECTRON_BRIDGE_ALLOW_UNAUTHENTICATED === "1";
  const allowExecuteJavaScript = options.allowExecuteJavaScript === true;

  if (!token && !allowUnauthenticated) {
    throw new Error(
      "Codex bridge auth token is required. Set CODEX_ELECTRON_BRIDGE_TOKEN, " +
        "or pass allowUnauthenticated: true for local development only. " +
        "CODEX_ELECTRON_BRIDGE_ALLOW_UNAUTHENTICATED=1 is also available for short-lived local debugging."
    );
  }

  registerCodexBridgeHandler("app.getVersion", () => app.getVersion());
  registerCodexBridgeHandler("app.getPath", (name) => app.getPath(String(name) as Parameters<typeof app.getPath>[0]));

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

      if (req.method === "POST" && url.pathname === "/invoke") {
        const body = await readJsonBody(req);
        const name = String(body.name || "");
        const handler = handlers.get(name);
        if (!handler) {
          sendJson(res, 404, { error: `No Codex bridge handler is registered for '${name}'.` });
          return;
        }

        const args = Array.isArray(body.args) ? body.args : [];
        sendJson(res, 200, { result: await handler(...args) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/window/focus") {
        const body = await readJsonBody(req);
        const win = findWindow(body.windowId);
        win.focus();
        sendJson(res, 200, { ok: true, window: describeWindow(win) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/window/devtools") {
        const body = await readJsonBody(req);
        const win = findWindow(body.windowId);
        if (body.open === false) {
          win.webContents.closeDevTools();
        } else {
          win.webContents.openDevTools({ mode: "detach" });
        }
        sendJson(res, 200, { ok: true, window: describeWindow(win) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/renderer/send") {
        const body = await readJsonBody(req);
        const win = findWindow(body.windowId);
        win.webContents.send(String(body.channel), body.payload);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/renderer/execute-js") {
        if (!allowExecuteJavaScript) {
          sendJson(res, 403, { error: "renderer/execute-js is disabled. Pass allowExecuteJavaScript: true in development only." });
          return;
        }

        const body = await readJsonBody(req);
        const win = findWindow(body.windowId);
        const result = await win.webContents.executeJavaScript(String(body.expression), true);
        sendJson(res, 200, { result });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
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

function findWindow(windowId: unknown): BrowserWindow {
  const id = Number(windowId);
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

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}
