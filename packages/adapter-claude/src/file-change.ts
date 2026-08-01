import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ChangeSet,
  DiffHunk,
  DiffLine,
  FileChange,
  ToolCallId,
} from '@agent-gateway/core'

const CONTEXT_LINES = 3
const MAX_DIFF_LINES = 10_000
const MAX_PREVIEW_FILE_BYTES = 2_000_000

export async function createClaudeProposedChangeSet(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: ToolCallId,
  workspacePath: string,
): Promise<ChangeSet | undefined> {
  const filePath = stringField(input, 'file_path')
  if (!filePath) return undefined

  const absolutePath = path.resolve(workspacePath, filePath)
  let before = ''
  try {
    if ((await stat(absolutePath)).size > MAX_PREVIEW_FILE_BYTES) return undefined
    before = await readFile(absolutePath, 'utf8')
  } catch (error) {
    if (toolName !== 'Write' || !isMissingFileError(error)) return undefined
  }

  const after = applyClaudeFileInput(toolName, input, before)
  if (after === undefined || after === before) return undefined
  return {
    id: `proposed:${toolCallId}`,
    intent: 'proposed',
    scope: 'tool',
    status: 'running',
    toolCallId,
    files: [createFileChangeFromContents(filePath, before, after, workspacePath)],
  }
}

export function createFileChangeFromContents(
  filePath: string,
  before: string,
  after: string,
  workspacePath: string,
): FileChange {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const contextBefore = Math.min(CONTEXT_LINES, prefix)
  const contextAfter = Math.min(CONTEXT_LINES, suffix)
  const oldChanged = beforeLines.slice(prefix, beforeLines.length - suffix)
  const newChanged = afterLines.slice(prefix, afterLines.length - suffix)
  const oldStart = beforeLines.length === 0 ? 0 : prefix - contextBefore + 1
  const newStart = afterLines.length === 0 ? 0 : prefix - contextBefore + 1
  const oldLines = contextBefore + oldChanged.length + contextAfter
  const newLines = contextBefore + newChanged.length + contextAfter
  let oldLine = oldStart
  let newLine = newStart
  const allLines: DiffLine[] = []

  for (const text of beforeLines.slice(prefix - contextBefore, prefix)) {
    allLines.push({ kind: 'context', text, oldLine, newLine })
    oldLine += 1
    newLine += 1
  }
  for (const text of oldChanged) {
    allLines.push({ kind: 'deletion', text, oldLine })
    oldLine += 1
  }
  for (const text of newChanged) {
    allLines.push({ kind: 'addition', text, newLine })
    newLine += 1
  }
  for (const text of afterLines.slice(afterLines.length - suffix, afterLines.length - suffix + contextAfter)) {
    allLines.push({ kind: 'context', text, oldLine, newLine })
    oldLine += 1
    newLine += 1
  }

  const omittedLines = Math.max(0, allLines.length - MAX_DIFF_LINES)
  const hunk: DiffHunk = {
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines: allLines.slice(0, MAX_DIFF_LINES),
  }
  const normalizedPath = normalizeChangePath(filePath, workspacePath)
  const kind: FileChange['kind'] = beforeLines.length === 0 ? 'create' : afterLines.length === 0 ? 'delete' : 'modify'
  return {
    ...normalizedPath,
    kind,
    additions: newChanged.length,
    deletions: oldChanged.length,
    patch: formatHunk(hunk),
    hunks: [hunk],
    ...(omittedLines > 0
      ? { truncation: { reason: 'line_limit' as const, omittedLines } }
      : {}),
  }
}

export function normalizeChangePath(
  filePath: string,
  workspacePath: string,
): Pick<FileChange, 'path' | 'pathKind'> {
  if (!path.isAbsolute(filePath)) {
    return { path: toPosixPath(filePath.replace(/^\.\//, '')), pathKind: 'workspace-relative' }
  }

  const relative = path.relative(path.resolve(workspacePath), path.resolve(filePath))
  if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return { path: toPosixPath(relative), pathKind: 'workspace-relative' }
  }
  return { path: toPosixPath(path.resolve(filePath)), pathKind: 'absolute' }
}

function applyClaudeFileInput(
  toolName: string,
  input: Record<string, unknown>,
  before: string,
): string | undefined {
  if (toolName === 'Write') return stringField(input, 'content')
  if (toolName === 'Edit') {
    const oldString = stringField(input, 'old_string')
    const newString = stringField(input, 'new_string')
    if (oldString === undefined || newString === undefined || !before.includes(oldString)) return undefined
    return input.replace_all === true ? before.replaceAll(oldString, newString) : before.replace(oldString, newString)
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    let result = before
    for (const edit of input.edits) {
      if (!isRecord(edit)) return undefined
      const oldString = stringField(edit, 'old_string')
      const newString = stringField(edit, 'new_string')
      if (oldString === undefined || newString === undefined || !result.includes(oldString)) return undefined
      result = edit.replace_all === true ? result.replaceAll(oldString, newString) : result.replace(oldString, newString)
    }
    return result
  }
  return undefined
}

function formatHunk(hunk: DiffHunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
  return [
    header,
    ...hunk.lines.map((line) => {
      if (line.kind === 'addition') return `+${line.text}`
      if (line.kind === 'deletion') return `-${line.text}`
      if (line.kind === 'no-newline') return line.text
      return ` ${line.text}`
    }),
  ].join('\n')
}

function splitLines(value: string): string[] {
  if (!value) return []
  const lines = value.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
