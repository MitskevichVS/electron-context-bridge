# Electron Context Bridge

Codex plugin for inspecting and driving local Electron apps during development.

This repo packages `electron-codex-bridge`, a Codex plugin that exposes MCP tools for:

- Chrome DevTools Protocol access to Electron `BrowserWindow` renderer targets.
- A local Electron main-process bridge for explicit, allowlisted app actions.
- Browser-window operations such as listing targets, screenshots, clicks, typing, and renderer evaluation.
- Electron + React best-practice guidance for secure `contextBridge`, typed IPC, packaging, signing, and testing.

Use it as a local development bridge. Do not ship the bridge enabled in production builds.

## Repository Layout

```text
.agents/
  plugins/
    marketplace.json

plugins/
  electron-codex-bridge/
    .codex-plugin/
      plugin.json
    .mcp.json
    README.md
    scripts/
      electron-codex-bridge.mjs
      electron-main-bridge-example.ts
    skills/
      electron-codex-bridge/
        SKILL.md
      electron-best-practices/
        SKILL.md
        assets/
        references/
        scripts/
    assets/
```

Important files:

- `.agents/plugins/marketplace.json` registers this repo-local plugin with Codex.
- `plugins/electron-codex-bridge/.codex-plugin/plugin.json` describes the plugin.
- `plugins/electron-codex-bridge/.mcp.json` tells Codex how to launch the MCP server.
- `plugins/electron-codex-bridge/scripts/electron-codex-bridge.mjs` is the MCP server.
- `plugins/electron-codex-bridge/scripts/electron-main-bridge-example.ts` is the optional Electron main-process bridge example.
- `plugins/electron-codex-bridge/skills/electron-best-practices/SKILL.md` adds secure Electron + React development guidance and companion references/scripts.

## How Codex Finds The Plugin

Codex reads the repo-local marketplace file:

```text
.agents/plugins/marketplace.json
```

That file points at:

```text
./plugins/electron-codex-bridge
```

After cloning this repo, open the repo folder in Codex and enable/install the plugin named **Electron Codex Bridge**. If it does not appear immediately, reload or restart Codex so it re-reads the local marketplace.

## What The Plugin Provides

The plugin exposes these MCP tools:

- `electron_orchestrator_inspect`
- `electron_cdp_get_version`
- `electron_cdp_list_targets`
- `electron_cdp_evaluate`
- `electron_cdp_capture_screenshot`
- `electron_cdp_click`
- `electron_cdp_type`
- `electron_bridge_health`
- `electron_bridge_list_windows`
- `electron_bridge_invoke`
- `electron_bridge_request`

The CDP tools talk to Electron's Chromium debugging port.

The bridge tools talk to a small HTTP server that you explicitly start inside your Electron main process.

Start with `electron_orchestrator_inspect` for the usual workflow. It checks the main-process bridge, lists BrowserWindows, lists CDP targets, probes the selected renderer, and can attach a screenshot in one response.

The plugin also contributes two Codex skills:

- `electron-codex-bridge`: inspect, debug, and drive a local Electron app through CDP and the development bridge.
- `electron-best-practices`: guide secure Electron + React implementation, including `contextBridge`, typed IPC, CSP, packaging, signing, updates, and Playwright testing.

The bridge skill loads `electron-best-practices` as a required companion, so every `electron-codex-bridge` workflow automatically carries the best-practice guidance.

## Electron App Setup

In your Electron app, enable Chrome DevTools Protocol before `app.whenReady()`:

```ts
import { app } from "electron";

app.commandLine.appendSwitch("remote-debugging-port", "9223");
```

Then copy or adapt:

```text
plugins/electron-codex-bridge/scripts/electron-main-bridge-example.ts
```

into your Electron app's main-process source, for example:

```text
src/main/codexBridge.ts
```

Start the bridge from your main process:

```ts
import { app } from "electron";
import { startCodexBridge } from "./codexBridge";

app.whenReady().then(() => {
  startCodexBridge({
    token: process.env.CODEX_ELECTRON_BRIDGE_TOKEN,
    allowExecuteJavaScript: process.env.CODEX_BRIDGE_ALLOW_EVAL === "1"
  });
});
```

The bridge requires `CODEX_ELECTRON_BRIDGE_TOKEN` by default when `ENABLE_CODEX_BRIDGE=1`.
For short-lived local debugging only, you can opt out explicitly with
`allowUnauthenticated: true` or `CODEX_ELECTRON_BRIDGE_ALLOW_UNAUTHENTICATED=1`.
JSON request bodies are limited to 1 MiB by default. Override with
`maxBodyBytes` or `CODEX_ELECTRON_BRIDGE_MAX_BODY_BYTES`.

Run your Electron app with:

```bash
ENABLE_CODEX_BRIDGE=1 CODEX_ELECTRON_BRIDGE_TOKEN=dev-secret npm run dev
```

If you want renderer `executeJavaScript` through the HTTP bridge, opt in explicitly:

```bash
ENABLE_CODEX_BRIDGE=1 CODEX_BRIDGE_ALLOW_EVAL=1 CODEX_ELECTRON_BRIDGE_TOKEN=dev-secret npm run dev
```

Prefer allowlisted bridge handlers over renderer evaluation for app-specific actions.
Malformed JSON, wrong argument types, and oversized bodies return `400` or `413`
from the Electron main-process bridge.

