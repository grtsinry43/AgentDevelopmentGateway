import { randomUUID } from 'node:crypto'
import {
  AdapterError,
  toRuntimeError,
  type AdapterEvent,
  type CreateSessionInput,
  type InteractionResolution,
  type InterruptOptions,
  type ModelSelection,
  type ResumeSessionInput,
  type RuntimeAdapter,
  type RuntimeAdapterDescriptor,
  type RuntimeCapabilities,
  type RuntimeConnectOptions,
  type RuntimeConnection,
  type RuntimeHostContext,
  type RuntimeInstallation,
  type RuntimeSessionHandle,
  type SendOptions,
  type SessionId,
  type TurnId,
  type UserInput,
} from '@agent-gateway/core'
import {
  query as createClaudeQuery,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './async-queue.js'
import { CLAUDE_BASE_CAPABILITIES } from './capabilities.js'
import { ClaudeInteractionBridge } from './interaction-bridge.js'
import { ClaudeMessageMapper } from './message-mapper.js'

export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  initializationResult(): Promise<SDKControlInitializeResponse>
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<unknown>
  close(): void
}

export type ClaudeQueryFactory = (parameters: Parameters<typeof createClaudeQuery>[0]) => ClaudeQuery

interface ClaudeConnectionState {
  connection: RuntimeConnection
  context: RuntimeHostContext
  installation?: RuntimeInstallation
}

interface ClaudeSessionState {
  id: SessionId
  runtimeSessionId: string
  query: ClaudeQuery
  input: AsyncQueue<SDKUserMessage>
  events: AsyncQueue<AdapterEvent>
  mapper: ClaudeMessageMapper
  bridge: ClaudeInteractionBridge
  capabilities: RuntimeCapabilities
  activeTurnId?: TurnId
  lastTurnId?: TurnId
  disposed: boolean
  failure?: unknown
  pump: Promise<void>
}

const descriptor: RuntimeAdapterDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  adapterVersion: '0.0.0',
  protocolVersion: '1',
  capabilities: CLAUDE_BASE_CAPABILITIES,
}

/** Claude Agent SDK adapter backed by one streaming-input Query per Gateway session. */
export class ClaudeAdapter implements RuntimeAdapter {
  readonly descriptor = descriptor
  private readonly connections = new Map<string, ClaudeConnectionState>()
  private readonly sessions = new Map<SessionId, ClaudeSessionState>()

  constructor(private readonly queryFactory: ClaudeQueryFactory = createClaudeQuery) {}

  detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]> {
    void context
    return Promise.resolve([
      {
        path: '@anthropic-ai/claude-agent-sdk',
        source: 'managed',
      },
    ])
  }

  connect(options: RuntimeConnectOptions): Promise<RuntimeConnection> {
    const connection: RuntimeConnection = {
      id: randomUUID(),
      transport: 'sdk',
      runtimeVersion: options.installation?.version,
      capabilities: cloneCapabilities(CLAUDE_BASE_CAPABILITIES),
    }
    this.connections.set(connection.id, {
      connection,
      context: options.context,
      installation: options.installation,
    })
    return Promise.resolve(connection)
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    this.assertContextUnsupported(input.context)
    if (input.providerProfileId) {
      throw adapterError('not_implemented', 'Claude provider profiles are not wired yet')
    }
    const runtimeSessionId = randomUUID()
    const session = await this.startSession({
      id: input.sessionId,
      runtimeSessionId,
      projectPath: input.projectPath,
      connection: input.connection,
      model: input.model,
      mode: input.mode,
      querySessionOptions: { sessionId: runtimeSessionId },
      publishCreated: true,
    })
    return { sessionId: session.id, runtimeSessionId: session.runtimeSessionId }
  }

  async resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle> {
    this.assertContextUnsupported(input.context)
    if (input.providerStateSnapshot) {
      throw adapterError('protocol', 'Claude sessions do not resume from provider state snapshots')
    }
    if (input.cursor && input.cursor.by !== 'message') {
      throw adapterError('protocol', `Claude cannot resume from a ${input.cursor.by} cursor`)
    }
    const session = await this.startSession({
      id: input.sessionId,
      runtimeSessionId: input.runtimeSessionId,
      projectPath: input.projectPath,
      connection: input.connection,
      querySessionOptions: {
        resume: input.runtimeSessionId,
        ...(input.cursor?.by === 'message' ? { resumeSessionAt: input.cursor.messageUuid } : {}),
      },
      publishCreated: false,
    })
    return { sessionId: session.id, runtimeSessionId: session.runtimeSessionId }
  }

  send(sessionId: SessionId, input: UserInput, options: SendOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (options.context) {
      throw adapterError('not_implemented', 'Claude turn context injection is not implemented')
    }
    if (input.admitOnly) throw adapterError('protocol', 'admitOnly inputs must not be delivered to adapters')
    if (input.attachments?.length) {
      throw adapterError('not_implemented', 'Claude attachment delivery is not implemented')
    }
    if (session.activeTurnId) {
      throw adapterError('protocol', `Claude session already has an active turn: ${session.activeTurnId}`)
    }

    session.activeTurnId = options.turnId
    session.lastTurnId = options.turnId
    try {
      session.input.push({
        type: 'user',
        message: { role: 'user', content: input.text },
        parent_tool_use_id: null,
      })
    } catch (error) {
      session.activeTurnId = undefined
      throw error
    }
    this.publish(session, {
      type: 'turn.started',
      payload: { turnId: options.turnId },
      turnId: options.turnId,
    })
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'running' },
      turnId: options.turnId,
    })
    return Promise.resolve()
  }

  async interrupt(sessionId: SessionId, options?: InterruptOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (options?.cancelQueued) {
      throw adapterError('not_implemented', 'Claude Agent SDK does not expose cancelQueued on Query.interrupt()')
    }
    if (options?.turnId && options.turnId !== session.activeTurnId) {
      throw adapterError('protocol', `Claude active turn is ${session.activeTurnId ?? 'none'}, not ${options.turnId}`)
    }
    if (options?.expectedTurnId && options.expectedTurnId !== session.activeTurnId) {
      throw adapterError(
        'protocol',
        `Claude active turn is ${session.activeTurnId ?? 'none'}, not expected ${options.expectedTurnId}`,
      )
    }
    session.bridge.cancelAll('aborted', 'Turn interrupted')
    await session.query.interrupt()
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'interrupted' },
      turnId: session.activeTurnId,
    })
  }

  resolveInteraction(sessionId: SessionId, resolution: InteractionResolution): Promise<void> {
    this.getSession(sessionId).bridge.resolve(resolution)
    return Promise.resolve()
  }

  async setModel(sessionId: SessionId, model: ModelSelection): Promise<void> {
    if (model.reasoningEffort) {
      throw adapterError('not_implemented', 'Mid-session Claude reasoning effort changes are not implemented')
    }
    await this.getSession(sessionId).query.setModel(model.model)
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    session.bridge.cancelAll('aborted', 'Session disposed')
    session.disposed = true
    session.input.close()
    session.query.close()
    await session.pump.catch(() => undefined)
    if (!session.failure) {
      session.events.push({
        type: 'session.status_changed',
        payload: { status: 'closed' },
        turnId: session.activeTurnId,
      })
    }
    session.events.close()
    this.sessions.delete(sessionId)
  }

  events(sessionId: SessionId): AsyncIterable<AdapterEvent> {
    return this.getSession(sessionId).events
  }

  getCapabilities(sessionId: SessionId): Promise<RuntimeCapabilities> {
    return Promise.resolve(cloneCapabilities(this.getSession(sessionId).capabilities))
  }

  private async startSession(input: {
    id: SessionId
    runtimeSessionId: string
    projectPath: string
    connection: RuntimeConnection
    model?: ModelSelection
    mode?: 'default' | 'plan'
    querySessionOptions: { sessionId: string } | { resume: string; resumeSessionAt?: string }
    publishCreated: boolean
  }): Promise<ClaudeSessionState> {
    if (this.sessions.has(input.id)) throw adapterError('protocol', `Duplicate Gateway session: ${input.id}`)
    const connection = this.getConnection(input.connection)
    const events = new AsyncQueue<AdapterEvent>()
    const sdkInput = new AsyncQueue<SDKUserMessage>()
    const sessionReference: { current?: ClaudeSessionState } = {}
    const bridge = new ClaudeInteractionBridge(
      input.id,
      () => sessionReference.current?.activeTurnId,
      (event) => {
        if (!sessionReference.current) {
          throw new Error('Claude session received an interaction before construction')
        }
        this.publish(sessionReference.current, event)
      },
    )
    const query = this.queryFactory({
      prompt: sdkInput,
      options: {
        cwd: input.projectPath,
        persistSession: true,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        env: { ...process.env, ...connection.context.env },
        canUseTool: bridge.canUseTool,
        permissionMode: input.mode === 'plan' ? 'plan' : 'default',
        model: input.model?.model,
        effort: mapEffort(input.model?.reasoningEffort),
        pathToClaudeCodeExecutable:
          connection.installation?.source === 'path' || connection.installation?.source === 'custom'
            ? connection.installation.path
            : undefined,
        ...input.querySessionOptions,
      },
    })
    const session: ClaudeSessionState = {
      id: input.id,
      runtimeSessionId: input.runtimeSessionId,
      query,
      input: sdkInput,
      events,
      mapper: new ClaudeMessageMapper(),
      bridge,
      capabilities: cloneCapabilities(input.connection.capabilities),
      disposed: false,
      pump: Promise.resolve(),
    }
    sessionReference.current = session
    this.sessions.set(input.id, session)
    session.pump = this.pump(session)

    try {
      await query.initializationResult()
    } catch (error) {
      session.disposed = true
      sdkInput.close()
      query.close()
      await session.pump.catch(() => undefined)
      this.sessions.delete(input.id)
      throw new AdapterError({
        ...toRuntimeError(error, 'connection'),
        layer: 'transport',
      })
    }

    if (session.failure) {
      session.disposed = true
      sdkInput.close()
      query.close()
      await session.pump.catch(() => undefined)
      this.sessions.delete(input.id)
      throw new AdapterError({
        ...toRuntimeError(session.failure, 'connection'),
        layer: 'transport',
      })
    }

    if (input.publishCreated) {
      this.publish(session, {
        type: 'session.created',
        payload: {
          runtimeSessionId: input.runtimeSessionId,
          capabilities: cloneCapabilities(session.capabilities),
        },
      })
    }
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return session
  }

  private async pump(session: ClaudeSessionState): Promise<void> {
    try {
      for await (const message of session.query) {
        if (session.disposed) return
        if (message.type === 'result' && !session.activeTurnId) {
          const messageText =
            message.subtype === 'success'
              ? 'Claude ended before a Gateway turn started'
              : message.errors.join('\n') || message.subtype
          this.publish(session, {
            type: 'runtime.error',
            payload: {
              error: {
                code: 'connection',
                layer: 'transport',
                message: messageText,
                nativeCode: message.subtype,
              },
            },
            nativeRef: { eventId: message.uuid, eventType: `result.${message.subtype}` },
          })
          continue
        }

        const mapped = session.mapper.map(message, { turnId: session.activeTurnId ?? session.lastTurnId })
        for (const event of mapped) {
          if (event.type === 'session.created') {
            if (event.payload.runtimeSessionId !== session.runtimeSessionId) {
              throw new Error(
                `Claude initialized session ${event.payload.runtimeSessionId}, expected ${session.runtimeSessionId}`,
              )
            }
            session.capabilities = cloneCapabilities(event.payload.capabilities)
            this.publish(session, {
              type: 'session.capabilities_changed',
              payload: { capabilities: cloneCapabilities(session.capabilities) },
              nativeRef: event.nativeRef,
            })
          } else {
            this.publish(session, event)
          }
        }

        if (message.type === 'result' && session.activeTurnId) {
          const completedTurnId = session.activeTurnId
          session.activeTurnId = undefined
          this.publish(session, {
            type: 'session.status_changed',
            payload: { status: 'idle' },
            turnId: completedTurnId,
          })
        }
      }
      if (!session.disposed) throw new Error('Claude Query ended unexpectedly')
    } catch (error) {
      if (session.disposed) return
      session.failure = error
      const runtimeError = { ...toRuntimeError(error, 'connection'), layer: 'transport' as const }
      this.publish(session, { type: 'runtime.error', payload: { error: runtimeError } })
      this.publish(session, {
        type: 'session.status_changed',
        payload: { status: 'error' },
        turnId: session.activeTurnId,
      })
      session.bridge.cancelAll('aborted', runtimeError.message)
      session.input.fail(error)
      session.events.fail(error)
    }
  }

  private publish(session: ClaudeSessionState, event: AdapterEvent): void {
    if (session.disposed) return
    session.events.push(event)
    if (event.type === 'interaction.permission_requested' || event.type === 'interaction.question_requested') {
      session.events.push({
        type: 'session.status_changed',
        payload: { status: 'waiting' },
        turnId: event.turnId,
      })
    } else if (
      (event.type === 'interaction.resolved' || event.type === 'interaction.canceled') &&
      session.activeTurnId
    ) {
      session.events.push({
        type: 'session.status_changed',
        payload: { status: 'running' },
        turnId: event.turnId,
      })
    }
  }

  private getConnection(connection: RuntimeConnection): ClaudeConnectionState {
    const state = this.connections.get(connection.id)
    if (!state || state.connection.transport !== 'sdk') {
      throw adapterError('connection', `Unknown Claude SDK connection: ${connection.id}`)
    }
    return state
  }

  private getSession(sessionId: SessionId): ClaudeSessionState {
    const session = this.sessions.get(sessionId)
    if (!session || session.disposed) throw adapterError('connection', `Unknown Claude session: ${sessionId}`)
    return session
  }

  private assertContextUnsupported(context: CreateSessionInput['context'] | ResumeSessionInput['context']): void {
    if (context) throw adapterError('not_implemented', 'Claude session context injection is not implemented')
  }
}

function mapEffort(value: string | undefined): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!value) return undefined
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value
  }
  throw adapterError('protocol', `Unsupported Claude reasoning effort: ${value}`)
}

function adapterError(code: 'connection' | 'not_implemented' | 'protocol', message: string): AdapterError {
  return new AdapterError({ code, layer: 'transport', message })
}

function cloneCapabilities(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  return {
    ...capabilities,
    features: { ...capabilities.features },
    raw: [...capabilities.raw],
    ...(capabilities.degradations
      ? { degradations: capabilities.degradations.map((degradation) => ({ ...degradation })) }
      : {}),
  }
}
