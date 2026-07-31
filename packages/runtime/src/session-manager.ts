import { randomUUID } from 'node:crypto'
import {
  asSessionId,
  asTurnId,
  toRuntimeError,
  type AdapterEvent,
  type AgentSession,
  type InputAdmissionReceipt,
  type RuntimeAdapter,
  type RuntimeConnection,
  type RuntimeEvent,
  type SessionId,
  type TurnId,
  type UserInput,
} from '@agent-gateway/core'
import { AdapterRegistry } from './adapter-registry.js'
import { RuntimeConnectionManager } from './connection-manager.js'
import { RuntimeSessionEventStream } from './session-event-stream.js'
import type {
  CreateRuntimeSessionInput,
  RuntimeAdapterAvailability,
  RuntimeEventSink,
  RuntimeSessionSnapshot,
} from './types.js'

interface ManagedSession {
  session: AgentSession
  adapter: RuntimeAdapter
  connection: RuntimeConnection
  events: RuntimeSessionEventStream
  pump: Promise<void>
  disposing: boolean
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
    const session: AgentSession = {
      id: sessionId,
      projectId: input.projectId,
      hostId: input.host.hostId,
      adapterId: input.adapterId,
      providerProfileId: input.providerProfileId,
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
      events,
      pump: Promise.resolve(),
      disposing: false,
    }
    this.sessions.set(sessionId, managed)

    try {
      const handle = await adapter.createSession({
        sessionId,
        projectPath: input.projectPath,
        connection,
        providerProfileId: input.providerProfileId,
        model: input.model,
        mode: input.mode,
      })
      if (handle.sessionId !== sessionId) {
        throw new Error(`Adapter returned Gateway session ${handle.sessionId}, expected ${sessionId}`)
      }
      managed.session = {
        ...managed.session,
        runtimeSessionId: handle.runtimeSessionId,
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

  /** Durably admits user input before delivering it to the session's immutable adapter. */
  async send(
    sessionId: SessionId,
    input: UserInput,
  ): Promise<InputAdmissionReceipt & { turnId: TurnId }> {
    const managed = this.requireSession(sessionId)
    if (managed.disposing || managed.session.status === 'closed') {
      throw new Error(`Cannot send to closed Runtime session: ${sessionId}`)
    }

    const turnId = asTurnId(randomUUID())
    const admittedSequence = managed.session.lastEventSequence + 1
    const admittedInput = cloneUserInput(input)
    this.append(managed, {
      type: 'input.admitted',
      payload: {
        admittedSequence,
        turnId,
        ...(input.delivery ? { delivery: input.delivery } : {}),
        input: admittedInput,
      },
      turnId,
    })

    try {
      await managed.adapter.send(sessionId, admittedInput, { turnId })
    } catch (error) {
      this.append(managed, {
        type: 'turn.failed',
        payload: { turnId, error: toRuntimeError(error, 'protocol') },
        turnId,
      })
      throw error
    }

    return { admittedSequence, turnId }
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    const managed = this.requireSession(sessionId)
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
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to dispose ${failures.length} Runtime session(s)`)
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

  private append(managed: ManagedSession, event: AdapterEvent): RuntimeEvent {
    const sealed = managed.events.append(event, (candidate) => this.eventSink?.append(candidate))
    managed.session = applyEvent(managed.session, sealed)
    return sealed
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
  } else if (event.type === 'runtime.error') {
    next = { ...next, status: 'error' }
  }
  return { ...next, lastEventSequence: event.sequence, updatedAt: event.timestamp }
}

function snapshot(managed: ManagedSession): RuntimeSessionSnapshot {
  return {
    session: { ...managed.session },
    connection: {
      ...managed.connection,
      capabilities: {
        ...managed.connection.capabilities,
        features: { ...managed.connection.capabilities.features },
        raw: [...managed.connection.capabilities.raw],
      },
    },
  }
}

function sessionHasStatus(managed: ManagedSession, status: AgentSession['status']): boolean {
  return managed.session.status === status
}

function cloneUserInput(input: UserInput): UserInput {
  return {
    text: input.text,
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.attachments
      ? { attachments: input.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(input.admitOnly === undefined ? {} : { admitOnly: input.admitOnly }),
  }
}
