import type { InteractionId, SessionId, ToolCallId, TurnId } from '../ids.js'
import type { ToolKind } from './tool-call.js'
import type { ChangeSet } from './change-set.js'

/**
 * InteractionRequest — a mid-turn request that needs a client answer (§9.4).
 *
 * The permission|question binary was too narrow (docs/05 §6): the three runtimes need a
 * structured SUPERSET with an open escape hatch. Five sub-kinds, discriminated by `kind`:
 *   - tool_permission   Claude canUseTool / Codex exec+patch approval / OpenCode permission
 *   - question          Claude AskUserQuestion / OpenCode question / cradle userInput
 *   - permission_grant  Codex item/permissions/requestApproval (grant a profile, not yes/no)
 *   - host_dialog       Claude OnUserDialog (OPEN dialogKind; unknown → client replies cancelled)
 *   - elicitation       MCP elicitation (form / url)
 *
 * Invariants (docs/05 §6.3): resolution is idempotent (first wins across clients),
 * blocking (the adapter genuinely suspends the turn), and non-leaking (a pending request
 * gets `interaction.canceled` on turn abort / timeout).
 */
export type InteractionRequest =
  | ToolPermissionRequest
  | QuestionRequest
  | PermissionGrantRequest
  | HostDialogRequest
  | ElicitationRequest

export type InteractionKind = InteractionRequest['kind']

export interface InteractionBase {
  id: InteractionId
  sessionId: SessionId
  /** The turn this interaction gates, when known (Codex addresses turns). */
  turnId?: TurnId
  /** Set when the interaction gates a specific tool call. */
  toolCallId?: ToolCallId
  createdAt: number
}

// --- tool_permission ---
export interface ToolPermissionRequest extends InteractionBase {
  kind: 'tool_permission'
  /** Provider-neutral classification of the action being approved. */
  toolKind: ToolKind
  /** Native tool name for precise display and permission-rule matching. */
  toolName: string
  /** Immutable request snapshot; approval UIs must show what will actually run. */
  input?: unknown
  /** Provider-neutral preview for file mutations, when the adapter can derive it safely. */
  proposedChangeSet?: ChangeSet
  prompt: string
  /** Multi-resource grant target (OpenCode `resources`). */
  resources?: string[]
  /** Decisions the runtime advertises for THIS request (Codex `available_decisions`). */
  availableDecisions?: string[]
  /** Rule suggestions the runtime offers (Claude `PermissionUpdate[]` suggestions). */
  suggestions?: unknown
}

// --- question ---
export interface QuestionOption {
  id: string
  label: string
  description?: string
  /** Rich preview for the option (Claude AskUserQuestion `preview`). */
  preview?: string
}
export interface Question {
  id: string
  /** Short label (OpenCode caps at ≤30 chars). */
  header?: string
  question: string
  /** Present = choice; absent = free text. */
  options?: QuestionOption[]
  multiSelect?: boolean
  /** Allow a free-text "other" answer alongside choices (OpenCode custom / cradle isOther). */
  allowCustom?: boolean
  /** Answer should be treated as a secret (cradle `isSecret`). */
  isSecret?: boolean
}
export interface QuestionRequest extends InteractionBase {
  kind: 'question'
  /** 1..N questions (Claude 1-4 batch; OpenCode N). */
  questions: Question[]
}

// --- permission_grant (Codex: client grants a profile + scope, not a yes/no) ---
export interface PermissionGrantRequest extends InteractionBase {
  kind: 'permission_grant'
  prompt: string
  /** The permission profile being requested (runtime-shaped; kept opaque here). */
  requestedProfile: unknown
}

// --- host_dialog (Claude OnUserDialog; open-ended) ---
export interface HostDialogRequest extends InteractionBase {
  kind: 'host_dialog'
  /** Open string; unknown kinds must be answered `cancelled`. */
  dialogKind: string
  payload: unknown
}

// --- elicitation (MCP) ---
export interface ElicitationRequest extends InteractionBase {
  kind: 'elicitation'
  serverName: string
  message: string
  mode: 'form' | 'url'
  /** JSON schema for the requested form (mode 'form'). */
  requestedSchema?: unknown
}
