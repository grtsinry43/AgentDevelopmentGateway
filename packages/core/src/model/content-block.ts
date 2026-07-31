import type { TurnId } from '../ids.js'

/**
 * ContentBlock — a unit of assistant output (§9.4). The three block kinds converge
 * Claude content blocks / Codex items / OpenCode parts. Streamed via
 * `content.text.*` and `content.reasoning.*` events; tool calls get their own model.
 */
export type ContentBlockKind = 'text' | 'reasoning' | 'tool_call'

export interface ContentBlockRef {
  turnId: TurnId
  blockId: string
  /** Position within the turn's content array; used to correlate deltas to blocks. */
  index: number
}
