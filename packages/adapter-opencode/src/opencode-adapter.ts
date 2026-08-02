import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import {
  AdapterError,
  cloneSessionExecutionSettings,
  createDefaultSessionExecutionSettings,
  toRuntimeError,
  type AdapterEvent,
  type AdapterSendResult,
  type CreateSessionInput,
  type ExecutionConfigurationResult,
  type InteractionResolution,
  type ListModelsInput,
  type ModelCatalog,
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
  type ToolCall,
  type TurnId,
  type UserInput,
} from '@agent-gateway/core'
import { AsyncQueue } from './async-queue.js'
import { OpenCodeHttpClient } from './http-client.js'
import { toModelRef, toNativeMessageId, toPrompt } from './input.js'
import {
  interactionClosedNativeId,
  mapInteractionAsked,
  resolutionRequest,
  type PendingInteraction,
} from './interaction.js'
import {
  changeSetFromOpenCodeDiffs,
  findToolCallIdForPath,
  mapOpenCodeEvent,
  tasksFromOpenCodeTodos,
  type MapperState,
} from './mapper.js'
import {
  parseAdmittedInput,
  recordValue,
  requiredString,
  stringValue,
  unwrapData,
  type OpenCodeAdapterEvent,
  type OpenCodeEvent,
} from './protocol.js'
import { startEventPump, type EventPump } from './sse.js'

const execFileAsync = promisify(execFile)

const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
  steer: 'native',
  modelSwitch: 'in-session',
  execution: {
    workModes: ['build'],
    approvalActions: ['ask'],
    approvalReviewers: ['user'],
    filesystemSandbox: ['workspace-write'],
    networkAccess: ['ask'],
    update: 'unsupported',
    granularRules: false,
  },
  features: {
    'session.resume': true,
    'session.fork': false,
    'model.catalog': true,
    'output.partial_text': true,
    'output.partial_reasoning': true,
    'tool.input_stream': true,
    'interaction.permission': true,
    'interaction.question': true,
    'work-mode.plan': false,
    'task.todo': true,
    'agent.subagent': false,
    'context.session_injection': false,
    'context.turn_injection': false,
    'context.compaction': true,
    'changes.revert': false,
    'extension.skills': false,
  },
  raw: [
    'opencode.v2.session.status',
    'opencode.v2.session.interrupt',
    'opencode.v2.session.delivery.steer',
    'opencode.v2.session.delivery.queue',
    'opencode.v2.agent.catalog.raw',
    'opencode.v2.command.catalog.raw',
    'opencode.v2.skill.catalog.raw',
  ],
  degradations: [
    {
      capability: 'context.session_injection',
      status: 'unsupported',
      reason: 'OpenCode 1.18.10 PromptInput has no system or session-context field',
    },
    {
      capability: 'context.turn_injection',
      status: 'unsupported',
      reason: 'OpenCode 1.18.10 PromptInput has no typed turn-context channel',
    },
    {
      capability: 'execution.configure',
      status: 'unsupported',
      reason: 'OpenCode v2 has no per-session permission policy update route',
    },
    {
      capability: 'agent.subagent',
      status: 'unsupported',
      reason: 'Agent catalog entries do not expose a real SubagentRun lifecycle',
    },
    {
      capability: 'session.fork',
      status: 'unsupported',
      reason: 'OpenCode v2 has no session fork route',
    },
    {
      capability: 'attachment.inline_data',
      status: 'unsupported',
      reason: 'OpenCode 1.18.10 PromptInput only proves URI-based file attachments',
    },
  ],
}

const descriptor: RuntimeAdapterDescriptor = {
  id: 'opencode',
  displayName: 'OpenCode',
  adapterVersion: '0.0.0',
  protocolVersion: 'http-sse-v2',
  capabilities: OPENCODE_CAPABILITIES,
}

interface ConnectionState {
  connection: RuntimeConnection
  process: ChildProcessWithoutNullStreams
  client: OpenCodeHttpClient
  globalPump?: EventPump
}

