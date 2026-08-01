import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { delimiter, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  AdapterError,
  asInteractionId,
  asSubagentRunId,
  asToolCallId,
  asTurnId,
  cloneSessionExecutionSettings,
  createDefaultSessionExecutionSettings,
  toRuntimeError,
  type AdapterEvent,
  type ChangeSet,
  type CreateSessionInput,
  type ExecutionConfigurationResult,
  type ForkSessionInput,
  type InteractionResolution,
  type ListModelsInput,
  type ModelCatalog,
  type ModelSelection,
  type ResumeSessionInput,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeConnectOptions,
  type RuntimeConnection,
  type RuntimeHostContext,
  type RuntimeInstallation,
  type RuntimeSessionHandle,
  type SendOptions,
  type SessionExecutionSettings,
  type SessionId,
  type SubagentRun,
  type ToolCall,
  type TurnId,
  type UserInput,
} from '@agent-gateway/core'
import { CodexAppServerClient, type RpcMessage, type ServerRequest } from './app-server-client.js'
import { AsyncQueue } from './async-queue.js'

const execFileAsync = promisify(execFile)

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  steer: 'native',
  modelSwitch: 'in-session',
  execution: {
    workModes: ['build', 'plan'],
    approvalActions: ['allow', 'ask', 'deny'],
    approvalReviewers: ['user', 'provider'],
    filesystemSandbox: ['read-only', 'workspace-write', 'unrestricted'],
    networkAccess: ['deny', 'ask', 'allow'],
    update: 'in-session',
    granularRules: false,
  },
  features: {
    'session.resume': true,
    'session.fork': true,
    'model.catalog': true,
    'output.partial_text': true,
    'output.partial_reasoning': true,
    'interaction.permission': true,
    'interaction.question': true,
    'interaction.elicitation': true,
    'work-mode.plan': true,
    'task.todo': true,
    'agent.subagent': true,
  },
  raw: ['codex.app-server.v2', 'codex.experimentalApi'],
  degradations: [
    {
      capability: 'execution.granularRules',
      status: 'unsupported',
      reason: 'Gateway portable rules cannot yet be translated atomically to Codex execpolicy',
    },
  ],
}

interface ConnectionState {
  connection: RuntimeConnection
  client: CodexAppServerClient
  sessions: Map<SessionId, SessionState>
  rootsByThread: Map<string, SessionState>
  childrenByThread: Map<string, ChildState>
}

interface SessionState {
  id: SessionId
  threadId: string
  projectPath: string
  connection: ConnectionState
  events: AsyncQueue<AdapterEvent>
  /** Gateway-owned turn id used in Core events and durable input receipts. */
  activeTurnId?: TurnId
  /** Provider-owned turn id used only when addressing Codex app-server. */
  nativeActiveTurnId?: string
  model?: ModelSelection
  execution: SessionExecutionSettings
  startedItems: Set<string>
  pendingInteractions: Map<
    string,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >
  disposed: boolean
}

interface ChildState {
  root: SessionState
  run: SubagentRun
}

export class CodexAdapter implements RuntimeAdapter {
  readonly descriptor = {
    id: 'codex',
    displayName: 'Codex',
    adapterVersion: '0.0.0',
    protocolVersion: 'app-server-v2',
    capabilities: CODEX_CAPABILITIES,
  } as const

  private readonly connections = new Map<string, ConnectionState>()
  private readonly sessions = new Map<SessionId, SessionState>()

