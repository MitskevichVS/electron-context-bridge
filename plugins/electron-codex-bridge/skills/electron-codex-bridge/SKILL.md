---
name: electron-codex-bridge
description: Use when the user wants Codex to inspect, debug, or control a local Electron app, including the main process, renderer process, and BrowserWindow via Chrome DevTools Protocol.
---

# Electron Codex Bridge

This plugin connects Codex to a local Electron app through two development-only surfaces:

- Chrome DevTools Protocol on `CODEX_ELECTRON_CDP_URL`, defaulting to `http://127.0.0.1:9223`.
- An explicit Electron main-process HTTP bridge on `CODEX_ELECTRON_BRIDGE_URL`, defaulting to `http://127.0.0.1:17345`.

## Companion Skill

Whenever this skill is used, also load and apply `../electron-best-practices/SKILL.md` before taking action. Treat `electron-best-practices` as a required companion for all bridge workflows, even when the user only names `electron-codex-bridge`.

Apply the companion guidance to bridge setup, renderer inspection, IPC handler design, security recommendations, and any code/config changes discovered while debugging. Load deeper companion references or scripts only when they are relevant to the specific request.

## Use

1. Start with `electron_orchestrator_inspect` for the standard app snapshot. It combines bridge health, BrowserWindow list, allowlisted handler list, CDP version, CDP targets, renderer probe, and optional screenshot.
2. Use specific tools only when the orchestrator shows a narrower next step.
3. Use CDP tools for visual/browser-window work: screenshot, click, type, and renderer evaluation.
4. Use `electron_bridge_list_handlers` before `electron_bridge_invoke` when handler names or argument expectations are unclear. Prefer handlers with declared `parameters` because the bridge validates missing, extra, wrong-type, and out-of-enum arguments before invocation.
5. Treat `electron_cdp_evaluate` and `/renderer/execute-js` as development-only tools. Prefer app-defined bridge handlers when changing app state.

## Orchestrator

Use `electron_orchestrator_inspect` when the user asks for a broad Electron status check, debugging pass, or "connect Codex to my Electron app."

Useful arguments:

- `targetId`: choose an exact CDP target id; this is the strongest override.
- `urlIncludes`: narrow renderer target candidates by URL or title substring.
- `includeScreenshot`: defaults to true; set false for text-only checks.
- `includeRendererProbe`: defaults to true; reads document title, URL, readyState, viewport, and active element.

Without `targetId`, prefer the focused BrowserWindow's matching CDP target when
the main-process bridge window list is available. Read `cdp.targetSelection` in
the orchestrator report to understand the selected target and ambiguity notes.

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

The bridge requires `CODEX_ELECTRON_BRIDGE_TOKEN` by default. Only use
`allowUnauthenticated: true` or `CODEX_ELECTRON_BRIDGE_ALLOW_UNAUTHENTICATED=1`
for short-lived local debugging.
JSON request bodies are limited to 1 MiB by default. Override with
`maxBodyBytes` or `CODEX_ELECTRON_BRIDGE_MAX_BODY_BYTES`.

Start the app with:

```bash
ENABLE_CODEX_BRIDGE=1 CODEX_ELECTRON_BRIDGE_TOKEN=dev-secret npm run dev
```

Set the same token for the MCP server environment.

## Security

Use this only in local development. Bind to `127.0.0.1`, require `CODEX_ELECTRON_BRIDGE_TOKEN`, keep bridge handlers allowlisted, and do not ship the bridge in production builds.
