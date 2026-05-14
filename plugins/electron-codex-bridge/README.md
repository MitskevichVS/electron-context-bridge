# Electron Codex Bridge

Development plugin for connecting Codex to a local Electron app.

It contributes:

- an MCP stdio server at `scripts/electron-codex-bridge.mjs`
- a Codex skill at `skills/electron-codex-bridge/SKILL.md`
- an Electron best-practices skill at `skills/electron-best-practices/SKILL.md`
- an Electron main-process bridge example at `scripts/electron-main-bridge-example.ts`

## MCP Tools

- `electron_orchestrator_inspect`
- `electron_cdp_get_version`
- `electron_cdp_list_targets`
- `electron_cdp_evaluate`
- `electron_cdp_capture_screenshot`
- `electron_cdp_click`
- `electron_cdp_type`
- `electron_bridge_health`
- `electron_bridge_list_windows`
- `electron_bridge_list_handlers`
- `electron_bridge_invoke`
- `electron_bridge_request`

Start with `electron_orchestrator_inspect`. It runs the common inspection flow in one call: bridge health, window list, handler list, CDP version, CDP targets, renderer probe, and optional screenshot.
Handler listings include declared argument metadata when a bridge handler provides
`parameters`; `/invoke` validates those contracts before calling the handler.
When the main-process bridge window list is available, the orchestrator prefers
the focused BrowserWindow's matching CDP target by URL or title. Explicit
`targetId` still wins, and `cdp.targetSelection` explains the final choice.

## Electron Setup

Enable CDP before `app.whenReady()`:

```ts
app.commandLine.appendSwitch("remote-debugging-port", "9223");
```

Add the bridge example to your Electron main process and start it only in development:

```ts
import { startCodexBridge } from "./codexBridge";

app.whenReady().then(() => {
  startCodexBridge({
    token: process.env.CODEX_ELECTRON_BRIDGE_TOKEN
  });
});
```

The bridge requires `CODEX_ELECTRON_BRIDGE_TOKEN` by default. For short-lived
local debugging only, opt out explicitly with `allowUnauthenticated: true` or
`CODEX_ELECTRON_BRIDGE_ALLOW_UNAUTHENTICATED=1`.
JSON request bodies are limited to 1 MiB by default. Override with
`maxBodyBytes` or `CODEX_ELECTRON_BRIDGE_MAX_BODY_BYTES`.

Then run your app with:

```bash
ENABLE_CODEX_BRIDGE=1 CODEX_ELECTRON_BRIDGE_TOKEN=dev-secret npm run dev
```

The MCP server reads:

- `CODEX_ELECTRON_CDP_URL`, default `http://127.0.0.1:9223`
- `CODEX_ELECTRON_BRIDGE_URL`, default `http://127.0.0.1:17345`
- `CODEX_ELECTRON_BRIDGE_TOKEN`, bearer/header token for authenticated bridge requests

Keep the bridge local-only and development-only.
Bridge HTTP responses use `{ ok: true, data }` for successes and
`{ ok: false, error: { code, message } }` for failures. Malformed JSON, wrong
argument types, and oversized bodies return `400` or `413` with that error
envelope.

Run regression tests with:

```bash
npm test
# or: node --test plugins/electron-codex-bridge/tests/electron-codex-bridge.test.mjs
```

The tests import `scripts/electron-main-bridge-example.ts` directly through
Node's native TypeScript stripping. Use Node 24 or newer for local checks.

## Skills

- `electron-codex-bridge`: inspect, debug, and control a local Electron app during development.
- `electron-best-practices`: apply secure Electron + React patterns for `contextBridge`, typed IPC, CSP, packaging, code signing, updates, and Playwright testing.

The bridge skill loads `electron-best-practices` as a required companion, so prompts that use `electron-codex-bridge` automatically apply the best-practice guidance too.
