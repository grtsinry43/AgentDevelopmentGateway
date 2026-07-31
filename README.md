# Agent Development Gateway

pnpm and Turborepo monorepo for the Agent Development Gateway applications.

## Workspaces

- `apps/desktop`: Electron, electron-vite, Svelte, and TypeScript
- `apps/server`: Fastify and TypeScript
- `packages/shared`: shared runtime values and TypeScript contracts

## Requirements

- Node.js 22.12 or newer
- pnpm 11.13

## Commands

```sh
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm build
```

The server listens on `http://127.0.0.1:3000` by default. Its health endpoint is
`GET /health`.

Run an individual application with:

```sh
pnpm dev --filter=@agent-gateway/server
pnpm dev --filter=@agent-gateway/desktop
```

The server port can be changed with `PORT`. The desktop API base URL can be
changed with `RENDERER_VITE_API_BASE_URL`; it defaults to
`http://127.0.0.1:3000`.