interface SessionState {
  id: SessionId
  runtimeSessionId: string
  projectPath: string
  connection: ConnectionState
  events: AsyncQueue<OpenCodeAdapterEvent>
  eventPump: EventPump
  seenEventIds: Set<string>
  interactions: Map<string, PendingInteraction>
  tools: Map<string, ToolCall>
  startedTextIds: Set<string>
  startedReasoningIds: Set<string>
  pendingTextDeltas: Map<string, string[]>
  pendingReasoningDeltas: Map<string, string[]>
  pendingToolInputDeltas: Map<string, string[]>
  activeTurnId?: TurnId
  /** Survives settle so late content keeps turn attribution (Claude parity). */
  lastTurnId?: TurnId
  /**
   * OpenCode stores diffs on the *user* message (`summary.diffs`).
   * `GET /session/:id/diff?messageID=` requires that user message id
   * (`SessionSummary.diff` rejects non-user roles).
   * @see packages/opencode/src/session/summary.ts
   * @see packages/opencode/src/session/processor.ts (summarize parentID)
   */
  lastUserMessageId?: string
  /**
   * CLI parity (`stream.transport` Wait.live): true after runner-progress
   * activity for this turn. Must NOT latch on prompt.admitted/prompted —
   * `/session/status` treats missing entries as idle, so admit-before-runner
   * would otherwise settle immediately. Busy/retry also latches, but v2
   * sessions often never appear in the instance status map.
   */
  turnObservedActivity: boolean
  statusPollAbort?: AbortController
  model?: ModelSelection
  disposed: boolean
}

/** Matches OpenCode CLI run transport poll cadence. */
const SESSION_STATUS_POLL_MS = 250
/** summarize() is forked after step-finish; briefly retry GET diff. */
const DIFF_HYDRATE_ATTEMPTS = 8
const DIFF_HYDRATE_GAP_MS = 100

export class OpenCodeAdapter implements RuntimeAdapter {
  readonly descriptor = descriptor
  private readonly connections = new Map<string, ConnectionState>()
  private readonly sessions = new Map<SessionId, SessionState>()
  private readonly sessionsByNativeId = new Map<string, SessionState>()

