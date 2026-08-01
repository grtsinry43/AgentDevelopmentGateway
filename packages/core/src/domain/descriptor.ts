import type { AdapterId } from '../ids.js'
import type { ExecutionCapabilities } from './execution.js'

/**
 * RuntimeFeature — boolean-gated features a runtime may support (docs/05 §8).
 * Clients decide which operations/views to show from these — NEVER inferred from the
 * adapter's name. This is the stable, closed enum; open-ended runtime capabilities live
 * in `RuntimeCapabilities.raw`.
 *
 * Distinct from `Capability` in `domain/capability.ts` (host placement of mcp/proxy/port…).
 */
export type RuntimeFeature =
  | 'session.resume'
  | 'session.fork'
  | 'output.partial_text'
  | 'output.partial_reasoning'
  | 'model.catalog'
  | 'tool.input_stream'
  | 'interaction.permission'
  | 'interaction.question'
  | 'interaction.dialog' // Claude OnUserDialog
  | 'interaction.elicitation' // MCP elicitation
  | 'work-mode.plan'
  | 'task.todo'
  | 'agent.subagent'
  | 'extension.skills'
  | 'extension.hooks'
  | 'extension.plugins'
  | 'mcp.dynamic'
  | 'context.session_injection'
  | 'context.turn_injection'
  | 'context.compaction'
  | 'changes.revert'

/** Steering support with a generic fallback (cradle tri-state, docs/05 §8). */
export type SteerSupport = 'native' | 'queue-fallback' | 'unsupported'

/**
 * Model-switch support: some runtimes switch in-session, some must restart the session
 * (which changes lifecycle, not just a call), some can't (cradle `sessionModelSwitch`).
 */
export type ModelSwitchSupport = 'in-session' | 'restart-session' | 'unsupported'

/**
 * A capability declared partially/experimentally supported, with a human-readable
 * reason (cradle `ChatRuntimeCapabilityDegradation`). Lets a runtime say "supported but
 * degraded" instead of a binary present/absent.
 */
export interface CapabilityDegradation {
  capability: string
  status: 'unsupported' | 'partial' | 'experimental'
  reason: string
}

/**
 * RuntimeCapabilities — what a runtime can do (docs/05 §8). Three parts a flat union
 * can't express: tri-state enums for fallback features, an open `raw` string set for
 * runtime-specific flags (Claude `init.capabilities`, "ignore unknown values"), and a
 * `degradations` list. Capabilities can CHANGE mid-session (Claude reloadSkills / MCP /
 * commands) — a `session.capabilities_changed` event re-broadcasts them, so treat the
 * value on `RuntimeConnection` as the INITIAL snapshot, not a permanent truth.
 */
export interface RuntimeCapabilities {
  steer: SteerSupport
  modelSwitch: ModelSwitchSupport
  execution: ExecutionCapabilities
  /** Boolean-gated features; absent key = unknown/unsupported. */
  features: Partial<Record<RuntimeFeature, boolean>>
  /** Open-ended runtime flags (Claude init.capabilities, Codex experimental gates). */
  raw: string[]
  degradations?: CapabilityDegradation[]
}

/** Descriptor an adapter advertises to clients (requirements §7.7). */
export interface RuntimeAdapterDescriptor {
  id: AdapterId
  displayName: string
  adapterVersion: string
  runtimeVersion?: string
  protocolVersion: string
  /** Baseline capabilities; per-connection/per-session values may differ (see above). */
  capabilities: RuntimeCapabilities
}

/**
 * Version triple recorded per connection (requirements §9.8). Adapter version,
 * gateway protocol version, and upstream runtime version are tracked separately so
 * upstream changes only touch the corresponding adapter.
 */
export interface AdapterRuntimeVersion {
  adapterVersion: string
  gatewayProtocolVersion: number
  upstreamRuntimeVersion: string
  upstreamProtocolVersion?: string
}
