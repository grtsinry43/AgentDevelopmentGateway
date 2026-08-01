import {
  asInteractionId,
  asToolCallId,
  type AdapterEvent,
  type InteractionId,
  type InteractionResolution,
  type Question,
  type SessionId,
  type TurnId,
} from '@agent-gateway/core'
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools'
import { classifyClaudeTool } from './tool-kind.js'
import { createClaudeProposedChangeSet } from './file-change.js'

type EventSink = (event: AdapterEvent) => void
type ClaudeQuestion = AskUserQuestionInput['questions'][number]
type ClaudeQuestionOption = ClaudeQuestion['options'][number]

interface PendingInteraction {
  kind: 'tool_permission' | 'question'
  input: Record<string, unknown>
  questions?: AskUserQuestionInput['questions']
  toolUseId: string
  resolve: (result: PermissionResult) => void
  removeAbortListener: () => void
}

/** Bridges Claude's blocking canUseTool callback onto runtime-owned interactions. */
export class ClaudeInteractionBridge {
  private readonly pending = new Map<InteractionId, PendingInteraction>()

  constructor(
    private readonly sessionId: SessionId,
    private readonly currentTurnId: () => TurnId | undefined,
    private readonly emit: EventSink,
    private readonly workspacePath = process.cwd(),
  ) {}

  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const id = asInteractionId(options.requestId)
    if (this.pending.has(id)) throw new Error(`Duplicate Claude interaction request: ${id}`)
    const questions = toolName === 'AskUserQuestion' ? parseQuestions(input) : undefined
    const toolKind = classifyClaudeTool(toolName)
    const toolCallId = asToolCallId(options.toolUseID)
    const proposedChangeSet =
      toolKind === 'file-edit'
        ? await createClaudeProposedChangeSet(toolName, input, toolCallId, this.workspacePath)
        : undefined

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => this.cancel(id, 'aborted', 'Claude canceled the interaction')
      options.signal.addEventListener('abort', onAbort, { once: true })
      const pending: PendingInteraction = {
        kind: toolName === 'AskUserQuestion' ? 'question' : 'tool_permission',
        input,
        questions,
        toolUseId: options.toolUseID,
        resolve,
        removeAbortListener: () => options.signal.removeEventListener('abort', onAbort),
      }
      this.pending.set(id, pending)
      if (options.signal.aborted) {
        this.cancel(id, 'aborted', 'Claude canceled the interaction')
        return
      }

      if (toolName === 'AskUserQuestion') {
        if (!questions) throw new Error('Claude question metadata is missing')
        this.emit({
          type: 'interaction.question_requested',
          payload: {
            request: {
              id,
              kind: 'question',
              sessionId: this.sessionId,
              turnId: this.currentTurnId(),
              toolCallId,
              createdAt: Date.now(),
              questions: questions.map(mapQuestion),
            },
          },
          turnId: this.currentTurnId(),
          nativeRef: { eventId: options.requestId, eventType: 'control_request.can_use_tool' },
        })
        return
      }

      this.emit({
        type: 'interaction.permission_requested',
        payload: {
          request: {
            id,
            kind: 'tool_permission',
            sessionId: this.sessionId,
            turnId: this.currentTurnId(),
            toolCallId,
            createdAt: Date.now(),
            toolKind,
            toolName,
            input,
            ...(proposedChangeSet ? { proposedChangeSet } : {}),
            prompt: options.title ?? options.description ?? `Claude wants to use ${toolName}`,
            resources: options.blockedPath ? [options.blockedPath] : undefined,
            availableDecisions: ['allow', 'deny'],
            suggestions: options.suggestions,
          },
        },
        turnId: this.currentTurnId(),
        nativeRef: { eventId: options.requestId, eventType: 'control_request.can_use_tool' },
      })
    })
  }

  resolve(resolution: InteractionResolution): void {
    const pending = this.pending.get(resolution.id)
    if (!pending) return

    let result: PermissionResult
    if (pending.kind === 'tool_permission' && resolution.kind === 'tool_permission') {
      result = mapToolPermissionResult(resolution, pending)
    } else if (pending.kind === 'question' && resolution.kind === 'question') {
      result = mapQuestionResult(resolution.answers, pending)
    } else if (pending.kind === 'question' && resolution.kind === 'question_rejected') {
      result = deny('User declined to answer the question', pending.toolUseId)
    } else if (resolution.kind === 'canceled') {
      this.cancel(resolution.id, resolution.reason, `Interaction ${resolution.reason}`)
      return
    } else {
      throw new Error(`Resolution kind ${resolution.kind} does not match ${pending.kind}`)
    }

    this.pending.delete(resolution.id)
    pending.removeAbortListener()
    this.emit({
      type: 'interaction.resolved',
      payload: { id: resolution.id, resolution },
      turnId: this.currentTurnId(),
    })
    pending.resolve(result)
  }

  cancelAll(reason: 'aborted' | 'superseded', message: string): void {
    for (const id of [...this.pending.keys()]) this.cancel(id, reason, message)
  }

  private cancel(
    id: InteractionId,
    reason: 'timed_out' | 'aborted' | 'superseded',
    message: string,
  ): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.removeAbortListener()
    this.emit({
      type: 'interaction.canceled',
      payload: { id, reason },
      turnId: this.currentTurnId(),
    })
    pending.resolve(deny(message, pending.toolUseId))
  }
}