  async detect(context: RuntimeHostContext): Promise<RuntimeInstallation[]> {
    const executable = await findExecutable('opencode', context.env?.PATH ?? process.env.PATH)
    if (!executable) return []
    return [{
      path: executable,
      version: await executableVersion(executable),
      source: 'path',
    }]
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
    const state: ConnectionState = {
      connection,
      process: processHandle,
      client: new OpenCodeHttpClient(baseUrl),
    }
    this.connections.set(connection.id, state)
    this.startGlobalPump(state)
    processHandle.once('exit', (code, signal) => {
      if (!this.connections.has(connection.id)) return
      this.failConnection(
        state,
        new Error(`OpenCode server exited (${code ?? signal ?? 'unknown'})`),
      )
    })
    return connection
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    assertNoSessionContext(input.context)
    const connection = this.requireConnection(input.connection)
    const response = await connection.client.json('/api/session', {
      method: 'POST',
      body: {
        ...(input.model ? { model: toModelRef(input.model) } : {}),
        location: { directory: input.projectPath },
      },
    })
    const info = requireResponseRecord(response, 'OpenCode create session')
    const runtimeSessionId = requiredString(info, 'id', 'OpenCode session')
    const session = this.openSession(
      input.sessionId,
      runtimeSessionId,
      input.projectPath,
      connection,
      undefined,
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
    await this.hydrateTodos(session)
    return {
      sessionId: input.sessionId,
      runtimeSessionId,
      execution: resolveExecution(input.execution),
    }
  }

  async resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle> {
    assertNoSessionContext(input.context)
    if (input.providerStateSnapshot) {
      throw adapterError('protocol', 'OpenCode v2 does not accept provider state snapshots')
    }
    if (input.cursor && input.cursor.by !== 'sequence') {
      throw adapterError(
        'protocol',
        `OpenCode v2 only supports sequence resume cursors, not ${input.cursor.by}`,
      )
    }
    const connection = this.requireConnection(input.connection)
    const response = await connection.client.json(
      `/api/session/${encodeURIComponent(input.runtimeSessionId)}`,
    )
    const info = requireResponseRecord(response, 'OpenCode get session')
    const nativeId = requiredString(info, 'id', 'OpenCode session')
    if (nativeId !== input.runtimeSessionId) {
      throw adapterError('protocol', 'OpenCode get session returned a different session id')
    }
    const after = input.cursor?.by === 'sequence' ? input.cursor.sequence : undefined
    const session = this.openSession(
      input.sessionId,
      nativeId,
      input.projectPath,
      connection,
      after,
      input.model,
    )
    this.publish(session, { type: 'session.status_changed', payload: { status: 'idle' } })
    await this.hydrateTodos(session)
    return {
      sessionId: input.sessionId,
      runtimeSessionId: nativeId,
      execution: resolveExecution(input.execution),
    }
  }

  async send(
    sessionId: SessionId,
    input: UserInput,
    options: SendOptions,
  ): Promise<AdapterSendResult> {
    const session = this.getSession(sessionId)
    if (options.context) {
      throw adapterError(
        'not_implemented',
        'OpenCode 1.18.10 has no typed TurnContext injection field',
      )
    }
    const resume = input.admitOnly !== true
    if (resume && options.kind === 'start-turn' && session.activeTurnId) {
      throw adapterError(
        'protocol',
        `OpenCode session already has an active turn: ${session.activeTurnId}`,
      )
    }
    const delivery = input.delivery ?? (options.kind === 'steer' ? 'steer' : 'queue')

    // Arm the turn before the HTTP round-trip (Claude parity). OpenCode streams
    // prompt.admitted / tools / text on SSE while POST /prompt is still awaiting;
    // publishing running only after the response made the UI skip "运行中".
    const armTurn = resume && options.kind === 'start-turn'
    if (armTurn) {
      session.activeTurnId = options.turnId
      session.lastTurnId = options.turnId
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
      this.startStatusPoll(session)
    }

    let admitted
    try {
      const response = await session.connection.client.json(
        `/api/session/${encodeURIComponent(session.runtimeSessionId)}/prompt`,
        {
          method: 'POST',
          body: {
            id: toNativeMessageId(input.clientMessageId),
            prompt: toPrompt(input, session.projectPath),
            delivery,
            resume,
          },
        },
      )
      admitted = parseAdmittedInput(response)
    } catch (error) {
      if (armTurn && session.activeTurnId === options.turnId) {
        this.stopStatusPoll(session)
        session.activeTurnId = undefined
        session.turnObservedActivity = false
        this.publish(session, {
          type: 'turn.failed',
          payload: {
            turnId: options.turnId,
            error: { ...toRuntimeError(error, 'protocol'), layer: 'turn' },
          },
          turnId: options.turnId,
        })
        this.publish(session, {
          type: 'session.status_changed',
          payload: { status: 'error' },
          turnId: options.turnId,
        })
      }
      throw error
    }

    // Admitted input id is the user Message.ID summarize/diff key off of.
    session.lastUserMessageId = admitted.id

    return {
      providerReceipt: {
        providerInputId: admitted.id,
        providerSequence: admitted.admittedSeq,
        raw: admitted,
      },
    }
  }

  async interrupt(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    // Official docs / SDK: POST /session/:id/abort
    await session.connection.client.void(
      `/session/${encodeURIComponent(session.runtimeSessionId)}/abort`,
      {
        method: 'POST',
        query: { directory: session.projectPath },
      },
    )
    this.stopStatusPoll(session)
    const turnId = session.activeTurnId
    session.activeTurnId = undefined
    session.turnObservedActivity = false
    if (turnId) {
      this.publish(session, {
        type: 'turn.completed',
        payload: { turnId, status: 'interrupted' },
        turnId,
      })
    }
    this.cancelInteractions(session, 'aborted', turnId)
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
    const request = resolutionRequest(pending, resolution)
    await session.connection.client.void(request.path, {
      method: 'POST',
      ...(request.body === undefined ? {} : { body: request.body }),
    })
    session.interactions.delete(resolution.id)
    this.publish(session, {
      type: 'interaction.resolved',
      payload: { id: resolution.id, resolution },
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    })
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: session.activeTurnId ? 'running' : 'idle' },
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    })
  }

  async listModels(input: ListModelsInput): Promise<ModelCatalog> {
    const connection = this.requireConnection(input.connection)
    const response = recordValue(await connection.client.json('/api/model', {
      query: { 'location[directory]': input.projectPath },
    }))
    const data = response?.data
    if (!Array.isArray(data)) throw adapterError('protocol', 'OpenCode /api/model returned invalid data')
    return {
      models: data.flatMap((value) => {
        const model = recordValue(value)
        const id = stringValue(model?.id)
        const providerId = stringValue(model?.providerID)
        const name = stringValue(model?.name)
        if (!model || !id || !providerId || !name || model.enabled === false) return []
        const variants = Array.isArray(model.variants)
          ? model.variants.flatMap((entry) => {
              const variant = recordValue(entry)
              const variantId = stringValue(variant?.id)
              return variantId ? [{ id: variantId, displayName: variantId }] : []
            })
          : []
        return [{
          id: `${providerId}/${id}`,
          displayName: name,
          reasoningEfforts: variants,
        }]
      }),
    }
  }

  async setModel(sessionId: SessionId, model: ModelSelection): Promise<void> {
    const session = this.getSession(sessionId)
    await session.connection.client.void(
      `/api/session/${encodeURIComponent(session.runtimeSessionId)}/model`,
      { method: 'POST', body: { model: toModelRef(model) } },
    )
    session.model = { ...model }
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    const session = this.getSession(sessionId)
    session.disposed = true
    this.stopStatusPoll(session)
    session.eventPump.abort.abort()
    this.cancelInteractions(session, 'aborted', session.activeTurnId)
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'closed' },
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
    }, true)
    session.events.close()
    this.sessions.delete(sessionId)
    this.sessionsByNativeId.delete(session.runtimeSessionId)
    await Promise.allSettled([session.eventPump.done])
  }

  events(sessionId: SessionId): AsyncIterable<OpenCodeAdapterEvent> {
    return this.getSession(sessionId).events
  }

  getCapabilities(): Promise<RuntimeCapabilities> {
    return Promise.resolve(cloneCapabilities(OPENCODE_CAPABILITIES))
  }

  async dispose(): Promise<void> {
    const sessionIds = [...this.sessions.keys()]
    await Promise.allSettled(sessionIds.map((sessionId) => this.disposeSession(sessionId)))
    const states = [...this.connections.values()]
    this.connections.clear()
    for (const state of states) {
      state.globalPump?.abort.abort()
      if (state.process.exitCode === null && state.process.signalCode === null) {
        state.process.kill('SIGTERM')
      }
    }
    await Promise.allSettled(states.flatMap((state) => state.globalPump ? [state.globalPump.done] : []))
  }

  private openSession(
    id: SessionId,
    runtimeSessionId: string,
    projectPath: string,
    connection: ConnectionState,
    after: number | undefined,
    model: ModelSelection | undefined,
  ): SessionState {
    if (this.sessions.has(id)) throw adapterError('protocol', `Duplicate Gateway session: ${id}`)
    if (this.sessionsByNativeId.has(runtimeSessionId)) {
      throw adapterError('protocol', `OpenCode session is already open: ${runtimeSessionId}`)
    }
    const placeholder = { abort: new AbortController(), done: Promise.resolve() }
    const session: SessionState = {
      id,
      runtimeSessionId,
      projectPath,
      connection,
      events: new AsyncQueue(),
      eventPump: placeholder,
      seenEventIds: new Set(),
      interactions: new Map(),
      tools: new Map(),
      startedTextIds: new Set(),
      startedReasoningIds: new Set(),
      pendingTextDeltas: new Map(),
      pendingReasoningDeltas: new Map(),
      pendingToolInputDeltas: new Map(),
      turnObservedActivity: false,
      ...(model ? { model: { ...model } } : {}),
      disposed: false,
    }
    this.sessions.set(id, session)
    this.sessionsByNativeId.set(runtimeSessionId, session)
    session.eventPump = startEventPump(
      connection.client,
      `/api/session/${encodeURIComponent(runtimeSessionId)}/event`,
      { after },
      (event) => this.handleDurableEvent(session, event),
      (error) => this.failSession(session, error),
    )
    return session
  }

  /**
   * Official SDK/CLI bus: GET /global/event → `{ directory?, payload: { id, type, properties } }`.
   * Do not use GET /api/event for status/todo — ServerDefinitions omit SessionStatusEvent.
   */
  private startGlobalPump(connection: ConnectionState): void {
    connection.globalPump?.abort.abort()
    connection.globalPump = startEventPump(
      connection.client,
      '/global/event',
      {},
      (event) => this.handleGlobalEvent(connection, event),
      (error) => this.onGlobalPumpFailure(connection, error),
    )
  }

  private onGlobalPumpFailure(connection: ConnectionState, error: unknown): void {
    if (!this.connections.has(connection.connection.id)) return
    if (connection.process.exitCode !== null || connection.process.signalCode !== null) {
      this.failConnection(connection, error)
      return
    }
    for (const session of this.sessions.values()) {
      if (session.connection !== connection || session.disposed) continue
      this.publish(session, {
        type: 'runtime.warning',
        payload: {
          error: {
            ...toRuntimeError(error, 'connection'),
            layer: 'transport',
            retriable: true,
          },
        },
      })
    }
    setTimeout(() => {
      if (!this.connections.has(connection.connection.id)) return
      this.startGlobalPump(connection)
    }, SESSION_STATUS_POLL_MS)
  }

  private handleGlobalEvent(connection: ConnectionState, event: OpenCodeEvent): void {
    if (event.durable) return
    const nativeSessionId =
      stringValue(event.data.sessionID) ??
      stringValue(recordValue(event.data.info)?.sessionID)
    if (!nativeSessionId) return
    const session = this.sessionsByNativeId.get(nativeSessionId)
    if (!session || session.connection !== connection || session.disposed) return

    const closedId = interactionClosedNativeId(event)
    if (closedId) {
      const entry = [...session.interactions.values()].find((item) => item.nativeId === closedId)
      if (!entry) return
      session.interactions.delete(entry.gatewayId)
      this.publish(session, {
        type: 'interaction.canceled',
        payload: { id: entry.gatewayId, reason: 'superseded' },
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
        nativeRef: { eventId: event.id, eventType: event.type },
      })
      return
    }
    if (
      event.type === 'permission.v2.asked' ||
      event.type === 'permission.asked' ||
      event.type === 'question.v2.asked' ||
      event.type === 'question.asked'
    ) {
      if (!this.markSeen(session, event)) return
      this.markTurnLiveFromBus(session, event)
      const mapped = mapInteractionAsked(event, session.id, session.activeTurnId)
      if (!mapped) return
      session.interactions.set(mapped.pending.gatewayId, mapped.pending)
      this.publish(session, mapped.event)
      this.publish(session, {
        type: 'session.status_changed',
        payload: { status: 'waiting' },
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      })
      return
    }
    if (event.type === 'todo.updated') {
      if (!this.markSeen(session, event)) return
      this.publishMapped(session, mapOpenCodeEvent(event, this.mapperState(session)))
      return
    }
    if (event.type === 'session.status' || event.type === 'session.idle') {
      if (!this.markSeen(session, event)) return
      const status = recordValue(event.data.status)
      const type = stringValue(status?.type)
      if (type === 'busy' || type === 'retry') {
        session.turnObservedActivity = true
        return
      }
      const idle = event.type === 'session.idle' || type === 'idle'
      // CLI: on idle event → complete(wait, fallback=true) after re-checking GET /session/status
      if (idle) void this.completeTurnIfIdle(session, true)
      return
    }
    if (event.type === 'message.updated') {
      // CLI active(): assistant message.updated latches Wait.live
      this.markTurnLiveFromBus(session, event)
      // Diffs land on the user message after summarize (processor → parentID).
      const info = recordValue(event.data.info)
      if (stringValue(info?.role) === 'user') {
        const userId = stringValue(info?.id)
        if (userId) session.lastUserMessageId = userId
        const summary = recordValue(info?.summary)
        if (Array.isArray(summary?.diffs) && summary.diffs.length > 0) {
          this.publishDiffChangeSet(session, summary.diffs, {
            changeSetId: `opencode:user:${userId ?? event.id}`,
            messageId: userId,
          })
        }
      }
      return
    }
    if (event.type === 'session.diff') {
      if (!this.markSeen(session, event)) return
      // summarize() first publishes an empty clear; ignore empties.
      if (!Array.isArray(event.data.diff) || event.data.diff.length === 0) return
      this.publishDiffChangeSet(session, event.data.diff, {
        changeSetId: `opencode:diff:${event.id}`,
        messageId: stringValue(event.data.messageID) ?? session.lastUserMessageId,
      })
      return
    }
    // Live-only session.next.*.delta may arrive on the global bus before durable
    // boundaries. Only forward deltas for entities already opened on the session stream
    // so timeline sequence stays durable-ordered (tools before late text rows).
    if (event.type.endsWith('.delta') && event.type.startsWith('session.next.')) {
      if (!this.markSeen(session, event)) return
      this.publishMapped(session, mapOpenCodeEvent(event, this.mapperState(session)))
    }
  }

  private handleDurableEvent(session: SessionState, event: OpenCodeEvent): void {
    if (!event.durable || event.durable.aggregateID !== session.runtimeSessionId) return
    if (!this.markSeen(session, event)) return
    // Durable deltas alone must not latch Wait.live (CLI: message.part.delta ignored).
    // Non-delta session.next.* (tool called/success, message complete, etc.) do.
    if (!event.type.endsWith('.delta')) this.markTurnLiveFromBus(session, event)
    if (
      event.type === 'session.next.prompt.admitted' ||
      event.type === 'session.next.prompted'
    ) {
      const userId = stringValue(event.data.messageID) ?? stringValue(event.data.id)
      if (userId) session.lastUserMessageId = userId
    }
    this.publishMapped(session, mapOpenCodeEvent(event, this.mapperState(session)))
    if (this.shouldRefreshTodos(session, event)) void this.hydrateTodos(session)
    // processor.ts calls summarize({ messageID: assistant.parentID }) after step-finish.
    // Diffs are not on step.ended.files — fetch via user messageID.
    if (event.type === 'session.next.step.ended') {
      void this.hydrateUserMessageDiff(session, event.id)
    }
  }

  private shouldRefreshTodos(session: SessionState, event: OpenCodeEvent): boolean {
    if (event.type === 'session.next.tool.called') {
      return isTodoToolName(stringValue(event.data.tool))
    }
    if (event.type !== 'session.next.tool.success') return false
    const callId = stringValue(event.data.callID)
    const tool = callId ? session.tools.get(callId) : undefined
    return isTodoToolName(tool?.name ?? stringValue(event.data.tool))
  }

  /**
   * CLI `Wait.live` / `active()` — latch only on events that prove the agent ran.
   * @see reference/opencode/.../cli/cmd/run/stream.transport.ts
   */
  private markTurnLiveFromBus(session: SessionState, event: OpenCodeEvent): void {
    if (!session.activeTurnId) return
    if (
      event.type === 'session.next.prompt.admitted' ||
      event.type === 'session.next.prompted' ||
      event.type === 'session.next.context.updated' ||
      event.type === 'session.next.synthetic' ||
      event.type === 'todo.updated' ||
      event.type.endsWith('.delta')
    ) {
      return
    }
    if (event.type === 'session.status' || event.type === 'session.idle') {
      const status = recordValue(event.data.status)
      const type = stringValue(status?.type)
      if (type === 'busy' || type === 'retry') session.turnObservedActivity = true
      return
    }
    if (event.type === 'message.updated') {
      const info = recordValue(event.data.info)
      if (stringValue(info?.role) === 'assistant') session.turnObservedActivity = true
      return
    }
    if (
      event.type === 'permission.asked' ||
      event.type === 'permission.v2.asked' ||
      event.type === 'question.asked' ||
      event.type === 'question.v2.asked' ||
      event.type.startsWith('session.next.') ||
      event.type === 'session.error' ||
      event.type === 'session.compacted'
    ) {
      session.turnObservedActivity = true
    }
  }

  private mapperState(session: SessionState): MapperState {
    return {
      activeTurnId: session.activeTurnId ?? session.lastTurnId,
      tools: session.tools,
      startedTextIds: session.startedTextIds,
      startedReasoningIds: session.startedReasoningIds,
      pendingTextDeltas: session.pendingTextDeltas,
      pendingReasoningDeltas: session.pendingReasoningDeltas,
      pendingToolInputDeltas: session.pendingToolInputDeltas,
    }
  }

  /**
   * OpenCode `SessionSummary.diff`: requires user `messageID`, returns
   * `userMessage.summary.diffs` (SnapshotFileDiff[] with `file`/`patch`).
   * summarize() is forked after step-finish, so retry briefly while empty.
   */
  private async hydrateUserMessageDiff(
    session: SessionState,
    reasonId: string,
  ): Promise<void> {
    const messageId = session.lastUserMessageId
    if (!messageId) return
    for (let attempt = 0; attempt < DIFF_HYDRATE_ATTEMPTS; attempt++) {
      if (session.disposed) return
      if (attempt > 0) await delay(DIFF_HYDRATE_GAP_MS, new AbortController().signal)
      try {
        const response = await session.connection.client.json(
          `/session/${encodeURIComponent(session.runtimeSessionId)}/diff`,
          {
            query: {
              directory: session.projectPath,
              messageID: messageId,
            },
          },
        )
        const root = recordValue(response)
        const diffs = Array.isArray(response) ? response : root?.data ?? root?.diff
        if (!Array.isArray(diffs) || diffs.length === 0) continue
        this.publishDiffChangeSet(session, diffs, {
          changeSetId: `opencode:user:${messageId}`,
          messageId,
        })
        return
      } catch (error) {
        if (attempt + 1 >= DIFF_HYDRATE_ATTEMPTS) {
          this.publish(session, {
            type: 'runtime.warning',
            payload: {
              error: {
                ...toRuntimeError(error, 'protocol'),
                layer: 'resource',
                details: { reasonId, messageId },
              },
            },
          })
        }
      }
    }
  }

  private publishDiffChangeSet(
    session: SessionState,
    diffs: unknown,
    options: { changeSetId: string; messageId?: string },
  ): void {
    const files = Array.isArray(diffs) ? diffs : []
    if (files.length === 0) return
    const turnId = session.activeTurnId ?? session.lastTurnId

    // Attach matching slices to file-edit tool rows (Codex / Desktop FileToolCallBlock).
    for (const tool of session.tools.values()) {
      if (tool.kind !== 'file-edit' && tool.kind !== 'file-diff') continue
      const matched = files.filter((value) => {
        const entry = recordValue(value)
        const raw = stringValue(entry?.file) ?? stringValue(entry?.path)
        return raw
          ? findToolCallIdForPath(
              new Map([[tool.id, tool]]),
              session.projectPath,
              raw,
            ) === tool.id
          : false
      })
      if (matched.length === 0) continue
      const toolChangeSet = changeSetFromOpenCodeDiffs(session.projectPath, matched, {
        changeSetId: `${options.changeSetId}:tool:${tool.id}`,
        scope: 'tool',
        toolCallId: tool.id,
        status: 'completed',
      })
      if (!toolChangeSet) continue
      this.publish(session, {
        type: 'changes.updated',
        payload: { changeSet: toolChangeSet },
        ...(turnId ? { turnId } : {}),
        nativeRef: { eventId: options.changeSetId, eventType: 'session.diff' },
      })
    }

    // Full user-message summary diffs (OpenCode app summary-diffs timeline).
    const changeSet = changeSetFromOpenCodeDiffs(session.projectPath, files, {
      changeSetId: options.changeSetId,
      scope: 'turn',
      status: 'completed',
    })
    if (!changeSet) return
    this.publish(session, {
      type: 'changes.updated',
      payload: { changeSet },
      ...(turnId ? { turnId } : {}),
      nativeRef: { eventId: options.changeSetId, eventType: 'session.diff' },
    })
  }

  /**
   * `todo.updated` is live-only (not in the durable session log), so resume/create
   * must hydrate via GET `/session/:id/todo` — same source OpenCode's own UI uses.
   */
  private async hydrateTodos(session: SessionState): Promise<void> {
    try {
      const response = await session.connection.client.json(
        `/session/${encodeURIComponent(session.runtimeSessionId)}/todo`,
        { query: { directory: session.projectPath } },
      )
      const root = recordValue(response)
      const todos = Array.isArray(response) ? response : root?.data
      const tasks = tasksFromOpenCodeTodos(todos)
      if (tasks.length === 0) return
      this.publish(session, {
        type: 'task.updated',
        payload: { update: { kind: 'replace', tasks } },
        ...(session.activeTurnId ?? session.lastTurnId
          ? { turnId: session.activeTurnId ?? session.lastTurnId }
          : {}),
      })
    } catch (error) {
      this.publish(session, {
        type: 'runtime.warning',
        payload: { error: { ...toRuntimeError(error, 'protocol'), layer: 'resource' } },
      })
    }
  }

  private publishMapped(session: SessionState, events: OpenCodeAdapterEvent[]): void {
    for (const event of events) {
      this.publish(session, event)
      if (event.type === 'turn.failed') {
        this.stopStatusPoll(session)
        const turnId = session.activeTurnId
        session.activeTurnId = undefined
        session.turnObservedActivity = false
        this.cancelInteractions(session, 'aborted', turnId)
        this.publish(session, {
          type: 'session.status_changed',
          payload: { status: 'error' },
          ...(turnId ? { turnId } : {}),
        })
      }
    }
  }

  /**
   * Official settle path mirrors OpenCode CLI `Wait`:
   * complete only when armed (`activeTurnId`) && live (`turnObservedActivity`) && idle
   * (SSE `session.status`/`session.idle` or GET `/session/status`).
   * Never use GET `/api/event` for this — SessionStatusEvent is omitted from that schema.
   */
  private settleActiveTurn(
    session: SessionState,
    status: 'completed' | 'interrupted',
  ): void {
    const turnId = session.activeTurnId
    if (!turnId || session.disposed) return
    this.stopStatusPoll(session)
    session.activeTurnId = undefined
    session.turnObservedActivity = false
    this.publish(session, {
      type: 'turn.completed',
      payload: { turnId, status },
      turnId,
    })
    this.publish(session, {
      type: 'session.status_changed',
      payload: { status: 'idle' },
      turnId,
    })
  }

  private startStatusPoll(session: SessionState): void {
    this.stopStatusPoll(session)
    session.turnObservedActivity = false
    const abort = new AbortController()
    session.statusPollAbort = abort
    void this.pollSessionStatus(session, abort.signal)
  }

  private stopStatusPoll(session: SessionState): void {
    session.statusPollAbort?.abort()
    session.statusPollAbort = undefined
  }

  /**
   * CLI `complete(wait, fallback)`: always probe GET /session/status so busy can
   * latch Wait.live, then settle only when armed && live && idle.
   */
  private async completeTurnIfIdle(session: SessionState, fallback: boolean): Promise<void> {
    if (!session.activeTurnId || session.disposed) return
    try {
      const response = await session.connection.client.json('/session/status', {
        query: { directory: session.projectPath },
      })
      // isSessionIdle latches live on busy/retry; do not settle until live.
      if (!this.isSessionIdle(session, response) || !session.turnObservedActivity) return
    } catch {
      if (!fallback || !session.turnObservedActivity) return
    }
    if (!session.activeTurnId || !session.turnObservedActivity || session.disposed) return
    this.settleActiveTurn(session, 'completed')
  }

  private async pollSessionStatus(session: SessionState, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !session.disposed && session.activeTurnId) {
      await delay(SESSION_STATUS_POLL_MS, signal)
      if (signal.aborted || session.disposed || !session.activeTurnId) return
      // CLI poll path: complete(wait, false) — API failure does not force idle
      await this.completeTurnIfIdle(session, false)
    }
  }

  /**
   * OpenCode drops idle sessions from the status map (`!entry` means idle).
   * Busy/retry also latches Wait.live. Combined with markTurnLiveFromBus, this
   * matches OpenCode CLI: complete only when Wait.live && status idle.
   */
  private isSessionIdle(session: SessionState, response: unknown): boolean {
    const root = recordValue(response)
    if (!root) return false
    const statuses = recordValue(root.data) ?? root
    const entry = recordValue(statuses[session.runtimeSessionId])
    const type = stringValue(entry?.type)
    if (type === 'busy' || type === 'retry') {
      session.turnObservedActivity = true
      return false
    }
    return !entry || type === 'idle'
  }

  private cancelInteractions(
    session: SessionState,
    reason: 'aborted' | 'superseded',
    turnId: TurnId | undefined,
  ): void {
    for (const pending of session.interactions.values()) {
      this.publish(session, {
        type: 'interaction.canceled',
        payload: { id: pending.gatewayId, reason },
        ...(turnId ? { turnId } : {}),
      }, true)
    }
    session.interactions.clear()
  }

  private markSeen(session: SessionState, event: OpenCodeEvent): boolean {
    if (session.seenEventIds.has(event.id)) return false
    session.seenEventIds.add(event.id)
    return true
  }

  private failConnection(connection: ConnectionState, error: unknown): void {
    for (const session of this.sessions.values()) {
      if (session.connection === connection) this.failSession(session, error)
    }
  }

  private failSession(session: SessionState, error: unknown): void {
    if (session.disposed) return
    this.stopStatusPoll(session)
    this.publish(session, {
      type: 'runtime.error',
      payload: {
        error: { ...toRuntimeError(error, 'connection'), layer: 'transport' },
      },
    })
    session.events.fail(error)
  }

  private publish(session: SessionState, event: AdapterEvent, force = false): void {
    if (!session.disposed || force) session.events.push(event)
  }

  private requireConnection(connection: RuntimeConnection): ConnectionState {
    const state = this.connections.get(connection.id)
    if (!state || connection.transport !== 'http-sse') {
      throw adapterError('connection', `Unknown OpenCode connection: ${connection.id}`)
    }
    return state
  }

  private getSession(sessionId: SessionId): SessionState {
    const session = this.sessions.get(sessionId)
    if (!session || session.disposed) {
      throw adapterError('connection', `Unknown OpenCode session: ${sessionId}`)
    }
    return session
  }
}

