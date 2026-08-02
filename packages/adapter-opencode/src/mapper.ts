import { createHash } from 'node:crypto'
import { relative, sep } from 'node:path'
import {
  asTurnId,
  asToolCallId,
  type ChangeSet,
  type FileChange,
  type TaskItem,
  type TaskPriority,
  type TaskStatus,
  type ToolCall,
  type TurnId,
} from '@agent-gateway/core'
import {
  booleanValue,
  numberValue,
  recordValue,
  stringValue,
  type OpenCodeAdapterEvent,
  type OpenCodeEvent,
} from './protocol.js'

export interface MapperState {
  activeTurnId?: TurnId
  tools: Map<string, ToolCall>
  /** Durable text.started ids — live deltas must not create timeline rows early. */
  startedTextIds: Set<string>
  startedReasoningIds: Set<string>
  /** Live deltas that raced ahead of durable *.started on a separate SSE bus. */
  pendingTextDeltas: Map<string, string[]>
  pendingReasoningDeltas: Map<string, string[]>
  pendingToolInputDeltas: Map<string, string[]>
}

export function createMapperState(activeTurnId?: TurnId): MapperState {
  return {
    ...(activeTurnId ? { activeTurnId } : {}),
    tools: new Map(),
    startedTextIds: new Set(),
    startedReasoningIds: new Set(),
    pendingTextDeltas: new Map(),
    pendingReasoningDeltas: new Map(),
    pendingToolInputDeltas: new Map(),
  }
}

