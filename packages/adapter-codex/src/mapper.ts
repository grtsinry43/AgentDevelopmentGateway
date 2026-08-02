import { relative, sep } from 'node:path'
import {
  asToolCallId,
  asTurnId,
  CODEX_COLLABORATION_UPDATED,
  type AdapterEvent,
  type ChangeSet,
  type EventAttribution,
  type NativeRef,
  type SessionId,
  type SubagentRun,
  type ToolCall,
  type TurnId,
} from '@agent-gateway/core'
import {
  isRecord,
  numberValue,
  requiredString,
  stringArray,
  stringValue,
  type JsonObject,
} from './protocol.js'

interface CommonEventFields {
  turnId?: TurnId
  attribution?: EventAttribution
  nativeRef?: NativeRef
}

export interface NotificationSession {
  id: SessionId
  projectPath: string
  activeTurnId?: TurnId
  nativeActiveTurnId?: string
  startedItems: Set<string>
}

export interface NotificationContext {
  session: NotificationSession
  attribution?: EventAttribution
  /** Cache spawn/send task text by collab call id (CollabAgentToolCall.prompt). */
  rememberCollabPrompt(callId: string, prompt: string): void
  takeCollabPrompt(callId: string): string | undefined
  upsertSubagent(threadId: string, item: JsonObject, completed: boolean): {
    run: SubagentRun
    event: 'subagent.started' | 'subagent.updated' | 'subagent.completed'
  }
}

export function mapNotification(
  context: NotificationContext,
  method: string,
  params: JsonObject,
): AdapterEvent[] {
  const { session, attribution } = context
  const nativeTurnId = stringValue(params.turnId)
  const turnId = session.activeTurnId ?? (nativeTurnId ? asTurnId(nativeTurnId) : undefined)
  const common = {
    ...(turnId ? { turnId } : {}),
    ...(attribution ? { attribution } : {}),
    nativeRef: { eventType: method },
  }
  if (method === 'turn/started' && isRecord(params.turn)) {
    const nativeId = requiredString(params.turn, 'id', 'Codex turn')
    const id = session.activeTurnId ?? asTurnId(nativeId)
    if (!attribution) {
      session.activeTurnId = id
      session.nativeActiveTurnId = nativeId
    }
    return [
      { type: 'turn.started', payload: { turnId: id }, turnId: id, ...common },
      {
        type: 'session.status_changed',
        payload: { status: 'running' },
        turnId: id,
        ...common,
      },
    ]
  }
  if (method === 'turn/completed' && isRecord(params.turn)) {
    const nativeId = requiredString(params.turn, 'id', 'Codex turn')
    const id = session.activeTurnId ?? asTurnId(nativeId)
    const status = mapTurnStatus(stringValue(params.turn.status))
    if (!attribution) {
      session.activeTurnId = undefined
      session.nativeActiveTurnId = undefined
    }
    if (status === 'failed') {
      return [
        {
          type: 'turn.failed',
          payload: {
            turnId: id,
            error: {
              code: 'unknown',
              layer: 'turn',
              nativeCode: nativeErrorCode(params.turn.error) ?? 'turn_failed',
              message: nativeError(params.turn.error) ?? 'Codex turn failed',
              ...(params.turn.error === undefined ? {} : { details: params.turn.error }),
            },
          },
          turnId: id,
          ...common,
        },
        ...(!attribution
          ? [{
              type: 'session.status_changed',
              payload: { status: 'error' },
              turnId: id,
              ...common,
            } satisfies AdapterEvent]
          : []),
      ]
    }
    return [
      {
        type: 'turn.completed',
        payload: { turnId: id, status },
        turnId: id,
        ...common,
      },
      ...(!attribution
        ? [{
            type: 'session.status_changed',
            payload: { status: status === 'interrupted' ? 'interrupted' : 'idle' },
            turnId: id,
            ...common,
          } satisfies AdapterEvent]
        : []),
    ]
  }
  if (method === 'item/agentMessage/delta') {
    return deltaEvents(
      session,
      'text',
      stringValue(params.itemId),
      stringValue(params.delta),
      common,
      params,
    )
  }
  if (
    method === 'item/reasoning/textDelta' ||
    method === 'item/reasoning/summaryTextDelta'
  ) {
    return deltaEvents(
      session,
      'reasoning',
      stringValue(params.itemId),
      stringValue(params.delta),
      common,
      params,
    )
  }
  if ((method === 'item/started' || method === 'item/completed') && isRecord(params.item)) {
    return mapItem(context, params.item, method === 'item/completed', common)
  }
  if (method === 'turn/plan/updated') return mapPlan(params, common)
  if (method === 'thread/tokenUsage/updated') return mapUsage(params, common)
  if (method === 'account/rateLimits/updated') return mapRateLimits(params, common)
  if (method === 'item/fileChange/patchUpdated') {
    const itemId = stringValue(params.itemId)
    if (!itemId || !Array.isArray(params.changes)) {
      return extension(method, params, common)
    }
    return [{
      type: 'changes.updated',
      payload: {
        changeSet: mapChangeSet(
          session.projectPath,
          {
            type: 'fileChange',
            id: itemId,
            changes: params.changes,
            status: 'inProgress',
          },
          false,
        ),
      },
      ...common,
    }]
  }
  if (method === 'item/mcpToolCall/progress') {
    const itemId = stringValue(params.itemId)
    const message = stringValue(params.message)
    return itemId && message !== undefined
      ? [{
          type: 'tool.output_delta',
          payload: { toolCallId: asToolCallId(itemId), delta: message },
          ...common,
        }]
      : extension(method, params, common)
  }
  if (
    method === 'command/exec/outputDelta' ||
    method === 'item/commandExecution/outputDelta' ||
    method === 'item/fileChange/outputDelta'
  ) {
    const itemId = stringValue(params.itemId)
    const delta = stringValue(params.delta)
    return itemId && delta !== undefined
      ? [{
          type: 'tool.output_delta',
          payload: { toolCallId: asToolCallId(itemId), delta },
          ...common,
        }]
      : extension(method, params, common)
  }
  if (method === 'thread/name/updated' && !attribution) {
    const title = stringValue(params.threadName) ?? stringValue(params.name)
    return title
      ? [{ type: 'session.title_changed', payload: { title, source: 'provider' }, ...common }]
      : extension(method, params, common)
  }
  if (method === 'thread/compacted') {
    return [{ type: 'context.compacted', payload: { reason: 'auto' }, ...common }]
  }
  if (method === 'error') {
    const retry = params.willRetry === true
    return [{
      type: retry ? 'runtime.warning' : 'runtime.error',
      payload: {
        error: {
          code: 'unknown',
          layer: 'turn',
          severity: retry ? 'warning' : 'error',
          retriable: retry,
          nativeCode: isRecord(params.error)
            ? nativeErrorCode(params.error) ?? 'provider_error'
            : 'provider_error',
          message: nativeError(params.error) ?? 'Codex error',
          details: params.error,
        },
      },
      ...common,
    } as AdapterEvent]
  }
  if (
    method === 'warning' ||
    method === 'guardianWarning' ||
    method === 'configWarning' ||
    method === 'deprecationNotice'
  ) {
    const message =
      stringValue(params.message) ??
      ([stringValue(params.summary), stringValue(params.details)].filter(Boolean).join(': ') ||
        `Codex ${method}`)
    return [{
      type: 'runtime.warning',
      payload: {
        error: {
          code: 'unknown',
          layer: 'turn',
          severity: 'warning',
          nativeCode: method,
          message,
          details: params,
        },
      },
      ...common,
    }]
  }
  return extension(method, params, common)
}

