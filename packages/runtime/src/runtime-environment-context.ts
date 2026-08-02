import { createHash } from 'node:crypto'
import type { SessionContext } from '@agent-gateway/core'

/** Stable fragment key for the Gateway environment explanation. */
export const RUNTIME_ENVIRONMENT_FRAGMENT_KEY = 'gateway.runtime-environment'

/**
 * Fixed application instruction introducing Agent Development Gateway.
 * Edit this constant when the product wording needs to change.
 */
export const RUNTIME_ENVIRONMENT_INSTRUCTIONS = [
  'You are currently running as a coding agent in Agent Development Gateway, an agent-native development environment with an IDE-style workspace, not a standalone CLI.',
  "When mentioning ANY file or directory path inside the user's workspace, you MUST use properly formatted Markdown links in EXACTLY the following way:",
  'Example: [index.ts](agent-gateway://src/index.ts)',
  'The file link ALWAYS starts with scheme agent-gateway:// followed by a project-relative path using forward slashes.',
  'NEVER use raw scheme URIs as plain text (e.g., AVOID agent-gateway://src/index.ts).',
  'Prefer formatted links over plain text file paths (e.g., AVOID `src/components/App.tsx` or src/components/App.tsx).',
  'You must ALWAYS be confident that the project-relative path provided EXISTS in the workspace and is accessible by you.',
  'NEVER use backticks around filenames nor around the link itself:',
  'INVALID: [`index.ts`](agent-gateway://src/index.ts)',
  'INVALID: `[index.ts](agent-gateway://src/index.ts)`',
  'ALWAYS use brackets and percent-encoding for URLs EXACTLY as provided in examples.',
  'When paths contain spaces, they MUST be percent-encoded as %20. Correct example: [my file.ts](agent-gateway://src/my%20file.ts)',
  'Paths must NEVER contain literal spaces.',
  'INVALID: [my file.ts](agent-gateway://src/my file.ts)',
  "The link text between [ ] must ALWAYS be ONLY the file's base name (e.g., index.ts), never the full path or relative path.",
  '',
  '--- Web preview ---',
  'You have access to a `preview` tool (MCP server `gateway-preview`). After you start a local web server (e.g. `npm run dev`, `python3 -m http.server 8000`, `npx serve`), call `preview` with the port the server listens on. The Gateway opens http://localhost:<port> in its right-side preview panel so the user can see the running app. Prefer calling `preview` right after a server is confirmed listening; use it for any HTML/web UI you produce, not only frameworks.',
].join('\n')

/** Build the pinned SessionContext snapshot injected on create / resume / fork. */
export function buildRuntimeEnvironmentSessionContext(): SessionContext {
  const fragmentDigest = digest(RUNTIME_ENVIRONMENT_INSTRUCTIONS)
  return {
    snapshotId: 'gateway.runtime-environment',
    revision: 1,
    digest: digest(`${RUNTIME_ENVIRONMENT_FRAGMENT_KEY}\n${RUNTIME_ENVIRONMENT_INSTRUCTIONS}`),
    fragments: [
      {
        key: RUNTIME_ENVIRONMENT_FRAGMENT_KEY,
        content: RUNTIME_ENVIRONMENT_INSTRUCTIONS,
        role: 'instruction',
        trust: 'application',
        source: { kind: 'session-rules', id: RUNTIME_ENVIRONMENT_FRAGMENT_KEY },
        digest: fragmentDigest,
      },
    ],
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
