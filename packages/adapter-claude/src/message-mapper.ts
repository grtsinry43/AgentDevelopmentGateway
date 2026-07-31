import {
  asToolCallId,
  type AdapterEvent,
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
    for (const block of content) {
      if (!isToolResultBlock(block)) continue

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
