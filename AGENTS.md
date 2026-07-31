# Repository Guidelines

## Product

- Build an IDE-style agent development workspace, not a chat-first desktop client.
- Use a Launcher window for recent projects and creation, then open each project in its own Project window.
- Identify projects by `hostId + path`; display them as `path @host`.
- Keep the Project window stable: Sessions/Context/Git/Files on the left, conversation in the center, constrained tool panels on the right, and status/key hints at the bottom.
- Prefer dense, keyboard-first, inline workflows. Use modal dialogs only for interruptive or destructive flows.

## Repository Map

- `apps/desktop`: Electron application. See its local `AGENTS.md` before editing it.
- `apps/server`: Fastify transport; currently health-only.
- `packages/core`: provider-neutral runtime model and adapter/wire contracts.
- `packages/adapter-*`: provider integrations.
- `packages/runtime`: future session/event orchestration.
- `docs`: verified provider research and architecture decisions.
- `reference`: read-only reference projects unless the user explicitly requests changes.

## Commands

- `pnpm dev`: run the Turborepo development graph.
- `pnpm lint`: lint all workspaces.
- `pnpm typecheck`: build dependencies and type-check all workspaces.
- `pnpm format:check`: verify formatting.
- `pnpm build`: build all workspaces.
- There is no automated test suite yet. Pair static checks with an explicit smoke checklist for changed behavior.

## Repository Rules

- Keep `packages/core` provider-neutral. SDK types and provider quirks terminate inside adapters or namespaced extension events.
- Treat runtime/server state as authoritative; desktop state is a projection plus local UI preferences.
- Gate behavior with capabilities, never `adapterId` branches.
- Do not silently drop unknown `runtime.extension` events.
- Keep one source of truth for each contract: IPC shapes, event envelopes, status styling, shortcuts, and panel registration.
- Do not add placeholder implementations, unused abstractions, `any`, fake production data, or unfinished behavior presented as complete.
- Before using a library API, inspect the installed version and current official documentation.
- Keep changes narrow. Do not rewrite or format unrelated code.

## Working Agreement

- For architecture, configuration, dependency, schema, or API changes, present the strategy, affected files, choices, and reasons before editing.
- Base conclusions on code, logs, documentation, or a reproducible result. Surface uncertainty early.
- Do not start, stop, or broadly match the user's development processes. Manage only exact PIDs started by the current task.
- Do not commit, publish, or perform destructive cleanup without explicit authorization.

## Completion

- A change is not complete because it compiles. Verify the real path it claims to support.
- Run the relevant workspace lint, typecheck, and build commands, then the repository-wide checks for milestone work.
- Report warnings, unverified GUI behavior, deferred work, and regression risk explicitly.
- When GUI state is unavailable, ask for DevTools output or user visual verification instead of guessing.

## Current Boundary

- The Common Runtime Model and `RuntimeAdapter` contract exist in `packages/core`.
- The current desktop milestone includes the Launcher, typed IPC, local preference stores, design system, keymap, and Project dock shell.
- Session transport/projection, real conversation panels, `packages/adapter-claude`, and `packages/runtime` remain future work.
