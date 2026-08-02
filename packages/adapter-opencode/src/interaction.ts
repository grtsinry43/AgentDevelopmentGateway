import {
  AdapterError,
  asInteractionId,
  asToolCallId,
  type AdapterEvent,
  type InteractionResolution,
  type SessionId,
  type TurnId,
} from '@agent-gateway/core'
import {
  recordValue,
  stringValue,
  type OpenCodeAdapterEvent,
  type OpenCodeEvent,
} from './protocol.js'

export interface PendingInteraction {
  gatewayId: ReturnType<typeof asInteractionId>
  nativeId: string
  nativeSessionId: string
  kind: 'permission' | 'question'
  questionIds?: string[]
}

export interface InteractionRequest {
  path: string
  body?: unknown
}

export function mapInteractionAsked(
  event: OpenCodeEvent,
  sessionId: SessionId,
  turnId: TurnId | undefined,
): { pending: PendingInteraction; event: OpenCodeAdapterEvent } | undefined {
  // Official bus: permission.asked; v2 alias: permission.v2.asked
  if (event.type === 'permission.v2.asked' || event.type === 'permission.asked') {
    const nativeId = stringValue(event.data.id)
    const nativeSessionId = stringValue(event.data.sessionID)
    const action = stringValue(event.data.action) ?? stringValue(event.data.permission)
    if (!nativeId || !nativeSessionId || !action) return undefined
    const gatewayId = asInteractionId(nativeId)
    const resources = stringArray(event.data.resources).length
      ? stringArray(event.data.resources)
      : stringArray(event.data.patterns)
    const source = recordValue(event.data.source) ?? recordValue(event.data.tool)
    return {
      pending: { gatewayId, nativeId, nativeSessionId, kind: 'permission' },
      event: withNative(event, {
        type: 'interaction.permission_requested',
        payload: {
          request: {
            id: gatewayId,
            sessionId,
            ...(turnId ? { turnId } : {}),
            ...(stringValue(source?.callID)
              ? { toolCallId: asToolCallId(stringValue(source?.callID) as string) }
              : {}),
            kind: 'tool_permission',
            toolKind: classifyTool(action),
            toolName: action,
            ...(event.data.metadata === undefined ? {} : { input: event.data.metadata }),
            prompt: `Allow ${action}?`,
            ...(resources.length ? { resources } : {}),
            availableDecisions: ['once', 'always', 'reject'],
            createdAt: Date.now(),
          },
        },
        ...(turnId ? { turnId } : {}),
      }),
    }
  }

  // Official bus: question.asked; v2 alias: question.v2.asked
  if (event.type === 'question.v2.asked' || event.type === 'question.asked') {
    const nativeId = stringValue(event.data.id)
    const nativeSessionId = stringValue(event.data.sessionID)
    if (!nativeId || !nativeSessionId || !Array.isArray(event.data.questions)) return undefined
    const gatewayId = asInteractionId(nativeId)
    const questions = event.data.questions.flatMap((value, index) => {
      const question = recordValue(value)
      const text = stringValue(question?.question)
      if (!question || !text) return []
      const id = `${nativeId}:${index}`
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option, optionIndex) => {
            const item = recordValue(option)
            const label = stringValue(item?.label)
            if (!item || !label) return []
            return [{
              id: `${id}:${optionIndex}`,
              label,
              ...(stringValue(item.description) ? { description: stringValue(item.description) } : {}),
            }]
          })
        : undefined
      return [{
        id,
        ...(stringValue(question.header) ? { header: stringValue(question.header) } : {}),
        question: text,
        ...(options?.length ? { options } : {}),
        ...(typeof question.multiple === 'boolean' ? { multiSelect: question.multiple } : {}),
        ...(typeof question.custom === 'boolean' ? { allowCustom: question.custom } : {}),
      }]
    })
    return {
      pending: {
        gatewayId,
        nativeId,
        nativeSessionId,
        kind: 'question',
        questionIds: questions.map((question) => question.id),
      },
      event: withNative(event, {
        type: 'interaction.question_requested',
        payload: {
          request: {
            id: gatewayId,
            sessionId,
            ...(turnId ? { turnId } : {}),
            kind: 'question',
            questions,
            createdAt: Date.now(),
          },
        },
        ...(turnId ? { turnId } : {}),
      }),
    }
  }
  return undefined
}

export function interactionClosedNativeId(event: OpenCodeEvent): string | undefined {
  if (
    event.type !== 'permission.v2.replied' &&
    event.type !== 'permission.replied' &&
    event.type !== 'question.v2.replied' &&
    event.type !== 'question.replied' &&
    event.type !== 'question.v2.rejected' &&
    event.type !== 'question.rejected'
  ) {
    return undefined
  }
  return stringValue(event.data.requestID)
}

export function resolutionRequest(
  pending: PendingInteraction,
  resolution: InteractionResolution,
): InteractionRequest {
  const base = `/api/session/${encodeURIComponent(pending.nativeSessionId)}`
  if (pending.kind === 'permission' && resolution.kind === 'tool_permission') {
    const reply =
      resolution.decision.behavior === 'deny'
        ? 'reject'
        : resolution.decision.scope === 'session'
          ? 'always'
          : 'once'
    return {
      path: `${base}/permission/${encodeURIComponent(pending.nativeId)}/reply`,
      body: {
        reply,
        ...(resolution.decision.behavior === 'deny' && resolution.decision.message
          ? { message: resolution.decision.message }
          : {}),
      },
    }
  }
  if (pending.kind === 'question' && resolution.kind === 'question') {
    const questionIds = pending.questionIds ?? []
    return {
      path: `${base}/question/${encodeURIComponent(pending.nativeId)}/reply`,
      body: { answers: questionIds.map((id) => resolution.answers[id] ?? []) },
    }
  }
  if (pending.kind === 'question' && resolution.kind === 'question_rejected') {
    return {
      path: `${base}/question/${encodeURIComponent(pending.nativeId)}/reject`,
    }
  }
  throw new AdapterError({
    code: 'protocol',
    layer: 'transport',
    message: `Resolution ${resolution.kind} does not match OpenCode ${pending.kind} interaction`,
  })
}

function withNative(event: OpenCodeEvent, mapped: AdapterEvent): OpenCodeAdapterEvent {
  return {
    ...mapped,
    nativeRef: { eventId: event.id, eventType: event.type },
    ...(event.durable ? { schemaVersion: event.durable.version } : {}),
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function classifyTool(name: string): 'terminal' | 'file-read' | 'file-edit' | 'search' | 'web' | 'mcp' | 'generic' {
  const normalized = name.toLowerCase()
  if (normalized === 'bash' || normalized === 'shell') return 'terminal'
  if (['edit', 'write', 'patch', 'apply_patch', 'multiedit'].includes(normalized)) return 'file-edit'
  if (normalized === 'read') return 'file-read'
  if (['glob', 'list', 'search'].includes(normalized)) return 'search'
  if (normalized.includes('web')) return 'web'
  if (normalized.startsWith('mcp')) return 'mcp'
  return 'generic'
}
