import { randomUUID } from 'node:crypto'
import {
  asSessionId,
  asTurnId,
  cloneSessionExecutionSettings,
  cloneSessionExecutionState,
  cloneTaskState,
  createDefaultSessionExecutionSettings,
  createEmptyTaskState,
  applyTaskStateUpdate,
  AdapterError,
  toRuntimeError,
  type AdapterEvent,
  type AgentSession,
  type InputAdmissionReceipt,
  type InputDelivery,
  type InputQueueEntry,
  type InteractionId,
  type InteractionRequest,
  type InteractionResolution,
  type InterruptOptions,
  type ModelSelection,
  type RuntimeAdapter,
  type RuntimeConnection,
  type RuntimeEvent,
  type SessionId,
  type SessionExecutionSettings,
  type TurnId,
  type TaskState,
  type SubagentRun,
  type UserInput,
} from '@agent-gateway/core'
import { AdapterRegistry } from './adapter-registry.js'
import { RuntimeConnectionManager } from './connection-manager.js'
import { RuntimeSessionEventStream } from './session-event-stream.js'
import type {
  CreateRuntimeSessionInput,
  ForkRuntimeSessionInput,
  ResumeRuntimeSessionInput,
  RuntimeAdapterAvailability,
  RuntimeControlOptions,
  RuntimeControlReceipt,
  RuntimeEventSink,
  RuntimeSessionSnapshot,
} from './types.js'

interface ManagedSession {
  session: AgentSession
  adapter: RuntimeAdapter
  connection: RuntimeConnection
  projectPath: string
  events: RuntimeSessionEventStream
  pump: Promise<void>
  disposing: boolean
  pendingInteractions: Map<InteractionId, InteractionRequest>
  admittedInputs: Map<string, InputAdmissionReceipt>
  inputQueue: InputQueueEntry[]
  subagentRuns: Map<SubagentRun['id'], SubagentRun>
  activeTurnId?: TurnId
  inputDrainScheduled: boolean
  inputDispatching: boolean
  commandTail: Promise<void>
  taskState: TaskState
}

