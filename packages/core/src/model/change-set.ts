import type { ToolCallId } from '../ids.js'

/** A provider-neutral line in a unified diff hunk. Prefix markers are not part of `text`. */
export interface DiffLine {
  kind: 'context' | 'addition' | 'deletion' | 'no-newline'
  text: string
  oldLine?: number
  newLine?: number
}

/** A normalized unified-diff hunk that clients can render without parsing provider output. */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Optional provider-supplied text following the `@@ ... @@` range header. */
  heading?: string
  lines: DiffLine[]
}

export interface DiffTruncation {
  reason: 'line_limit' | 'byte_limit' | 'provider'
  omittedLines?: number
}

/**
 * One file in a ChangeSet. Adapters normalize workspace files to relative POSIX paths;
 * changes outside the workspace remain absolute and are marked explicitly.
 */
export interface FileChange {
  path: string
  pathKind: 'workspace-relative' | 'absolute'
  kind: 'create' | 'modify' | 'delete' | 'rename'
  /** Source path for a rename; destination is `path`. */
  previousPath?: string
  additions: number
  deletions: number
  /** Original unified patch retained for fidelity and future renderers. */
  patch?: string
  hunks: DiffHunk[]
  binary?: boolean
  truncation?: DiffTruncation
}

/**
 * Provider-neutral file modifications. `changes.updated` carries the complete current
 * snapshot for this id, never a delta, so reconnect/replay can replace it atomically.
 */
export interface ChangeSet {
  id: string
  /** Proposed changes gate approval; applied changes report what the tool actually wrote. */
  intent: 'proposed' | 'applied'
  scope: 'tool' | 'turn' | 'session'
  status: 'running' | 'completed' | 'declined' | 'error'
  /** Present for a tool-scoped change set so clients can attach it to the tool timeline row. */
  toolCallId?: ToolCallId
  files: FileChange[]
}
