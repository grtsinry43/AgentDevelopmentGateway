import {
  asInteractionId,
  asToolCallId,
  asTurnId,
  type AdapterEvent,
  type InteractionId,
  type InteractionResolution,
  type SessionId,
  type TurnId,
} from '@agent-gateway/core'
import type { RequestId } from './app-server-client.js'
import {
  isRecord,
  requiredString,
  stringValue,
  unsupportedError,
  type JsonObject,
} from './protocol.js'

export const HUMAN_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'execCommandApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])

export function interactionIdFor(requestId: RequestId): InteractionId {
  return asInteractionId(`codex:${typeof requestId}:${String(requestId)}`)
}

export function mapInteractionRequest(
  sessionId: SessionId,
  activeTurnId: TurnId | undefined,
  requestId: RequestId,
  method: string,
  params: JsonObject,
): AdapterEvent {
  const id = interactionIdFor(requestId)
  const nativeTurn = stringValue(params.turnId)
  const turnId = activeTurnId ?? (nativeTurn ? asTurnId(nativeTurn) : undefined)
  const base = {
    id,
    sessionId,
    ...(turnId ? { turnId } : {}),
    createdAt: Date.now(),
  }
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'execCommandApproval'
  ) {
    const command = stringValue(params.command) ?? 'Command execution'
    return {
      type: 'interaction.permission_requested',
      payload: {
        request: {
          ...base,
          kind: 'tool_permission',
          ...(stringValue(params.itemId)
            ? { toolCallId: asToolCallId(stringValue(params.itemId)!) }
            : {}),
          toolKind: 'terminal',
          toolName: 'commandExecution',
          input: {
            command,
            ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) } : {}),
          },
          prompt: stringValue(params.reason) ?? `Run ${command}`,
          ...(Array.isArray(params.availableDecisions)
            ? { availableDecisions: params.availableDecisions.map(String) }
            : {}),
        },
      },
      ...(turnId ? { turnId } : {}),
    }
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return {
      type: 'interaction.permission_requested',
      payload: {
        request: {
          ...base,
          kind: 'tool_permission',
          ...(stringValue(params.itemId)
            ? { toolCallId: asToolCallId(stringValue(params.itemId)!) }
            : {}),
          toolKind: 'file-edit',
          toolName: 'fileChange',
          input: params,
          prompt: stringValue(params.reason) ?? 'Apply file changes',
        },
      },
      ...(turnId ? { turnId } : {}),
    }
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      type: 'interaction.grant_requested',
      payload: {
        request: {
          ...base,
          kind: 'permission_grant',
          prompt: stringValue(params.reason) ?? 'Grant additional permissions',
          requestedProfile: params.permissions,
        },
      },
      ...(turnId ? { turnId } : {}),
    }
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions)
      ? params.questions.filter(isRecord).map((question) => ({
          id: requiredString(question, 'id', 'Codex question'),
          ...(stringValue(question.header) ? { header: stringValue(question.header) } : {}),
          question: requiredString(question, 'question', 'Codex question'),
          ...(Array.isArray(question.options)
            ? {
                options: question.options.filter(isRecord).map((option) => ({
                  id: requiredString(option, 'label', 'Codex option'),
                  label: requiredString(option, 'label', 'Codex option'),
                  ...(stringValue(option.description)
                    ? { description: stringValue(option.description) }
                    : {}),
                })),
              }
            : {}),
          multiSelect: question.multiSelect === true,
          allowCustom: question.isOther === true,
          isSecret: question.isSecret === true,
        }))
      : []
    return {
      type: 'interaction.question_requested',
      payload: { request: { ...base, kind: 'question', questions } },
      ...(turnId ? { turnId } : {}),
    }
  }
  if (method === 'mcpServer/elicitation/request') {
    const mode = params.mode === 'url' ? 'url' : 'form'
    return {
      type: 'interaction.elicitation_requested',
      payload: {
        request: {
          ...base,
          kind: 'elicitation',
          serverName: stringValue(params.serverName) ?? 'MCP',
          message: stringValue(params.message) ?? 'Input requested',
          mode,
          ...(mode === 'form' ? { requestedSchema: params.requestedSchema } : {}),
        },
      },
      ...(turnId ? { turnId } : {}),
    }
  }
  throw unsupportedError(
    `Unsupported Codex human interaction: ${method}`,
    'codex.interaction.unsupported',
  )
}

export function mapInteractionResolution(
  method: string,
  resolution: InteractionResolution,
): unknown {
  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'execCommandApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'applyPatchApproval'
  ) {
    if (resolution.kind !== 'tool_permission') {
      throw new Error(`Expected tool_permission, got ${resolution.kind}`)
    }
    if (resolution.persistRule) {
      throw unsupportedError(
        'Codex approval responses cannot represent Gateway persistRule',
        'codex.interaction.persist_rule_unsupported',
      )
    }
    if (resolution.decision.behavior === 'allow' && resolution.decision.updatedInput !== undefined) {
      throw unsupportedError(
        'Codex approval responses cannot rewrite tool input',
        'codex.interaction.updated_input_unsupported',
      )
    }
    return {
      decision:
        resolution.decision.behavior === 'allow'
          ? resolution.decision.scope === 'session'
            ? 'acceptForSession'
            : 'accept'
          : resolution.decision.abortTurn
            ? 'cancel'
            : 'decline',
    }
  }
  if (method === 'item/permissions/requestApproval') {
    if (resolution.kind !== 'permission_grant') {
      throw new Error(`Expected permission_grant, got ${resolution.kind}`)
    }
    return {
      permissions: resolution.grantedProfile,
      scope: resolution.scope === 'session' ? 'session' : 'turn',
    }
  }
  if (method === 'item/tool/requestUserInput') {
    if (resolution.kind === 'question_rejected' || resolution.kind === 'canceled') {
      return { answers: {} }
    }
    if (resolution.kind !== 'question') {
      throw new Error(`Expected question, got ${resolution.kind}`)
    }
    return {
      answers: Object.fromEntries(
        Object.entries(resolution.answers).map(([key, answers]) => [key, { answers }]),
      ),
    }
  }
  if (method === 'mcpServer/elicitation/request') {
    if (resolution.kind !== 'elicitation') {
      throw new Error(`Expected elicitation, got ${resolution.kind}`)
    }
    return resolution.outcome.behavior === 'completed'
      ? { action: 'accept', content: resolution.outcome.content, _meta: null }
      : { action: 'cancel', content: null, _meta: null }
  }
  throw unsupportedError(
    `Unsupported Codex interaction method: ${method}`,
    'codex.interaction.unsupported',
  )
}
