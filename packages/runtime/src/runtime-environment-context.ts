import { createHash } from 'node:crypto'
import type { SessionContext } from '@agent-gateway/core'

/** Stable fragment key for the Gateway environment explanation. */
export const RUNTIME_ENVIRONMENT_FRAGMENT_KEY = 'gateway.runtime-environment'

/**
 * Fixed application instruction introducing Agent Development Gateway.
 * Edit this constant when the product wording needs to change.
 */
export const RUNTIME_ENVIRONMENT_INSTRUCTIONS =
  'You are currently running as a coding agent in Agent Development Gateway, which is an agent-native development environment with an IDE-style workspace.'

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