export function mapOpenCodeEvent(
  event: OpenCodeEvent,
  state: MapperState,
): OpenCodeAdapterEvent[] {
  const data = event.data
  const common = commonFields(event, state.activeTurnId)

  switch (event.type) {
    case 'session.next.text.started': {
      const blockId = contentBlockId(data, 'textID')
      if (!blockId) return []
      state.startedTextIds.add(blockId)
      const pending = state.pendingTextDeltas.get(blockId) ?? []
      state.pendingTextDeltas.delete(blockId)
      return [
        { type: 'content.text.started', payload: { blockId }, ...common },
        ...pending.map((delta) => ({
          type: 'content.text.delta' as const,
          payload: { blockId, delta },
          ...common,
        })),
      ]
    }
    case 'session.next.text.delta': {
      const blockId = contentBlockId(data, 'textID')
      const delta = stringValue(data.delta)
      if (!blockId || delta === undefined) return []
      // Live-only: buffer until durable text.started so timeline order stays durable-first.
      if (!state.startedTextIds.has(blockId)) {
        const queue = state.pendingTextDeltas.get(blockId) ?? []
        queue.push(delta)
        state.pendingTextDeltas.set(blockId, queue)
        return []
      }
      return [{ type: 'content.text.delta', payload: { blockId, delta }, ...common }]
    }
    case 'session.next.text.ended': {
      const blockId = contentBlockId(data, 'textID')
      const text = stringValue(data.text)
      if (!blockId || text === undefined) return []
      const hadStarted = state.startedTextIds.has(blockId)
      const pending = state.pendingTextDeltas.get(blockId) ?? []
      state.pendingTextDeltas.delete(blockId)
      state.startedTextIds.add(blockId)
      return [
        ...(hadStarted
          ? []
          : [{ type: 'content.text.started' as const, payload: { blockId }, ...common }]),
        ...pending.map((delta) => ({
          type: 'content.text.delta' as const,
          payload: { blockId, delta },
          ...common,
        })),
        { type: 'content.text.completed', payload: { blockId, text }, ...common },
      ]
    }
    case 'session.next.reasoning.started': {
      const blockId = contentBlockId(data, 'reasoningID')
      if (!blockId) return []
      state.startedReasoningIds.add(blockId)
      const pending = state.pendingReasoningDeltas.get(blockId) ?? []
      state.pendingReasoningDeltas.delete(blockId)
      return [
        { type: 'content.reasoning.started', payload: { blockId }, ...common },
        ...pending.map((delta) => ({
          type: 'content.reasoning.delta' as const,
          payload: { blockId, delta },
          ...common,
        })),
      ]
    }
    case 'session.next.reasoning.delta': {
      const blockId = contentBlockId(data, 'reasoningID')
      const delta = stringValue(data.delta)
      if (!blockId || delta === undefined) return []
      if (!state.startedReasoningIds.has(blockId)) {
        const queue = state.pendingReasoningDeltas.get(blockId) ?? []
        queue.push(delta)
        state.pendingReasoningDeltas.set(blockId, queue)
        return []
      }
      return [{ type: 'content.reasoning.delta', payload: { blockId, delta }, ...common }]
    }
    case 'session.next.reasoning.ended': {
      const blockId = contentBlockId(data, 'reasoningID')
      const text = stringValue(data.text)
      if (!blockId || text === undefined) return []
      const hadStarted = state.startedReasoningIds.has(blockId)
      const pending = state.pendingReasoningDeltas.get(blockId) ?? []
      state.pendingReasoningDeltas.delete(blockId)
      state.startedReasoningIds.add(blockId)
      return [
        ...(hadStarted
          ? []
          : [{ type: 'content.reasoning.started' as const, payload: { blockId }, ...common }]),
        ...pending.map((delta) => ({
          type: 'content.reasoning.delta' as const,
          payload: { blockId, delta },
          ...common,
        })),
        { type: 'content.reasoning.completed', payload: { blockId, text }, ...common },
      ]
    }
    case 'session.next.tool.input.started':
      return mapToolInputStarted(event, state, common)
    case 'session.next.tool.input.delta': {
      const callId = stringValue(data.callID)
      const delta = stringValue(data.delta)
      if (!callId || delta === undefined) return []
      if (!state.tools.has(callId)) {
        const queue = state.pendingToolInputDeltas.get(callId) ?? []
        queue.push(delta)
        state.pendingToolInputDeltas.set(callId, queue)
        return []
      }
      return [{
        type: 'tool.input_delta',
        payload: { toolCallId: asToolCallId(callId), delta },
        ...common,
      }]
    }
    case 'session.next.tool.input.ended':
      return mapToolInputEnded(event, state, common)
    case 'session.next.tool.called':
      return mapToolCalled(event, state, common)
    case 'session.next.tool.progress':
      return mapToolProgress(event, state, common)
    case 'session.next.tool.success':
      return mapToolTerminal(event, state, common, false)
    case 'session.next.tool.failed':
      return mapToolTerminal(event, state, common, true)
    case 'session.next.step.ended': {
      const tokens = recordValue(data.tokens)
      return tokens
        ? [{
            type: 'usage.updated',
            payload: { usage: mapUsage(tokens, numberValue(data.cost)) },
            ...common,
          }]
        : []
    }
    case 'session.next.step.failed': {
      const error = recordValue(data.error)
      const message = stringValue(error?.message) ?? 'OpenCode provider step failed'
      const turnId =
        state.activeTurnId ??
        (stringValue(data.assistantMessageID)
          ? asTurnId(stringValue(data.assistantMessageID) as string)
          : undefined)
      return turnId
        ? [{
            type: 'turn.failed',
            payload: {
              turnId,
              error: { code: 'unknown', layer: 'turn', message },
            },
            ...common,
            turnId,
          }]
        : [{
            type: 'runtime.error',
            payload: { error: { code: 'unknown', layer: 'turn', message } },
            ...common,
          }]
    }
    case 'session.next.retried': {
      const error = recordValue(data.error)
      return [{
        type: 'runtime.warning',
        payload: {
          error: {
            code: 'connection',
            layer: 'resource',
            retriable: booleanValue(error?.isRetryable) ?? true,
            message: stringValue(error?.message) ?? 'OpenCode is retrying',
            ...(numberValue(error?.statusCode) === undefined
              ? {}
              : { nativeCode: String(numberValue(error?.statusCode)) }),
          },
        },
        ...common,
      }]
    }
    case 'session.next.compaction.ended': {
      const reason = stringValue(data.reason)
      if (reason !== 'auto' && reason !== 'manual') return []
      return [{
        type: 'context.compacted',
        payload: { reason, ...(stringValue(data.text) ? { summary: stringValue(data.text) } : {}) },
        ...common,
      }]
    }
    case 'todo.updated':
      return mapTodoUpdated(event, common)
    case 'session.next.agent.switched':
    case 'session.next.model.switched':
    case 'session.next.shell.started':
    case 'session.next.shell.ended':
    case 'session.next.revert.staged':
    case 'session.next.revert.cleared':
    case 'session.next.revert.committed':
    case 'session.next.moved':
    case 'session.next.prompted':
    case 'session.next.prompt.admitted':
    case 'session.next.context.updated':
    case 'session.next.synthetic':
    case 'session.next.step.started':
    case 'session.next.compaction.started':
      return [extension(event, common)]
    case 'session.next.compaction.delta':
      return [{
        type: 'content.raw',
        payload: { channel: 'opencode.compaction.delta', native: event },
        ...common,
      }]
    default:
      return event.type.endsWith('.delta')
        ? [{
            type: 'content.raw',
            payload: { channel: event.type, native: event },
            ...common,
          }]
        : [extension(event, common)]
  }
}

