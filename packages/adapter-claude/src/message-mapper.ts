import {
  asToolCallId,
  type AdapterEvent,
  type ChangeSet,
  type DiffHunk,
  type DiffLine,
  type FileChange,
  type RuntimeError,
  type ToolCall,
  type TurnId,
  type Usage,
} from '@agent-gateway/core'
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { capabilitiesFromInit } from './capabilities.js'
import { classifyClaudeTool } from './tool-kind.js'
import { createFileChangeFromContents, normalizeChangePath } from './file-change.js'
import { mapClaudeTaskUpdates } from './task-update.js'

interface MapperContext {
  turnId?: TurnId
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

/** Stateful mapper for one Claude session. Provider types terminate in this package. */
export class ClaudeMessageMapper {
  private readonly tools = new Map<string, ToolCall>()
  private readonly streamedTools = new Map<number, ToolCall['id']>()
  private readonly startedBlocks = new Set<string>()
  private currentMessageId?: string

  constructor(private readonly workspacePath = process.cwd()) {}

  map(message: SDKMessage, context: MapperContext): AdapterEvent[] {
    if (message.type === 'system' && message.subtype === 'init') {
      return this.mapInit(message)
    }
    if (message.type === 'system' && message.subtype === 'session_state_changed') {
      return this.mapSessionState(message)
    }
    if (message.type === 'stream_event') {
      return this.mapPartial(message, requireTurnId(message, context.turnId))
    }
    if (message.type === 'assistant') {
      return this.mapAssistant(message, requireTurnId(message, context.turnId))
    }
    if (message.type === 'user') {
      return this.mapUser(message, requireTurnId(message, context.turnId))
    }
    if (message.type === 'result') {
      return this.mapResult(message, requireTurnId(message, context.turnId))
    }

    return [this.extension(message)]
  }

  private mapInit(message: SDKSystemMessage): AdapterEvent[] {
    return [
      {
        type: 'session.created',
        payload: {
          runtimeSessionId: message.session_id,
          capabilities: capabilitiesFromInit(message),
        },
        nativeRef: nativeRef(message),
      },
    ]
  }

  private mapSessionState(message: SDKSessionStateChangedMessage): AdapterEvent[] {
    const status =
      message.state === 'requires_action' ? 'waiting' : message.state === 'running' ? 'running' : 'idle'

    return [
      {
        type: 'session.status_changed',
        payload: { status },
        nativeRef: nativeRef(message),
      },
    ]
  }

  private mapPartial(message: SDKPartialAssistantMessage, turnId: TurnId): AdapterEvent[] {
    const event = message.event
    if (event.type === 'message_start') {
      this.currentMessageId = event.message.id
      return []
    }
    if (event.type === 'message_stop') {
      this.currentMessageId = undefined
      this.streamedTools.clear()
      return []
    }
    if (event.type === 'content_block_start') {
      const blockId = contentBlockId(this.currentMessageId ?? message.uuid, event.index)
      if (event.content_block.type === 'text') {
        this.startedBlocks.add(blockId)
        return [
          {
            type: 'content.text.started',
            payload: { blockId },
            turnId,
            nativeRef: nativeRef(message),
          },
        ]
      }
      if (event.content_block.type === 'thinking') {
        this.startedBlocks.add(blockId)
        return [
          {
            type: 'content.reasoning.started',
            payload: { blockId },
            turnId,
            nativeRef: nativeRef(message),
          },
        ]
      }
      if (event.content_block.type === 'tool_use') {
        this.streamedTools.set(event.index, asToolCallId(event.content_block.id))
        return []
      }
      return [this.rawStream(message, turnId)]
    }
    if (event.type !== 'content_block_delta') {
      return [this.rawStream(message, turnId)]
    }

    const blockId = contentBlockId(this.currentMessageId ?? message.uuid, event.index)
    if (event.delta.type === 'text_delta') {
      return [
        {
          type: 'content.text.delta',
          payload: { blockId, delta: event.delta.text },
          turnId,
          nativeRef: nativeRef(message),
        },
      ]
    }
    if (event.delta.type === 'thinking_delta') {
      return [
        {
          type: 'content.reasoning.delta',
          payload: { blockId, delta: event.delta.thinking },
          turnId,
          nativeRef: nativeRef(message),
        },
      ]
    }
    if (event.delta.type === 'input_json_delta') {
      const toolCallId = this.streamedTools.get(event.index)
      if (toolCallId) {
        return [
          {
            type: 'tool.input_delta',
            payload: { toolCallId, delta: event.delta.partial_json },
            turnId,
            nativeRef: nativeRef(message),
          },
        ]
      }
    }

    return [this.rawStream(message, turnId)]
  }

