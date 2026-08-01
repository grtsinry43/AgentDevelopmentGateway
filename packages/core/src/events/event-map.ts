import type { TurnId } from '../ids.js'
import type { EventAttribution, NativeRef, RuntimeEventEnvelope } from './envelope.js'
import type { RuntimeExtensionPayload } from './extension.js'
import type {
  ChangesUpdatedPayload,
  ContentRawPayload,
  ContentReasoningCompletedPayload,
  ContentReasoningDeltaPayload,
  ContentReasoningStartedPayload,
  ContentTextCompletedPayload,
  ContentTextDeltaPayload,
  ContentTextStartedPayload,
  ContextCompactedPayload,
  InputAdmittedPayload,
  InputQueueUpdatedPayload,
  InteractionCanceledPayload,
  InteractionDialogRequestedPayload,
  InteractionElicitationRequestedPayload,
  InteractionGrantRequestedPayload,
  InteractionPermissionRequestedPayload,
  InteractionQuestionRequestedPayload,
  InteractionResolvedPayload,
  PlanUpdatedPayload,
  RateLimitUpdatedPayload,
  RuntimeErrorPayload,
  RuntimeWarningPayload,
  SessionCapabilitiesChangedPayload,
  SessionCreatedPayload,
  SessionExecutionChangedPayload,
  SessionModelChangedPayload,
  SessionStatusChangedPayload,
  SessionTitleChangedPayload,
  TaskUpdatedPayload,
  ToolCompletedPayload,
  ToolInputDeltaPayload,
  ToolOutputDeltaPayload,
  ToolStartedPayload,
  TurnCompletedPayload,
  TurnFailedPayload,
  TurnStartedPayload,
  UsageUpdatedPayload,
} from './payloads.js'

/**
 * The single source of truth mapping each semantic event `type` to its payload
 * (requirements §9.4 base events + §9.5 extension). `RuntimeEvent`, `RuntimeEventType`
 * and `AdapterEvent` are all derived from this map so `type` and `payload` stay
 * correlated and the mapper switch is exhaustively checkable.
 *
 * NOTE: §8.2 lists a class-named union (`AssistantTextDeltaEvent`, `TodoUpdatedEvent`…).
 * That is legacy prose; §9.4's dotted-`type` envelope model is authoritative here.
 *
 * Durability: `*.delta` + `content.raw` are LIVE-ONLY (not persisted); everything else
 * is durable and replayable from the event store (see payloads.ts convention, docs/05 §4.2).
 */
export interface RuntimeEventMap {
  // session
  'session.created': SessionCreatedPayload
  'session.status_changed': SessionStatusChangedPayload
  'session.capabilities_changed': SessionCapabilitiesChangedPayload
  'session.title_changed': SessionTitleChangedPayload
  'session.model_changed': SessionModelChangedPayload
  'session.execution_changed': SessionExecutionChangedPayload
  // turn
  'turn.started': TurnStartedPayload
  'turn.completed': TurnCompletedPayload
  'turn.failed': TurnFailedPayload
  // content: text
  'content.text.started': ContentTextStartedPayload
  'content.text.delta': ContentTextDeltaPayload // live-only
  'content.text.completed': ContentTextCompletedPayload
  // content: reasoning
  'content.reasoning.started': ContentReasoningStartedPayload
  'content.reasoning.delta': ContentReasoningDeltaPayload // live-only
  'content.reasoning.completed': ContentReasoningCompletedPayload
  // content: raw passthrough (live-only, debug)
  'content.raw': ContentRawPayload
  // tool
  'tool.started': ToolStartedPayload
  'tool.input_delta': ToolInputDeltaPayload // live-only
  'tool.output_delta': ToolOutputDeltaPayload // live-only
  'tool.completed': ToolCompletedPayload
  // interaction
  'interaction.permission_requested': InteractionPermissionRequestedPayload
  'interaction.question_requested': InteractionQuestionRequestedPayload
  'interaction.grant_requested': InteractionGrantRequestedPayload
  'interaction.dialog_requested': InteractionDialogRequestedPayload
  'interaction.elicitation_requested': InteractionElicitationRequestedPayload
  'interaction.resolved': InteractionResolvedPayload
  'interaction.canceled': InteractionCanceledPayload
  // input scheduling
  'input.admitted': InputAdmittedPayload
  'input.queue_updated': InputQueueUpdatedPayload
  // task / plan / changes
  'plan.updated': PlanUpdatedPayload
  'task.updated': TaskUpdatedPayload
  'changes.updated': ChangesUpdatedPayload
  // context / usage / errors
  'context.compacted': ContextCompactedPayload
  'usage.updated': UsageUpdatedPayload
  'usage.rate_limit_updated': RateLimitUpdatedPayload
  'runtime.warning': RuntimeWarningPayload
  'runtime.error': RuntimeErrorPayload
  'runtime.extension': RuntimeExtensionPayload
}

export type RuntimeEventType = keyof RuntimeEventMap

/**
 * Event types whose payloads are LIVE-ONLY and must NOT be written to the append-only
 * event store (docs/05 §4.2). The Event Store / SSE layer uses this to decide what to
 * persist; replay from `after=<seq>` therefore only replays boundary + state events.
 */
export const LIVE_ONLY_EVENT_TYPES = [
  'content.text.delta',
  'content.reasoning.delta',
  'content.raw',
  'tool.input_delta',
  'tool.output_delta',
] as const satisfies readonly RuntimeEventType[]

export type LiveOnlyEventType = (typeof LIVE_ONLY_EVENT_TYPES)[number]

/** Sealed, storable event: the discriminated union over every base + extension type. */
export type RuntimeEvent = {
  [K in RuntimeEventType]: RuntimeEventEnvelope<RuntimeEventMap[K]> & { type: K }
}[RuntimeEventType]

/**
 * What an adapter emits before the runtime seals the event. An adapter may echo the
 * runtime-assigned turn id and add provider-derived attribution, but the runtime remains
 * the single authority for `id`/`sequence`/`sessionId`/`adapterId`/`timestamp`
 * (append-only correctness, §8.3).
 */
export type AdapterEvent<K extends RuntimeEventType = RuntimeEventType> = {
  [P in K]: {
    type: P
    payload: RuntimeEventMap[P]
    turnId?: TurnId
    attribution?: EventAttribution
    nativeRef?: NativeRef
  }
}[K]
