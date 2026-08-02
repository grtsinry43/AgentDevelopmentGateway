import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import {
  asSubagentRunId,
  asToolCallId,
  cloneSessionExecutionSettings,
  createDefaultSessionExecutionSettings,
  toRuntimeError,
  type AdapterEvent,
  type CreateSessionInput,
  type Disposable,
  type ExecutionConfigurationResult,
  type ForkSessionInput,
  type InteractionId,
  type InteractionResolution,
  type InterruptOptions,
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
  type ServerRequestHandler,
  type SessionExecutionSettings,
  type SessionId,
  type SubagentRun,
  type UserInput,
} from '@agent-gateway/core'
import {
  CodexAppServerClient,
  type RpcMessage,
  type ServerRequest,
} from './app-server-client.js'
import { AsyncQueue } from './async-queue.js'
import {
  executionResult,
  mapThreadCreationExecution,
  mapThreadSettings,
  mapTurnExecution,
} from './execution.js'
import {
  HUMAN_REQUEST_METHODS,
  interactionIdFor,
  mapInteractionRequest,
  mapInteractionResolution,
} from './interaction.js'
import { mapSessionContext, mapTurnContext, mapUserInput } from './input.js'
import {
  mapNotification,
  type NotificationSession,
} from './mapper.js'
import {
  isRecord,
  numberValue,
  protocolError,
  readNativeTurnId,
  readThreadId,
  stringValue,
  unsupportedError,
  type JsonObject,
} from './protocol.js'

const execFileAsync = promisify(execFile)

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  steer: 'native',
  modelSwitch: 'in-session',
  execution: {
    workModes: ['build', 'plan'],
    approvalActions: ['allow', 'ask'],
    approvalReviewers: ['user', 'provider'],
    filesystemSandbox: ['read-only', 'workspace-write', 'unrestricted'],
    networkAccess: ['ask', 'allow'],
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
    'mcp.dynamic': true,
    'context.session_injection': true,
    'context.turn_injection': true,
    'context.compaction': true,
  },
  raw: [
    'codex.app-server.v2',
    'codex.experimentalApi',
    'codex.turn.additionalContext',
    'codex.thread.settings.update',
  ],
  degradations: [
    {
      capability: 'execution.granularRules',
      status: 'unsupported',
      reason: 'Gateway portable rules cannot be translated atomically to Codex execpolicy',
    },
    {
      capability: 'interaction.persistRule',
      status: 'unsupported',
      reason: 'Codex approval responses do not accept portable persisted rules',
    },
    {
      capability: 'interaction.updatedInput',
      status: 'unsupported',
      reason: 'Codex approval responses cannot rewrite the pending tool input',
    },
  ],
}

interface ConnectionState {
  connection: RuntimeConnection
  client: CodexAppServerClient
  sessions: Map<SessionId, SessionState>
  rootsByThread: Map<string, SessionState>
  childrenByThread: Map<string, ChildState>
  /** CollabAgentToolCall.prompt keyed by call id, for V2 SubAgentActivity recovery. */
  collabPromptsByCallId: Map<string, string>
}

interface PendingInteraction {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
}

interface SessionState extends NotificationSession {
  threadId: string
  connection: ConnectionState
  events: AsyncQueue<AdapterEvent>
  model?: ModelSelection
  execution: SessionExecutionSettings
  pendingInteractions: Map<InteractionId, PendingInteraction>
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
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>()

