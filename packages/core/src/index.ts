/**
 * @agent-gateway/core — the Common Runtime Model (requirements §7, §9.4).
 *
 * Pure, dependency-free domain types + the RuntimeAdapter contract. Clients, event
 * store, memory and remote control depend ONLY on this package, never on an upstream
 * runtime's raw protocol (§4.7). Adapters map native protocols onto these types.
 */

export * from './ids.js'
export * from './errors.js'
export * from './domain/index.js'
export * from './model/index.js'
export * from './events/index.js'
export * from './adapter/index.js'
export * from './wire/index.js'

import type { RuntimeEventType } from './events/event-map.js'

/**
 * Exhaustiveness guard: every `RuntimeEventMap` key must be listed here. If a base
 * event is added to the map without a payload (or vice versa), this fails to compile.
 * Compile-time only — erased from the emitted JS.
 */
const _eventTypeExhaustive: Record<RuntimeEventType, true> = {
  'session.created': true,
  'session.status_changed': true,
  'session.capabilities_changed': true,
  'session.title_changed': true,
  'session.model_changed': true,
  'session.execution_changed': true,
  'turn.started': true,
  'turn.completed': true,
  'turn.failed': true,
  'content.text.started': true,
  'content.text.delta': true,
  'content.text.completed': true,
  'content.reasoning.started': true,
  'content.reasoning.delta': true,
  'content.reasoning.completed': true,
  'content.raw': true,
  'tool.started': true,
  'tool.input_delta': true,
  'tool.output_delta': true,
  'tool.completed': true,
  'interaction.permission_requested': true,
  'interaction.question_requested': true,
  'interaction.grant_requested': true,
  'interaction.dialog_requested': true,
  'interaction.elicitation_requested': true,
  'interaction.resolved': true,
  'interaction.canceled': true,
  'input.admitted': true,
  'input.queue_updated': true,
  'plan.updated': true,
  'task.updated': true,
  'changes.updated': true,
  'context.compacted': true,
  'usage.updated': true,
  'usage.rate_limit_updated': true,
  'runtime.warning': true,
  'runtime.error': true,
  'runtime.extension': true,
}
void _eventTypeExhaustive