function mapPlan(params: JsonObject, common: CommonEventFields): AdapterEvent[] {
  if (!Array.isArray(params.plan)) return extension('turn/plan/updated', params, common)
  const turnId = stringValue(params.turnId) ?? 'unknown'
  const explanation = stringValue(params.explanation)
  const tasks = params.plan.filter(isRecord).flatMap((step, index) => {
    const title = stringValue(step.step)
    if (!title) return []
    return [{
      id: `${turnId}:${index}`,
      title,
      status: mapPlanStatus(stringValue(step.status)),
    }]
  })
  return [{
    type: 'task.updated',
    payload: {
      update: {
        kind: 'replace' as const,
        tasks,
        ...(explanation ? { explanation } : {}),
      },
    },
    ...common,
  }]
}

function mapUsage(params: JsonObject, common: CommonEventFields): AdapterEvent[] {
  if (!isRecord(params.tokenUsage) || !isRecord(params.tokenUsage.total)) {
    return extension('thread/tokenUsage/updated', params, common)
  }
  const total = params.tokenUsage.total
  return [{
    type: 'usage.updated',
    payload: {
      usage: {
        inputTokens: numberValue(total.inputTokens),
        outputTokens: numberValue(total.outputTokens),
        cachedInputTokens: numberValue(total.cachedInputTokens),
        cacheCreationInputTokens: numberValue(total.cacheWriteInputTokens),
        reasoningTokens: numberValue(total.reasoningOutputTokens),
        totalTokens: numberValue(total.totalTokens),
        contextWindow: numberValue(params.tokenUsage.modelContextWindow),
      },
    },
    ...common,
  }]
}

