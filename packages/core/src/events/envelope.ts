import type { AdapterId, SubagentRunId, ToolCallId, TurnId } from '../ids.js'

/**
 * Reference back to the native runtime event that produced this envelope.
 * Kept for debugging and re-projection (§9.5); defaults to debug-only, and the raw
 * payload it points at may be redacted or disabled per config.
 */
export interface NativeRef {
  runtimeVersion?: string
  eventType?: string
  eventId?: string
}

/**
 * Attribution — places an event that does NOT belong to the main run/turn: subagent
 * output (Claude `parent_tool_use_id`, Codex subagent threads), out-of-band provider
 * events (cradle `ProviderThreadEvent`), user-shell commands (docs/05 §4.1).
 */
export interface EventAttribution {
  parentToolCallId?: ToolCallId
  /** Gateway child execution this event belongs to. */
  subagentRunId?: SubagentRunId
  taskId?: string
  depth?: number
  sourceKind?: 'main' | 'subagent' | 'subagent-review' | 'subagent-compact' | 'user-shell'
}

/** Fields every runtime event carries (requirements §8.2). */
export interface RuntimeEventBase {
  id: number
  /** Monotonic per-session cursor; drives append-only replay + SSE resume (§8.3). */
  sequence: number
  sessionId: string
  timestamp: number
  /** The turn this event belongs to, when known (Codex carries thread+turn+item). */
  turnId?: TurnId
  /** Non-null when the event belongs to a subagent / out-of-band source (docs/05 §4.1). */
  attribution?: EventAttribution
  /**
   * Payload schema version. The same dotted `type` may carry multiple coexisting
   * versions as schemas evolve (OpenCode durable events, docs/05 §4). Absent = v1.
   */
  schemaVersion?: number
}

/**
 * The single wire + storage shape for all runtime events (requirements §9.4).
 * `type` is a dotted semantic string (e.g. `content.text.delta`); `payload` is
 * typed against it via `RuntimeEventMap`. Extension events (§9.5) ride the same
 * envelope under `type: 'runtime.extension'` — the event store persists ONE shape.
 */
export interface RuntimeEventEnvelope<TPayload = unknown> extends RuntimeEventBase {
  adapterId: AdapterId
  type: string
  payload: TPayload
  nativeRef?: NativeRef
}