  private mapAssistant(message: SDKAssistantMessage, turnId: TurnId): AdapterEvent[] {
    const events: AdapterEvent[] = []

    for (const [index, block] of message.message.content.entries()) {
      const blockId = contentBlockId(message.message.id, index)
      if (block.type === 'text') {
        if (!this.startedBlocks.has(blockId)) {
          events.push({
            type: 'content.text.started',
            payload: { blockId },
            turnId,
            nativeRef: nativeRef(message),
          })
        }
        events.push({
          type: 'content.text.completed',
          payload: { blockId, text: block.text },
          turnId,
          nativeRef: nativeRef(message),
        })
        this.startedBlocks.delete(blockId)
      } else if (block.type === 'thinking') {
        if (!this.startedBlocks.has(blockId)) {
          events.push({
            type: 'content.reasoning.started',
            payload: { blockId },
            turnId,
            nativeRef: nativeRef(message),
          })
        }
        events.push({
          type: 'content.reasoning.completed',
          payload: { blockId, text: block.thinking },
          turnId,
          nativeRef: nativeRef(message),
        })
        this.startedBlocks.delete(blockId)
      } else if (block.type === 'tool_use') {
        const toolCall: ToolCall = {
          id: asToolCallId(block.id),
          kind: classifyClaudeTool(block.name),
          name: block.name,
          status: 'pending',
          input: block.input,
          presentation: mapClaudeToolPresentation(block.name, block.input),
        }
        this.tools.set(block.id, toolCall)
        events.push({
          type: 'tool.started',
          payload: { toolCall },
          turnId,
          nativeRef: nativeRef(message),
        })
      } else {
        events.push(this.extension(message, `claude-code.content.${block.type}`))
      }
    }

    return events
  }

  private mapUser(message: SDKUserMessage, turnId: TurnId): AdapterEvent[] {
    const content = message.message.content
    if (!Array.isArray(content)) return []

    const events: AdapterEvent[] = []
    const toolResults: ToolResultBlock[] = []
    for (const block of content) {
      if (isToolResultBlock(block)) toolResults.push(block)
    }
    for (const block of toolResults) {

      const existing = this.tools.get(block.tool_use_id)
      const status = block.is_error ? 'error' : 'completed'
      const toolCall: ToolCall = {
        ...(existing ?? {
          id: asToolCallId(block.tool_use_id),
          kind: 'generic',
          name: 'unknown',
        }),
        status,
        result: block.content,
        presentation: mapClaudeToolPresentation(
          existing?.name ?? 'unknown',
          existing?.input,
          block.content,
          message.tool_use_result,
          existing?.presentation,
        ),
        ...(toolResults.length === 1 && message.tool_use_result !== undefined
          ? { structured: message.tool_use_result }
          : {}),
        ...(block.is_error
          ? {
              error: {
                code: 'unknown',
                layer: 'resource',
                message: stringifyToolResult(block.content),
              } satisfies RuntimeError,
            }
          : {}),
      }
      this.tools.set(block.tool_use_id, toolCall)
      events.push({
        type: 'tool.completed',
        payload: { toolCall },
        turnId,
        nativeRef: nativeRef(message),
      })
      const changeSet =
        toolResults.length === 1
          ? mapClaudeChangeSet(message.tool_use_result, toolCall, this.workspacePath)
          : undefined
      if (changeSet) {
        events.push({
          type: 'changes.updated',
          payload: { changeSet },
          turnId,
          nativeRef: nativeRef(message),
        })
      }
      if (status === 'completed' && toolResults.length === 1) {
        for (const update of mapClaudeTaskUpdates(
          toolCall.name,
          toolCall.input,
          message.tool_use_result,
        )) {
          events.push({
            type: 'task.updated',
            payload: { update },
            turnId,
            nativeRef: nativeRef(message),
          })
        }
      }
      this.tools.delete(block.tool_use_id)
    }
    return events
  }