  async detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]> {
    const executable = await findExecutable('codex', context.env?.PATH ?? process.env.PATH)
    if (!executable) return []
    return [{ path: executable, version: await executableVersion(executable), source: 'path' }]
  }

  async connect(options: RuntimeConnectOptions): Promise<RuntimeConnection> {
    if (!options.installation) throw adapterError('connection', 'Codex installation is required')
    const id = randomUUID()
    const connection: RuntimeConnection = {
      id,
      transport: 'jsonrpc-stdio',
      ...(options.installation.version ? { runtimeVersion: options.installation.version } : {}),
      capabilities: cloneCapabilities(CODEX_CAPABILITIES),
    }
    const client = new CodexAppServerClient(
      options.installation.path,
      options.context.env ?? {},
      (message) => {
        const current = this.connections.get(id)
        if (current) this.handleNotification(current, message)
      },
      (request) => {
        const current = this.connections.get(id)
        return current
          ? this.handleServerRequest(current, request)
          : Promise.reject(new Error('Codex connection is not initialized'))
      },
      (error) => {
        const current = this.connections.get(id)
        if (current) this.handleConnectionClose(current, error)
      },
    )
    const state: ConnectionState = {
      connection,
      client,
      sessions: new Map(),
      rootsByThread: new Map(),
      childrenByThread: new Map(),
    }
    this.connections.set(id, state)
    try {
      await client.initialize(this.descriptor.adapterVersion)
    } catch (error) {
      this.connections.delete(id)
      await client.close()
      throw error
    }
    return connection
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    this.assertContextUnsupported(input.context)
    const connection = this.requireConnection(input.connection)
    const execution = input.execution ?? createDefaultSessionExecutionSettings()
    const result = await connection.client.request('thread/start', {
      cwd: input.projectPath,
      ...(input.model ? { model: input.model.model } : {}),
      ...codexExecution(execution),
    })
    const threadId = readThreadId(result, 'thread/start')
    const session = this.openSession(input.sessionId, threadId, input.projectPath, connection, execution, input.model)
    this.publish(session, {
      type: 'session.created',
      payload: { runtimeSessionId: threadId, capabilities: cloneCapabilities(CODEX_CAPABILITIES) },
    })
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return { sessionId: input.sessionId, runtimeSessionId: threadId, execution: executionResult(execution) }
  }

  async resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle> {
    this.assertContextUnsupported(input.context)
    const connection = this.requireConnection(input.connection)
    const execution = input.execution ?? createDefaultSessionExecutionSettings()
    const result = await connection.client.request('thread/resume', {
      threadId: input.runtimeSessionId,
      cwd: input.projectPath,
      excludeTurns: true,
      ...codexExecution(execution),
    })
    const threadId = readThreadId(result, 'thread/resume')
    const session = this.openSession(
      input.sessionId,
      threadId,
      input.projectPath,
      connection,
      execution,
      input.model,
    )
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return { sessionId: input.sessionId, runtimeSessionId: threadId, execution: executionResult(execution) }
  }

  async forkSession(input: ForkSessionInput): Promise<RuntimeSessionHandle> {
    this.assertContextUnsupported(input.context)
    const connection = this.requireConnection(input.connection)
    const execution = input.execution ?? createDefaultSessionExecutionSettings()
    const forkPoint = input.forkPoint
    if (forkPoint && forkPoint.by !== 'message') {
      throw adapterError('protocol', `Codex cannot fork from a ${forkPoint.by} cursor`)
    }
    const result = await connection.client.request('thread/fork', {
      threadId: input.runtimeSessionId,
      cwd: input.projectPath,
      ...(forkPoint ? { lastTurnId: forkPoint.messageUuid } : {}),
      excludeTurns: true,
      ...codexExecution(execution),
    })
    const threadId = readThreadId(result, 'thread/fork')
    const session = this.openSession(
      input.sessionId,
      threadId,
      input.projectPath,
      connection,
      execution,
      input.model,
    )
    this.publish(session, {
      type: 'session.created',
      payload: { runtimeSessionId: threadId, capabilities: cloneCapabilities(CODEX_CAPABILITIES) },
    })
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return { sessionId: input.sessionId, runtimeSessionId: threadId, execution: executionResult(execution) }
  }

  async send(sessionId: SessionId, input: UserInput, options: SendOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (input.attachments?.length) {
      throw adapterError('not_implemented', 'Codex attachment delivery is not implemented')
    }
    if (input.admitOnly) throw adapterError('protocol', 'admitOnly inputs must not reach adapters')
    const providerInput = [{ type: 'text', text: input.text, text_elements: [] }]
    if (options.kind === 'steer') {
      if (!session.activeTurnId || !session.nativeActiveTurnId) {
        throw adapterError('protocol', 'Codex has no active turn to steer')
      }
      await session.connection.client.request('turn/steer', {
        threadId: session.threadId,
        expectedTurnId: session.nativeActiveTurnId,
        clientUserMessageId: input.clientMessageId,
        input: providerInput,
      })
      return
    }
    if (session.activeTurnId) throw adapterError('protocol', `Codex turn ${session.activeTurnId} is active`)
    session.activeTurnId = options.turnId
    try {
      const result = await session.connection.client.request('turn/start', {
        threadId: session.threadId,
        clientUserMessageId: input.clientMessageId,
        input: providerInput,
        ...(session.model
          ? { model: session.model.model, effort: session.model.reasoningEffort ?? null }
          : {}),
        ...codexTurnExecution(session.execution),
      })
      if (session.activeTurnId === options.turnId) {
        session.nativeActiveTurnId = readNestedString(result, 'turn', 'id')
      }
    } catch (error) {
      session.activeTurnId = undefined
      session.nativeActiveTurnId = undefined
      throw error
    }
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    if (!session.activeTurnId || !session.nativeActiveTurnId) return
    await session.connection.client.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.nativeActiveTurnId,
    })
  }

  async resolveInteraction(sessionId: SessionId, resolution: InteractionResolution): Promise<void> {
    const session = this.getSession(sessionId)
    const pending = session.pendingInteractions.get(resolution.id)
    if (!pending) return
    session.pendingInteractions.delete(resolution.id)
    try {
      pending.resolve(codexInteractionResponse(pending.method, resolution))
      this.publish(session, {
        type: 'interaction.resolved',
        payload: { id: resolution.id, resolution },
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      })
    } catch (error) {
      pending.reject(toError(error))
      throw error
    }
  }

  async listModels(input: ListModelsInput): Promise<ModelCatalog> {
    const connection = this.requireConnection(input.connection)
    const models: ModelCatalog['models'] = []
    let cursor: string | undefined
    do {
      const result = await connection.client.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      })
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw adapterError('protocol', 'Codex model/list returned an invalid catalog')
      }
      for (const value of result.data) {
        if (isRecord(value)) models.push(codexModel(value))
      }
      cursor = stringValue(result.nextCursor)
    } while (cursor)
    return { models }
  }

  setModel(sessionId: SessionId, model: ModelSelection): Promise<void> {
    const session = this.getSession(sessionId)
    session.model = { ...model }
    return Promise.resolve()
  }

  configureExecution(sessionId: SessionId, settings: SessionExecutionSettings): Promise<ExecutionConfigurationResult> {
    const session = this.getSession(sessionId)
    session.execution = cloneSessionExecutionSettings(settings)
    return Promise.resolve(executionResult(settings))
  }

  disposeSession(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    this.publish(session, { type: 'session.status_changed', payload: { status: 'closed' } })
    session.disposed = true
    for (const pending of session.pendingInteractions.values()) pending.reject(new Error('Session closed'))
    session.pendingInteractions.clear()
    session.events.close()
    session.connection.sessions.delete(sessionId)
    session.connection.rootsByThread.delete(session.threadId)
    this.sessions.delete(sessionId)
    return Promise.resolve()
  }

  events(sessionId: SessionId): AsyncIterable<AdapterEvent> {
    return this.getSession(sessionId).events
  }

  getCapabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve(cloneCapabilities(CODEX_CAPABILITIES))
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.client.close()))
    this.connections.clear()
  }

  private openSession(
    id: SessionId,
    threadId: string,
    projectPath: string,
    connection: ConnectionState,
    execution: SessionExecutionSettings,
    model?: ModelSelection,
  ): SessionState {
    if (this.sessions.has(id)) throw adapterError('protocol', `Duplicate Gateway session: ${id}`)
    const session: SessionState = {
      id,
      threadId,
      projectPath,
      connection,
      events: new AsyncQueue(),
      ...(model ? { model: { ...model } } : {}),
      execution: cloneSessionExecutionSettings(execution),
      startedItems: new Set(),
      pendingInteractions: new Map(),
      disposed: false,
    }
    this.sessions.set(id, session)
    connection.sessions.set(id, session)
    connection.rootsByThread.set(threadId, session)
    return session
  }

  private handleNotification(connection: ConnectionState, message: RpcMessage): void {
    if (!message.method || !isRecord(message.params)) return
    const params = message.params
    if (message.method === 'thread/started' && isRecord(params.thread)) {
      this.registerChildThread(connection, params.thread)
    }
    const threadId = notificationThreadId(params)
    if (!threadId) return
    const route = this.routeThread(connection, threadId)
    if (!route) return
    const { session, attribution } = route
    for (const event of this.mapNotification(session, message.method, params, attribution)) {
      this.publish(session, event)
    }
  }

  private mapNotification(
    session: SessionState,
    method: string,
    params: Record<string, unknown>,
    attribution?: AdapterEvent['attribution'],
  ): AdapterEvent[] {
    const nativeTurnId = stringValue(params.turnId)
    const turnId = session.activeTurnId ?? (nativeTurnId ? asTurnId(nativeTurnId) : undefined)
    const common = { ...(turnId ? { turnId } : {}), ...(attribution ? { attribution } : {}) }
    if (method === 'turn/started' && isRecord(params.turn)) {
      const nativeId = requiredString(params.turn, 'id', 'Codex turn')
      const id = session.activeTurnId ?? asTurnId(nativeId)
      if (!attribution) {
        session.activeTurnId = id
        session.nativeActiveTurnId = nativeId
      }
      return [
        { type: 'turn.started', payload: { turnId: id }, turnId: id, ...(attribution ? { attribution } : {}) },
        { type: 'session.status_changed', payload: { status: 'running' }, turnId: id, ...(attribution ? { attribution } : {}) },
      ]
    }
    if (method === 'turn/completed' && isRecord(params.turn)) {
      const nativeId = requiredString(params.turn, 'id', 'Codex turn')
      const id = session.activeTurnId ?? asTurnId(nativeId)
      const status = codexTurnStatus(stringValue(params.turn.status))
      if (!attribution) {
        session.activeTurnId = undefined
        session.nativeActiveTurnId = undefined
      }
      if (status === 'failed') {
        return [{
          type: 'turn.failed',
          payload: {
            turnId: id,
            error: { code: 'unknown', layer: 'turn', nativeCode: 'turn_failed', message: nativeError(params.turn.error) ?? 'Codex turn failed' },
          },
          turnId: id,
          ...(attribution ? { attribution } : {}),
        }, { type: 'session.status_changed', payload: { status: 'error' }, turnId: id }]
      }
      return [
        { type: 'turn.completed', payload: { turnId: id, status }, turnId: id, ...(attribution ? { attribution } : {}) },
        ...(!attribution ? [{ type: 'session.status_changed', payload: { status: status === 'interrupted' ? 'interrupted' : 'idle' }, turnId: id } as AdapterEvent] : []),
      ]
    }
    if (method === 'item/agentMessage/delta') {
      const blockId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      if (!blockId || delta === undefined) return []
      return this.deltaEvents(session, 'text', blockId, delta, common)
    }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const blockId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      if (!blockId || delta === undefined) return []
      return this.deltaEvents(session, 'reasoning', blockId, delta, common, params)
    }
    if ((method === 'item/started' || method === 'item/completed') && isRecord(params.item)) {
      return this.mapItem(session, params.item, method === 'item/completed', common)
    }
    if (method === 'command/exec/outputDelta' || method === 'item/commandExecution/outputDelta') {
      const itemId = stringValue(params.itemId)
      const delta = stringValue(params.delta)
      return itemId && delta !== undefined
        ? [{ type: 'tool.output_delta', payload: { toolCallId: asToolCallId(itemId), delta }, ...common }]
        : []
    }
    if (method === 'thread/name/updated' && typeof params.name === 'string' && !attribution) {
      return [{ type: 'session.title_changed', payload: { title: params.name, source: 'provider' } }]
    }
    if (method === 'error') {
      return [{ type: 'runtime.error', payload: { error: { code: 'unknown', layer: 'turn', nativeCode: 'provider_error', message: nativeError(params) ?? 'Codex error' } }, ...common }]
    }
    return [{
      type: 'runtime.extension',
      payload: { feature: `codex.event.${method}`, payload: params },
      ...common,
    }]
  }

  private deltaEvents(
    session: SessionState,
    kind: 'text' | 'reasoning',
    blockId: string,
    delta: string,
    common: Partial<AdapterEvent>,
    params?: Record<string, unknown>,
  ): AdapterEvent[] {
    const result: AdapterEvent[] = []
    if (!session.startedItems.has(`${kind}:${blockId}`)) {
      session.startedItems.add(`${kind}:${blockId}`)
      result.push({ type: kind === 'text' ? 'content.text.started' : 'content.reasoning.started', payload: { blockId }, ...common } as AdapterEvent)
    }
    result.push({
      type: kind === 'text' ? 'content.text.delta' : 'content.reasoning.delta',
      payload: kind === 'text'
        ? { blockId, delta }
        : { blockId, delta, ...(numberValue(params?.contentIndex) !== undefined ? { contentIndex: numberValue(params?.contentIndex) } : {}) },
      ...common,
    } as AdapterEvent)
    return result
  }

  private mapItem(
    session: SessionState,
    item: Record<string, unknown>,
    completed: boolean,
    common: Partial<AdapterEvent>,
  ): AdapterEvent[] {
    const type = stringValue(item.type)
    const id = stringValue(item.id)
    if (!type || !id) return []
    if (type === 'agentMessage' && completed) {
      return [{ type: 'content.text.completed', payload: { blockId: id, text: stringValue(item.text) ?? '' }, ...common } as AdapterEvent]
    }
    if (type === 'reasoning' && completed) {
      const content = stringArray(item.content).join('\n') || stringArray(item.summary).join('\n')
      return [{ type: 'content.reasoning.completed', payload: { blockId: id, text: content }, ...common } as AdapterEvent]
    }
    if (type === 'collabAgentToolCall') return this.mapCollabItem(session, item, completed, common)
    const toolCall = codexToolCall(item, completed)
    if (!toolCall) return []
    const events: AdapterEvent[] = [{
      type: completed ? 'tool.completed' : 'tool.started',
      payload: { toolCall },
      ...common,
    } as AdapterEvent]
    if (type === 'fileChange') {
      events.push({ type: 'changes.updated', payload: { changeSet: codexChangeSet(session.projectPath, item, completed) }, ...common } as AdapterEvent)
    }
    return events
  }

  private mapCollabItem(
    session: SessionState,
    item: Record<string, unknown>,
    completed: boolean,
    common: Partial<AdapterEvent>,
  ): AdapterEvent[] {
    const toolCall = codexToolCall(item, completed)
    const events: AdapterEvent[] = toolCall
      ? [{ type: completed ? 'tool.completed' : 'tool.started', payload: { toolCall }, ...common } as AdapterEvent]
      : []
    const receiverIds = stringArray(item.receiverThreadIds)
    for (const threadId of receiverIds) {
      const child = session.connection.childrenByThread.get(threadId)
      const state = isRecord(item.agentsStates) && isRecord(item.agentsStates[threadId])
        ? item.agentsStates[threadId]
        : undefined
      const now = Date.now()
      const run = child?.run ?? {
        id: asSubagentRunId(`codex:${threadId}`),
        sessionId: session.id,
        parentToolCallId: asToolCallId(requiredString(item, 'id', 'Codex collab item')),
        runtimeSubagentId: threadId,
        title: stringValue(item.prompt) ?? 'Delegated task',
        ...(stringValue(item.prompt) ? { prompt: stringValue(item.prompt) } : {}),
        ...(stringValue(item.model) ? { model: { model: stringValue(item.model)! } } : {}),
        executionMode: stringValue(item.tool) === 'wait' ? 'foreground' : 'background',
        status: mapCollabStatus(state ? stringValue(state.status) : undefined, completed),
        startedAt: now,
        updatedAt: now,
      } satisfies SubagentRun
      run.status = mapCollabStatus(state ? stringValue(state.status) : undefined, completed)
      run.updatedAt = now
      if (isTerminalSubagent(run.status)) run.completedAt = now
      session.connection.childrenByThread.set(threadId, { root: session, run })
      events.push({
        type: child ? (isTerminalSubagent(run.status) ? 'subagent.completed' : 'subagent.updated') : 'subagent.started',
        payload: { run: { ...run } },
      } as AdapterEvent)
    }
    return events
  }

  private registerChildThread(connection: ConnectionState, thread: Record<string, unknown>): void {
    const threadId = stringValue(thread.id)
    const parentThreadId = stringValue(thread.parentThreadId)
    if (!threadId || !parentThreadId || connection.childrenByThread.has(threadId)) return
    const parent = this.routeThread(connection, parentThreadId)
    if (!parent) return
    const now = Date.now()
    const run: SubagentRun = {
      id: asSubagentRunId(`codex:${threadId}`),
      sessionId: parent.session.id,
      ...(parent.attribution?.subagentRunId ? { parentSubagentRunId: parent.attribution.subagentRunId } : {}),
      runtimeSubagentId: threadId,
      ...(stringValue(thread.agentRole) ? { agentName: stringValue(thread.agentRole) } : {}),
      title: stringValue(thread.name) ?? stringValue(thread.preview) ?? 'Delegated task',
      ...(stringValue(thread.preview) ? { description: stringValue(thread.preview) } : {}),
      executionMode: 'background',
      status: 'starting',
      startedAt: numberValue(thread.createdAt) ? numberValue(thread.createdAt)! * 1_000 : now,
      updatedAt: now,
    }
    connection.childrenByThread.set(threadId, { root: parent.session, run })
    this.publish(parent.session, { type: 'subagent.started', payload: { run: { ...run } } })
  }

  private handleServerRequest(connection: ConnectionState, request: ServerRequest): Promise<unknown> {
    if (!isRecord(request.params)) return Promise.reject(new Error(`Invalid ${request.method} params`))
    const threadId = notificationThreadId(request.params)
    const route = threadId ? this.routeThread(connection, threadId) : undefined
    if (!route) return Promise.reject(new Error(`No Gateway session for Codex request ${request.method}`))
    const session = route.session
    const interactionId = asInteractionId(`codex:${request.id}`)
    const event = codexInteractionEvent(session, interactionId, request.method, request.params)
    if (!event) return Promise.reject(new Error(`Unsupported Codex server request: ${request.method}`))
    this.publish(session, event)
    return new Promise((resolve, reject) => {
      session.pendingInteractions.set(interactionId, { method: request.method, resolve, reject })
    })
  }

  private routeThread(connection: ConnectionState, threadId: string): { session: SessionState; attribution?: AdapterEvent['attribution'] } | undefined {
    const root = connection.rootsByThread.get(threadId)
    if (root) return { session: root }
    const child = connection.childrenByThread.get(threadId)
    if (!child) return undefined
    return {
      session: child.root,
      attribution: { subagentRunId: child.run.id, sourceKind: 'subagent' },
    }
  }

  private handleConnectionClose(connection: ConnectionState, error: Error): void {
    for (const session of connection.sessions.values()) {
      if (session.disposed) continue
      this.publish(session, { type: 'runtime.error', payload: { error: toRuntimeError(error, 'connection') } })
      session.events.fail(error)
    }
    this.connections.delete(connection.connection.id)
  }

  private publish(session: SessionState, event: AdapterEvent): void {
    if (!session.disposed) session.events.push(event)
  }

  private getSession(id: SessionId): SessionState {
    const session = this.sessions.get(id)
    if (!session) throw adapterError('unknown', `Unknown Codex session: ${id}`)
    return session
  }

  private requireConnection(connection: RuntimeConnection): ConnectionState {
    const state = this.connections.get(connection.id)
    if (!state) throw adapterError('connection', `Unknown Codex connection: ${connection.id}`)
    return state
  }

  private assertContextUnsupported(context: unknown): void {
    if (context) throw adapterError('not_implemented', 'Codex context injection is not implemented')
  }
}

