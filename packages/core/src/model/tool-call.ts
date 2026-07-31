import type { ToolCallId } from '../ids.js'
import type { RuntimeError } from './runtime-error.js'

/**
 * ToolKind — a closed vocabulary every tool call is classified into (cradle
 * `cradleToolKinds`, docs/05 §5.1). `name` is free-form (the native tool name), so
 * without a `kind` the UI / permission / grouping can't be provider-agnostic — a Codex
 * `command_execution`, a Claude `Bash`, and an OpenCode shell part must all collapse to
 * `'terminal'`. Adapters MUST classify into one of these before emitting.
 */
export type ToolKind =
  | 'terminal'
  | 'file-read'
  | 'file-edit'
  | 'file-diff'
  | 'notebook-edit'
  | 'search'
  | 'web'
  | 'subagent'
  | 'task-control'
  | 'todo'
  | 'plan'
  | 'mcp'
  | 'worktree'
  | 'generic'

/**
 * ToolCall — converges Claude `tool_use` (+ `tool_result`), Codex `command_execution`
 * / `mcp_tool_call` / `file_change` items, and OpenCode tool parts (§9.4).
 *
 * Status is the intersection of all three PLUS Codex's `Declined`: `declined`
 * (user/policy rejected before running) is DISTINCT from `error` (execution failed) —
 * Codex exec/patch tools have it, MCP/dynamic tools don't (docs/05 §5.2). Status can be
 * inferred implicitly: Claude emits no explicit transitions, so the adapter synthesizes
 * from tool_use / tool_result / is_error / tool_progress.
 */
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'declined' | 'error'

/** A tool output spilled to / referencing a file (OpenCode `attachments`). */
export interface ToolAttachment {
  kind: 'file' | 'image'
  path?: string
  mimeType?: string
}

export interface ToolCall {
  id: ToolCallId
  /** Provider-agnostic classification; adapters must set this. */
  kind: ToolKind
  /** Native tool name, for display + exact matching (e.g. 'Bash', 'command_execution'). */
  name: string
  status: ToolCallStatus
  /** Parsed input once available; streamed incrementally via `tool.input_delta`. */
  input?: unknown

  // --- three output channels (OpenCode ToolState, docs/05 §5.1) ---
  /** Model-facing text/result the runtime feeds back to the model. */
  result?: unknown
  /** Structured record, distinct from human-readable content (OpenCode `structured`). */
  structured?: unknown
  /** Large results spilled to files (OpenCode `outputPaths`). */
  outputPaths?: string[]
  attachments?: ToolAttachment[]

  /** Structured error (not a bare string) when status is 'error'. */
  error?: RuntimeError

  // --- status bits ---
  /** Provider ran the tool server-side vs the client executed it (OpenCode/Codex dynamic). */
  providerExecuted?: boolean
  /** Result pruned from context but the call retained (OpenCode `time.pruned`), epoch ms. */
  prunedAt?: number
}