  async detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]> {
    const executable = await findExecutable('codex', context.env?.PATH ?? process.env.PATH)
    if (!executable) return []
    return [{
      path: executable,
      version: await executableVersion(executable),
      source: 'path',
    }]
  }

  async connect(options: RuntimeConnectOptions): Promise<RuntimeConnection> {
    if (!options.installation) {
      throw protocolError('Codex installation is required', 'codex.installation.required')
    }
    const id = randomUUID()
    const connection: RuntimeConnection = {
      id,
      transport: 'jsonrpc-stdio',
      ...(options.installation.version
        ? { runtimeVersion: options.installation.version }
        : {}),
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
          : Promise.reject(protocolError('Codex connection is not initialized'))
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
      collabPromptsByCallId: new Map(),
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
    const connection = this.requireConnection(input.connection)
    const execution = input.execution ?? createDefaultSessionExecutionSettings()
    const result = await connection.client.request('thread/start', {
      cwd: input.projectPath,
      ...(input.model ? { model: input.model.model } : {}),
      ...(mapSessionContext(input.context)
        ? { developerInstructions: mapSessionContext(input.context) }
        : {}),
      ...mapThreadCreationExecution(execution),
    })
    return this.finishSessionOpen(
      input.sessionId,
      input.projectPath,
      connection,
      result,
      execution,
      input.model,
      true,
    )
  }

  async resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle> {
    const connection = this.requireConnection(input.connection)
    const execution = input.execution ?? createDefaultSessionExecutionSettings()
    if (input.cursor && input.cursor.by !== 'rollout-path') {
      throw unsupportedError(
        `Codex thread/resume cannot represent ${input.cursor.by} cursor without fabricating history`,
        'codex.resume.cursor_unsupported',
      )
    }
    const result = await connection.client.request('thread/resume', {
      threadId: input.runtimeSessionId,
      ...(input.cursor?.by === 'rollout-path' ? { path: input.cursor.path } : {}),
      cwd: input.projectPath,
      excludeTurns: true,
      ...(input.model ? { model: input.model.model } : {}),
      ...(mapSessionContext(input.context)
        ? { developerInstructions: mapSessionContext(input.context) }
        : {}),
      ...mapThreadCreationExecution(execution),
    })
    return this.finishSessionOpen(
      input.sessionId,
      input.projectPath,
      connection,
      result,
      execution,
      input.model,
      false,
    )
  }

  async forkSession(input: ForkSessionInput): Promise<RuntimeSessionHandle> {
    const connection = this.requireConnection(input.connection)
    const execution = input.execution ?? createDefaultSessionExecutionSettings()
    if (
      input.forkPoint &&
      input.forkPoint.by !== 'message' &&
      input.forkPoint.by !== 'rollout-path'
    ) {
      throw unsupportedError(
        `Codex thread/fork cannot represent ${input.forkPoint.by} cursor`,
        'codex.fork.cursor_unsupported',
      )
    }
    const result = await connection.client.request('thread/fork', {
      threadId: input.runtimeSessionId,
      ...(input.forkPoint?.by === 'message'
        ? { lastTurnId: input.forkPoint.messageUuid }
        : {}),
      ...(input.forkPoint?.by === 'rollout-path'
        ? { path: input.forkPoint.path }
        : {}),
      cwd: input.projectPath,
      excludeTurns: true,
      ...(input.model ? { model: input.model.model } : {}),
      ...(mapSessionContext(input.context)
        ? { developerInstructions: mapSessionContext(input.context) }
        : {}),
      ...mapThreadCreationExecution(execution),
    })
    return this.finishSessionOpen(
      input.sessionId,
      input.projectPath,
      connection,
      result,
      execution,
      input.model,
      true,
    )
  }

  async send(sessionId: SessionId, input: UserInput, options: SendOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (input.admitOnly) {
      throw protocolError('admitOnly inputs must not reach adapters')
    }
    const providerInput = mapUserInput(input)
    const additionalContext = mapTurnContext(options.context)
    if (options.kind === 'steer') {
      if (!session.activeTurnId || !session.nativeActiveTurnId) {
        throw protocolError('Codex has no active turn to steer')
      }
      await session.connection.client.request('turn/steer', {
        threadId: session.threadId,
        expectedTurnId: session.nativeActiveTurnId,
        clientUserMessageId: input.clientMessageId,
        input: providerInput,
        ...(additionalContext ? { additionalContext } : {}),
      })
      return
    }
    if (session.activeTurnId) {
      throw protocolError(`Codex turn ${session.activeTurnId} is active`)
    }
    session.activeTurnId = options.turnId
    try {
      const result = await session.connection.client.request('turn/start', {
        threadId: session.threadId,
        clientUserMessageId: input.clientMessageId,
        input: providerInput,
        ...(additionalContext ? { additionalContext } : {}),
        ...mapTurnExecution(session.execution, session.model),
      })
      if (session.activeTurnId === options.turnId) {
        session.nativeActiveTurnId = readNativeTurnId(result)
      }
    } catch (error) {
      session.activeTurnId = undefined
      session.nativeActiveTurnId = undefined
      throw error
    }
  }

  async interrupt(sessionId: SessionId, options?: InterruptOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (!session.activeTurnId || !session.nativeActiveTurnId) return
    if (
      options?.expectedTurnId &&
      options.expectedTurnId !== session.nativeActiveTurnId
    ) {
      throw protocolError(
        `Codex active turn ${session.nativeActiveTurnId} does not match expected ${options.expectedTurnId}`,
        'codex.turn.expected_mismatch',
      )
    }
    if (
      options?.turnId &&
      options.turnId !== session.nativeActiveTurnId &&
      options.turnId !== session.activeTurnId
    ) {
      throw protocolError(
        `Codex cannot interrupt non-active turn ${options.turnId}`,
        'codex.turn.not_active',
      )
    }
    await session.connection.client.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.nativeActiveTurnId,
    })
  }

  async resolveInteraction(
    sessionId: SessionId,
    resolution: InteractionResolution,
  ): Promise<void> {
    const session = this.getSession(sessionId)
    const pending = session.pendingInteractions.get(resolution.id)
    if (!pending) {
      throw protocolError(
        `Unknown or already resolved Codex interaction: ${resolution.id}`,
        'codex.interaction.not_pending',
      )
    }
    const response = mapInteractionResolution(pending.method, resolution)
    session.pendingInteractions.delete(resolution.id)
    pending.resolve(response)
    this.publish(session, {
      type: 'interaction.resolved',
      payload: { id: resolution.id, resolution },
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    })
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
        throw protocolError('Codex model/list returned an invalid catalog')
      }
      for (const value of result.data) {
        if (isRecord(value)) models.push(mapModel(value))
      }
      cursor = stringValue(result.nextCursor)
    } while (cursor)
    return { models }
  }

  async setModel(sessionId: SessionId, model: ModelSelection): Promise<void> {
    const session = this.getSession(sessionId)
    await session.connection.client.request(
      'thread/settings/update',
      mapThreadSettings(session.threadId, session.execution, model),
    )
    session.model = { ...model }
  }

  async configureExecution(
    sessionId: SessionId,
    settings: SessionExecutionSettings,
  ): Promise<ExecutionConfigurationResult> {
    const session = this.getSession(sessionId)
    const result = executionResult(settings)
    await session.connection.client.request(
      'thread/settings/update',
      mapThreadSettings(session.threadId, result.effective, session.model),
    )
    session.execution = cloneSessionExecutionSettings(result.effective)
    return result
  }

  disposeSession(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    this.publish(session, { type: 'session.status_changed', payload: { status: 'closed' } })
    session.disposed = true
    for (const pending of session.pendingInteractions.values()) {
      pending.reject(new Error('Codex session closed'))
    }
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

  onServerRequest(handler: ServerRequestHandler): Disposable {
    this.serverRequestHandlers.add(handler)
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        this.serverRequestHandlers.delete(handler)
      },
    }
  }

  async dispose(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await this.disposeSession(session.id)
    }
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => connection.client.close()),
    )
    this.connections.clear()
    this.serverRequestHandlers.clear()
  }

  private finishSessionOpen(
    sessionId: SessionId,
    projectPath: string,
    connection: ConnectionState,
    result: unknown,
    execution: SessionExecutionSettings,
    requestedModel: ModelSelection | undefined,
    emitCreated: boolean,
  ): RuntimeSessionHandle {
    const threadId = readThreadId(result, 'Codex thread operation')
    const responseModel = isRecord(result) ? stringValue(result.model) : undefined
    const model = requestedModel ??
      (responseModel
        ? {
            model: responseModel,
            ...(isRecord(result) && stringValue(result.reasoningEffort)
              ? { reasoningEffort: stringValue(result.reasoningEffort) }
              : {}),
          }
        : undefined)
    const session = this.openSession(
      sessionId,
      threadId,
      projectPath,
      connection,
      executionResult(execution).effective,
      model,
    )
    if (emitCreated) {
      this.publish(session, {
        type: 'session.created',
        payload: {
          runtimeSessionId: threadId,
          capabilities: cloneCapabilities(CODEX_CAPABILITIES),
        },
      })
    }
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return {
      sessionId,
      runtimeSessionId: threadId,
      execution: executionResult(execution),
    }
  }

  private openSession(
    id: SessionId,
    threadId: string,
    projectPath: string,
    connection: ConnectionState,
    execution: SessionExecutionSettings,
    model?: ModelSelection,
  ): SessionState {
    if (this.sessions.has(id)) {
      throw protocolError(`Duplicate Gateway session: ${id}`)
    }
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
    if (!message.method) return
    if (!isRecord(message.params)) {
      for (const session of connection.sessions.values()) {
        this.publish(session, {
          type: 'runtime.extension',
          payload: {
            feature: `codex.event.${message.method}`,
            payload: message.params,
          },
          nativeRef: { eventType: message.method },
        })
      }
      return
    }
    const params = message.params
    if (message.method === 'thread/started' && isRecord(params.thread)) {
      this.registerChildThread(connection, params.thread)
    }
    const threadId = notificationThreadId(params)
    if (!threadId) {
      for (const session of connection.sessions.values()) {
        for (const event of mapNotification(
          this.notificationContext(session, connection),
          message.method,
          params,
        )) {
          this.publish(session, event)
        }
      }
      return
    }
    const route = this.routeThread(connection, threadId)
    if (!route) return
    const events = mapNotification(
      this.notificationContext(route.session, connection, route.attribution),
      message.method,
      params,
    )
    for (const event of events) this.publish(route.session, event)
  }

  private async handleServerRequest(
    connection: ConnectionState,
    request: ServerRequest,
  ): Promise<unknown> {
    if (!isRecord(request.params)) {
      throw protocolError(`Invalid ${request.method} params`)
    }
    const threadId = notificationThreadId(request.params)
    const route = threadId
      ? this.routeThread(connection, threadId)
      : connection.sessions.size === 1
        ? { session: [...connection.sessions.values()][0]! }
        : undefined
    if (!route) {
      throw protocolError(`No Gateway session for Codex request ${request.method}`)
    }
    if (HUMAN_REQUEST_METHODS.has(request.method)) {
      const interactionId = interactionIdFor(request.id)
      this.publish(
        route.session,
        mapInteractionRequest(
          route.session.id,
          route.session.activeTurnId,
          request.id,
          request.method,
          request.params,
        ),
      )
      return new Promise((resolve, reject) => {
        route.session.pendingInteractions.set(interactionId, {
          method: request.method,
          resolve,
          reject,
        })
      })
    }
    const handlers = [...this.serverRequestHandlers]
    if (handlers.length !== 1) {
      throw unsupportedError(
        `Codex server request ${request.method} requires exactly one RuntimeAdapter host handler; found ${handlers.length}`,
        'codex.server_request.handler_unavailable',
      )
    }
    const id = `codex:${typeof request.id}:${String(request.id)}`
    const response = await handlers[0]!({
      id,
      sessionId: route.session.id,
      method: hostRequestMethod(request.method),
      params: request.params,
    })
    if (response.id !== id) {
      throw protocolError(
        `Codex host response id ${response.id} does not match request ${id}`,
        'codex.server_request.id_mismatch',
      )
    }
    return response.result
  }

  private registerChildThread(connection: ConnectionState, thread: JsonObject): void {
    const threadId = stringValue(thread.id)
    const parentThreadId = stringValue(thread.parentThreadId)
    if (!threadId || !parentThreadId || connection.childrenByThread.has(threadId)) return
    const parent = this.routeThread(connection, parentThreadId)
    if (!parent) return
    const now = Date.now()
    const run: SubagentRun = {
      // Wire contract requires UUID; keep native thread id in runtimeSubagentId.
      id: asSubagentRunId(randomUUID()),
      sessionId: parent.session.id,
      ...(parent.attribution?.subagentRunId
        ? { parentSubagentRunId: parent.attribution.subagentRunId }
        : {}),
      runtimeSubagentId: threadId,
      ...(stringValue(thread.agentRole) ? { agentName: stringValue(thread.agentRole) } : {}),
      title: stringValue(thread.name) ?? stringValue(thread.preview) ?? 'Delegated task',
      ...(stringValue(thread.preview)
        ? { description: stringValue(thread.preview) }
        : {}),
      executionMode: 'background',
      status: 'starting',
      startedAt: numberValue(thread.createdAt) ? numberValue(thread.createdAt)! * 1_000 : now,
      updatedAt: now,
    }
    connection.childrenByThread.set(threadId, { root: parent.session, run })
    this.publish(parent.session, { type: 'subagent.started', payload: { run: { ...run } } })
  }

  private notificationContext(
    session: SessionState,
    connection: ConnectionState,
    attribution?: AdapterEvent['attribution'],
  ) {
    return {
      session,
      ...(attribution ? { attribution } : {}),
      rememberCollabPrompt: (callId: string, prompt: string) => {
        connection.collabPromptsByCallId.set(callId, prompt)
      },
      takeCollabPrompt: (callId: string) => {
        const prompt = connection.collabPromptsByCallId.get(callId)
        if (prompt !== undefined) connection.collabPromptsByCallId.delete(callId)
        return prompt
      },
      upsertSubagent: (childThreadId: string, item: JsonObject, completed: boolean) =>
        this.upsertSubagent(
          session,
          childThreadId,
          item,
          completed,
          attribution?.subagentRunId,
        ),
    }
  }

  private upsertSubagent(
    root: SessionState,
    threadId: string,
    item: JsonObject,
    completed: boolean,
    parentSubagentRunId?: SubagentRun['parentSubagentRunId'],
  ): {
    run: SubagentRun
    event: 'subagent.started' | 'subagent.updated' | 'subagent.completed'
  } {
    const existing = root.connection.childrenByThread.get(threadId)
    const state =
      isRecord(item.agentsStates) && isRecord(item.agentsStates[threadId])
        ? item.agentsStates[threadId]
        : undefined
    const now = Date.now()
    // agentPath is identity/title only; prompt is the real main→child task text.
    const agentPath = stringValue(item.agentPath)
    const taskPrompt = stringValue(item.prompt) ?? stringValue(item.message)
    const title =
      subagentTitle(agentPath) ??
      subagentTitle(stringValue(item.title)) ??
      'Delegated task'
    const run = existing?.run ?? {
      id: asSubagentRunId(randomUUID()),
      sessionId: root.id,
      ...(parentSubagentRunId ? { parentSubagentRunId } : {}),
      parentToolCallId: asToolCallId(
        stringValue(item.id) ?? `collab:${threadId}`,
      ),
      runtimeSubagentId: threadId,
      title,
      ...(taskPrompt ? { prompt: taskPrompt } : {}),
      ...(stringValue(item.model)
        ? { model: { model: stringValue(item.model)! } }
        : {}),
      executionMode: stringValue(item.tool) === 'wait' ? 'foreground' : 'background',
      status: mapSubagentStatus(state ? stringValue(state.status) : undefined, completed),
      startedAt: now,
      updatedAt: now,
    } satisfies SubagentRun
    if (agentPath) {
      const fromPath = subagentTitle(agentPath)
      if (fromPath) run.title = fromPath
    }
    if (taskPrompt) run.prompt = taskPrompt
    run.status = mapSubagentStatus(state ? stringValue(state.status) : undefined, completed)
    run.updatedAt = now
    if (isTerminalSubagent(run.status)) run.completedAt = now
    root.connection.childrenByThread.set(threadId, { root, run })
    return {
      run: { ...run },
      event: existing
        ? isTerminalSubagent(run.status)
          ? 'subagent.completed'
          : 'subagent.updated'
        : 'subagent.started',
    }
  }

  private routeThread(
    connection: ConnectionState,
    threadId: string,
  ): { session: SessionState; attribution?: AdapterEvent['attribution'] } | undefined {
    const root = connection.rootsByThread.get(threadId)
    if (root) return { session: root }
    const child = connection.childrenByThread.get(threadId)
    if (!child) return undefined
    return {
      session: child.root,
      attribution: {
        subagentRunId: child.run.id,
        ...(child.run.parentToolCallId
          ? { parentToolCallId: child.run.parentToolCallId }
          : {}),
        sourceKind: 'subagent',
      },
    }
  }

  private handleConnectionClose(connection: ConnectionState, error: Error): void {
    for (const session of connection.sessions.values()) {
      if (session.disposed) continue
      this.publish(session, {
        type: 'runtime.error',
        payload: { error: toRuntimeError(error, 'connection') },
      })
      session.events.fail(error)
    }
    this.connections.delete(connection.connection.id)
  }

  private publish(session: SessionState, event: AdapterEvent): void {
    if (!session.disposed) session.events.push(event)
  }

  private getSession(id: SessionId): SessionState {
    const session = this.sessions.get(id)
    if (!session) throw protocolError(`Unknown Codex session: ${id}`)
    return session
  }

  private requireConnection(connection: RuntimeConnection): ConnectionState {
    const state = this.connections.get(connection.id)
    if (!state) throw protocolError(`Unknown Codex connection: ${connection.id}`)
    return state
  }
}

