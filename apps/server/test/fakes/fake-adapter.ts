import {
  AdapterError,
  type AdapterEvent,
  type AdapterId,
  type CreateSessionInput,
  type RuntimeAdapter,
  type RuntimeAdapterDescriptor,
  type RuntimeConnection,
  type RuntimeInstallation,
  type RuntimeSessionHandle,
  type SendOptions,
  type SessionId,
  type UserInput
} from '@agent-gateway/core'

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly descriptor: RuntimeAdapterDescriptor
  readonly disposeCalls: SessionId[] = []
  readonly sendCalls: Array<{ sessionId: SessionId; input: UserInput; options: SendOptions }> = []
  sendError?: unknown
  private readonly streams = new Map<SessionId, FakeEventStream>()

  constructor(
    adapterId: AdapterId = 'claude-code',
    readonly installations: RuntimeInstallation[] = [
      { path: `/managed/${adapterId}`, source: 'managed', version: 'test' }
    ]
  ) {
    this.descriptor = {
      id: adapterId,
      displayName: `Fake ${adapterId}`,
      adapterVersion: 'test',
      protocolVersion: 'test',
      capabilities: {
        steer: 'queue-fallback',
        modelSwitch: 'unsupported',
        features: {},
        raw: []
      }
    }
  }

  detect(): Promise<RuntimeInstallation[]> {
    return Promise.resolve(this.installations)
  }

  connect(): Promise<RuntimeConnection> {
    return Promise.resolve({
      id: 'fake-connection',
      transport: 'sdk',
      capabilities: this.descriptor.capabilities
    })
  }

  createSession(input: CreateSessionInput): Promise<RuntimeSessionHandle> {
    const stream = new FakeEventStream()
    this.streams.set(input.sessionId, stream)
    stream.push({
      type: 'session.created',
      payload: {
        runtimeSessionId: `native-${input.sessionId}`,
        capabilities: this.descriptor.capabilities
      }
    })
    stream.push({ type: 'session.status_changed', payload: { status: 'idle' } })
    return Promise.resolve({
      sessionId: input.sessionId,
      runtimeSessionId: `native-${input.sessionId}`
    })
  }

  resumeSession(): Promise<RuntimeSessionHandle> {
    return Promise.reject(notImplemented('resumeSession'))
  }

  send(sessionId: SessionId, input: UserInput, options: SendOptions): Promise<void> {
    if (this.sendError) return Promise.reject(this.sendError)
    this.sendCalls.push({ sessionId, input, options })
    const stream = this.requireStream(sessionId)
    stream.push({ type: 'turn.started', payload: { turnId: options.turnId }, turnId: options.turnId })
    stream.push({
      type: 'session.status_changed',
      payload: { status: 'running' },
      turnId: options.turnId
    })
    stream.push({
      type: 'content.text.started',
      payload: { blockId: `text-${options.turnId}` },
      turnId: options.turnId
    })
    stream.push({
      type: 'content.text.completed',
      payload: { blockId: `text-${options.turnId}`, text: `Reply to: ${input.text}` },
      turnId: options.turnId
    })
    stream.push({
      type: 'turn.completed',
      payload: { turnId: options.turnId, status: 'completed' },
      turnId: options.turnId
    })
    stream.push({
      type: 'session.status_changed',
      payload: { status: 'idle' },
      turnId: options.turnId
    })
    return Promise.resolve()
  }

  interrupt(): Promise<void> {
    return Promise.reject(notImplemented('interrupt'))
  }

  resolveInteraction(): Promise<void> {
    return Promise.reject(notImplemented('resolveInteraction'))
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    this.disposeCalls.push(sessionId)
    const stream = this.streams.get(sessionId)
    if (!stream) return
    stream.push({ type: 'session.status_changed', payload: { status: 'closed' } })
    stream.close()
  }

  events(sessionId: SessionId): AsyncIterable<AdapterEvent> {
    return this.requireStream(sessionId)
  }

  private requireStream(sessionId: SessionId): FakeEventStream {
    const stream = this.streams.get(sessionId)
    if (!stream) throw new Error(`Unknown fake session: ${sessionId}`)
    return stream
  }
}

class FakeEventStream implements AsyncIterable<AdapterEvent> {
  private readonly values: AdapterEvent[] = []
  private readonly waiters: Array<(result: IteratorResult<AdapterEvent>) => void> = []
  private closed = false

  push(event: AdapterEvent): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.values.push(event)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
    return { next: () => this.next() }
  }

  private next(): Promise<IteratorResult<AdapterEvent>> {
    const event = this.values.shift()
    if (event) return Promise.resolve({ value: event, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

function notImplemented(method: string): AdapterError {
  return new AdapterError({ code: 'not_implemented', message: method })
}