function mapRateLimits(params: JsonObject, common: CommonEventFields): AdapterEvent[] {
  if (!isRecord(params.rateLimits)) {
    return extension('account/rateLimits/updated', params, common)
  }
  const rateLimits = params.rateLimits
  const windows = ['primary', 'secondary'].flatMap((window) => {
    const value = rateLimits[window]
    if (!isRecord(value)) return []
    const usedPercent = numberValue(value.usedPercent)
    const resetsAt = numberValue(value.resetsAt)
    return [{
      window,
      ...(usedPercent === undefined ? {} : { utilization: usedPercent / 100 }),
      ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1_000 }),
    }]
  })
  return [{ type: 'usage.rate_limit_updated', payload: { windows }, ...common }]
}

function deltaEvents(
  session: NotificationSession,
  kind: 'text' | 'reasoning',
  blockId: string | undefined,
  delta: string | undefined,
  common: CommonEventFields,
  params: JsonObject,
): AdapterEvent[] {
  if (!blockId || delta === undefined) {
    return extension(`item/${kind}/delta`, params, common)
  }
  const result: AdapterEvent[] = []
  if (!session.startedItems.has(`${kind}:${blockId}`)) {
    session.startedItems.add(`${kind}:${blockId}`)
    result.push({
      type: kind === 'text' ? 'content.text.started' : 'content.reasoning.started',
      payload: { blockId },
      ...common,
    } as AdapterEvent)
  }
  result.push({
    type: kind === 'text' ? 'content.text.delta' : 'content.reasoning.delta',
    payload:
      kind === 'text'
        ? { blockId, delta }
        : {
            blockId,
            delta,
            ...(numberValue(params.summaryIndex) === undefined
              ? {}
              : { summaryIndex: numberValue(params.summaryIndex) }),
            ...(numberValue(params.contentIndex) === undefined
              ? {}
              : { contentIndex: numberValue(params.contentIndex) }),
          },
    ...common,
  } as AdapterEvent)
  return result
}

function mapItem(
  context: NotificationContext,
  item: JsonObject,
  completed: boolean,
  common: CommonEventFields,
): AdapterEvent[] {
  const type = stringValue(item.type)
  const id = stringValue(item.id)
  if (!type || !id) return extension('item/unknown', item, common)
  if (type === 'agentMessage' && completed) {
    return [{
      type: 'content.text.completed',
      payload: { blockId: id, text: stringValue(item.text) ?? '' },
      ...common,
    }]
  }
  if (type === 'reasoning' && completed) {
    return [{
      type: 'content.reasoning.completed',
      payload: {
        blockId: id,
        text: stringArray(item.content).join('\n') || stringArray(item.summary).join('\n'),
      },
      ...common,
    }]
  }
  if (type === 'plan' && completed) {
    return [{
      type: 'plan.updated',
      payload: {
        plan: {
          id: `codex:${id}`,
          steps: [{ id, text: stringValue(item.text) ?? '', status: 'completed' }],
        },
      },
      ...common,
    }]
  }
  if (type === 'contextCompaction' && completed) {
    return [{ type: 'context.compacted', payload: { reason: 'auto' }, ...common }]
  }
  if (type === 'collabAgentToolCall') {
    return mapCollabAgentToolCall(context, item, completed, common)
  }
  if (type === 'subAgentActivity') {
    return mapSubAgentActivity(context, item, common)
  }
  const events = toolEvents(item, completed, common)
  if (events.length === 0) return extension(`item.${type}`, item, common)
  if (type === 'fileChange') {
    events.push({
      type: 'changes.updated',
      payload: {
        changeSet: mapChangeSet(context.session.projectPath, item, completed),
      },
      ...common,
    } as AdapterEvent)
  }
  return events
}

function mapCollabAgentToolCall(
  context: NotificationContext,
  item: JsonObject,
  completed: boolean,
  common: CommonEventFields,
): AdapterEvent[] {
  const callId = stringValue(item.id)
  const prompt = collabPrompt(item)
  if (callId && prompt) context.rememberCollabPrompt(callId, prompt)
  const events = toolEvents(item, completed, common)
  const receivers = stringArray(item.receiverThreadIds)
  for (const threadId of receivers) {
    const update = context.upsertSubagent(threadId, item, completed)
    events.push({ type: update.event, payload: { run: update.run }, ...common } as AdapterEvent)
    // Emit task text when the collab call settles with receivers (spawn/send end).
    if (prompt && completed) {
      events.push(...collabTaskEvents(update.run, prompt, callId, common))
    }
  }
  events.push({
    type: 'runtime.extension',
    payload: {
      feature: CODEX_COLLABORATION_UPDATED,
      payload: {
        tool: stringValue(item.tool),
        status: stringValue(item.status),
        callId,
        prompt,
        receiverThreadIds: receivers,
        agentsStates: item.agentsStates,
      },
    },
    ...common,
  } as AdapterEvent)
  return events
}