function mapToolPermissionResult(
  resolution: Extract<InteractionResolution, { kind: 'tool_permission' }>,
  pending: PendingInteraction,
): PermissionResult {
  if (resolution.decision.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: resolution.decision.message ?? 'User denied this action',
      interrupt: resolution.decision.abortTurn,
      toolUseID: pending.toolUseId,
    }
  }

  const updatedInput = resolution.decision.updatedInput ?? pending.input
  if (!isRecord(updatedInput)) throw new Error('Claude tool input must be an object')
  const updatedPermissions = resolution.persistRule ? [mapPersistRule(resolution.persistRule)] : undefined
  return { behavior: 'allow', updatedInput, updatedPermissions, toolUseID: pending.toolUseId }
}

function mapPersistRule(
  persistRule: NonNullable<Extract<InteractionResolution, { kind: 'tool_permission' }>['persistRule']>,
): PermissionUpdate {
  const destination = {
    session: 'session',
    project: 'projectSettings',
    user: 'userSettings',
    local: 'localSettings',
  } as const
  return {
    type: 'addRules',
    behavior: 'allow',
    destination: destination[persistRule.destination],
    rules: [persistRule.rule],
  }
}

function mapQuestionResult(
  answers: Record<string, string[]>,
  pending: PendingInteraction,
): PermissionResult {
  const questions = pending.questions
  if (!questions) throw new Error('Claude question metadata is missing')
  const sdkAnswers = Object.fromEntries(
    questions.map((question) => {
      const answer = answers[question.question]
      if (!answer?.length) throw new Error(`Missing answer for Claude question: ${question.question}`)
      return [question.question, answer.join(', ')]
    }),
  )
  return {
    behavior: 'allow',
    updatedInput: { questions, answers: sdkAnswers },
    toolUseID: pending.toolUseId,
  }
}

function parseQuestions(input: Record<string, unknown>): AskUserQuestionInput['questions'] {
  if (!Array.isArray(input.questions)) throw new Error('AskUserQuestion input must contain questions')
  if (input.questions.length < 1 || input.questions.length > 4) {
    throw new Error('AskUserQuestion must contain between one and four questions')
  }
  const questions: ClaudeQuestion[] = []
  for (const value of input.questions) {
    if (!isRecord(value) || typeof value.question !== 'string' || typeof value.header !== 'string') {
      throw new Error('Invalid AskUserQuestion question')
    }
    if (!Array.isArray(value.options) || typeof value.multiSelect !== 'boolean') {
      throw new Error('Invalid AskUserQuestion options')
    }
    if (value.options.length < 2 || value.options.length > 4) {
      throw new Error('AskUserQuestion must contain between two and four options')
    }
    const options: ClaudeQuestionOption[] = value.options.map((option) => {
      if (!isRecord(option) || typeof option.label !== 'string' || typeof option.description !== 'string') {
        throw new Error('Invalid AskUserQuestion option')
      }
      return {
        label: option.label,
        description: option.description,
        ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
      }
    })
    questions.push({
      question: value.question,
      header: value.header,
      options: options as ClaudeQuestion['options'],
      multiSelect: value.multiSelect,
    })
  }
  return questions as AskUserQuestionInput['questions']
}

function mapQuestion(question: AskUserQuestionInput['questions'][number]): Question {
  return {
    id: question.question,
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({ id: option.label, ...option })),
    multiSelect: question.multiSelect,
    allowCustom: true,
  }
}

function deny(message: string, toolUseID: string): PermissionResult {
  return { behavior: 'deny', message, toolUseID }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