  private mapResult(message: SDKResultMessage, turnId: TurnId): AdapterEvent[] {
    const usage = mapUsage(message)
    const events: AdapterEvent[] = [
      {
        type: 'usage.updated',
        payload: { usage },
        turnId,
        nativeRef: nativeRef(message),
      },
    ]

    if (message.subtype === 'success') {
      events.push({
        type: 'turn.completed',
        payload: {
          turnId,
          status: isInterruptedTerminalReason(message.terminal_reason) ? 'interrupted' : 'completed',
          usage,
        },
        turnId,
        nativeRef: nativeRef(message),
      })
    } else {
      events.push({
        type: 'turn.failed',
        payload: { turnId, error: mapResultError(message), usage },
        turnId,
        nativeRef: nativeRef(message),
      })
    }

    return events
  }

  private rawStream(message: SDKPartialAssistantMessage, turnId: TurnId): AdapterEvent {
    return {
      type: 'content.raw',
      payload: { channel: nativeEventType(message), native: message.event },
      turnId,
      nativeRef: nativeRef(message),
    }
  }

  private extension(message: SDKMessage, feature = `claude-code.message.${nativeEventType(message)}`): AdapterEvent {
    return {
      type: 'runtime.extension',
      payload: { feature, payload: message },
      nativeRef: nativeRef(message),
    }
  }
}

interface ClaudeStructuredHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

interface ClaudeFileChangeOutput {
  filePath: string
  structuredPatch: ClaudeStructuredHunk[]
  originalFile: string | null
  type?: 'create' | 'update'
  content?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  gitDiff?: {
    status: 'modified' | 'added'
    additions: number
    deletions: number
    patch: string
  }
}

const MAX_DIFF_LINES = 10_000
const MAX_PATCH_BYTES = 1_000_000

function mapClaudeChangeSet(
  value: unknown,
  toolCall: ToolCall,
  workspacePath: string,
): ChangeSet | undefined {
  if (toolCall.status !== 'completed' || toolCall.kind !== 'file-edit' || !isClaudeFileChangeOutput(value)) {
    return undefined
  }

  const normalizedPath = normalizeChangePath(value.filePath, workspacePath)
  const normalizedHunks = normalizeClaudeHunks(value.structuredPatch)
  const contents = deriveClaudeFileContents(value)
  const fallbackChange =
    normalizedHunks.hunks.every((hunk) => hunk.lines.length === 0) && contents
      ? createFileChangeFromContents(value.filePath, contents.before, contents.after, workspacePath)
      : undefined
  const patch = value.gitDiff?.patch
  const patchBytes = patch === undefined ? 0 : Buffer.byteLength(patch, 'utf8')
  const limitedPatch = patchBytes > MAX_PATCH_BYTES ? patch?.slice(0, MAX_PATCH_BYTES) : patch
  const kind: FileChange['kind'] =
    value.type === 'create' || value.gitDiff?.status === 'added' || value.originalFile === null
      ? 'create'
      : 'modify'
  const file: FileChange = {
    ...normalizedPath,
    kind,
    additions: value.gitDiff?.additions ?? fallbackChange?.additions ?? normalizedHunks.additions,
    deletions: value.gitDiff?.deletions ?? fallbackChange?.deletions ?? normalizedHunks.deletions,
    ...(limitedPatch === undefined
      ? fallbackChange?.patch
        ? { patch: fallbackChange.patch }
        : {}
      : { patch: limitedPatch }),
    hunks: fallbackChange?.hunks ?? normalizedHunks.hunks,
    ...(normalizedHunks.omittedLines > 0
      ? {
          truncation: {
            reason: 'line_limit' as const,
            omittedLines: normalizedHunks.omittedLines,
          },
        }
      : patchBytes > MAX_PATCH_BYTES
        ? { truncation: { reason: 'byte_limit' as const } }
        : {}),
  }

  return {
    id: `tool:${toolCall.id}`,
    intent: 'applied',
    scope: 'tool',
    status: 'completed',
    toolCallId: toolCall.id,
    files: [file],
  }
}

function deriveClaudeFileContents(
  value: ClaudeFileChangeOutput,
): { before: string; after: string } | undefined {
  const before = value.originalFile ?? ''
  if (typeof value.content === 'string') return { before, after: value.content }
  if (
    typeof value.oldString !== 'string' ||
    typeof value.newString !== 'string' ||
    !before.includes(value.oldString)
  ) {
    return undefined
  }
  return {
    before,
    after: value.replaceAll
      ? before.replaceAll(value.oldString, value.newString)
      : before.replace(value.oldString, value.newString),
  }
}

function isClaudeFileChangeOutput(value: unknown): value is ClaudeFileChangeOutput {
  return (
    isRecord(value) &&
    typeof value.filePath === 'string' &&
    (typeof value.originalFile === 'string' || value.originalFile === null) &&
    Array.isArray(value.structuredPatch) &&
    value.structuredPatch.every(isClaudeStructuredHunk)
  )
}

function isClaudeStructuredHunk(value: unknown): value is ClaudeStructuredHunk {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.oldStart) &&
    isNonNegativeInteger(value.oldLines) &&
    isNonNegativeInteger(value.newStart) &&
    isNonNegativeInteger(value.newLines) &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === 'string')
  )
}

