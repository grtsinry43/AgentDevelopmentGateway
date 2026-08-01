import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import {
  AdapterError,
  asInteractionId,
  asSubagentRunId,
  asToolCallId,
  cloneSessionExecutionSettings,
  createDefaultSessionExecutionSettings,
  toRuntimeError,
  type AdapterEvent,
  type ChangeSet,
  type CreateSessionInput,
  type ExecutionConfigurationResult,
  type ForkSessionInput,
  type InteractionResolution,
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
  type SessionExecutionSettings,
  type SessionId,
  type SubagentRun,
  type ToolCall,
  type TurnId,
  type UserInput,
} from '@agent-gateway/core'
import { AsyncQueue } from './async-queue.js'

const execFileAsync = promisify(execFile)

const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
  steer: 'queue-fallback',
  modelSwitch: 'in-session',
  execution: {
    workModes: ['build'],
    approvalActions: ['allow', 'ask', 'deny'],
    approvalReviewers: ['user'],
    filesystemSandbox: ['workspace-write'],
    networkAccess: ['ask'],
    update: 'unsupported',
    granularRules: false,
  },
  features: {
    'session.resume': true,
    'session.fork': true,
    'output.partial_text': true,
    'output.partial_reasoning': true,
    'interaction.permission': true,
    'task.todo': true,
    'agent.subagent': true,
  },
  raw: ['opencode.http-sse', 'opencode.session.children'],
  degradations: [
    {
      capability: 'input.steer',
      status: 'unsupported',
      reason: 'OpenCode 1.x prompt_async has no steer delivery field; Gateway queues instead',
    },
  ],
}

const descriptor: RuntimeAdapterDescriptor = {
  id: 'opencode',
  displayName: 'OpenCode',
  adapterVersion: '0.0.0',
  protocolVersion: 'http-sse-v1',
  capabilities: OPENCODE_CAPABILITIES,
}

interface OpenCodeConnectionState {
  connection: RuntimeConnection
  context: RuntimeHostContext
  installation: RuntimeInstallation
  process: ChildProcessWithoutNullStreams
  baseUrl: string
  directories: Map<string, DirectoryPump>
}

interface DirectoryPump {
  abort: AbortController
  promise: Promise<void>
}

interface OpenCodeSessionState {
  id: SessionId
  runtimeSessionId: string
  projectPath: string
  connection: OpenCodeConnectionState
  events: AsyncQueue<AdapterEvent>
  activeTurnId?: TurnId
  model?: ModelSelection
  interactions: Map<string, { nativeId: string; nativeSessionId: string }>
  messageRoles: Map<string, string>
  startedParts: Set<string>
  completedParts: Set<string>
  tools: Map<string, ToolCall>
  disposed: boolean
}

interface OpenCodeChildState {
  nativeSessionId: string
  root: OpenCodeSessionState
  run: SubagentRun
}

export class OpenCodeAdapter implements RuntimeAdapter {
  readonly descriptor = descriptor
  private readonly connections = new Map<string, OpenCodeConnectionState>()
  private readonly sessions = new Map<SessionId, OpenCodeSessionState>()
  private readonly rootsByNativeId = new Map<string, OpenCodeSessionState>()
  private readonly childrenByNativeId = new Map<string, OpenCodeChildState>()