function assertNoSessionContext(context: CreateSessionInput['context'] | ResumeSessionInput['context']): void {
  if (context) {
    throw adapterError(
      'not_implemented',
      'OpenCode 1.18.10 PromptInput has no typed SessionContext injection field',
    )
  }
}

function isTodoToolName(name: string | undefined): boolean {
  if (!name) return false
  const normalized = name.toLowerCase()
  return normalized === 'todowrite' || normalized === 'todo_write' || normalized === 'todo'
}

function resolveExecution(settings?: SessionExecutionSettings): ExecutionConfigurationResult {
  const configured = cloneSessionExecutionSettings(settings ?? createDefaultSessionExecutionSettings())
  const effective = createDefaultSessionExecutionSettings()
  return {
    effective,
    limitations:
      JSON.stringify(configured) === JSON.stringify(effective)
        ? []
        : [{
            capability: 'execution.configure',
            reason: 'OpenCode v2 has no per-session permission policy update route',
          }],
  }
}

function requireResponseRecord(response: unknown, label: string): Record<string, unknown> {
  const data = recordValue(unwrapData(response, label))
  if (!data) throw adapterError('protocol', `${label} returned invalid data`)
  return data
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
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  )
  return address.port
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function waitForServer(
  processHandle: ChildProcessWithoutNullStreams,
  expectedPort: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(
      () => finish(new Error('Timed out waiting for OpenCode server')),
      15_000,
    )
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      const match = output.match(/opencode server listening on (http:\/\/[^\s]+)/)
      if (match?.[1]) finish(undefined, match[1])
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        new Error(
          `OpenCode server exited before ready (${code ?? signal ?? 'unknown'}): ${output}`,
        ),
      )
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

function cloneCapabilities(value: RuntimeCapabilities): RuntimeCapabilities {
  return structuredClone(value)
}

function adapterError(
  code: ConstructorParameters<typeof AdapterError>[0]['code'],
  message: string,
): AdapterError {
  return new AdapterError({ code, layer: 'transport', message })
}
