import {
  type AdapterEvent,
  type AdapterId,
  type CreateSessionInput,
  type RuntimeAdapter,
  type RuntimeAdapterDescriptor,
  type RuntimeConnection,
  type RuntimeInstallation,
  type RuntimeSessionHandle,
  type ResumeSessionInput,
  type ForkSessionInput,
  type SessionExecutionSettings,
  type ExecutionConfigurationResult,
  type InteractionResolution,
  type ModelSelection,
  type SendOptions,
  type SessionId,
  type UserInput,
} from '@agent-gateway/core'

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor
  readonly createInputs: CreateSessionInput[] = []
  readonly disposeCalls: SessionId[] = []
  readonly disposeFailures = new Set<SessionId>()
  readonly sendInputs: Array<{ sessionId: SessionId; input: UserInput; options: SendOptions }> = []
  readonly executionSettings: SessionExecutionSettings[] = []
  readonly models: ModelSelection[] = []
  readonly resolutions: InteractionResolution[] = []
  interruptCount = 0
  connectCount = 0
  detectError?: unknown
  createError?: unknown
  sendError?: unknown
  beforeSend?: () => void

  private readonly streams = new Map<SessionId, TestEventStream>()

  constructor(
    adapterId: AdapterId,
    readonly installations: RuntimeInstallation[] = [
      { path: `/managed/${adapterId}`, source: 'managed', version: 'test' },
    ],
  ) {
    this.descriptor = {
      id: adapterId,
      displayName: `Fake ${adapterId}`,
      adapterVersion: 'test',
      protocolVersion: 'test',
      capabilities: {
        steer: 'queue-fallback',
        modelSwitch: 'in-session',
        execution: {
          workModes: ['build', 'plan'],
          approvalActions: ['allow', 'ask', 'deny'],
          approvalReviewers: ['user'],
          filesystemSandbox: ['read-only', 'workspace-write', 'unrestricted'],
          networkAccess: ['deny', 'ask', 'allow'],
          update: 'in-session',
          granularRules: true,
        },
        features: { 'session.resume': true, 'session.fork': true },
        raw: [],
      },
    }
  }

  detect(): Promise<RuntimeInstallation[]> {
    if (this.detectError) return Promise.reject(this.detectError)
    return Promise.resolve(this.installations)
  }

  connect(): Promise<RuntimeConnection> {
    this.connectCount += 1
    return Promise.resolve({
      id: `${this.descriptor.id}-connection-${this.connectCount}`,
      transport: 'sdk',
      capabilities: this.descriptor.capabilities,
    })
  }

  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    if (this.createError) return Promise.reject(this.createError)
    this.createInputs.push(input)
    return this.openSession(input.sessionId, `${this.descriptor.id}-native-${input.sessionId}`)
  }

  resumeSession(input: ResumeSessionInput): Promise<RuntimeSessionHandle> {
    return this.openSession(input.sessionId, input.runtimeSessionId)
  }

  forkSession(input: ForkSessionInput): Promise<RuntimeSessionHandle> {
    return this.openSession(input.sessionId, `${this.descriptor.id}-fork-${input.runtimeSessionId}`)
  }

  private openSession(sessionId: SessionId, runtimeSessionId: string): Promise<RuntimeSessionHandle> {
    const stream = new TestEventStream()
    this.streams.set(sessionId, stream)
    stream.push({
      type: 'session.created',
      payload: {
        runtimeSessionId,
        capabilities: this.descriptor.capabilities,
      },
    })
    stream.push({ type: 'session.status_changed', payload: { status: 'idle' } })
    return Promise.resolve({
      sessionId,
      runtimeSessionId,
    })
  }

  send(sessionId: SessionId, input: UserInput, options: SendOptions): Promise<void> {
    if (this.sendError) return Promise.reject(this.sendError)
    this.beforeSend?.()
    this.sendInputs.push({ sessionId, input, options })
    return Promise.resolve()
  }

  interrupt(): Promise<void> {
    this.interruptCount += 1
    return Promise.resolve()
  }

  resolveInteraction(sessionId: SessionId, resolution: InteractionResolution): Promise<void> {
    this.resolutions.push(resolution)
    this.requireStream(sessionId).push({
      type: 'interaction.resolved',
      payload: { id: resolution.id, resolution },
    })
    return Promise.resolve()
  }

  setModel(_sessionId: SessionId, model: ModelSelection): Promise<void> {
    this.models.push(model)
    return Promise.resolve()
  }

  configureExecution(
    _sessionId: SessionId,
    settings: SessionExecutionSettings,
  ): Promise<ExecutionConfigurationResult> {
    this.executionSettings.push(settings)
    return Promise.resolve({ effective: settings, limitations: [] })
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    this.disposeCalls.push(sessionId)
    if (this.disposeFailures.has(sessionId)) throw new Error(`dispose failed: ${sessionId}`)
    const stream = this.streams.get(sessionId)
    if (!stream) return
    stream.push({ type: 'session.status_changed', payload: { status: 'closed' } })
    stream.close()
  }

  events(sessionId: SessionId): AsyncIterable<AdapterEvent> {
    const stream = this.streams.get(sessionId)
    if (!stream) throw new Error(`Unknown fake session: ${sessionId}`)
    return stream
  }

  emit(sessionId: SessionId, event: AdapterEvent): void {
    this.requireStream(sessionId).push(event)
  }

  failEvents(sessionId: SessionId, error: unknown): void {
    this.requireStream(sessionId).fail(error)
  }

  private requireStream(sessionId: SessionId): TestEventStream {
    const stream = this.streams.get(sessionId)
    if (!stream) throw new Error(`Unknown fake session: ${sessionId}`)
    return stream
  }
}

class TestEventStream implements AsyncIterable<AdapterEvent> {
  private readonly values: AdapterEvent[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<AdapterEvent>) => void
    reject: (error: unknown) => void
  }> = []
  private terminal: { kind: 'closed' } | { kind: 'failed'; error: unknown } | undefined

  push(event: AdapterEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value: event, done: false })
    else this.values.push(event)
  }

  close(): void {
    this.terminal = { kind: 'closed' }
    this.settle()
  }

  fail(error: unknown): void {
    this.terminal = { kind: 'failed', error }
    this.settle()
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
    return { next: () => this.next() }
  }

  private next(): Promise<IteratorResult<AdapterEvent>> {
    const value = this.values.shift()
    if (value) return Promise.resolve({ value, done: false })
    if (this.terminal?.kind === 'closed') return Promise.resolve({ value: undefined, done: true })
    if (this.terminal?.kind === 'failed') return Promise.reject(this.terminal.error)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private settle(): void {
    for (const waiter of this.waiters.splice(0)) {
      if (this.terminal?.kind === 'failed') waiter.reject(this.terminal.error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }
}