function normalizeClaudeHunks(source: ClaudeStructuredHunk[]): {
  hunks: DiffHunk[]
  additions: number
  deletions: number
  omittedLines: number
} {
  let remaining = MAX_DIFF_LINES
  let additions = 0
  let deletions = 0
  let omittedLines = 0
  const hunks: DiffHunk[] = []

  for (const sourceHunk of source) {
    let oldLine = sourceHunk.oldStart
    let newLine = sourceHunk.newStart
    const lines: DiffLine[] = []
    for (const sourceLine of sourceHunk.lines) {
      const line = normalizeClaudeDiffLine(sourceLine, oldLine, newLine)
      if (line.kind === 'addition') {
        additions += 1
        newLine += 1
      } else if (line.kind === 'deletion') {
        deletions += 1
        oldLine += 1
      } else if (line.kind === 'context') {
        oldLine += 1
        newLine += 1
      }

      if (remaining > 0) {
        lines.push(line)
        remaining -= 1
      } else {
        omittedLines += 1
      }
    }
    hunks.push({
      oldStart: sourceHunk.oldStart,
      oldLines: sourceHunk.oldLines,
      newStart: sourceHunk.newStart,
      newLines: sourceHunk.newLines,
      lines,
    })
  }

  return { hunks, additions, deletions, omittedLines }
}

function normalizeClaudeDiffLine(source: string, oldLine: number, newLine: number): DiffLine {
  if (source.startsWith('\\ No newline at end of file')) {
    return { kind: 'no-newline', text: source }
  }
  if (source.startsWith('+')) return { kind: 'addition', text: source.slice(1), newLine }
  if (source.startsWith('-')) return { kind: 'deletion', text: source.slice(1), oldLine }
  return {
    kind: 'context',
    text: source.startsWith(' ') ? source.slice(1) : source,
    oldLine,
    newLine,
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireTurnId(message: SDKMessage, turnId: TurnId | undefined): TurnId {
  if (turnId) return turnId
  throw new Error(`Claude emitted ${nativeEventType(message)} without an active Gateway turn`)
}

function contentBlockId(messageId: string, index: number): string {
  return `${messageId}:${index}`
}

function isToolResultBlock(value: unknown): value is ToolResultBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'tool_result' &&
    'tool_use_id' in value &&
    typeof value.tool_use_id === 'string'
  )
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? 'Claude tool execution failed'
}

