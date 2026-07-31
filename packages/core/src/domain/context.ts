/**
 * Model-facing authority of a context fragment.
 *
 * Instructions steer behavior. References provide facts and must not acquire
 * instruction authority merely because their content contains imperative text.
 */
export type ContextFragmentRole = 'instruction' | 'reference'

/**
 * Trust boundary used when an upstream runtime can distinguish application-owned
 * context from imported or retrieved material.
 */
export type ContextFragmentTrust = 'application' | 'untrusted'

/** Provider-neutral provenance used for ordering, auditing and adapter mapping. */
export type ContextFragmentSourceKind =
  | 'repository-instructions'
  | 'global-rules'
  | 'project-rules'
  | 'session-rules'
  | 'context-profile'
  | 'memory'
  | 'retrieved-context'

export interface ContextFragmentSource {
  kind: ContextFragmentSourceKind
  /** Stable domain id, such as a rule set, profile or MemoryItem id. */
  id?: string
  /** Repository-relative path when the source is a file or directory. */
  path?: string
}

/**
 * A normalized context unit prepared by the runtime and consumed by an adapter.
 *
 * `key` is stable across turns and `digest` changes only when model-visible content
 * changes. Adapters may use the pair for de-duplication and incremental injection.
 * Conflict resolution happens before this boundary; adapters only translate the
 * resolved fragments into their provider's protocol.
 */
export interface ContextFragment {
  key: string
  content: string
  role: ContextFragmentRole
  trust: ContextFragmentTrust
  source: ContextFragmentSource
  /** Stable digest of the model-visible content; the hashing algorithm is runtime-owned. */
  digest: string
}

/**
 * Stable context pinned when a session is created, resumed or forked.
 *
 * The snapshot excludes volatile metadata from model-visible content so providers can
 * preserve prompt-prefix caching. A rule refresh creates a new revision rather than
 * silently mutating the active session's foundation.
 */
export interface SessionContext {
  snapshotId: string
  revision: number
  /** Digest of the ordered, model-visible fragment set. */
  digest: string
  fragments: ContextFragment[]
}

/** Dynamic context recalled for one send/steer operation. */
export interface TurnContext {
  fragments: ContextFragment[]
}