  async detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]> {
    const executable = await findExecutable('opencode', context.env?.PATH ?? process.env.PATH)
    if (!executable) return []
    const version = await executableVersion(executable)
    return [{ path: executable, version, source: 'path' }]
  }

  async connect(options: RuntimeConnectOptions): Promise<RuntimeConnection> {
    if (!options.installation) throw adapterError('connection', 'OpenCode installation is required')
    const port = await reservePort()
    const processHandle = spawn(
      options.installation.path,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'],
      {
        env: { ...process.env, ...options.context.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const baseUrl = await waitForServer(processHandle, port)
    const connection: RuntimeConnection = {
      id: randomUUID(),
      transport: 'http-sse',
      runtimeVersion: options.installation.version,
      capabilities: cloneCapabilities(OPENCODE_CAPABILITIES),
    }
    const state: OpenCodeConnectionState = {
      connection,
      context: options.context,
      installation: options.installation,
      process: processHandle,
      baseUrl,
      directories: new Map(),
    }
    processHandle.once('exit', (code, signal) => {
      const error = new Error(`OpenCode server exited (${code ?? signal ?? 'unknown'})`)
      for (const session of this.sessions.values()) {
        if (session.connection !== state || session.disposed) continue
        this.publish(session, {
          type: 'runtime.error',
          payload: { error: { ...toRuntimeError(error, 'connection'), layer: 'transport' } },
        })
        session.events.fail(error)
      }
    })
    this.connections.set(connection.id, state)
    return connection
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    this.assertContextUnsupported(input.context)
    const connection = this.requireConnection(input.connection)
    this.ensureDirectoryPump(connection, input.projectPath)
    const native = await requestJson(connection, input.projectPath, '/session', {
      method: 'POST',
      body: {},
    })
    const runtimeSessionId = requiredString(native, 'id', 'OpenCode create response')
    const session = this.openSession(
      input.sessionId,
      runtimeSessionId,
      input.projectPath,
      connection,
      input.model,
    )
    this.publish(session, {
      type: 'session.created',
      payload: {
        runtimeSessionId,
        capabilities: cloneCapabilities(OPENCODE_CAPABILITIES),
      },
    })
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return {
      sessionId: input.sessionId,
      runtimeSessionId,
      execution: resolveExecution(input.execution),
    }
  }

  async resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle> {
    this.assertContextUnsupported(input.context)
    const connection = this.requireConnection(input.connection)
    this.ensureDirectoryPump(connection, input.projectPath)
    await requestJson(
      connection,
      input.projectPath,
      `/session/${encodeURIComponent(input.runtimeSessionId)}`,
    )
    const session = this.openSession(
      input.sessionId,
      input.runtimeSessionId,
      input.projectPath,
      connection,
      undefined,
    )
    await this.discoverChildren(session)
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return {
      sessionId: input.sessionId,
      runtimeSessionId: input.runtimeSessionId,
      execution: resolveExecution(input.execution),
    }
  }

  async forkSession(input: ForkSessionInput): Promise<RuntimeSessionHandle> {
    if (input.context) throw adapterError('not_implemented', 'OpenCode fork context is not implemented')
    const messageID = input.forkPoint?.by === 'message' ? input.forkPoint.messageUuid : undefined
    if (input.forkPoint && !messageID) {
      throw adapterError('protocol', `OpenCode cannot fork from a ${input.forkPoint.by} cursor`)
    }
    const native = await requestJson(
      this.requireConnection(input.connection),
      input.projectPath,
      `/session/${encodeURIComponent(input.runtimeSessionId)}/fork`,
      { method: 'POST', body: messageID ? { messageID } : {} },
    )
    const runtimeSessionId = requiredString(native, 'id', 'OpenCode fork response')
    const session = this.openSession(
      input.sessionId,
      runtimeSessionId,
      input.projectPath,
      this.requireConnection(input.connection),
      undefined,
    )
    this.publish(session, {
      type: 'session.created',
      payload: { runtimeSessionId, capabilities: cloneCapabilities(OPENCODE_CAPABILITIES) },
    })
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    return {
      sessionId: input.sessionId,
      runtimeSessionId,
      execution: resolveExecution(input.execution),
    }
  }

  async send(sessionId: SessionId, input: UserInput, options: SendOptions): Promise<void> {
    const session = this.getSession(sessionId)
    if (options.kind !== 'start-turn') {
      throw adapterError('protocol', 'OpenCode 1.x does not support native turn steering')
    }
    if (options.context) {
      throw adapterError('not_implemented', 'OpenCode turn context injection is not implemented')
    }
    if (input.attachments?.length) {
      throw adapterError('not_implemented', 'OpenCode attachment delivery is not implemented')
    }
    if (input.admitOnly) throw adapterError('protocol', 'admitOnly inputs must not reach adapters')
    if (session.activeTurnId) {
      throw adapterError('protocol', `OpenCode session already has an active turn: ${session.activeTurnId}`)
    }
    session.activeTurnId = options.turnId
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
    try {
      await requestVoid(
        session.connection,
        session.projectPath,
        `/session/${encodeURIComponent(session.runtimeSessionId)}/prompt_async`,
        {
          method: 'POST',
          body: {
            ...(session.model ? { model: splitModel(session.model.model) } : {}),
            parts: [{ type: 'text', text: input.text }],
          },
        },
      )
    } catch (error) {
      session.activeTurnId = undefined
      throw error
    }
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    await requestJson(
      session.connection,
      session.projectPath,
      `/session/${encodeURIComponent(session.runtimeSessionId)}/abort`,
      { method: 'POST' },
    )
    const turnId = session.activeTurnId
    session.activeTurnId = undefined
    if (turnId) {
      this.publish(session, {
        type: 'turn.completed',
        payload: { turnId, status: 'interrupted' },
        turnId,
      })
    }
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'interrupted' },
      ...(turnId ? { turnId } : {}),
    })
  }

  async resolveInteraction(
    sessionId: SessionId,
    resolution: InteractionResolution,
  ): Promise<void> {
    const session = this.getSession(sessionId)
    const pending = session.interactions.get(resolution.id)
    if (!pending) return
    if (resolution.kind !== 'tool_permission') {
      throw adapterError('not_implemented', `OpenCode cannot resolve ${resolution.kind}`)
    }
    const response =
      resolution.decision.behavior === 'deny'
        ? 'reject'
        : resolution.decision.scope === 'session'
          ? 'always'
          : 'once'
    await requestJson(
      session.connection,
      session.projectPath,
      `/session/${encodeURIComponent(pending.nativeSessionId)}/permissions/${encodeURIComponent(pending.nativeId)}`,
      { method: 'POST', body: { response } },
    )
    session.interactions.delete(resolution.id)
    this.publish(session, {
      type: 'interaction.resolved',
      payload: { id: resolution.id, resolution },
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    })
  }

  setModel(sessionId: SessionId, model: ModelSelection): Promise<void> {
    this.getSession(sessionId).model = { ...model }
    return Promise.resolve()
  }

  disposeSession(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'closed' },
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    })
    session.disposed = true
    session.events.close()
    this.sessions.delete(sessionId)
    this.rootsByNativeId.delete(session.runtimeSessionId)
    for (const [nativeId, child] of this.childrenByNativeId) {
      if (child.root === session) this.childrenByNativeId.delete(nativeId)
    }
    return Promise.resolve()
  }

  events(sessionId: SessionId): AsyncIterable<AdapterEvent> {
    return this.getSession(sessionId).events
  }

  getCapabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve(cloneCapabilities(OPENCODE_CAPABILITIES))
  }

  async dispose(): Promise<void> {
    for (const connection of this.connections.values()) {
      for (const directory of connection.directories.values()) directory.abort.abort()
      if (connection.process.exitCode === null && connection.process.signalCode === null) {
        connection.process.kill('SIGTERM')
      }
      await Promise.allSettled([...connection.directories.values()].map((entry) => entry.promise))
    }
    this.connections.clear()
  }

  private openSession(
    id: SessionId,
    runtimeSessionId: string,
    projectPath: string,
    connection: OpenCodeConnectionState,
    model?: ModelSelection,
  ): OpenCodeSessionState {
    if (this.sessions.has(id)) throw adapterError('protocol', `Duplicate Gateway session: ${id}`)
    const session: OpenCodeSessionState = {
      id,
      runtimeSessionId,
      projectPath,
      connection,
      events: new AsyncQueue(),
      ...(model ? { model: { ...model } } : {}),
      interactions: new Map(),
      messageRoles: new Map(),
      startedParts: new Set(),
      completedParts: new Set(),
      tools: new Map(),
      disposed: false,
    }
    this.sessions.set(id, session)
    this.rootsByNativeId.set(runtimeSessionId, session)
    return session
  }

  private ensureDirectoryPump(connection: OpenCodeConnectionState, projectPath: string): void {
    if (connection.directories.has(projectPath)) return
    const abort = new AbortController()
    const pump: DirectoryPump = {
      abort,
      promise: this.pumpDirectory(connection, projectPath, abort.signal),
    }
    connection.directories.set(projectPath, pump)
  }

  private async pumpDirectory(
    connection: OpenCodeConnectionState,
    projectPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const response = await fetch(urlFor(connection, projectPath, '/event'), {
        signal,
        headers: { accept: 'text/event-stream' },
      })
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream failed with HTTP ${response.status}`)
      }
      for await (const event of parseSse(response.body)) this.handleNativeEvent(projectPath, event)
      if (!signal.aborted) throw new Error('OpenCode event stream ended unexpectedly')
    } catch (error) {
      if (signal.aborted) return
      for (const session of this.sessions.values()) {
        if (session.connection !== connection || session.projectPath !== projectPath) continue
        this.publish(session, {
          type: 'runtime.error',
          payload: { error: { ...toRuntimeError(error, 'connection'), layer: 'transport' } },
        })
        session.events.fail(error)
      }
    }
  }

  private handleNativeEvent(projectPath: string, event: unknown): void {
    if (!isRecord(event) || typeof event.type !== 'string') return
    if (event.type === 'session.created') {
      const info = nestedRecord(event, 'properties', 'info')
      if (info && typeof info.parentID === 'string') this.registerChild(info)
    }
    const nativeSessionId = nativeEventSessionId(event)
    const root = nativeSessionId ? this.rootForNativeSession(nativeSessionId) : undefined
    if (!root || root.projectPath !== projectPath || root.disposed) return
    const child = nativeSessionId ? this.childrenByNativeId.get(nativeSessionId) : undefined
    const attribution = child
      ? {
          subagentRunId: child.run.id,
          ...(child.run.parentSubagentRunId
            ? { depth: 2 as const }
            : { depth: 1 as const }),
          sourceKind: 'subagent' as const,
          taskId: child.nativeSessionId,
        }
      : undefined
    const mapped = this.mapNativeEvent(root, child, event, attribution)
    for (const gatewayEvent of mapped) this.publish(root, gatewayEvent)
  }

  private mapNativeEvent(
    session: OpenCodeSessionState,
    child: OpenCodeChildState | undefined,
    event: Record<string, unknown>,
    attribution: AdapterEvent['attribution'],
  ): AdapterEvent[] {
    const properties = isRecord(event.properties) ? event.properties : {}
    const turnId = session.activeTurnId
    const common = {
      ...(turnId ? { turnId } : {}),
      ...(attribution ? { attribution } : {}),
      nativeRef: {
        ...(typeof event.id === 'string' ? { eventId: event.id } : {}),
        eventType: event.type as string,
      },
    }
    if (event.type === 'message.updated' && isRecord(properties.info)) {
      const info = properties.info
      const messageId = stringValue(info.id)
      const role = stringValue(info.role)
      if (messageId && role) session.messageRoles.set(messageId, role)
      if (role === 'assistant' && isRecord(info.tokens)) {
        return [{
          type: 'usage.updated',
          payload: { usage: mapUsage(info.tokens, numberValue(info.cost)) },
          ...common,
        }]
      }
      return []
    }
    if (event.type === 'message.part.updated' && isRecord(properties.part)) {
      return this.mapPart(session, properties.part, stringValue(properties.delta), common)
    }
    if (event.type === 'session.status' && isRecord(properties.status)) {
      const status = stringValue(properties.status.type)
      if (child) return this.updateChildFromStatus(child, status, common)
      if (status === 'busy') {
        return [{ type: 'session.status_changed', payload: { status: 'running' }, ...common }]
      }
      if (status === 'retry') {
        return [{
          type: 'runtime.warning',
          payload: {
            error: {
              code: 'connection',
              layer: 'resource',
              retriable: true,
              message: stringValue(properties.status.message) ?? 'OpenCode is retrying',
            },
          },
          ...common,
        }]
      }
      if (status === 'idle') return this.completeRootTurn(session, common)
    }
    if (event.type === 'session.idle') {
      return child
        ? this.updateChildFromStatus(child, 'idle', common)
        : this.completeRootTurn(session, common)
    }
    if (event.type === 'session.updated' && isRecord(properties.info)) {
      const title = stringValue(properties.info.title)
      if (child && title) {
        const run = { ...child.run, title, updatedAt: Date.now() }
        child.run = run
        return [{ type: 'subagent.updated', payload: { run }, ...common }]
      }
      return title
        ? [{ type: 'session.title_changed', payload: { title, source: 'provider' }, ...common }]
        : []
    }
    if (event.type === 'permission.updated') {
      return this.mapPermission(session, properties, common)
    }
    if (event.type === 'permission.replied') {
      const nativeId = stringValue(properties.permissionID)
      const entry = [...session.interactions.entries()].find(([, value]) => value.nativeId === nativeId)
      if (!entry) return []
      session.interactions.delete(entry[0])
      return [{
        type: 'interaction.canceled',
        payload: { id: asInteractionId(entry[0]), reason: 'superseded' },
        ...common,
      }]
    }
    if (event.type === 'todo.updated' && Array.isArray(properties.todos)) {
      const tasks = properties.todos.flatMap((value) => mapTodo(value))
      return [{ type: 'task.updated', payload: { update: { kind: 'replace', tasks } }, ...common }]
    }
    if (event.type === 'session.diff' && Array.isArray(properties.diff)) {
      const changeSet = mapDiff(properties.diff, session.runtimeSessionId)
      return changeSet ? [{ type: 'changes.updated', payload: { changeSet }, ...common }] : []
    }
    if (event.type === 'session.error') {
      const message = nativeErrorMessage(properties.error) ?? 'OpenCode session failed'
      if (child) {
        const run: SubagentRun = {
          ...child.run,
          status: 'failed',
          error: { code: 'unknown', layer: 'turn', message },
          updatedAt: Date.now(),
          completedAt: Date.now(),
        }
        child.run = run
        return [{ type: 'subagent.completed', payload: { run }, ...common }]
      }
      if (!turnId) return [{ type: 'runtime.error', payload: { error: { code: 'unknown', message } }, ...common }]
      session.activeTurnId = undefined
      return [
        {
          type: 'turn.failed',
          payload: { turnId, error: { code: 'unknown', layer: 'turn', message } },
          ...common,
        },
        { type: 'session.status_changed', payload: { status: 'error' }, ...common },
      ]
    }
    return [{
      type: 'runtime.extension',
      payload: { feature: `opencode.event.${event.type as string}`, payload: event },
      ...common,
    }]
  }

  private mapPart(
    session: OpenCodeSessionState,
    part: Record<string, unknown>,
    delta: string | undefined,
    common: Omit<AdapterEvent, 'type' | 'payload'>,
  ): AdapterEvent[] {
    const partId = stringValue(part.id)
    const messageId = stringValue(part.messageID)
    const type = stringValue(part.type)
    if (!partId || !type) return []
    if (messageId && session.messageRoles.get(messageId) === 'user') return []
    if (type === 'text' || type === 'reasoning') {
      const contentType = type === 'text' ? 'text' : 'reasoning'
      const events: AdapterEvent[] = []
      if (!session.startedParts.has(partId)) {
        session.startedParts.add(partId)
        events.push({
          type: contentType === 'text' ? 'content.text.started' : 'content.reasoning.started',
          payload: { blockId: partId },
          ...common,
        } as AdapterEvent)
      }
      if (delta !== undefined) {
        events.push({
          type: contentType === 'text' ? 'content.text.delta' : 'content.reasoning.delta',
          payload: { blockId: partId, delta },
          ...common,
        } as AdapterEvent)
      }
      const time = isRecord(part.time) ? part.time : undefined
      if (delta === undefined && (!time || typeof time.end === 'number') && !session.completedParts.has(partId)) {
        session.completedParts.add(partId)
        events.push({
          type: contentType === 'text' ? 'content.text.completed' : 'content.reasoning.completed',
          payload: { blockId: partId, text: stringValue(part.text) ?? '' },
          ...common,
        } as AdapterEvent)
      }
      return events
    }
    if (type === 'tool' && isRecord(part.state)) {
      const callId = stringValue(part.callID) ?? partId
      const toolName = stringValue(part.tool) ?? 'unknown'
      const status = mapToolStatus(stringValue(part.state.status))
      if (!status) return []
      const toolCall: ToolCall = {
        id: asToolCallId(callId),
        kind: classifyTool(toolName),
        name: toolName,
        status,
        ...(isRecord(part.state.input) ? { input: part.state.input } : {}),
        ...(typeof part.state.output === 'string' ? { result: part.state.output } : {}),
        ...(isRecord(part.state.metadata) ? { structured: part.state.metadata } : {}),
        ...(status === 'error'
          ? {
              error: {
                code: 'unknown',
                layer: 'turn',
                message: stringValue(part.state.error) ?? 'OpenCode tool failed',
              },
            }
          : {}),
      }
      session.tools.set(callId, toolCall)
      const terminal = status === 'completed' || status === 'error'
      if (terminal) session.completedParts.add(partId)
      return [{
        type: terminal ? 'tool.completed' : 'tool.started',
        payload: { toolCall },
        ...common,
      } as AdapterEvent]
    }
    return [{
      type: 'runtime.extension',
      payload: { feature: `opencode.part.${type}`, payload: part },
      ...common,
    }]
  }

  private mapPermission(
    session: OpenCodeSessionState,
    permission: Record<string, unknown>,
    common: Omit<AdapterEvent, 'type' | 'payload'>,
  ): AdapterEvent[] {
    const nativeId = stringValue(permission.id)
    const nativeSessionId = stringValue(permission.sessionID)
    if (!nativeId || !nativeSessionId) return []
    const id = asInteractionId(randomUUID())
    session.interactions.set(id, { nativeId, nativeSessionId })
    const toolName = stringValue(permission.type) ?? 'unknown'
    const pattern = permission.pattern
    const resources = Array.isArray(pattern)
      ? pattern.filter((value): value is string => typeof value === 'string')
      : typeof pattern === 'string'
        ? [pattern]
        : undefined
    return [{
      type: 'interaction.permission_requested',
      payload: {
        request: {
          id,
          sessionId: session.id,
          ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
          ...(typeof permission.callID === 'string'
            ? { toolCallId: asToolCallId(permission.callID) }
            : {}),
          kind: 'tool_permission',
          toolKind: classifyTool(toolName),
          toolName,
          input: permission.metadata,
          prompt: stringValue(permission.title) ?? `Allow ${toolName}?`,
          ...(resources?.length ? { resources } : {}),
          availableDecisions: ['once', 'always', 'reject'],
          createdAt: nestedNumber(permission, 'time', 'created') ?? Date.now(),
        },
      },
      ...common,
    }]
  }

  private completeRootTurn(
    session: OpenCodeSessionState,
    common: Omit<AdapterEvent, 'type' | 'payload'>,
  ): AdapterEvent[] {
    const turnId = session.activeTurnId
    if (!turnId) return []
    session.activeTurnId = undefined
    return [
      { type: 'turn.completed', payload: { turnId, status: 'completed' }, ...common },
      { type: 'session.status_changed', payload: { status: 'idle' }, ...common },
    ]
  }

  private updateChildFromStatus(
    child: OpenCodeChildState,
    status: string | undefined,
    common: Omit<AdapterEvent, 'type' | 'payload'>,
  ): AdapterEvent[] {
    const nextStatus: SubagentRun['status'] =
      status === 'busy' ? 'running' : status === 'retry' ? 'waiting' : 'completed'
    if (child.run.status === nextStatus && nextStatus === 'completed') return []
    const run: SubagentRun = {
      ...child.run,
      status: nextStatus,
      updatedAt: Date.now(),
      ...(nextStatus === 'completed' ? { completedAt: Date.now() } : {}),
    }
    child.run = run
    return [{
      type: nextStatus === 'completed' ? 'subagent.completed' : 'subagent.updated',
      payload: { run },
      ...common,
    }]
  }

  private registerChild(info: Record<string, unknown>): void {
    const nativeSessionId = stringValue(info.id)
    const parentId = stringValue(info.parentID)
    if (!nativeSessionId || !parentId || this.childrenByNativeId.has(nativeSessionId)) return
    const root = this.rootForNativeSession(parentId)
    if (!root) return
    const parent = this.childrenByNativeId.get(parentId)
    const now = Date.now()
    const run: SubagentRun = {
      id: asSubagentRunId(randomUUID()),
      sessionId: root.id,
      ...(parent ? { parentSubagentRunId: parent.run.id } : {}),
      runtimeSubagentId: nativeSessionId,
      title: stringValue(info.title) ?? 'OpenCode subagent',
      description: stringValue(info.title),
      executionMode: 'foreground',
      status: 'starting',
      startedAt: nestedNumber(info, 'time', 'created') ?? now,
      updatedAt: now,
    }
    const child = { nativeSessionId, root, run }
    this.childrenByNativeId.set(nativeSessionId, child)
    this.publish(root, {
      type: 'subagent.started',
      payload: { run },
      ...(root.activeTurnId ? { turnId: root.activeTurnId } : {}),
      attribution: {
        subagentRunId: run.id,
        taskId: nativeSessionId,
        depth: parent ? 2 : 1,
        sourceKind: 'subagent',
      },
    })
  }

  private async discoverChildren(root: OpenCodeSessionState): Promise<void> {
    const children = await requestJson(
      root.connection,
      root.projectPath,
      `/session/${encodeURIComponent(root.runtimeSessionId)}/children`,
    )
    if (!Array.isArray(children)) return
    for (const child of children) if (isRecord(child)) this.registerChild(child)
  }

  private rootForNativeSession(nativeSessionId: string): OpenCodeSessionState | undefined {
    return this.rootsByNativeId.get(nativeSessionId) ?? this.childrenByNativeId.get(nativeSessionId)?.root
  }

  private publish(session: OpenCodeSessionState, event: AdapterEvent): void {
    if (!session.disposed) session.events.push(event)
  }

  private requireConnection(connection: RuntimeConnection): OpenCodeConnectionState {
    const state = this.connections.get(connection.id)
    if (!state || state.connection.transport !== 'http-sse') {
      throw adapterError('connection', `Unknown OpenCode connection: ${connection.id}`)
    }
    return state
  }

  private getSession(sessionId: SessionId): OpenCodeSessionState {
    const session = this.sessions.get(sessionId)
    if (!session || session.disposed) throw adapterError('connection', `Unknown OpenCode session: ${sessionId}`)
    return session
  }

  private assertContextUnsupported(context: CreateSessionInput['context'] | ResumeSessionInput['context']): void {
    if (context) throw adapterError('not_implemented', 'OpenCode session context injection is not implemented')
  }
}

function resolveExecution(settings?: SessionExecutionSettings): ExecutionConfigurationResult {
  const configured = cloneSessionExecutionSettings(settings ?? createDefaultSessionExecutionSettings())
  const effective = createDefaultSessionExecutionSettings()
  return {
    effective,
    limitations:
      JSON.stringify(configured) === JSON.stringify(effective)
        ? []
        : [{ capability: 'execution.configure', reason: 'OpenCode 1.x HTTP API does not expose per-session execution policy updates' }],
  }
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf('/')
  if (separator <= 0 || separator === model.length - 1) {
    throw adapterError('protocol', 'OpenCode models must use provider/model format')
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

function mapUsage(tokens: Record<string, unknown>, cost?: number) {
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  const inputTokens = numberValue(tokens.input) ?? 0
  const outputTokens = numberValue(tokens.output) ?? 0
  const reasoningTokens = numberValue(tokens.reasoning) ?? 0
  const cachedInputTokens = numberValue(cache.read) ?? 0
  const cacheCreationInputTokens = numberValue(cache.write) ?? 0
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
}

function mapTodo(value: unknown) {
  if (!isRecord(value)) return []
  const id = stringValue(value.id)
  const title = stringValue(value.content)
  const status = stringValue(value.status)
  if (!id || !title || !status || !['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) return []
  const priority = stringValue(value.priority)
  return [{
    id,
    title,
    status: status as 'pending' | 'in_progress' | 'completed' | 'cancelled',
    ...(['high', 'medium', 'low'].includes(priority ?? '')
      ? { priority: priority as 'high' | 'medium' | 'low' }
      : {}),
  }]
}

function mapDiff(values: unknown[], nativeSessionId: string): ChangeSet | undefined {
  const files = values.flatMap((value) => {
    if (!isRecord(value)) return []
    const path = stringValue(value.file)
    if (!path) return []
    const before = stringValue(value.before) ?? ''
    const after = stringValue(value.after) ?? ''
    return [{
      path,
      pathKind: 'workspace-relative' as const,
      kind: before.length === 0 ? ('create' as const) : after.length === 0 ? ('delete' as const) : ('modify' as const),
      additions: numberValue(value.additions) ?? 0,
      deletions: numberValue(value.deletions) ?? 0,
      hunks: [],
    }]
  })
  return files.length === 0
    ? undefined
    : {
        id: `opencode:${nativeSessionId}:diff`,
        intent: 'applied',
        scope: 'session',
        status: 'completed',
        files,
      }
}

function mapToolStatus(status: string | undefined): ToolCall['status'] | undefined {
  if (status === 'pending') return 'pending'
  if (status === 'running') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'error') return 'error'
  return undefined
}

function classifyTool(name: string): ToolCall['kind'] {
  const normalized = name.toLowerCase()
  if (normalized === 'bash' || normalized === 'shell') return 'terminal'
  if (['edit', 'write', 'patch', 'apply_patch', 'multiedit'].includes(normalized)) return 'file-edit'
  if (['read', 'glob', 'list'].includes(normalized)) return normalized === 'read' ? 'file-read' : 'search'
  if (normalized.includes('web')) return 'web'
  if (normalized.includes('task') || normalized.includes('agent')) return 'subagent'
  if (normalized.includes('todo')) return 'todo'
  if (normalized.startsWith('mcp')) return 'mcp'
  return 'generic'
}

function nativeEventSessionId(event: Record<string, unknown>): string | undefined {
  const properties = isRecord(event.properties) ? event.properties : undefined
  if (!properties) return undefined
  if (typeof properties.sessionID === 'string') return properties.sessionID
  if (isRecord(properties.info) && typeof properties.info.sessionID === 'string') return properties.info.sessionID
  if (isRecord(properties.info) && typeof properties.info.id === 'string' && String(event.type).startsWith('session.')) {
    return properties.info.id
  }
  if (isRecord(properties.part) && typeof properties.part.sessionID === 'string') return properties.part.sessionID
  return undefined
}

async function requestJson(
  connection: OpenCodeConnectionState,
  projectPath: string,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(urlFor(connection, projectPath, path), {
    method: options.method ?? 'GET',
    ...(options.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  })
  if (!response.ok) throw await httpError(response)
  return response.json()
}

async function requestVoid(
  connection: OpenCodeConnectionState,
  projectPath: string,
  path: string,
  options: { method: 'POST'; body?: unknown },
): Promise<void> {
  const response = await fetch(urlFor(connection, projectPath, path), {
    method: options.method,
    ...(options.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  })
  if (!response.ok) throw await httpError(response)
}

function urlFor(connection: OpenCodeConnectionState, projectPath: string, path: string): string {
  const url = new URL(path, connection.baseUrl)
  url.searchParams.set('directory', projectPath)
  return url.href
}

async function httpError(response: Response): Promise<AdapterError> {
  const body = await response.text()
  return new AdapterError({
    code: 'protocol',
    layer: 'transport',
    nativeCode: `opencode.http.${response.status}`,
    message: body || `OpenCode returned HTTP ${response.status}`,
  })
}

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield JSON.parse(data) as unknown
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function findExecutable(name: string, pathValue: string | undefined): Promise<string | undefined> {
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

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to reserve an OpenCode port')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function waitForServer(processHandle: ChildProcessWithoutNullStreams, expectedPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for OpenCode server')), 15_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      const match = output.match(/opencode server listening on (http:\/\/[^\s]+)/)
      if (match?.[1]) finish(undefined, match[1])
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(new Error(`OpenCode server exited before ready (${code ?? signal ?? 'unknown'}): ${output}`))
    const finish = (error?: Error, url?: string): void => {
      clearTimeout(timeout)
      processHandle.stdout.off('data', onData)
      processHandle.stderr.off('data', onData)
      processHandle.off('exit', onExit)
      if (error) {
        if (processHandle.exitCode === null) processHandle.kill('SIGTERM')
        reject(error)
      } else {
        resolve(url ?? `http://127.0.0.1:${expectedPort}`)
      }
    }
    processHandle.stdout.on('data', onData)
    processHandle.stderr.on('data', onData)
    processHandle.once('exit', onExit)
  })
}

function requiredString(value: unknown, key: string, label: string): string {
  if (!isRecord(value) || typeof value[key] !== 'string') throw new Error(`${label} has no ${key}`)
  return value[key]
}

function nestedRecord(value: Record<string, unknown>, first: string, second: string): Record<string, unknown> | undefined {
  const outer = value[first]
  return isRecord(outer) && isRecord(outer[second]) ? outer[second] : undefined
}

function nestedNumber(value: Record<string, unknown>, first: string, second: string): number | undefined {
  const outer = value[first]
  return isRecord(outer) ? numberValue(outer[second]) : undefined
}

function nativeErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.data) && typeof value.data.message === 'string') return value.data.message
  return stringValue(value.message) ?? stringValue(value.name)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneCapabilities(value: RuntimeCapabilities): RuntimeCapabilities {
  return structuredClone(value)
}

function adapterError(code: ConstructorParameters<typeof AdapterError>[0]['code'], message: string): AdapterError {
  return new AdapterError({ code, layer: 'transport', message })
}