## MCP Environment Variables

The MCP server reads these variables:

```text
CODEX_ELECTRON_CDP_URL=http://127.0.0.1:9223
CODEX_ELECTRON_BRIDGE_URL=http://127.0.0.1:17345
CODEX_ELECTRON_BRIDGE_TOKEN=dev-secret
```

Defaults:

- `CODEX_ELECTRON_CDP_URL`: `http://127.0.0.1:9223`
- `CODEX_ELECTRON_BRIDGE_URL`: `http://127.0.0.1:17345`
- `CODEX_ELECTRON_BRIDGE_TOKEN`: empty, meaning no bridge auth header is sent

The Electron main-process bridge requires a token unless you explicitly opt out.
Set the same `CODEX_ELECTRON_BRIDGE_TOKEN` in the Electron app and Codex's MCP server environment.

## Using It In Codex

After the plugin is enabled and your Electron app is running, try prompts like:

```text
Use electron-codex-bridge to run the Electron orchestrator inspection.
```

```text
Use electron-codex-bridge to list Electron CDP targets.
```

```text
Use electron-codex-bridge to capture a screenshot of the Electron BrowserWindow.
```

```text
Use electron-codex-bridge to list Electron windows.
```

```text
Use electron-codex-bridge to evaluate document.title in the renderer.
```

```text
Use electron-codex-bridge to invoke app.getVersion through the bridge.
```

The orchestrator accepts optional arguments through the tool call:

- `targetId`: choose an exact CDP target id; this is the strongest override
- `urlIncludes`: narrow candidates by URL or window title substring
- `includeScreenshot`: defaults to true
- `includeRendererProbe`: defaults to true

Without `targetId`, the orchestrator uses the main-process bridge window list
when available and prefers the focused BrowserWindow's matching CDP target by
URL or title. The report includes `cdp.targetSelection` with the selection
reason and ambiguity notes.

## Main-Process Bridge Handlers

The example bridge includes a small handler registry:

```ts
registerCodexBridgeHandler("app.getVersion", () => app.getVersion());
registerCodexBridgeHandler("app.getPath", (name) => app.getPath(String(name) as any));
```

Add app-specific handlers for useful, safe operations:

```ts
registerCodexBridgeHandler("settings.snapshot", () => {
  return readCurrentSettings();
});

registerCodexBridgeHandler("workspace.openFile", async (filePath) => {
  return openFileInApp(String(filePath));
});
```

Then call them from Codex with `electron_bridge_invoke`.

## BrowserWindow Access

The CDP path gives Codex renderer/browser-window control:

- list targets through `http://127.0.0.1:9223/json`
- select a target by id or URL/title substring
- evaluate renderer expressions
- take screenshots
- dispatch clicks
- type into the focused element

CDP only works if the Electron app was started with:

```ts
app.commandLine.appendSwitch("remote-debugging-port", "9223");
```

## Security Rules

Use this bridge only for local development.

Recommended constraints:

- bind only to `127.0.0.1`
- keep `CODEX_ELECTRON_BRIDGE_TOKEN` required unless you explicitly opt out for short-lived local debugging
- keep handlers allowlisted
- keep `allowExecuteJavaScript` disabled unless actively debugging
- never enable this bridge in packaged production apps
- never expose arbitrary shell, filesystem, or network operations without a deliberate permission model

## Troubleshooting

Check whether CDP is reachable:

```text
http://127.0.0.1:9223/json
```

If that fails:

- confirm the Electron app is running
- confirm `remote-debugging-port` is set before `app.whenReady()`
- confirm the port is `9223`
- restart the Electron app after changing command-line switches

Check whether the main-process bridge is reachable:

```bash
curl -H "x-codex-bridge-token: dev-secret" http://127.0.0.1:17345/health
```

If that fails:

- confirm the app was started with `ENABLE_CODEX_BRIDGE=1`
- confirm `startCodexBridge()` is called in the main process
- confirm `CODEX_ELECTRON_BRIDGE_TOKEN` is set, or that unauthenticated mode was explicitly enabled
- confirm the bridge port is `17345`
- when authenticated mode is enabled, confirm Codex and Electron use the same `CODEX_ELECTRON_BRIDGE_TOKEN`

If Codex does not show the plugin:

- confirm `.agents/plugins/marketplace.json` exists
- confirm it points to `./plugins/electron-codex-bridge`
- reload or restart Codex
- confirm `plugins/electron-codex-bridge/.codex-plugin/plugin.json` exists

## Development Checks

On machines with `npm`, run the standard checks:

```bash
npm run check
```

Validate plugin JSON:

```bash
python3 -m json.tool .agents/plugins/marketplace.json
python3 -m json.tool plugins/electron-codex-bridge/.codex-plugin/plugin.json
```

Check the MCP server syntax:

```bash
node --check plugins/electron-codex-bridge/scripts/electron-codex-bridge.mjs
```

Run the bridge regression tests:

```bash
npm test
# or: node --test plugins/electron-codex-bridge/tests/electron-codex-bridge.test.mjs
```

Smoke-test MCP initialization:

```bash
node plugins/electron-codex-bridge/scripts/electron-codex-bridge.mjs
```

The MCP server communicates over stdio, so interactive manual testing requires sending JSON-RPC lines on stdin.
