# Desktop Guidelines

## Process Boundaries

- `src/main` owns windows, filesystem access, native dialogs, process control, and preference persistence.
- `src/preload` exposes the smallest typed bridge. Do not place business logic there.
- `src/contract` is the single type source shared by main, preload, and renderer. Define channels and payloads there first.
- Keep `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and a restrictive CSP.
- Never expose raw `ipcRenderer`, arbitrary channels, or Node APIs to the renderer.

## IPC and State Flow

- Keep cross-process operations asynchronous. Do not use `sendSync`, synchronous filesystem APIs, or synchronous native dialogs.
- `identity` and initial `SystemInfo` are the only synchronous bridge values; inject them through `additionalArguments` for the first frame.
- Use one main-to-renderer push channel with a tagged `PushEvent` union.
- Wrap preload listeners and remove the exact same function identity on cleanup.
- The process that owns a change publishes it. Renderers must not poll to discover main-process state.
- Preserve one state-arrival path after mutations. Shared list state reconciles from authoritative broadcasts, not both a command response and a broadcast.

## Windows and Persistence

- Launcher and Project are separate renderer entries and BrowserWindows, not routes in one SPA.
- Show windows on `ready-to-show`; retain native macOS vibrancy and an opaque fallback elsewhere.
- Store recent projects, Context Profiles, SSH host profiles, window bounds, and workspace layout under Electron `userData`.
- Keep writes asynchronous, serialized, and atomic with temporary-file-plus-rename.
- Preference corruption must not block startup; log it and use a safe default.
- Workspace layout is per `projectKey`; debounce high-frequency resize persistence.

## Local Server Lifecycle

- `src/main/local/server-manager.ts` owns the local backend: it is a child process, never in-process. Idempotent `ensure()` reuses a live instance (health check on the local port) before spawning, so a manually started dev server is respected.
- Spawn uses `ELECTRON_RUN_AS_NODE=1` + `process.execPath` (no system-node dependency), `PORT=0`, and parses the `AGENT_GATEWAY_LISTENING` stdout sentinel (same contract as remote bootstrap). Data dir keeps the server's default (`~/.agent-development-gateway/server`) so local hostId/identity stays compatible.
- The local server outlives project windows; stop it on app quit (`before-quit` → `localServerManager.stop()`), never on window close. Never kill an externally started instance.

## Remote Connections

- `src/main/remote/` must stay electron-free (ssh/provision/manager); the electron glue lives only in `remote/index.ts`. This keeps the whole path verifiable headlessly with tsx.
- Use system `ssh` with ControlMaster; never implement SSH auth in-process. Passwords go through `SSH_ASKPASS` helpers and `safeStorage`; plaintext never leaves the main process or touches the command line.
- Resolve the server client per window (`event.sender → projectKey → connection`); a project window maps to exactly one host. Stream registries receive the client per call, not at construction.
- Tunnels and control connections are disposable; the remote server outlives the client. Never kill the remote server from desktop code.

## Electron binary

- Electron 43+ no longer downloads its binary in a package lifecycle script. `electron-vite` still requires `path.txt` + `dist`.
- `dev` / `preview` / `pack:mac` / `pack:win` run `scripts/ensure-electron.mjs` first. Plain `pnpm install` and CI lint/typecheck do not.
- `ensure-electron.mjs` downloads from `ELECTRON_MIRROR` (npmmirror by default for networks without GitHub access; empty it to use upstream). `pack:*` additionally run `scripts/with-electron-env.mjs` around `electron-builder`, which needs the same mirror for its own download.
- Escape hatch: `SKIP_ELECTRON_DOWNLOAD=1`. Manual: `pnpm --filter @agent-gateway/desktop ensure-electron`.

## Verification

- Run `pnpm --filter @agent-gateway/desktop lint`.
- Run `pnpm --filter @agent-gateway/desktop typecheck`.
- Run `pnpm --filter @agent-gateway/desktop build`.
- Do not launch a second dev server when the user already has one running.
- Verify diagnostic builds by output directory, bundle hash, source-map mode, and the file actually loaded by Electron.