function codexInteractionEvent(
  session: SessionState,
  id: ReturnType<typeof asInteractionId>,
  method: string,
  params: Record<string, unknown>,
): AdapterEvent | undefined {
  const turnId = session.activeTurnId ?? (stringValue(params.turnId) ? asTurnId(stringValue(params.turnId)!) : undefined)
  const base = { id, sessionId: session.id, ...(turnId ? { turnId } : {}), createdAt: Date.now() }
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const command = stringValue(params.command) ?? 'Command execution'
    return { type: 'interaction.permission_requested', payload: { request: {
      ...base,
      kind: 'tool_permission',
      ...(stringValue(params.itemId) ? { toolCallId: asToolCallId(stringValue(params.itemId)!) } : {}),
      toolKind: 'terminal',
      toolName: 'commandExecution',
      input: { command, ...(stringValue(params.cwd) ? { cwd: stringValue(params.cwd) } : {}) },
      prompt: stringValue(params.reason) ?? `Run ${command}`,
      ...(Array.isArray(params.availableDecisions) ? { availableDecisions: params.availableDecisions.map(String) } : {}),
    } }, ...(turnId ? { turnId } : {}) }
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return { type: 'interaction.permission_requested', payload: { request: {
      ...base,
      kind: 'tool_permission',
      ...(stringValue(params.itemId) ? { toolCallId: asToolCallId(stringValue(params.itemId)!) } : {}),
      toolKind: 'file-edit',
      toolName: 'fileChange',
      input: params,
      prompt: stringValue(params.reason) ?? 'Apply file changes',
    } }, ...(turnId ? { turnId } : {}) }
  }
  if (method === 'item/permissions/requestApproval') {
    return { type: 'interaction.grant_requested', payload: { request: {
      ...base,
      kind: 'permission_grant',
      prompt: stringValue(params.reason) ?? 'Grant additional permissions',
      requestedProfile: params.permissions,
    } }, ...(turnId ? { turnId } : {}) }
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord).map((question) => ({
      id: requiredString(question, 'id', 'Codex question'),
      header: stringValue(question.header),
      question: requiredString(question, 'question', 'Codex question'),
      ...(Array.isArray(question.options) ? { options: question.options.filter(isRecord).map((option) => ({
        id: requiredString(option, 'label', 'Codex option'),
        label: requiredString(option, 'label', 'Codex option'),
        ...(stringValue(option.description) ? { description: stringValue(option.description) } : {}),
      })) } : {}),
      allowCustom: question.isOther === true,
      isSecret: question.isSecret === true,
    })) : []
    return { type: 'interaction.question_requested', payload: { request: { ...base, kind: 'question', questions } }, ...(turnId ? { turnId } : {}) }
  }
  if (method === 'mcpServer/elicitation/request') {
    const mode = params.mode === 'url' ? 'url' : 'form'
    return { type: 'interaction.elicitation_requested', payload: { request: {
      ...base,
      kind: 'elicitation',
      serverName: stringValue(params.serverName) ?? 'MCP',
      message: stringValue(params.message) ?? 'Input requested',
      mode,
      ...(mode === 'form' ? { requestedSchema: params.requestedSchema } : {}),
    } }, ...(turnId ? { turnId } : {}) }
  }
  return undefined
}

