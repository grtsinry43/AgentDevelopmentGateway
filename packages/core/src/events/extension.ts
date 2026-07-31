/**
 * Namespaced extension events (requirements §9.5). Any native event that the base
 * model cannot express falls through to `type: 'runtime.extension'` carrying its
 * raw payload — native information is never dropped. Known extensions are rendered
 * by dedicated client components (registered via a Feature Registry); unknown ones
 * are retained in the Event Store and visible in a Debug View.
 */
export interface RuntimeExtensionPayload<T = unknown> {
  /** e.g. `claude-code.subagent.progress`, `codex.sandbox.changed`, `opencode.session.reverted`. */
  feature: string
  payload: T
  /**
   * Optional declarative UI hint (cradle `RuntimeUiSlot`, docs/05 §11): the runtime
   * tells the client what chrome to render (a slash command, a picker, an inline panel)
   * instead of the renderer hardcoding `if (adapterId === ...)`.
   */
  presentation?: UiChromeHint
}

/** Where a runtime-declared UI element surfaces (cradle surfaces). */
export type UiSurface =
  | 'slashCommand'
  | 'toolbarPicker'
  | 'composerState'
  | 'messageInline'
  | 'runtimePanel'
  | 'streamEvidence'
  | 'recordOnly'

/** A declarative hint for the client's Feature Registry to render (docs/05 §11). */
export interface UiChromeHint {
  surface: UiSurface
  label?: string
  iconKey?: string
}

/** Known extension feature strings, so adapters don't stringly-type (§9.5 examples). */
export const CLAUDE_SUBAGENT_PROGRESS = 'claude-code.subagent.progress'
export const CLAUDE_PLAN_MODE_CHANGED = 'claude-code.plan_mode.changed'
export const CODEX_SANDBOX_CHANGED = 'codex.sandbox.changed'
export const CODEX_COLLABORATION_UPDATED = 'codex.collaboration.updated'
export const OPENCODE_SESSION_REVERTED = 'opencode.session.reverted'
export const OPENCODE_COMMAND_AVAILABLE = 'opencode.command.available'
