---
name: electron-codex-bridge
description: Use when the user wants Codex to inspect, debug, or control a local Electron app, including the main process, renderer process, and BrowserWindow via Chrome DevTools Protocol.
---

# Electron Codex Bridge

This plugin connects Codex to a local Electron app through two development-only surfaces:

- Chrome DevTools Protocol on `CODEX_ELECTRON_CDP_URL`, defaulting to `http://127.0.0.1:9223`.
- An explicit Electron main-process HTTP bridge on `CODEX_ELECTRON_BRIDGE_URL`, defaulting to `http://127.0.0.1:17345`.

## Use

1. Prefer `electron_bridge_health` and `electron_bridge_list_windows` to confirm the main-process bridge is running.
2. Use `electron_cdp_list_targets` to find BrowserWindow renderer targets.
3. Use CDP tools for visual/browser-window work: screenshot, click, type, and renderer evaluation.
4. Use `electron_bridge_invoke` for safe main-process actions registered with `registerCodexBridgeHandler`.
5. Treat `electron_cdp_evaluate` and `/renderer/execute-js` as development-only tools. Prefer app-defined bridge handlers when changing app state.

## Electron App Setup

Enable CDP before `app.whenReady()`:

```ts
app.commandLine.appendSwitch("remote-debugging-port", "9223");
```

Install the bridge example from `scripts/electron-main-bridge-example.ts` into the Electron main process, then call:

```ts
startCodexBridge({
  token: process.env.CODEX_ELECTRON_BRIDGE_TOKEN,
  allowExecuteJavaScript: process.env.CODEX_BRIDGE_ALLOW_EVAL === "1"
});
```

Start the app with:

```bash
ENABLE_CODEX_BRIDGE=1 CODEX_ELECTRON_BRIDGE_TOKEN=dev-secret npm run dev
```

Set the same token for the MCP server environment when token auth is enabled.

## Security

Use this only in local development. Bind to `127.0.0.1`, use `CODEX_ELECTRON_BRIDGE_TOKEN`, keep bridge handlers allowlisted, and do not ship the bridge in production builds.