function codexInteractionResponse(method: string, resolution: InteractionResolution): unknown {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval' || method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    if (resolution.kind !== 'tool_permission') throw new Error(`Expected tool_permission, got ${resolution.kind}`)
    return { decision: resolution.decision.behavior === 'allow'
      ? resolution.decision.scope === 'session' ? 'acceptForSession' : 'accept'
      : resolution.decision.abortTurn ? 'cancel' : 'decline' }
  }
  if (method === 'item/permissions/requestApproval') {
    if (resolution.kind !== 'permission_grant') throw new Error(`Expected permission_grant, got ${resolution.kind}`)
    return { permissions: resolution.grantedProfile, scope: resolution.scope === 'once' ? 'turn' : resolution.scope }
  }
  if (method === 'item/tool/requestUserInput') {
    if (resolution.kind !== 'question') throw new Error(`Expected question, got ${resolution.kind}`)
    return { answers: Object.fromEntries(Object.entries(resolution.answers).map(([key, answers]) => [key, { answers }])) }
  }
  if (method === 'mcpServer/elicitation/request') {
    if (resolution.kind !== 'elicitation') throw new Error(`Expected elicitation, got ${resolution.kind}`)
    return resolution.outcome.behavior === 'completed'
      ? { action: 'accept', content: resolution.outcome.content, _meta: null }
      : { action: 'cancel', content: null, _meta: null }
  }
  throw new Error(`Unsupported Codex interaction method: ${method}`)
}

