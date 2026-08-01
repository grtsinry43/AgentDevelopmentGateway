import type { RuntimeCapabilities } from '../domain/descriptor.js'
import type { SessionStatus } from '../domain/session.js'
import type { InteractionId, TurnId } from '../ids.js'
import type { InteractionResolution } from '../adapter/io.js'
import type { ChangeSet } from '../model/change-set.js'
import type { InteractionRequest } from '../model/interaction.js'
import type { Plan, TaskStateUpdate } from '../model/task-plan.js'
import type { ToolCall } from '../model/tool-call.js'
import type { TurnStatus } from '../model/turn.js'
import type { RateLimitWindow, Usage } from '../model/usage.js'
import type { RuntimeError } from '../model/runtime-error.js'
import type { SessionExecutionState } from '../domain/execution.js'
import type { ModelSelection } from '../adapter/io.js'
import type { SubagentRun } from '../domain/subagent.js'
import type { InputQueueEntry } from '../domain/input-queue.js'

/**
 * One payload interface per base runtime event (requirements §9.4).
 *
 * DURABILITY CONVENTION (docs/05 §4.2 — the single most important rule here):
 *   - `*.delta` payloads are LIVE-ONLY and MUST NOT be written to the event store.
 *     They carry only the incremental fragment; a reconnecting client replaying from
 *     `after=<seq>` never sees them, which is what stops double-counting.
 *   - `*.started` / `*.completed` boundary payloads ARE durable. `*.completed` carries
 *     the whole authoritative value AND may optionally carry a committed snapshot so a
 *     late/reconnecting subscriber needs no separate read (cradle, docs/05 §4.2).
 * This mirrors all three runtimes (Claude stream_event vs assistant; Codex delta vs
 * item/completed — where deltas are explicitly advisory; OpenCode .delta vs .ended).
 */

// --- session ---
export interface SessionCreatedPayload {
  runtimeSessionId?: string
  capabilities: RuntimeCapabilities
}
export interface SessionStatusChangedPayload {
  status: SessionStatus
}
/** Capabilities drifted mid-session (Claude reloadSkills / MCP / commands, docs/05 §8). */
export interface SessionCapabilitiesChangedPayload {
  capabilities: RuntimeCapabilities
}
/** Runtime-generated or user-set title (OpenCode / cradle `TitleChanged`). */
export interface SessionTitleChangedPayload {
  title: string
  source?: 'provider' | 'user'
}
export interface SessionModelChangedPayload {
  model: ModelSelection
  controlRevision: number
}
export interface SessionExecutionChangedPayload {
  execution: SessionExecutionState
  controlRevision: number
}

// --- delegated agent execution ---
export interface SubagentStartedPayload {
  run: SubagentRun
}
export interface SubagentUpdatedPayload {
  /** Full authoritative state; projections replace rather than merge it. */
  run: SubagentRun
}
export interface SubagentCompletedPayload {
  /** Full authoritative terminal state. */
  run: SubagentRun
}

// --- turn ---
export interface TurnStartedPayload {
  turnId: TurnId
}
export interface TurnCompletedPayload {
  turnId: TurnId
  status: TurnStatus
  usage?: Usage
}
/** Turn failed as data (Codex `TurnError` on the turn), distinct from turn.completed. */
export interface TurnFailedPayload {
  turnId: TurnId
  error: RuntimeError
  usage?: Usage
}

// --- content: text ---
export interface ContentTextStartedPayload {
  blockId: string
}
/** LIVE-ONLY — not persisted (see durability convention above). */
export interface ContentTextDeltaPayload {
  blockId: string
  delta: string
}
export interface ContentTextCompletedPayload {
  blockId: string
  /** Authoritative full value (may NOT equal concatenated deltas — deltas are advisory). */
  text: string
}

// --- content: reasoning ---
export interface ContentReasoningStartedPayload {
  blockId: string
}
/**
 * LIVE-ONLY. Reasoning can be two-dimensional (Codex indexes by both `summary_index`
 * and `content_index`, docs/05 §4.3); single-dimensional runtimes omit both.
 */
