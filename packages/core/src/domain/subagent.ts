import type { ModelSelection } from '../adapter/io.js'
import type { RuntimeError } from '../model/runtime-error.js'
import type { SessionId, SubagentRunId, ToolCallId } from '../ids.js'

/** Provider-neutral lifecycle of one delegated agent execution. */
export type SubagentRunStatus =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

/**
 * A child execution inside a user-created AgentSession.
 *
 * Providers disagree on the native container: Claude uses Task/subagent transcripts,
 * Codex uses child threads, and OpenCode uses child sessions. The Gateway therefore
 * gives every child execution its own stable id while keeping the provider id opaque.
 */
export interface SubagentRun {
  id: SubagentRunId
  /** User-created root conversation that owns this execution tree. */
  sessionId: SessionId
  /** Parent for nested delegation. Absent means the root agent spawned this run. */
  parentSubagentRunId?: SubagentRunId
  /** Tool call in the parent transcript that initiated the run, when observable. */
  parentToolCallId?: ToolCallId
  /** Native task/thread/session id. It is diagnostic and must not drive client behavior. */
  runtimeSubagentId?: string
  /** Provider-neutral agent/profile name, for example explorer or general. */
  agentName?: string
  title: string
  description?: string
  prompt?: string
  model?: ModelSelection
  executionMode: 'foreground' | 'background'
  status: SubagentRunStatus
  resultSummary?: string
  error?: RuntimeError
  startedAt: number
  updatedAt: number
  completedAt?: number
}
