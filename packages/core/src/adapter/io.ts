import type { InteractionId, SessionId, TurnId } from '../ids.js'
import type { SessionContext, TurnContext } from '../domain/context.js'
import type { SessionExecutionSettings } from '../domain/execution.js'
import type { RuntimeConnection } from './connection.js'

/**
 * User input for a turn (§9.3 `send`).
 *
 * `delivery` is a first-class scheduling primitive, not an adapter detail (OpenCode
 * `Delivery`, cradle steer): `steer` injects into the RUNNING turn, `queue` defers to
 * after it. Adapters lacking native steering fall back per `RuntimeCapabilities.steer`.
 * `admitOnly` mirrors OpenCode `resume:false` — durably admit the input without executing.
 */
export interface UserInput {
  /** Client-generated id used to make active-session retries idempotent. */
  clientMessageId: string
  text: string
  delivery?: InputDelivery
  attachments?: InputAttachment[]
  /** Admit to the log without scheduling execution (OpenCode `resume:false`). */
  admitOnly?: boolean
}

export type InputDelivery = 'steer' | 'queue'

/** Runtime-prepared context accompanying one send without becoming user-authored input. */
export interface SendOptions {
  /** Gateway turn assigned by the runtime before provider delivery. */
  turnId: TurnId
  /** Whether this input opens a new turn or joins the currently active one. */
  kind: 'start-turn' | 'steer'
  context?: TurnContext
}

/** Provider acknowledgement for an input accepted across the adapter boundary. */
export interface ProviderInputReceipt {
  /** Provider-native identifier for the accepted input, when one exists. */
  providerInputId?: string
  /** Provider-native sequence/cursor; never a Gateway event or admission sequence. */
  providerSequence?: number
  /** Opaque provider acknowledgement retained for adapter-specific diagnostics or resume. */
  raw?: unknown
}

/** Optional result returned after an adapter has accepted an input. */
export interface AdapterSendResult {
  providerReceipt?: ProviderInputReceipt
}

export interface InputAttachment {
  kind: 'file' | 'image'
  path?: string
  /** Base64 inline data, when the attachment isn't a path. */
  data?: string
}

/** Receipt returned by the runtime after durable input admission. */
export interface InputAdmissionReceipt {
  admittedSequence: number
  /** Turn started or steered by this input, when one was scheduled. */
  turnId?: TurnId
}

/**
 * Scope a permission decision persists at. Converges Codex `PermissionGrantScope`
 * (Turn|Session) and OpenCode `once|always`.
 */
export type PermissionScope = 'once' | 'turn' | 'session'

/** Where a persisted rule is written (Claude `PermissionUpdateDestination`). */
export type PersistDestination = 'session' | 'project' | 'user' | 'local'

/** A rule to persist alongside an allow/deny (Claude `PermissionUpdate`). */
export interface PersistRule {
  rule: { toolName: string; ruleContent?: string }
  destination: PersistDestination
}

/**
 * Structured resolution for a pending interaction (§9.3 `resolveInteraction`).
 *
 * Far richer than allow/deny (docs/05 §6.2): permission `allow` can rewrite tool args
 * (Claude `updatedInput`) and scope a grant; `deny` carries a model-facing message and
 * can abort the turn (Codex Decline=continue vs Cancel=abortTurn). Questions answer with
 * `Record<questionId, string[]>` (multi-select / free-text). `canceled` closes a pending
 * request without an answer so it can't leak (cradle timedOut/aborted).
 */
export type InteractionResolution =
  | ToolPermissionResolution
  | QuestionResolution
  | { kind: 'question_rejected'; id: InteractionId }
  | PermissionGrantResolution
  | HostDialogResolution
  | ElicitationResolution
  | { kind: 'canceled'; id: InteractionId; reason: 'timed_out' | 'aborted' | 'superseded' }

export interface ToolPermissionResolution {
  kind: 'tool_permission'
  id: InteractionId
  decision:
    | { behavior: 'allow'; updatedInput?: unknown; scope?: PermissionScope }
    | { behavior: 'deny'; message?: string; abortTurn?: boolean }
  /** Persist a rule for future requests (Claude PermissionUpdate + destination). */
  persistRule?: PersistRule
}