function mapSubAgentActivity(
  context: NotificationContext,
  item: JsonObject,
  common: CommonEventFields,
): AdapterEvent[] {
  const threadId = stringValue(item.agentThreadId)
  if (!threadId) return extension('item.subAgentActivity', item, common)
  const kind = stringValue(item.kind)
  const callId = stringValue(item.id)
  const agentPath = stringValue(item.agentPath)
  // SubAgentActivity has no task text; recover prompt from a prior CollabAgentToolCall.
  const prompt = callId ? context.takeCollabPrompt(callId) : undefined
  const terminal = kind === 'interrupted'
  const status =
    kind === 'interrupted' ? 'interrupted' : kind === 'started' ? 'pendingInit' : 'running'
  const update = context.upsertSubagent(
    threadId,
    {
      id: callId ?? `activity:${threadId}`,
      type: 'subAgentActivity',
      ...(agentPath ? { agentPath } : {}),
      ...(prompt ? { prompt } : {}),
      agentsStates: { [threadId]: { status } },
    },
    terminal,
  )
  const events: AdapterEvent[] = [
    { type: update.event, payload: { run: update.run }, ...common } as AdapterEvent,
  ]
  if (prompt && update.event === 'subagent.started') {
    events.push(...collabTaskEvents(update.run, prompt, callId, common))
  }
  events.push({
    type: 'runtime.extension',
    payload: {
      feature: CODEX_COLLABORATION_UPDATED,
      payload: {
        kind,
        agentThreadId: threadId,
        agentPath,
        callId,
        prompt: prompt ?? update.run.prompt,
      },
    },
    ...common,
  } as AdapterEvent)
  return events
}

/** Project the main→child task text onto the child timeline (and SubagentRun.prompt). */
function collabTaskEvents(
  run: SubagentRun,
  prompt: string,
  callId: string | undefined,
  common: CommonEventFields,
): AdapterEvent[] {
  const blockId = `codex-collab-task:${run.runtimeSubagentId ?? run.id}:${callId ?? 'task'}`
  const attribution: EventAttribution = {
    subagentRunId: run.id,
    ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
    sourceKind: 'subagent',
  }
  return [
    {
      type: 'content.text.completed',
      payload: { blockId, text: prompt },
      ...common,
      attribution,
    } as AdapterEvent,
  ]
}

function collabPrompt(item: JsonObject): string | undefined {
  return stringValue(item.prompt) ?? stringValue(item.message)
}

function toolEvents(
  item: JsonObject,
  completed: boolean,
  common: CommonEventFields,
): AdapterEvent[] {
  const toolCall = mapToolCall(item, completed)
  return toolCall
    ? [{
        type: completed ? 'tool.completed' : 'tool.started',
        payload: { toolCall },
        ...common,
      } as AdapterEvent]
    : []
}

