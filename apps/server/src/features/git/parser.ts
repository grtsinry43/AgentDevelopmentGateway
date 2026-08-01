import type {
  GitBranch,
  GitChange,
  GitChangeArea,
  GitFileStatus
} from '@agent-gateway/shared'
import type { DiffHunk, DiffLine, FileChange } from '@agent-gateway/core'

interface ParsedStatus {
  branch: GitBranch
  changes: GitChange[]
}

export function parseGitStatus(output: Buffer, repositoryPrefix: string): ParsedStatus {
  const records = output.toString('utf8').split('\0')
  const branch: GitBranch = { detached: false, ahead: 0, behind: 0 }
  const changes: GitChange[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# ')) {
      parseBranchHeader(branch, record)
      continue
    }
    const kind = record[0]
    if (kind === '?') {
      const path = projectPath(record.slice(2), repositoryPrefix)
      if (path !== undefined) changes.push({ path, area: 'untracked', status: 'untracked' })
      continue
    }
    if (kind === '1') {
      const fields = splitFields(record, 9)
      const path = projectPath(fields[8] ?? '', repositoryPrefix)
      if (path !== undefined) appendOrdinary(changes, fields[1] ?? '..', path)
      continue
    }
    if (kind === '2') {
      const fields = splitFields(record, 10)
      const path = projectPath(fields[9] ?? '', repositoryPrefix)
      const previousPath = projectPath(records[index + 1] ?? '', repositoryPrefix)
      index += 1
      if (path !== undefined) appendOrdinary(changes, fields[1] ?? '..', path, previousPath)
      continue
    }
    if (kind === 'u') {
      const fields = splitFields(record, 11)
      const path = projectPath(fields[10] ?? '', repositoryPrefix)
      if (path !== undefined) changes.push({ path, area: 'conflict', status: 'unmerged' })
    }
  }
  changes.sort(compareChanges)
  return { branch, changes }
}

export function applyNumstat(
  changes: GitChange[],
  output: Buffer,
  area: Extract<GitChangeArea, 'staged' | 'unstaged'>,
  repositoryPrefix: string
): void {
  const records = output.toString('utf8').split('\0')
  for (const record of records) {
    if (!record) continue
    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additionsText = record.slice(0, firstTab)
    const deletionsText = record.slice(firstTab + 1, secondTab)
    const path = projectPath(record.slice(secondTab + 1), repositoryPrefix)
    if (path === undefined) continue
    const change = changes.find((item) => item.area === area && item.path === path)
    if (!change) continue
    if (additionsText === '-' || deletionsText === '-') {
      change.binary = true
      continue
    }
    const additions = Number.parseInt(additionsText, 10)
    const deletions = Number.parseInt(deletionsText, 10)
    if (Number.isSafeInteger(additions)) change.additions = additions
    if (Number.isSafeInteger(deletions)) change.deletions = deletions
  }
}

export function parseGitPatch(
  patch: string,
  change: GitChange,
  truncated = false
): FileChange {
  const hunks: DiffHunk[] = []
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  let current: DiffHunk | undefined
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      current = {
        oldStart: oldLine,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newLine,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        ...(header[5]?.trim() ? { heading: header[5].trim() } : {}),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    const parsed = parseDiffLine(line, oldLine, newLine)
    if (!parsed) continue
    current.lines.push(parsed.line)
    oldLine = parsed.oldLine
    newLine = parsed.newLine
  }

  const additions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'addition').length,
    0
  )
  const deletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'deletion').length,
    0
  )
  return {
    path: change.path,
    pathKind: 'workspace-relative',
    kind: fileChangeKind(change.status),
    ...(change.previousPath ? { previousPath: change.previousPath } : {}),
    additions: change.additions ?? additions,
    deletions: change.deletions ?? deletions,
    ...(patch ? { patch } : {}),
    hunks,
    ...(change.binary || /(?:Binary files .* differ|GIT binary patch)/.test(patch)
      ? { binary: true }
      : {}),
    ...(truncated ? { truncation: { reason: 'byte_limit' as const } } : {})
  }
}

function parseBranchHeader(branch: GitBranch, record: string): void {
  if (record.startsWith('# branch.oid ')) {
    const oid = record.slice('# branch.oid '.length)
    if (oid !== '(initial)') branch.oid = oid
  } else if (record.startsWith('# branch.head ')) {
    const head = record.slice('# branch.head '.length)
    branch.detached = head === '(detached)'
    if (!branch.detached) branch.name = head
  } else if (record.startsWith('# branch.upstream ')) {
    branch.upstream = record.slice('# branch.upstream '.length)
  } else if (record.startsWith('# branch.ab ')) {
    const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
    if (match) {
      branch.ahead = Number(match[1])
      branch.behind = Number(match[2])
    }
  }
}

function appendOrdinary(
  changes: GitChange[],
  xy: string,
  path: string,
  previousPath?: string
): void {
  const indexStatus = statusFromCode(xy[0])
  const worktreeStatus = statusFromCode(xy[1])
  if (indexStatus) {
    changes.push({
      path,
      area: 'staged',
      status: indexStatus,
      ...(previousPath ? { previousPath } : {})
    })
  }
  if (worktreeStatus) {
    changes.push({
      path,
      area: 'unstaged',
      status: worktreeStatus,
      ...(previousPath ? { previousPath } : {})
    })
  }
}

function statusFromCode(code: string | undefined): GitFileStatus | undefined {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'type-changed'
    case 'U':
      return 'unmerged'
    default:
      return undefined
  }
}

function projectPath(path: string, prefix: string): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  if (!prefix) return normalized
  if (normalized === prefix) return ''
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : undefined
}

function splitFields(record: string, count: number): string[] {
  const fields: string[] = []
  let start = 0
  for (let index = 0; index < record.length && fields.length < count - 1; index += 1) {
    if (record[index] !== ' ') continue
    fields.push(record.slice(start, index))
    start = index + 1
  }
  fields.push(record.slice(start))
  return fields
}

function compareChanges(left: GitChange, right: GitChange): number {
  const rank: Record<GitChangeArea, number> = {
    conflict: 0,
    staged: 1,
    unstaged: 2,
    untracked: 3
  }
  return rank[left.area] - rank[right.area] || left.path.localeCompare(right.path)
}

function parseDiffLine(
  line: string,
  oldLine: number,
  newLine: number
): { line: DiffLine; oldLine: number; newLine: number } | undefined {
  if (line.startsWith('+')) {
    return {
      line: { kind: 'addition', text: line.slice(1), newLine },
      oldLine,
      newLine: newLine + 1
    }
  }
  if (line.startsWith('-')) {
    return {
      line: { kind: 'deletion', text: line.slice(1), oldLine },
      oldLine: oldLine + 1,
      newLine
    }
  }
  if (line.startsWith(' ')) {
    return {
      line: { kind: 'context', text: line.slice(1), oldLine, newLine },
      oldLine: oldLine + 1,
      newLine: newLine + 1
    }
  }
  if (line === '\\ No newline at end of file') {
    return { line: { kind: 'no-newline', text: line }, oldLine, newLine }
  }
  return undefined
}

function fileChangeKind(status: GitFileStatus): FileChange['kind'] {
  if (status === 'added' || status === 'untracked') return 'create'
  if (status === 'deleted') return 'delete'
  if (status === 'renamed') return 'rename'
  return 'modify'
}