export interface ContentReasoningDeltaPayload {
  blockId: string
  delta: string
  summaryIndex?: number
  contentIndex?: number
}
export interface ContentReasoningCompletedPayload {
  blockId: string
  text: string
}

// --- content: raw passthrough (Claude multiplexes text/reasoning/tool-input on one
//     stream_event channel; Debug View / re-projection sometimes needs the raw event,
//     docs/05 §4.4). Debug-only; may be redacted or disabled per config (§9.5). ---
export interface ContentRawPayload {
  channel: string
  native: unknown
}

// --- tool ---
export interface ToolStartedPayload {
  toolCall: ToolCall
}
/** LIVE-ONLY. Partial JSON of the tool input (Claude input_json_delta / OpenCode input.delta). */
export interface ToolInputDeltaPayload {
  toolCallId: ToolCall['id']
  delta: string
}
/** LIVE-ONLY. Incremental tool output (Codex command outputDelta / OpenCode tool.progress). */
export interface ToolOutputDeltaPayload {
  toolCallId: ToolCall['id']
  delta: string
}
export interface ToolCompletedPayload {
  toolCall: ToolCall
}

// --- interaction (structured; see model/interaction.ts + adapter/io.ts) ---
export interface InteractionPermissionRequestedPayload {
  request: Extract<InteractionRequest, { kind: 'tool_permission' }>
}
export interface InteractionQuestionRequestedPayload {
  request: Extract<InteractionRequest, { kind: 'question' }>
}
export interface InteractionGrantRequestedPayload {
  request: Extract<InteractionRequest, { kind: 'permission_grant' }>
}
export interface InteractionDialogRequestedPayload {
  request: Extract<InteractionRequest, { kind: 'host_dialog' }>
}
export interface InteractionElicitationRequestedPayload {
  request: Extract<InteractionRequest, { kind: 'elicitation' }>
}
/** A resolved interaction (permission/question/grant/dialog/elicitation). Idempotent. */
export interface InteractionResolvedPayload {
  id: InteractionId
  resolution: InteractionResolution
}
/**
 * A pending interaction was closed WITHOUT an answer so it can't leak (cradle
 * timedOut/aborted, docs/05 §6.3): turn abort, timeout, or superseded.
 */
export interface InteractionCanceledPayload {
  id: InteractionId
  reason: 'timed_out' | 'aborted' | 'superseded'
}

// --- input scheduling (OpenCode durable admission + steer/queue, docs/05 §4.5) ---
export interface InputAdmittedPayload {
  entry: InputQueueEntry
}
/** Full ordered snapshot of inputs still waiting for provider delivery. */
export interface InputQueueUpdatedPayload {
  entries: InputQueueEntry[]
}
export interface InputDispatchedPayload {
  entry: InputQueueEntry
}
export interface InputFailedPayload {
  entry: InputQueueEntry
}
export interface InputCancelledPayload {
  entry: InputQueueEntry
}

// --- task / plan / changes ---
export interface PlanUpdatedPayload {
  plan: Plan
}
export interface TaskUpdatedPayload {
  update: TaskStateUpdate
}
export interface ChangesUpdatedPayload {
  changeSet: ChangeSet
}

// --- context / usage / errors ---
/** Context was compacted — a first-class timeline entry, not a hidden rewrite (docs/05 §4.5). */
export interface ContextCompactedPayload {
  reason: 'auto' | 'manual'
  summary?: string
}
export interface UsageUpdatedPayload {
  usage: Usage
}
/** Rate-limit state (a recurring STATE, not an error — docs/05 §9). */
export interface RateLimitUpdatedPayload {
  windows: RateLimitWindow[]
}
export interface RuntimeWarningPayload {
  error: RuntimeError
}
export interface RuntimeErrorPayload {
  error: RuntimeError
}