/** Owns Gateway session identity, immutable adapter binding, and provider event consumption. */
export class RuntimeSessionManager {
  private readonly connections: RuntimeConnectionManager
  private readonly sessions = new Map<SessionId, ManagedSession>()
  private nextEventId = 1

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly eventSink?: RuntimeEventSink,
  ) {
    this.connections = new RuntimeConnectionManager(registry)
  }

  inspectAdapters(input: CreateRuntimeSessionInput['host']): Promise<RuntimeAdapterAvailability[]> {
    return this.registry.inspect(input)
  }

  async createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSessionSnapshot> {
    const adapter = this.registry.get(input.adapterId)
    const connection = await this.connections.connect(input.adapterId, input.host, input.installationPath)
    const sessionId = asSessionId(randomUUID())
    const now = Date.now()
    const configuredExecution = cloneSessionExecutionSettings(
      input.execution ?? createDefaultSessionExecutionSettings(),
    )
    const session: AgentSession = {
      id: sessionId,
      projectId: input.projectId,
      hostId: input.host.hostId,
      adapterId: input.adapterId,
      providerProfileId: input.providerProfileId,
      ...(input.model ? { model: { ...input.model } } : {}),
      execution: {
        configured: cloneSessionExecutionSettings(configuredExecution),
        effective: cloneSessionExecutionSettings(configuredExecution),
        limitations: [],
      },
      controlRevision: 0,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      lastEventSequence: 0,
    }
    const events = new RuntimeSessionEventStream(sessionId, input.adapterId, () => this.nextEventId++)
    const managed: ManagedSession = {
      session,
      adapter,
      connection,
      projectPath: input.projectPath,
      events,
      pump: Promise.resolve(),
      disposing: false,
      pendingInteractions: new Map(),
      admittedInputs: new Map(),
      inputQueue: [],
      subagentRuns: new Map(),
      inputDrainScheduled: false,
      inputDispatching: false,
      commandTail: Promise.resolve(),
      taskState: createEmptyTaskState(),
    }
    this.sessions.set(sessionId, managed)

    try {
      const handle = await adapter.createSession({
        sessionId,
        projectPath: input.projectPath,
        connection,
        providerProfileId: input.providerProfileId,
        model: input.model,
        execution: configuredExecution,
      })
      if (handle.sessionId !== sessionId) {
        throw new Error(`Adapter returned Gateway session ${handle.sessionId}, expected ${sessionId}`)
      }
      managed.session = {
        ...managed.session,
        runtimeSessionId: handle.runtimeSessionId,
        ...(handle.execution
          ? {
              execution: {
                configured: cloneSessionExecutionSettings(configuredExecution),
                effective: cloneSessionExecutionSettings(handle.execution.effective),
                limitations: handle.execution.limitations.map((limitation) => ({ ...limitation })),
              },
            }
          : {}),
        updatedAt: Date.now(),
      }
      managed.pump = this.pumpEvents(managed)
      return snapshot(managed)
    } catch (error) {
      managed.disposing = true
      events.fail(error)
      this.sessions.delete(sessionId)
      await adapter.disposeSession(sessionId).catch(() => undefined)
      this.eventSink?.discardSession(sessionId)
      throw error
    }
  }

  async resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSessionSnapshot> {
    const existing = this.sessions.get(input.sessionId)
    if (existing) {
      if (existing.session.status === 'closed') {
        this.sessions.delete(input.sessionId)
      } else if (existing.session.status === 'error' || existing.session.status === 'interrupted') {
        await this.disposeManagedSession(existing).catch(() => undefined)
        this.sessions.delete(input.sessionId)
      } else {
        throw new Error(`Runtime session is already active: ${input.sessionId}`)
      }
    }
    const adapter = this.registry.get(input.adapterId)
    if (!adapter.descriptor.capabilities.features['session.resume']) {
      throw unsupported('session resume')
    }
    const connection = await this.connections.connect(
      input.adapterId,
      input.host,
      input.installationPath,
    )
    const configured = cloneSessionExecutionSettings(
      input.execution ?? createDefaultSessionExecutionSettings(),
    )
    const now = Date.now()
    if (input.previousSession.id !== input.sessionId) {
      throw new Error(`Resume snapshot id ${input.previousSession.id} does not match ${input.sessionId}`)
    }
    if (
      input.previousSession.projectId !== input.projectId ||
      input.previousSession.hostId !== input.host.hostId ||
      input.previousSession.adapterId !== input.adapterId
    ) {
      throw new Error(`Resume target does not match the stored Runtime session ${input.sessionId}`)
    }
    const managed: ManagedSession = {
      session: {
        ...input.previousSession,
        runtimeSessionId: input.runtimeSessionId,
        ...(input.model ? { model: { ...input.model } } : {}),
        execution: {
          configured: cloneSessionExecutionSettings(configured),
          effective: cloneSessionExecutionSettings(input.previousSession.execution.effective),
          limitations: input.previousSession.execution.limitations.map((limitation) => ({
            ...limitation,
          })),
        },
        status: 'starting',
        ...(input.providerStateSnapshot
          ? { providerStateSnapshot: input.providerStateSnapshot }
          : {}),
        updatedAt: now,
      },
      adapter,
      connection,
      projectPath: input.projectPath,
      events: new RuntimeSessionEventStream(
        input.sessionId,
        input.adapterId,
        () => this.nextEventId++,
        input.previousSession.lastEventSequence,
      ),
      pump: Promise.resolve(),
      disposing: false,
      pendingInteractions: new Map(),
      admittedInputs: new Map(
        input.inputAdmissions.map(({ clientMessageId, receipt }) => [
          clientMessageId,
          { ...receipt },
        ]),
      ),
      inputQueue: input.inputQueue.map(cloneInputQueueEntry),
      subagentRuns: new Map(input.subagentRuns.map((run) => [run.id, cloneSubagentRun(run)])),
      inputDrainScheduled: false,
      inputDispatching: false,
      commandTail: Promise.resolve(),
      taskState: cloneTaskState(input.taskState),
    }
    this.sessions.set(input.sessionId, managed)
    try {
      const handle = await adapter.resumeSession({
        sessionId: input.sessionId,
        projectPath: input.projectPath,
        runtimeSessionId: input.runtimeSessionId,
        connection,
        cursor: input.cursor,
        providerStateSnapshot: input.providerStateSnapshot,
        execution: configured,
      })
      managed.session = {
        ...managed.session,
        runtimeSessionId: handle.runtimeSessionId ?? input.runtimeSessionId,
        ...(handle.execution
          ? {
              execution: {
                configured: cloneSessionExecutionSettings(configured),
                effective: cloneSessionExecutionSettings(handle.execution.effective),
                limitations: handle.execution.limitations.map((limitation) => ({ ...limitation })),
              },
            }
          : {}),
        updatedAt: Date.now(),
      }
      managed.pump = this.pumpEvents(managed)
      return snapshot(managed)
    } catch (error) {
      managed.disposing = true
      managed.events.fail(error)
      this.sessions.delete(input.sessionId)
      await adapter.disposeSession(input.sessionId).catch(() => undefined)
      throw error
    }
  }

  async forkSession(input: ForkRuntimeSessionInput): Promise<RuntimeSessionSnapshot> {
    const source = this.requireSession(input.sourceSessionId)
    if (!source.adapter.forkSession || !source.connection.capabilities.features['session.fork']) {
      throw unsupported('session fork')
    }
    if (!source.session.runtimeSessionId) throw new Error('Source session has no provider session id')
    const sessionId = asSessionId(randomUUID())
    const configured = cloneSessionExecutionSettings(
      input.execution ?? source.session.execution.configured,
    )
    const now = Date.now()
    const managed: ManagedSession = {
      session: {
        id: sessionId,
        projectId: source.session.projectId,
        hostId: source.session.hostId,
        adapterId: source.session.adapterId,
        providerProfileId: source.session.providerProfileId,
        ...(source.session.model ? { model: { ...source.session.model } } : {}),
        execution: {
          configured: cloneSessionExecutionSettings(configured),
          effective: cloneSessionExecutionSettings(configured),
          limitations: [],
        },
        controlRevision: 0,
        status: 'starting',
        forkedFromSessionId: source.session.id,
        ...(input.forkPoint ? { forkPoint: input.forkPoint } : {}),
        createdAt: now,
        updatedAt: now,
        lastEventSequence: 0,
      },
      adapter: source.adapter,
      connection: source.connection,
      projectPath: source.projectPath,
      events: new RuntimeSessionEventStream(sessionId, source.session.adapterId, () => this.nextEventId++),
      pump: Promise.resolve(),
      disposing: false,
      pendingInteractions: new Map(),
      admittedInputs: new Map(),
      inputQueue: [],
      subagentRuns: new Map(),
      inputDrainScheduled: false,
      inputDispatching: false,
      commandTail: Promise.resolve(),
      taskState: cloneTaskState(source.taskState),
    }
    this.sessions.set(sessionId, managed)
    try {
      const handle = await source.adapter.forkSession({
        sessionId,
        projectPath: source.projectPath,
        runtimeSessionId: source.session.runtimeSessionId,
        connection: source.connection,
        forkPoint: input.forkPoint,
        execution: configured,
      })
      managed.session = {
        ...managed.session,
        runtimeSessionId: handle.runtimeSessionId,
        ...(handle.execution
          ? {
              execution: {
                configured: cloneSessionExecutionSettings(configured),
                effective: cloneSessionExecutionSettings(handle.execution.effective),
                limitations: handle.execution.limitations.map((limitation) => ({ ...limitation })),
              },
            }
          : {}),
        updatedAt: Date.now(),
      }
      managed.pump = this.pumpEvents(managed)
      return snapshot(managed)
    } catch (error) {
      managed.disposing = true
      managed.events.fail(error)
      this.sessions.delete(sessionId)
      await source.adapter.disposeSession(sessionId).catch(() => undefined)
      throw error
    }
  }

  getSession(sessionId: SessionId): RuntimeSessionSnapshot {
    return snapshot(this.requireSession(sessionId))
  }

  listSessions(projectId?: string): RuntimeSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((managed) => projectId === undefined || managed.session.projectId === projectId)
      .map(snapshot)
  }

  events(sessionId: SessionId, afterSequence = 0): AsyncIterable<RuntimeEvent> {
    return this.requireSession(sessionId).events.subscribe(afterSequence)
  }

  eventSnapshot(sessionId: SessionId, afterSequence = 0): RuntimeEvent[] {
    return this.requireSession(sessionId).events.snapshot(afterSequence)
  }

  setSessionTitle(sessionId: SessionId, title: string): RuntimeEvent {
    const managed = this.requireSession(sessionId)
    return this.append(managed, {
      type: 'session.title_changed',
      payload: { title, source: 'user' },
    })
  }

  async renameSession(
    sessionId: SessionId,
    title: string,
    options: RuntimeControlOptions = {},
  ): Promise<RuntimeControlReceipt> {
    return this.enqueueControl(sessionId, options, async (managed) => {
      this.bumpControlRevision(managed)
      this.append(managed, {
        type: 'session.title_changed',
        payload: { title, source: 'user' },
      })
      return { controlRevision: managed.session.controlRevision }
    })
  }

  async setModel(
    sessionId: SessionId,
    model: ModelSelection,
    options: RuntimeControlOptions = {},
  ): Promise<RuntimeControlReceipt> {
    return this.enqueueControl(sessionId, options, async (managed) => {
      if (!managed.adapter.setModel || managed.connection.capabilities.modelSwitch === 'unsupported') {
        throw unsupported('model switching')
      }
      await managed.adapter.setModel(sessionId, model)
      this.bumpControlRevision(managed)
      this.append(managed, { type: 'session.model_changed', payload: { model: { ...model } } })
      return { controlRevision: managed.session.controlRevision }
    })
  }

  async setWorkMode(
    sessionId: SessionId,
    workMode: SessionExecutionSettings['workMode'],
    options: RuntimeControlOptions = {},
  ): Promise<RuntimeControlReceipt> {
    return this.enqueueControl(sessionId, options, async (managed) => {
      const configured = cloneSessionExecutionSettings(managed.session.execution.configured)
      configured.workMode = workMode
      return this.configureExecution(managed, configured)
    })
  }

  async setExecutionSettings(
    sessionId: SessionId,
    settings: SessionExecutionSettings,
    options: RuntimeControlOptions = {},
  ): Promise<RuntimeControlReceipt> {
    return this.enqueueControl(sessionId, options, async (managed) => {
      const configured = cloneSessionExecutionSettings(settings)
      return this.configureExecution(managed, configured)
    })
  }

  async interrupt(
    sessionId: SessionId,
    interruptOptions?: InterruptOptions,
  ): Promise<void> {
    return this.enqueue(sessionId, async (managed) => {
      await managed.adapter.interrupt(sessionId, interruptOptions)
    })
  }

  async resolveInteraction(sessionId: SessionId, resolution: InteractionResolution): Promise<void> {
    return this.enqueue(sessionId, async (managed) => {
      if (!managed.pendingInteractions.has(resolution.id)) return
      await managed.adapter.resolveInteraction(sessionId, resolution)
    })
  }

  /** Durably admits user input before delivering it to the session's immutable adapter. */
  async send(
    sessionId: SessionId,
    input: UserInput,
  ): Promise<InputAdmissionReceipt> {
    return this.enqueue(sessionId, async (managed) => {
      if (managed.disposing || managed.session.status === 'closed') {
        throw new Error(`Cannot send to closed Runtime session: ${sessionId}`)
      }

      const duplicate = managed.admittedInputs.get(input.clientMessageId)
      if (duplicate) return { ...duplicate }
      const admittedSequence = managed.session.lastEventSequence + 1
      const admittedInput = cloneUserInput(input)
      const timestamp = Date.now()
      const entry: InputQueueEntry = {
        id: admittedInput.clientMessageId,
        input: admittedInput,
        requestedDelivery: admittedInput.delivery ?? 'queue',
        status: 'pending',
        admittedSequence,
        position: managed.inputQueue.length,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.append(managed, {
        type: 'input.admitted',
        payload: { entry: cloneInputQueueEntry(entry) },
      })
      managed.inputQueue.push(entry)
      this.publishInputQueue(managed)
      const receipt = { admittedSequence }
      managed.admittedInputs.set(input.clientMessageId, receipt)
      if (!admittedInput.admitOnly) this.scheduleInputDrain(managed)
      return receipt
    })
  }

  async replaceQueuedInput(sessionId: SessionId, input: UserInput): Promise<void> {
    return this.enqueue(sessionId, async (managed) => {
      const entry = this.requirePendingInput(managed, input.clientMessageId)
      entry.input = cloneUserInput(input)
      entry.requestedDelivery = input.delivery ?? entry.requestedDelivery
      entry.updatedAt = Date.now()
      this.publishInputQueue(managed)
      this.scheduleInputDrain(managed)
    })
  }

  async reorderQueuedInputs(sessionId: SessionId, orderedIds: string[]): Promise<void> {
    return this.enqueue(sessionId, async (managed) => {
      if (
        orderedIds.length !== managed.inputQueue.length ||
        new Set(orderedIds).size !== orderedIds.length ||
        orderedIds.some((id) => !managed.inputQueue.some((entry) => entry.id === id))
      ) {
        throw new Error('Queued input order must contain every pending input exactly once')
      }
      const byId = new Map(managed.inputQueue.map((entry) => [entry.id, entry]))
      managed.inputQueue = orderedIds.map((id, position) => {
        const entry = byId.get(id)
        if (!entry) throw new Error(`Unknown queued input: ${id}`)
        entry.position = position
        entry.updatedAt = Date.now()
        return entry
      })
      this.publishInputQueue(managed)
    })
  }

  async cancelQueuedInput(sessionId: SessionId, inputId: string): Promise<void> {
    return this.enqueue(sessionId, async (managed) => {
      const entry = this.requirePendingInput(managed, inputId)
      managed.inputQueue = managed.inputQueue.filter((candidate) => candidate.id !== inputId)
      const cancelled: InputQueueEntry = {
        ...cloneInputQueueEntry(entry),
        status: 'cancelled',
        updatedAt: Date.now(),
      }
      this.append(managed, { type: 'input.cancelled', payload: { entry: cancelled } })
      this.publishInputQueue(managed)
    })
  }

  async sendQueuedInputNow(sessionId: SessionId, inputId: string): Promise<void> {
    return this.enqueue(sessionId, async (managed) => {
      const entry = this.requirePendingInput(managed, inputId)
      entry.requestedDelivery = 'steer'
      entry.input = { ...entry.input, delivery: 'steer', admitOnly: false }
      entry.updatedAt = Date.now()
      this.publishInputQueue(managed)
      this.scheduleInputDrain(managed)
    })
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    const managed = this.requireSession(sessionId)
    await this.disposeManagedSession(managed)
  }

  async closeSession(
    sessionId: SessionId,
    options: RuntimeControlOptions = {},
  ): Promise<RuntimeControlReceipt> {
    return this.enqueueControl(sessionId, options, async (managed) => {
      this.bumpControlRevision(managed)
      await this.disposeManagedSession(managed)
      return { controlRevision: managed.session.controlRevision }
    })
  }

  private async disposeManagedSession(managed: ManagedSession): Promise<void> {
    const sessionId = managed.session.id
    if (managed.disposing || managed.session.status === 'closed') return
    managed.disposing = true
    try {
      await managed.adapter.disposeSession(sessionId)
      await managed.pump
      if (!sessionHasStatus(managed, 'closed')) {
        this.append(managed, {
          type: 'session.status_changed',
          payload: { status: 'closed' },
        })
      }
      managed.events.close()
    } catch (error) {
      managed.session = { ...managed.session, status: 'error', updatedAt: Date.now() }
      managed.events.fail(error)
      throw error
    }
  }

  /** Releases every live adapter session, attempting all of them even if one fails. */
  async disposeAllSessions(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)),
    )
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    const adapterResults = await Promise.allSettled(
      this.registry.list().map((adapter) => adapter.dispose?.() ?? Promise.resolve()),
    )
    const adapterFailures = adapterResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    const allFailures = [...failures, ...adapterFailures]
    if (allFailures.length > 0) {
      throw new AggregateError(
        allFailures,
        `Failed to dispose ${failures.length} Runtime session(s) and ${adapterFailures.length} adapter(s)`,
      )
    }
  }

  private async pumpEvents(managed: ManagedSession): Promise<void> {
    let sawRuntimeError = false
    try {
      for await (const event of managed.adapter.events(managed.session.id)) {
        sawRuntimeError = sawRuntimeError || event.type === 'runtime.error'
        this.append(managed, event)
      }
      if (!managed.disposing) throw new Error(`Adapter event stream ended: ${managed.session.id}`)
    } catch (error) {
      if (managed.disposing) return
      if (!sawRuntimeError) {
        this.append(managed, {
          type: 'runtime.error',
          payload: {
            error: { ...toRuntimeError(error, 'connection'), layer: 'transport' },
          },
        })
      }
      managed.session = { ...managed.session, status: 'error', updatedAt: Date.now() }
    }
  }

  private scheduleInputDrain(managed: ManagedSession): void {
    if (managed.inputDrainScheduled || managed.disposing) return
    managed.inputDrainScheduled = true
    queueMicrotask(() => {
      void this.enqueue(managed.session.id, async (current) => {
        current.inputDrainScheduled = false
        await this.drainInputQueue(current)
      }).catch((error: unknown) => {
        if (managed.disposing) return
        this.append(managed, {
          type: 'runtime.warning',
          payload: { error: toRuntimeError(error, 'protocol') },
        })
      })
    })
  }

  private async drainInputQueue(managed: ManagedSession): Promise<void> {
    if (
      managed.inputDispatching ||
      managed.inputQueue.length === 0 ||
      managed.disposing ||
      managed.session.status === 'closed' ||
      managed.session.status === 'error' ||
      managed.session.status === 'interrupted'
    ) {
      return
    }

    const activeTurnId = managed.activeTurnId
    const hasActiveTurn =
      activeTurnId !== undefined ||
      managed.session.status === 'running' ||
      managed.session.status === 'waiting'
    const entry = hasActiveTurn
      ? managed.inputQueue.find(
          (candidate) => !candidate.input.admitOnly && candidate.requestedDelivery === 'steer',
        )
      : managed.inputQueue.find((candidate) => !candidate.input.admitOnly)
    if (!entry) return

    if (hasActiveTurn && managed.connection.capabilities.steer !== 'native') return
    if (hasActiveTurn && !activeTurnId) return

    const kind = hasActiveTurn ? 'steer' : 'start-turn'
    const turnId = activeTurnId ?? asTurnId(randomUUID())
    const effectiveDelivery: InputDelivery = hasActiveTurn ? 'steer' : 'queue'
    managed.inputDispatching = true
    try {
      await managed.adapter.send(managed.session.id, cloneUserInput(entry.input), {
        turnId,
        kind,
      })
      managed.inputQueue = managed.inputQueue.filter((candidate) => candidate.id !== entry.id)
      const delivered: InputQueueEntry = {
        ...cloneInputQueueEntry(entry),
        effectiveDelivery,
        status: 'delivered',
        turnId,
        updatedAt: Date.now(),
      }
      this.append(managed, {
        type: 'input.dispatched',
        payload: { entry: delivered },
        turnId,
      })
      this.publishInputQueue(managed)
      if (hasActiveTurn) this.scheduleInputDrain(managed)
    } catch (error) {
      if (hasActiveTurn) {
        entry.requestedDelivery = 'queue'
        entry.input = { ...entry.input, delivery: 'queue' }
        entry.updatedAt = Date.now()
        this.publishInputQueue(managed)
        this.append(managed, {
          type: 'runtime.warning',
          payload: { error: toRuntimeError(error, 'protocol') },
          turnId,
        })
      } else {
        managed.inputQueue = managed.inputQueue.filter((candidate) => candidate.id !== entry.id)
        const failed: InputQueueEntry = {
          ...cloneInputQueueEntry(entry),
          effectiveDelivery,
          status: 'failed',
          turnId,
          error: toRuntimeError(error, 'protocol'),
          updatedAt: Date.now(),
        }
        this.append(managed, { type: 'input.failed', payload: { entry: failed }, turnId })
        this.publishInputQueue(managed)
      }
    } finally {
      managed.inputDispatching = false
    }
  }

  private publishInputQueue(managed: ManagedSession): RuntimeEvent {
    const now = Date.now()
    for (const [position, entry] of managed.inputQueue.entries()) {
      entry.position = position
      entry.updatedAt = Math.max(entry.updatedAt, now)
    }
    return this.append(managed, {
      type: 'input.queue_updated',
      payload: { entries: managed.inputQueue.map(cloneInputQueueEntry) },
    })
  }

  private requirePendingInput(managed: ManagedSession, inputId: string): InputQueueEntry {
    const entry = managed.inputQueue.find((candidate) => candidate.id === inputId)
    if (!entry) throw new Error(`Unknown queued input: ${inputId}`)
    return entry
  }

  private append(managed: ManagedSession, event: AdapterEvent): RuntimeEvent {
    const sealed = managed.events.append(event, (candidate) => this.eventSink?.append(candidate))
    if (
      sealed.type === 'interaction.permission_requested' ||
      sealed.type === 'interaction.question_requested' ||
      sealed.type === 'interaction.grant_requested' ||
      sealed.type === 'interaction.dialog_requested' ||
      sealed.type === 'interaction.elicitation_requested'
    ) {
      managed.pendingInteractions.set(sealed.payload.request.id, structuredClone(sealed.payload.request))
    } else if (sealed.type === 'interaction.resolved' || sealed.type === 'interaction.canceled') {
      managed.pendingInteractions.delete(sealed.payload.id)
    } else if (sealed.type === 'session.capabilities_changed') {
      managed.connection = {
        ...managed.connection,
        capabilities: cloneCapabilities(sealed.payload.capabilities),
      }
    } else if (sealed.type === 'task.updated') {
      managed.taskState = applyTaskStateUpdate(managed.taskState, sealed.payload.update)
    } else if (
      sealed.type === 'subagent.started' ||
      sealed.type === 'subagent.updated' ||
      sealed.type === 'subagent.completed'
    ) {
      managed.subagentRuns.set(sealed.payload.run.id, cloneSubagentRun(sealed.payload.run))
    } else if (sealed.type === 'turn.started') {
      managed.activeTurnId = sealed.payload.turnId
    } else if (
      (sealed.type === 'turn.completed' || sealed.type === 'turn.failed') &&
      managed.activeTurnId === sealed.payload.turnId
    ) {
      managed.activeTurnId = undefined
    }
    managed.session = applyEvent(managed.session, sealed)
    if (sealed.type === 'session.status_changed' && sealed.payload.status === 'idle') {
      managed.activeTurnId = undefined
      this.scheduleInputDrain(managed)
    }
    return sealed
  }

  private bumpControlRevision(managed: ManagedSession): void {
    managed.session = { ...managed.session, controlRevision: managed.session.controlRevision + 1 }
  }

  private async configureExecution(
    managed: ManagedSession,
    configured: SessionExecutionSettings,
  ): Promise<RuntimeControlReceipt> {
    if (
      !managed.adapter.configureExecution ||
      managed.connection.capabilities.execution.update !== 'in-session'
    ) {
      throw unsupported('in-session execution configuration')
    }
    const resolved = await managed.adapter.configureExecution(managed.session.id, configured)
    this.bumpControlRevision(managed)
    this.append(managed, {
      type: 'session.execution_changed',
      payload: {
        execution: {
          configured,
          effective: cloneSessionExecutionSettings(resolved.effective),
          limitations: resolved.limitations.map((limitation) => ({ ...limitation })),
        },
        controlRevision: managed.session.controlRevision,
      },
    })
    return { controlRevision: managed.session.controlRevision }
  }

  private enqueue<T>(sessionId: SessionId, operation: (managed: ManagedSession) => Promise<T>): Promise<T> {
    const managed = this.requireSession(sessionId)
    const result = managed.commandTail.then(() => operation(managed))
    managed.commandTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private enqueueControl<T>(
    sessionId: SessionId,
    options: RuntimeControlOptions,
    operation: (managed: ManagedSession) => Promise<T>,
  ): Promise<T> {
    return this.enqueue(sessionId, async (managed) => {
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== managed.session.controlRevision
      ) {
        throw new AdapterError({
          code: 'protocol',
          nativeCode: 'gateway.session.revision_conflict',
          message: `Session control revision is ${managed.session.controlRevision}, expected ${options.expectedRevision}`,
        })
      }
      return operation(managed)
    })
  }

  private requireSession(sessionId: SessionId): ManagedSession {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Unknown Runtime session: ${sessionId}`)
    return managed
  }
}

function applyEvent(session: AgentSession, event: RuntimeEvent): AgentSession {
  let next = session
  if (event.type === 'session.created') {
    next = { ...next, runtimeSessionId: event.payload.runtimeSessionId ?? next.runtimeSessionId }
  } else if (event.type === 'session.status_changed') {
    next = { ...next, status: event.payload.status }
  } else if (event.type === 'session.title_changed') {
    next = { ...next, title: event.payload.title }
  } else if (event.type === 'session.model_changed') {
    next = { ...next, model: { ...event.payload.model } }
  } else if (event.type === 'session.execution_changed') {
    next = {
      ...next,
      execution: cloneSessionExecutionState(event.payload.execution),
      controlRevision: event.payload.controlRevision,
    }
  } else if (event.type === 'runtime.error') {
    next = { ...next, status: 'error' }
  }
  return { ...next, lastEventSequence: event.sequence, updatedAt: event.timestamp }
}

function snapshot(managed: ManagedSession): RuntimeSessionSnapshot {
  return {
    session: {
      ...managed.session,
      ...(managed.session.model ? { model: { ...managed.session.model } } : {}),
      execution: cloneSessionExecutionState(managed.session.execution),
    },
    connection: {
      ...managed.connection,
      capabilities: {
        ...managed.connection.capabilities,
        features: { ...managed.connection.capabilities.features },
        raw: [...managed.connection.capabilities.raw],
      },
    },
    capabilities: cloneCapabilities(managed.connection.capabilities),
    pendingInteractions: [...managed.pendingInteractions.values()].map((request) => structuredClone(request)),
    taskState: cloneTaskState(managed.taskState),
    subagentRuns: [...managed.subagentRuns.values()].map(cloneSubagentRun),
    inputQueue: managed.inputQueue.map(cloneInputQueueEntry),
  }
}

function sessionHasStatus(managed: ManagedSession, status: AgentSession['status']): boolean {
  return managed.session.status === status
}

function cloneUserInput(input: UserInput): UserInput {
  return {
    clientMessageId: input.clientMessageId,
    text: input.text,
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.attachments
      ? { attachments: input.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(input.admitOnly === undefined ? {} : { admitOnly: input.admitOnly }),
  }
}

function cloneInputQueueEntry(entry: InputQueueEntry): InputQueueEntry {
  return {
    ...entry,
    input: cloneUserInput(entry.input),
    ...(entry.error ? { error: structuredClone(entry.error) } : {}),
  }
}

function cloneSubagentRun(run: SubagentRun): SubagentRun {
  return {
    ...run,
    ...(run.model ? { model: { ...run.model } } : {}),
    ...(run.error ? { error: structuredClone(run.error) } : {}),
  }
}

function cloneCapabilities(capabilities: RuntimeConnection['capabilities']): RuntimeConnection['capabilities'] {
  return {
    ...capabilities,
    execution: {
      ...capabilities.execution,
      workModes: [...capabilities.execution.workModes],
      approvalActions: [...capabilities.execution.approvalActions],
      approvalReviewers: [...capabilities.execution.approvalReviewers],
      filesystemSandbox: [...capabilities.execution.filesystemSandbox],
      networkAccess: [...capabilities.execution.networkAccess],
    },
    features: { ...capabilities.features },
    raw: [...capabilities.raw],
    ...(capabilities.degradations
      ? { degradations: capabilities.degradations.map((degradation) => ({ ...degradation })) }
      : {}),
  }
}

function unsupported(capability: string): AdapterError {
  return new AdapterError({
    code: 'not_implemented',
    nativeCode: 'gateway.capability.unsupported',
    message: `Runtime does not support ${capability}`,
  })
}