function codexToolCall(item: Record<string, unknown>, completed: boolean): ToolCall | undefined {
  const id = stringValue(item.id)
  const type = stringValue(item.type)
  if (!id || !type) return undefined
  const status = completed ? codexToolStatus(type, stringValue(item.status)) : 'running'
  if (type === 'commandExecution') return {
    id: asToolCallId(id), kind: 'terminal', name: type, status,
    input: { command: stringValue(item.command) ?? '', cwd: stringValue(item.cwd) ?? '' },
    ...(typeof item.aggregatedOutput === 'string' ? { result: item.aggregatedOutput } : {}),
    presentation: {
      target: { kind: 'command', value: stringValue(item.command) ?? '' },
      ...(typeof item.aggregatedOutput === 'string' ? { resultText: item.aggregatedOutput } : {}),
    }, providerExecuted: true,
  }
  if (type === 'fileChange') return {
    id: asToolCallId(id), kind: 'file-edit', name: type, status,
    input: item.changes, providerExecuted: true,
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const name = [stringValue(item.server) ?? stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join('/') || type
    return { id: asToolCallId(id), kind: 'mcp', name, status, input: item.arguments,
      ...(item.result !== undefined && item.result !== null ? { result: item.result } : {}), providerExecuted: type === 'mcpToolCall' }
  }
  if (type === 'webSearch') return { id: asToolCallId(id), kind: 'web', name: type, status, providerExecuted: true }
  if (type === 'collabAgentToolCall') return {
    id: asToolCallId(id), kind: 'subagent', name: stringValue(item.tool) ?? type, status,
    input: { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds }, providerExecuted: true,
  }
  if (type === 'imageView') return { id: asToolCallId(id), kind: 'file-read', name: type, status, input: { path: item.path }, providerExecuted: true }
  return undefined
}

function codexChangeSet(projectPath: string, item: Record<string, unknown>, completed: boolean): ChangeSet {
  const toolCallId = asToolCallId(requiredString(item, 'id', 'Codex file change'))
  const files = Array.isArray(item.changes) ? item.changes.filter(isRecord).map((change) => {
    const rawPath = requiredString(change, 'path', 'Codex file change')
    const patch = stringValue(change.diff) ?? ''
    const normalized = normalizePath(projectPath, rawPath)
    return {
      path: normalized.path,
      pathKind: normalized.pathKind,
      kind: mapChangeKind(stringValue(change.kind)),
      additions: patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      deletions: patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      patch,
      hunks: [],
    }
  }) : []
  const toolStatus = completed ? codexToolStatus('fileChange', stringValue(item.status)) : 'running'
  const status = toolStatus === 'pending' ? 'running' : toolStatus
  return { id: `codex:${toolCallId}`, intent: 'applied', scope: 'tool', status, toolCallId, files }
}

function mapChangeKind(value: string | undefined): 'create' | 'modify' | 'delete' | 'rename' {
  if (value === 'add') return 'create'
  if (value === 'delete') return 'delete'
  return 'modify'
}

function normalizePath(projectPath: string, rawPath: string): { path: string; pathKind: 'workspace-relative' | 'absolute' } {
  const candidate = relative(projectPath, rawPath)
  if (candidate && candidate !== '..' && !candidate.startsWith(`..${sep}`)) return { path: candidate.split(sep).join('/'), pathKind: 'workspace-relative' }
  return { path: rawPath, pathKind: 'absolute' }
}

function codexToolStatus(type: string, value: string | undefined): ToolCall['status'] {
  if (value === 'declined') return 'declined'
  if (value === 'failed' || value === 'error') return 'error'
  if (value === 'completed' || value === 'applied' || value === 'success') return 'completed'
  return type === 'fileChange' && value === 'completed' ? 'completed' : 'running'
}

function codexTurnStatus(value: string | undefined): 'completed' | 'failed' | 'interrupted' {
  if (value === 'failed') return 'failed'
  if (value === 'interrupted') return 'interrupted'
  return 'completed'
}

function codexModel(value: Record<string, unknown>): ModelCatalog['models'][number] {
  const id = stringValue(value.model) ?? requiredString(value, 'id', 'Codex model')
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.filter(isRecord).map((effort) => {
        const effortId = requiredString(effort, 'reasoningEffort', 'Codex reasoning effort')
        return {
          id: effortId,
          displayName: effortId,
          ...(stringValue(effort.description) ? { description: stringValue(effort.description) } : {}),
        }
      })
    : []
  return {
    id,
    displayName: stringValue(value.displayName) ?? id,
    ...(stringValue(value.description) ? { description: stringValue(value.description) } : {}),
    ...(value.isDefault === true ? { isDefault: true } : {}),
    ...(stringValue(value.defaultReasoningEffort)
      ? { defaultReasoningEffort: stringValue(value.defaultReasoningEffort) }
      : {}),
    reasoningEfforts: efforts,
  }
}

function mapCollabStatus(value: string | undefined, completed: boolean): SubagentRun['status'] {
  if (value === 'completed' || value === 'shutdown') return 'completed'
  if (value === 'errored' || value === 'notFound') return 'failed'
  if (value === 'interrupted') return 'interrupted'
  if (value === 'pendingInit') return 'starting'
  return completed ? 'completed' : 'running'
}

function isTerminalSubagent(value: SubagentRun['status']): boolean {
  return value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'cancelled'
}

function codexExecution(settings: SessionExecutionSettings): Record<string, unknown> {
  return {
    approvalPolicy: settings.approval.defaultAction === 'allow' ? 'never' : 'on-request',
    sandbox: settings.sandbox.filesystem === 'unrestricted' ? 'danger-full-access' : settings.sandbox.filesystem,
  }
}

function codexTurnExecution(settings: SessionExecutionSettings): Record<string, unknown> {
  return {
    approvalPolicy: settings.approval.defaultAction === 'allow' ? 'never' : 'on-request',
  }
}

function executionResult(settings: SessionExecutionSettings): ExecutionConfigurationResult {
  const effective = cloneSessionExecutionSettings(settings)
  const limitations: ExecutionConfigurationResult['limitations'] = []
  if (settings.approval.defaultAction === 'deny') {
    effective.approval.defaultAction = 'ask'
    limitations.push({ capability: 'approval.defaultAction.deny', reason: 'Codex app-server has no deny-all approval policy' })
  }
  if (settings.approval.rules.length) limitations.push({ capability: 'approval.rules', reason: 'Portable rules are not translated to Codex execpolicy yet' })
  return { effective, limitations }
}

function notificationThreadId(params: Record<string, unknown>): string | undefined {
  return stringValue(params.threadId) ?? (isRecord(params.thread) ? stringValue(params.thread.id) : undefined)
}

function readThreadId(value: unknown, label: string): string {
  if (!isRecord(value) || !isRecord(value.thread)) throw new Error(`${label} returned no thread`)
  return requiredString(value.thread, 'id', label)
}

function readNestedString(value: unknown, first: string, second: string): string | undefined {
  return isRecord(value) && isRecord(value[first]) ? stringValue(value[first][second]) : undefined
}

function nativeError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return stringValue(value.message) ?? (isRecord(value.error) ? stringValue(value.error.message) : undefined)
}

async function findExecutable(name: string, pathValue: string | undefined): Promise<string | undefined> {
  if (!pathValue) return undefined
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try { await access(candidate, 1); return candidate } catch { continue }
  }
  return undefined
}

async function executableVersion(path: string): Promise<string | undefined> {
  try { const result = await execFileAsync(path, ['--version']); return result.stdout.trim() || undefined } catch { return undefined }
}

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const result = stringValue(value[key])
  if (!result) throw new Error(`${label} has no ${key}`)
  return result
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function cloneCapabilities(value: RuntimeCapabilities): RuntimeCapabilities { return structuredClone(value) }
function toError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)) }
function adapterError(code: ConstructorParameters<typeof AdapterError>[0]['code'], message: string): AdapterError { return new AdapterError({ code, layer: 'transport', message }) }
