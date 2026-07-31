import type { AgentSession } from '../domain/session.js'
import type { RuntimeCapabilities } from '../domain/descriptor.js'
import type { InteractionRequest } from '../model/interaction.js'
import type { Turn } from '../model/turn.js'
import type { RuntimeEvent } from '../events/event-map.js'

/**
 * host↔client wire layer (docs/05 §2, §10).
 *
 * This is the SECOND transport, distinct from the adapter↔host `RuntimeAdapter.events()`
 * iterable (cradle's core lesson #1). Clients (Electron / Web / Mobile / TUI / IDE) talk
 * to the Agent Server here — a resumable, multiplexed subscription over SSE (+ WS for
 * PTY). The Server seals `AdapterEvent`s into sequenced `RuntimeEvent`s and serves them;
 * clients never touch an upstream runtime protocol.
 */

/** Subscribe to a session's event stream, optionally resuming after a sequence (§17.2). */
export interface SubscribeRequest {
  sessionId: string
  /** Last sequence the client has; server replays durable events after it (Last-Event-ID). */
  after?: number
}

/**
 * Why a stream ended. `snapshot-required` / `backpressure` are FIRST-CLASS reasons that
 * instruct the client to resync from a snapshot rather than replay (cradle, docs/05 §10):
 * append-only replay isn't always possible (compaction, retention, a slow client).
 */
export type StreamEndReason =
  | 'terminal'
  | 'snapshot-required'
  | 'backpressure'
  | 'upstream-closed'
  | 'error'

/** Frame the server sends over the subscription. */
export type WireServerFrame =
  | { op: 'event'; event: RuntimeEvent }
  | { op: 'ping' }
  | { op: 'end'; reason: StreamEndReason }
  /** The client's cursor is behind the retained log; resync from a snapshot (cradle tail_gap). */
  | { op: 'tail_gap'; latestSequence: number }
  | { op: 'error'; code: string; message: string }

/** Frame the client sends over the subscription. */
export type WireClientFrame =
  | { op: 'sub'; request: SubscribeRequest }
  | { op: 'unsub'; sessionId: string }
  | { op: 'pong' }

/**
 * Full session snapshot for the resync path (docs/05 §10). Rebuilds the UI from current
 * state without replaying every event — used after `snapshot-required` / `tail_gap`, and
 * by late subscribers. Contains only COMMITTED content (deltas were never persisted).
 */
export interface SessionSnapshot {
  session: AgentSession
  turns: Turn[]
  /** Committed content/tool blocks (boundary values only — no deltas). */
  blocks: unknown[]
  /** Interactions still awaiting a resolution. */
  pendingInteractions: InteractionRequest[]
  capabilities: RuntimeCapabilities
  /** The sequence this snapshot is current as of; subscribe with `after` = this. */
  atSequence: number
}