function mapToolCall(item: JsonObject, completed: boolean): ToolCall | undefined {
  const id = stringValue(item.id)
  const type = stringValue(item.type)
  if (!id || !type) return undefined
  const status = completed ? mapToolStatus(stringValue(item.status)) : 'running'
  const base = { id: asToolCallId(id), name: type, status }
  if (type === 'commandExecution') {
    const command = stringValue(item.command) ?? ''
    return {
      ...base,
      kind: 'terminal',
      input: { command, cwd: stringValue(item.cwd) ?? '' },
      ...(typeof item.aggregatedOutput === 'string'
        ? { result: item.aggregatedOutput }
        : {}),
      ...(status === 'error'
        ? { error: toolError(type, item) }
        : {}),
      presentation: {
        target: { kind: 'command', value: command },
        ...(typeof item.aggregatedOutput === 'string'
          ? { resultText: item.aggregatedOutput }
          : {}),
      },
      providerExecuted: true,
    }
  }
  if (type === 'fileChange') {
    return {
      ...base,
      kind: 'file-edit',
      input: item.changes,
      ...(status === 'error' ? { error: toolError(type, item) } : {}),
      providerExecuted: true,
    }
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const name =
      [stringValue(item.server) ?? stringValue(item.namespace), stringValue(item.tool)]
        .filter(Boolean)
        .join('/') || type
    return {
      ...base,
      kind: 'mcp',
      name,
      input: item.arguments,
      ...(item.result != null
        ? { result: item.result }
        : item.contentItems != null
          ? { result: item.contentItems }
          : {}),
      ...(status === 'error' ? { error: toolError(type, item) } : {}),
      providerExecuted: type === 'mcpToolCall',
    }
  }
  if (type === 'webSearch') {
    return { ...base, kind: 'web', input: item, providerExecuted: true }
  }
  if (type === 'imageGeneration') {
    return { ...base, kind: 'generic', input: item, providerExecuted: true }
  }
  if (type === 'imageView') {
    return {
      ...base,
      kind: 'file-read',
      input: { path: item.path },
      providerExecuted: true,
    }
  }
  if (type === 'collabAgentToolCall') {
    const prompt = collabPrompt(item)
    const toolStatus = stringValue(item.status)
    const mappedStatus = completed
      ? toolStatus === 'failed' || toolStatus === 'Failed'
        ? 'error'
        : mapToolStatus(toolStatus)
      : 'running'
    return {
      id: asToolCallId(id),
      name: stringValue(item.tool) ?? type,
      status: mappedStatus,
      kind: 'subagent',
      input: {
        ...(prompt ? { prompt } : {}),
        receiverThreadIds: item.receiverThreadIds,
        tool: stringValue(item.tool),
      },
      ...(mappedStatus === 'error'
        ? {
            error: {
              code: 'unknown' as const,
              layer: 'turn' as const,
              nativeCode: 'collabAgentToolCall_failed',
              message: nativeError(item.error) ?? 'Collaboration tool call failed',
              details: item.error ?? item,
            },
          }
        : {}),
      providerExecuted: true,
    }
  }
  return undefined
}

function mapChangeSet(projectPath: string, item: JsonObject, completed: boolean): ChangeSet {
  const toolCallId = asToolCallId(requiredString(item, 'id', 'Codex file change'))
  const files = Array.isArray(item.changes)
    ? item.changes.filter(isRecord).map((change) => {
        const rawPath = requiredString(change, 'path', 'Codex file change')
        const patch = stringValue(change.diff) ?? ''
        const normalized = normalizePath(projectPath, rawPath)
        const movePath = isRecord(change.kind) && isRecord(change.kind.update)
          ? stringValue(change.kind.update.movePath)
          : undefined
        return {
          path: movePath ?? normalized.path,
          pathKind: normalized.pathKind,
          kind: movePath ? 'rename' as const : mapChangeKind(change.kind),
          ...(movePath ? { previousPath: normalized.path } : {}),
          additions: patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          deletions: patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
          patch,
          hunks: [],
        }
      })
    : []
  const status = completed ? mapToolStatus(stringValue(item.status)) : 'running'
  return {
    id: `codex:${toolCallId}`,
    intent: 'applied',
    scope: 'tool',
    status: status === 'pending' ? 'running' : status,
    toolCallId,
    files,
  }
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

function mapChangeKind(value: unknown): 'create' | 'modify' | 'delete' {
  if (value === 'add') return 'create'
  if (value === 'delete') return 'delete'
  return 'modify'
}

function mapToolStatus(value: string | undefined): ToolCall['status'] {
  if (value === 'declined') return 'declined'
  if (value === 'failed' || value === 'error') return 'error'
  if (value === 'completed' || value === 'applied' || value === 'success') return 'completed'
  return 'running'
}

function mapTurnStatus(value: string | undefined): 'completed' | 'failed' | 'interrupted' {
  if (value === 'failed') return 'failed'
  if (value === 'interrupted') return 'interrupted'
  return 'completed'
}

function mapPlanStatus(value: string | undefined): 'pending' | 'in_progress' | 'completed' {
  if (value === 'completed') return 'completed'
  if (value === 'inProgress') return 'in_progress'
  return 'pending'
}

function nativeError(value: unknown): string | undefined {
  if (!isRecord(value)) return stringValue(value)
  return stringValue(value.message)
}

function nativeErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return stringValue(value.codexErrorInfo) ?? stringValue(value.code)
}

function toolError(type: string, item: JsonObject) {
  return {
    code: 'unknown' as const,
    layer: 'turn' as const,
    nativeCode: `${type}_failed`,
    message: nativeError(item.error) ?? `${type} failed`,
    details: item.error,
  }
}

function extension(
  method: string,
  payload: unknown,
  common: CommonEventFields,
): AdapterEvent[] {
  return [{
    type: 'runtime.extension',
    payload: { feature: `codex.event.${method}`, payload },
    ...common,
  }]
}
