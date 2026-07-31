/**
 * ChangeSet — file modifications produced during a turn (§9.4). Converges Codex
 * `file_change` items, OpenCode `Revert.FileDiff`, and Claude Edit/Write tool results.
 */
export interface FileChange {
  path: string
  kind: 'create' | 'modify' | 'delete'
  additions?: number
  deletions?: number
}

export interface ChangeSet {
  id: string
  files: FileChange[]
}