function notificationThreadId(params: JsonObject): string | undefined {
  return stringValue(params.threadId) ??
    (isRecord(params.thread) ? stringValue(params.thread.id) : undefined)
}

function hostRequestMethod(method: string): string {
  if (method === 'item/tool/call') return 'codex.dynamicTool.call'
  if (method === 'attestation/generate') return 'codex.attestation.generate'
  if (method === 'account/chatgptAuthTokens/refresh') return 'codex.authTokens.refresh'
  if (method === 'currentTime/read') return 'codex.currentTime.read'
  return `codex.request.${method}`
}

function mapModel(value: JsonObject): ModelCatalog['models'][number] {
  const id = stringValue(value.model) ?? stringValue(value.id)
  if (!id) throw protocolError('Codex model has no id')
  const efforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts.filter(isRecord).map((effort) => {
        const effortId = stringValue(effort.reasoningEffort)
        if (!effortId) throw protocolError('Codex reasoning effort has no id')
        return {
          id: effortId,
          displayName: effortId,
          ...(stringValue(effort.description)
            ? { description: stringValue(effort.description) }
            : {}),
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

function mapSubagentStatus(
  value: string | undefined,
  completed: boolean,
): SubagentRun['status'] {
  if (value === 'completed' || value === 'shutdown') return 'completed'
  if (value === 'errored' || value === 'notFound') return 'failed'
  if (value === 'interrupted') return 'interrupted'
  if (value === 'pendingInit') return 'starting'
  return completed ? 'completed' : 'running'
}

/** Prefer the last agent-path segment for UI titles (`/root/worker` → `worker`). */
function subagentTitle(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const segments = trimmed.split('/').filter(Boolean)
  return segments.at(-1) ?? trimmed
}

function isTerminalSubagent(value: SubagentRun['status']): boolean {
  return (
    value === 'completed' ||
    value === 'failed' ||
    value === 'interrupted' ||
    value === 'cancelled'
  )
}

async function findExecutable(
  name: string,
  pathValue: string | undefined,
): Promise<string | undefined> {
  if (!pathValue) return undefined
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      await access(candidate, 1)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

async function executableVersion(path: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(path, ['--version'])
    return result.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

function cloneCapabilities(value: RuntimeCapabilities): RuntimeCapabilities {
  return structuredClone(value)
}