/**
 * Official `GET /session/:id/diff?messageID=<user>` → SnapshotFileDiff[]
 * (`file`, `patch`, `additions`, `deletions`, `status`) from user.summary.diffs.
 * @see packages/schema/src/file-diff.ts
 * @see packages/opencode/src/session/summary.ts SessionSummary.diff
 */
export function changeSetFromOpenCodeDiffs(
  projectPath: string,
  diffs: unknown,
  options: {
    changeSetId: string
    scope: ChangeSet['scope']
    toolCallId?: ToolCall['id']
    status?: ChangeSet['status']
  },
): ChangeSet | undefined {
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const files: FileChange[] = []
  for (const value of diffs) {
    const entry = recordValue(value)
    if (!entry) continue
    const rawPath = stringValue(entry.path) ?? stringValue(entry.file)
    if (!rawPath) continue
    const patch = stringValue(entry.patch) ?? ''
    const normalized = normalizePath(projectPath, rawPath)
    const status = stringValue(entry.status)
    const additions =
      numberValue(entry.additions) ??
      patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
    const deletions =
      numberValue(entry.deletions) ??
      patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length
    files.push({
      path: normalized.path,
      pathKind: normalized.pathKind,
      kind: status === 'added' ? 'create' : status === 'deleted' ? 'delete' : 'modify',
      additions,
      deletions,
      ...(patch ? { patch } : {}),
      hunks: [],
    })
  }
  if (files.length === 0) return undefined
  return {
    id: options.changeSetId,
    intent: 'applied',
    scope: options.scope,
    status: options.status ?? 'completed',
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
    files,
  }
}

/** Match a file-edit tool call whose input path equals a diff path. */
export function findToolCallIdForPath(
  tools: Map<string, ToolCall>,
  projectPath: string,
  filePath: string,
): ToolCall['id'] | undefined {
  const target = normalizePath(projectPath, filePath).path
  for (const tool of tools.values()) {
    if (tool.kind !== 'file-edit' && tool.kind !== 'file-diff') continue
    const input = recordValue(tool.input)
    const raw =
      stringValue(input?.filePath) ??
      stringValue(input?.path) ??
      stringValue(input?.file_path)
    if (!raw) continue
    if (normalizePath(projectPath, raw).path === target) return tool.id
  }
  return undefined
}

function mapToolInputStarted(
  event: OpenCodeEvent,
  state: MapperState,
  common: EventCommon,
): OpenCodeAdapterEvent[] {
  const callId = stringValue(event.data.callID)
  const name = stringValue(event.data.name)
  if (!callId || !name) return []
  const toolCall: ToolCall = {
    id: asToolCallId(callId),
    kind: classifyTool(name),
    name,
    status: 'pending',
  }
  state.tools.set(callId, toolCall)
  const pending = state.pendingToolInputDeltas.get(callId) ?? []
  state.pendingToolInputDeltas.delete(callId)
  return [
    { type: 'tool.started', payload: { toolCall }, ...common },
    ...pending.map((delta) => ({
      type: 'tool.input_delta' as const,
      payload: { toolCallId: asToolCallId(callId), delta },
      ...common,
    })),
  ]
}