function mapClaudeToolPresentation(
  toolName: string,
  input: unknown,
  result?: unknown,
  structured?: unknown,
  existing?: ToolCall['presentation'],
): ToolCall['presentation'] {
  const target = existing?.target ?? claudeToolTarget(toolName, input)
  const resultText = extractClaudeResultText(result, structured)
  const resultSummary = resultText ? lastMeaningfulLine(resultText) : existing?.resultSummary
  return {
    ...(target ? { target } : {}),
    ...(resultText ? { resultText } : existing?.resultText ? { resultText: existing.resultText } : {}),
    ...(resultSummary ? { resultSummary } : {}),
  }
}

function claudeToolTarget(
  toolName: string,
  input: unknown,
): NonNullable<ToolCall['presentation']>['target'] | undefined {
  const record = isRecord(input) ? input : {}
  if (toolName === 'Bash') return target('command', firstString(record, ['command']))
  if (['Read', 'Edit', 'MultiEdit', 'Write'].includes(toolName)) {
    return target('path', firstString(record, ['file_path', 'path']))
  }
  if (toolName === 'NotebookEdit') {
    return target('path', firstString(record, ['notebook_path', 'file_path', 'path']))
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    return target('query', firstString(record, ['pattern', 'query']))
  }
  if (toolName === 'WebFetch') return target('url', firstString(record, ['url']))
  if (toolName === 'WebSearch') return target('query', firstString(record, ['query']))
  if (toolName === 'Agent' || toolName === 'Task') {
    return target('task', firstString(record, ['description', 'prompt']))
  }
  if (toolName.startsWith('mcp__')) {
    return target('resource', firstString(record, ['url', 'path', 'resource']) ?? toolName)
  }
  return target('task', firstString(record, ['subject', 'description', 'name']))
}

function extractClaudeResultText(result: unknown, structured: unknown): string | undefined {
  const direct = extractText(result)
  if (direct) return direct
  if (!isRecord(structured)) return undefined
  const stdout = typeof structured.stdout === 'string' ? structured.stdout : ''
  const stderr = typeof structured.stderr === 'string' ? structured.stderr : ''
  const terminal = [stdout, stderr].filter(Boolean).join('\n')
  return terminal || extractText(structured)
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value.map(extractText).filter((entry): entry is string => Boolean(entry)).join('\n')
    return text || undefined
  }
  if (!isRecord(value)) return undefined
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  for (const key of ['text', 'content', 'message', 'output', 'result']) {
    const text = extractText(value[key])
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
    if (typeof value[key] === 'string') return value[key]
  }
  return undefined
}

function lastMeaningfulLine(value: string): string | undefined {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return undefined
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

function mapUsage(message: SDKResultMessage): Usage {
  const byModel = Object.fromEntries(
    Object.entries(message.modelUsage).map(([model, usage]) => [
      model,
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        costUsd: usage.costUSD,
      },
    ]),
  )

  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cachedInputTokens: message.usage.cache_read_input_tokens,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens,
    totalTokens: message.usage.input_tokens + message.usage.output_tokens,
    costUsd: message.total_cost_usd,
    byModel,
  }
}

function mapResultError(message: Exclude<SDKResultMessage, { subtype: 'success' }>): RuntimeError {
  const code =
    isInterruptedTerminalReason(message.terminal_reason)
      ? 'interrupted'
      : message.subtype === 'error_max_turns'
      ? 'max_turns'
      : message.subtype === 'error_max_budget_usd'
        ? 'budget_exhausted'
        : 'unknown'

  return {
    code,
    layer: 'turn',
    message: message.errors.join('\n') || message.subtype,
    nativeCode: message.subtype,
    details: {
      permissionDenials: message.permission_denials,
      terminalReason: message.terminal_reason,
    },
  }
}

function isInterruptedTerminalReason(reason: SDKResultMessage['terminal_reason']): boolean {
  return reason === 'aborted_streaming' || reason === 'aborted_tools'
}

function nativeEventType(message: SDKMessage): string {
  if ('subtype' in message && typeof message.subtype === 'string') {
    return `${message.type}.${message.subtype}`
  }
  if (message.type === 'stream_event') return `stream_event.${message.event.type}`
  return message.type
}

function nativeRef(message: SDKMessage) {
  return {
    eventType: nativeEventType(message),
    ...('uuid' in message && typeof message.uuid === 'string' ? { eventId: message.uuid } : {}),
  }
}