export interface QuestionResolution {
  kind: 'question'
  id: InteractionId
  /** Per-question answers; array = multi-select / free-text (cradle answer shape). */
  answers: Record<string, string[]>
}

export interface PermissionGrantResolution {
  kind: 'permission_grant'
  id: InteractionId
  /** The granted profile (runtime-shaped; opaque to core). */
  grantedProfile: unknown
  scope: PermissionScope
}

export interface HostDialogResolution {
  kind: 'host_dialog'
  id: InteractionId
  /** `cancelled` for unknown dialog kinds; otherwise the dialog result. */
  outcome: { behavior: 'completed'; result: unknown } | { behavior: 'cancelled' }
}

export interface ElicitationResolution {
  kind: 'elicitation'
  id: InteractionId
  outcome: { behavior: 'completed'; content: unknown } | { behavior: 'cancelled' }
}

export interface ModelSelection {
  model: string
  reasoningEffort?: string
}

/** Provider-advertised reasoning option. Order is meaningful and must be preserved. */
export interface ModelReasoningEffort {
  id: string
  displayName?: string
  description?: string
}

/** Provider-neutral model metadata used by clients to render a model picker. */
export interface RuntimeModel {
  id: string
  displayName: string
  description?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  reasoningEfforts: ModelReasoningEffort[]
}

export interface ModelCatalog {
  models: RuntimeModel[]
}

export interface ListModelsInput {
  projectPath: string
  connection: RuntimeConnection
  /** Active Gateway session whose provider connection can serve this catalog. */
  sessionId?: SessionId
}

/**
 * Resume cursor — the three runtimes address resume differently (docs/05 §7.4):
 * OpenCode by integer seq, Claude by message UUID (`resumeSessionAt`), Codex by rollout
 * path, and cradle by an opaque provider-state snapshot.
 */
export type ResumeCursor =
  | { by: 'sequence'; sequence: number }
  | { by: 'message'; messageUuid: string }
  | { by: 'rollout-path'; path: string }
  | { by: 'snapshot'; providerStateSnapshot: string }

/** Options for interrupting — Codex addresses a specific live turn (docs/05 §7.3). */
export interface InterruptOptions {
  turnId?: string
  /** Optimistic-concurrency guard (Codex `expected_turn_id`). */
  expectedTurnId?: string
  /** Also cancel queued/pending-dispatch inputs (Claude `interrupt_cancel_queued_v1`). */
  cancelQueued?: boolean
}

/** Input to create a new session (§9.3 `createSession`). */
export interface CreateSessionInput {
  /** Gateway session id assigned by the runtime before the adapter starts provider work. */
  sessionId: SessionId
  projectPath: string
  connection: RuntimeConnection
  providerProfileId?: string
  model?: ModelSelection
  execution?: SessionExecutionSettings
  /** Stable, resolved context foundation for the new runtime session. */
  context?: SessionContext
}

/** Input to resume an existing session (§9.3 `resumeSession`). */
export interface ResumeSessionInput {
  /** Existing Gateway session id whose provider session is being resumed. */
  sessionId: SessionId
  /** Authoritative project path; provider session lookup must not infer it from process cwd. */
  projectPath: string
  runtimeSessionId: string
  connection: RuntimeConnection
  /** Gateway-persisted selection to restore when the provider transport is reopened. */
  model?: ModelSelection
  /** Where to resume from; shape varies per runtime (see {@link ResumeCursor}). */
  cursor?: ResumeCursor
  /** Opaque provider state for runtimes not reconstructable from the log (cradle). */
  providerStateSnapshot?: string
  /** The pinned context snapshot to restore alongside the provider session. */
  context?: SessionContext
  execution?: SessionExecutionSettings
}

/** Input to fork a session into a new branch (§9.3 `forkSession`). */
export interface ForkSessionInput {
  /** New Gateway session id assigned to the fork by the runtime. */
  sessionId: SessionId
  /** Authoritative source project path for locating and forking provider state. */
  projectPath: string
  runtimeSessionId: string
  connection: RuntimeConnection
  /** Selection inherited from the source Gateway session. */
  model?: ModelSelection
  /** Cut point for the fork (Codex `last_turn_id` / `before_turn_id`). */
  forkPoint?: ResumeCursor
  /** New stable context, for example when continuing under refreshed rules. */
  context?: SessionContext
  execution?: SessionExecutionSettings
}
