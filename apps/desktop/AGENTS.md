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
- Store recent projects, Context Profiles, window bounds, and workspace layout under Electron `userData`.
- Keep writes asynchronous, serialized, and atomic with temporary-file-plus-rename.
- Preference corruption must not block startup; log it and use a safe default.
- Workspace layout is per `projectKey`; debounce high-frequency resize persistence.

## Verification

- Run `pnpm --filter @agent-gateway/desktop lint`.
- Run `pnpm --filter @agent-gateway/desktop typecheck`.
- Run `pnpm --filter @agent-gateway/desktop build`.
- Do not launch a second dev server when the user already has one running.
- Verify diagnostic builds by output directory, bundle hash, source-map mode, and the file actually loaded by Electron.