function mapToolInputEnded(
  event: OpenCodeEvent,
  state: MapperState,
  common: EventCommon,
): OpenCodeAdapterEvent[] {
  const callId = stringValue(event.data.callID)
  const text = stringValue(event.data.text)
  if (!callId || text === undefined) return []
  const previous = state.tools.get(callId)
  if (!previous) return [extension(event, common)]
  const input = parseToolInput(text)
  const toolCall: ToolCall = {
    ...previous,
    input,
    presentation: mapToolPresentation(previous.name, input, undefined, undefined, previous.presentation),
  }
  state.tools.set(callId, toolCall)
  return [{ type: 'tool.started', payload: { toolCall }, ...common }]
}

function mapToolCalled(
  event: OpenCodeEvent,
  state: MapperState,
  common: EventCommon,
): OpenCodeAdapterEvent[] {
  const callId = stringValue(event.data.callID)
  const name = stringValue(event.data.tool)
  if (!callId || !name) return []
  const provider = recordValue(event.data.provider)
  const previous = state.tools.get(callId)
  const input = event.data.input === undefined ? previous?.input : event.data.input
  const toolCall: ToolCall = {
    id: asToolCallId(callId),
    kind: classifyTool(name),
    name,
    status: 'running',
    ...(input === undefined ? {} : { input }),
    presentation: mapToolPresentation(name, input, undefined, undefined, previous?.presentation),
    ...(booleanValue(provider?.executed) === undefined
      ? {}
      : { providerExecuted: booleanValue(provider?.executed) }),
  }
  state.tools.set(callId, toolCall)
  return [{ type: 'tool.started', payload: { toolCall }, ...common }]
}

function mapToolProgress(
  event: OpenCodeEvent,
  state: MapperState,
  common: EventCommon,
): OpenCodeAdapterEvent[] {
  const callId = stringValue(event.data.callID)
  if (!callId) return []
  const previous = state.tools.get(callId)
  if (!previous) return [extension(event, common)]
  const content = Array.isArray(event.data.content) ? event.data.content : []
  const structured = recordValue(event.data.structured)
  const toolCall: ToolCall = {
    ...previous,
    status: 'running',
    ...(structured ? { structured } : {}),
    ...(content.length ? { result: content } : {}),
    presentation: mapToolPresentation(
      previous.name,
      previous.input,
      content.length ? content : undefined,
      structured,
      previous.presentation,
    ),
  }
  state.tools.set(callId, toolCall)
  const output = extractResultText(content.length ? content : undefined, structured)
  return [
    { type: 'tool.started', payload: { toolCall }, ...common },
    ...(output
      ? [{
          type: 'tool.output_delta',
          payload: { toolCallId: asToolCallId(callId), delta: output },
          ...common,
        } satisfies OpenCodeAdapterEvent]
      : []),
  ]
}

