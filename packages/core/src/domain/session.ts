import type { AdapterId, SessionId } from '../ids.js'
import type { ResumeCursor } from '../adapter/io.js'
import type { ModelSelection } from '../adapter/io.js'
import type { SessionExecutionState } from './execution.js'

/**
 * SessionStatus — structured, not a boolean `turnActive` (docs/05 §3.2).
 * Codex exposes `Active{active_flags:[WaitingOnApproval|WaitingOnUserInput]}` and Claude
 * `SDKSessionStateChangedMessage` has `requires_action`; both say WHY a session is blocked.
 * When `waiting`, the pending InteractionRequest(s) explain what it's waiting on.
 */
export type SessionStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'error'
  | 'closed'

/** AgentSession — one Agent session bound to a project + host + adapter (§7.3). */
export interface AgentSession {
  id: SessionId
  projectId: string
  hostId: string
  adapterId: AdapterId
  /** The runtime's own id: Claude UUID / Codex thread_id / OpenCode ses_*. */
  runtimeSessionId?: string
  providerProfileId?: string
  model?: ModelSelection
  execution: SessionExecutionState
  /** Optimistic-concurrency revision for user-mutable control state. */
  controlRevision: number
  status: SessionStatus

  // --- lineage for user-visible conversation forks — docs/05 §3.1 ---
  /** Source session this was forked from. */
  forkedFromSessionId?: SessionId
  /** Where the fork was cut (Codex last_turn_id / before_turn_id). */
  forkPoint?: ResumeCursor

  /**
   * Opaque serialized provider state (cradle `providerStateSnapshot`). Some
   * process/CLI-backed runtimes cannot be reconstructed from the event log alone;
   * this lets resume carry state the log doesn't hold (docs/05 §3.1).
   */
  providerStateSnapshot?: string

  /** Runtime-generated or user-set title (OpenCode / cradle `TitleChanged`). */
  title?: string

  createdAt: number
  updatedAt: number
  /** Cursor into the append-only event store; drives SSE resume (§8.3, §17.2). */
  lastEventSequence: number
}