function mapToolTerminal(
  event: OpenCodeEvent,
  state: MapperState,
  common: EventCommon,
  failed: boolean,
): OpenCodeAdapterEvent[] {
  const callId = stringValue(event.data.callID)
  if (!callId) return []
  const provider = recordValue(event.data.provider)
  const previous = state.tools.get(callId) ?? {
    id: asToolCallId(callId),
    kind: 'generic' as const,
    name: 'unknown',
    status: 'running' as const,
  }
  const content = Array.isArray(event.data.content) ? event.data.content : []
  const structured = recordValue(event.data.structured)
  const error = recordValue(event.data.error)
  const result =
    event.data.result !== undefined ? event.data.result : content.length ? content : undefined
  const toolCall: ToolCall = {
    ...previous,
    status: failed ? 'error' : 'completed',
    ...(structured ? { structured } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(stringArray(event.data.outputPaths).length
      ? { outputPaths: stringArray(event.data.outputPaths) }
      : {}),
    ...(booleanValue(provider?.executed) === undefined
      ? {}
      : { providerExecuted: booleanValue(provider?.executed) }),
    ...(failed
      ? {
          error: {
            code: 'unknown',
            layer: 'turn',
            message: stringValue(error?.message) ?? 'OpenCode tool failed',
          },
        }
      : {}),
    presentation: mapToolPresentation(
      previous.name,
      previous.input,
      result ?? (content.length ? content : undefined),
      structured,
      previous.presentation,
    ),
  }
  state.tools.set(callId, toolCall)
  return [{ type: 'tool.completed', payload: { toolCall }, ...common }]
}

function mapTodoUpdated(
  event: OpenCodeEvent,
  common: EventCommon,
): OpenCodeAdapterEvent[] {
  if (!Array.isArray(event.data.todos)) return [extension(event, common)]
  return [{
    type: 'task.updated',
    payload: { update: { kind: 'replace', tasks: tasksFromOpenCodeTodos(event.data.todos) } },
    ...common,
  }]
}

/** OpenCode TodoWrite rows → Core TaskItem list (shared by SSE + HTTP hydrate). */
export function tasksFromOpenCodeTodos(todos: unknown): TaskItem[] {
  if (!Array.isArray(todos)) return []
  const occurrences = new Map<string, number>()
  const tasks: TaskItem[] = []
  for (const value of todos) {
    const todo = recordValue(value)
    const title = stringValue(todo?.content)
    const status = taskStatus(todo?.status)
    if (!title || !status) continue
    const occurrence = occurrences.get(title) ?? 0
    occurrences.set(title, occurrence + 1)
    const priority = taskPriority(todo?.priority)
    tasks.push({
      id: todoId(title, occurrence),
      title,
      status,
      ...(priority ? { priority } : {}),
    })
  }
  return tasks
}

function todoId(title: string, occurrence: number): string {
  const digest = createHash('sha256').update(title).digest('hex').slice(0, 16)
  return `todo:${digest}:${occurrence}`
}

function taskStatus(value: unknown): TaskStatus | undefined {
  return value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'cancelled'
    ? value
    : undefined
}

function taskPriority(value: unknown): TaskPriority | undefined {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined
}

function extension(event: OpenCodeEvent, common: EventCommon): OpenCodeAdapterEvent {
  return {
    type: 'runtime.extension',
    payload: { feature: `opencode.event.${event.type}`, payload: event },
    ...common,
  }
}

interface EventCommon {
  turnId?: TurnId
  nativeRef: { eventId: string; eventType: string }
  schemaVersion?: number
}

function commonFields(event: OpenCodeEvent, turnId: TurnId | undefined): EventCommon {
  return {
    ...(turnId ? { turnId } : {}),
    nativeRef: { eventId: event.id, eventType: event.type },
    ...(event.durable ? { schemaVersion: event.durable.version } : {}),
  }
}

/** Scope content ids by assistantMessageID so OpenCode's recycled text-0 cannot collide. */
function contentBlockId(data: Record<string, unknown>, key: 'textID' | 'reasoningID'): string | undefined {
  const local = stringValue(data[key])
  if (!local) return undefined
  const assistant = stringValue(data.assistantMessageID)
  return assistant ? `${assistant}:${local}` : local
}

/**
 * Build UI presentation from OpenCode tool input/result shapes
 * (bash.command, read/edit/write.filePath, etc.).
 */
function mapToolPresentation(
  toolName: string,
  input: unknown,
  result?: unknown,
  structured?: unknown,
  existing?: ToolCall['presentation'],
): ToolCall['presentation'] {
  const target = existing?.target ?? toolTarget(toolName, input)
  const resultText = extractResultText(result, structured) ?? existing?.resultText
  const resultSummary = resultText ? lastMeaningfulLine(resultText) : existing?.resultSummary
  if (!target && !resultText && !resultSummary) return existing
  return {
    ...(target ? { target } : {}),
    ...(resultText ? { resultText } : {}),
    ...(resultSummary ? { resultSummary } : {}),
  }
}

function toolTarget(
  toolName: string,
  input: unknown,
): NonNullable<ToolCall['presentation']>['target'] | undefined {
  const record = recordValue(input) ?? {}
  const normalized = toolName.toLowerCase()
  if (normalized === 'bash' || normalized === 'shell') {
    return target('command', firstString(record, ['command']))
  }
  if (['read', 'edit', 'write', 'multiedit', 'patch', 'apply_patch'].includes(normalized)) {
    return target('path', firstString(record, ['filePath', 'path', 'file_path']))
  }
  if (normalized === 'glob' || normalized === 'grep' || normalized === 'search' || normalized === 'list') {
    return target(
      'query',
      firstString(record, ['pattern', 'query', 'path', 'glob']),
    )
  }
  if (normalized.includes('webfetch') || normalized === 'web_fetch') {
    return target('url', firstString(record, ['url']))
  }
  if (normalized.includes('websearch') || normalized === 'web_search' || normalized.includes('web')) {
    return target('query', firstString(record, ['query', 'q', 'search']))
  }
  if (normalized.includes('task') || normalized.includes('agent')) {
    return target('task', firstString(record, ['description', 'prompt', 'task']))
  }
  if (normalized.startsWith('mcp')) {
    return target('resource', firstString(record, ['url', 'path', 'resource']) ?? toolName)
  }
  return target(
    'task',
    firstString(record, ['command', 'filePath', 'path', 'pattern', 'query', 'description', 'name']),
  )
}

function extractResultText(result: unknown, structured?: unknown): string | undefined {
  const fromContent = textFromToolContent(result)
  if (fromContent) return fromContent
  if (typeof result === 'string' && result.trim()) return result
  const struct = recordValue(structured)
  if (struct) {
    const output = stringValue(struct.output) ?? stringValue(struct.preview)
    if (output?.trim()) return output
    const stdout = typeof struct.stdout === 'string' ? struct.stdout : ''
    const stderr = typeof struct.stderr === 'string' ? struct.stderr : ''
    const terminal = [stdout, stderr].filter(Boolean).join('\n')
    if (terminal.trim()) return terminal
  }
  return extractNestedText(result)
}

function textFromToolContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value
    .flatMap((entry) => {
      const item = recordValue(entry)
      return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    })
    .join('\n')
  return text.trim() ? text : undefined
}

function extractNestedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (Array.isArray(value)) {
    const text = value
      .map(extractNestedText)
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
    return text.trim() ? text : undefined
  }
  const record = recordValue(value)
  if (!record) return undefined
  if (record.type === 'text' && typeof record.text === 'string') return record.text
  for (const key of ['text', 'content', 'message', 'output', 'result', 'preview']) {
    const text = extractNestedText(record[key])
    if (text) return text
  }
  return undefined
}

function target(
  kind: NonNullable<NonNullable<ToolCall['presentation']>['target']>['kind'],
  value: string | undefined,
): NonNullable<ToolCall['presentation']>['target'] | undefined {
  return value?.trim() ? { kind, value: value.trim() } : undefined
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key]
  }
  return undefined
}

function lastMeaningfulLine(value: string): string | undefined {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1)
  return line
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function mapUsage(tokens: Record<string, unknown>, cost?: number) {
  const cache = recordValue(tokens.cache) ?? {}
  const inputTokens = numberValue(tokens.input) ?? 0
  const outputTokens = numberValue(tokens.output) ?? 0
  const reasoningTokens = numberValue(tokens.reasoning) ?? 0
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens: numberValue(cache.read) ?? 0,
    cacheCreationInputTokens: numberValue(cache.write) ?? 0,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function normalizePath(
  projectPath: string,
  rawPath: string,
): { path: string; pathKind: 'workspace-relative' | 'absolute' } {
  const candidate = relative(projectPath, rawPath)
  if (candidate && candidate !== '..' && !candidate.startsWith(`..${sep}`)) {
    return { path: candidate.split(sep).join('/'), pathKind: 'workspace-relative' }
  }
  return { path: rawPath, pathKind: 'absolute' }
}

function classifyTool(name: string): ToolCall['kind'] {
  const normalized = name.toLowerCase()
  if (normalized === 'bash' || normalized === 'shell') return 'terminal'
  if (['edit', 'write', 'patch', 'apply_patch', 'multiedit'].includes(normalized)) return 'file-edit'
  if (normalized === 'read') return 'file-read'
  if (['glob', 'list', 'grep', 'search'].includes(normalized)) return 'search'
  if (normalized.includes('web')) return 'web'
  if (normalized.includes('task') || normalized.includes('agent')) return 'subagent'
  if (normalized === 'todowrite' || normalized === 'todo_write' || normalized === 'todo') return 'todo'
  if (normalized.startsWith('mcp')) return 'mcp'
  return 'generic'
}
