import {
  asSessionId,
  type AgentSession,
  type RuntimeEvent,
  type SessionId
} from '@agent-gateway/core'
import type { RuntimeSessionManager } from '@agent-gateway/runtime'
import { GatewayHttpError } from '../../http/errors.js'
import type { ProjectRepository } from '../projects/repository.js'
import type {
  CreateSessionBody,
  CreateSessionResult,
  SendSessionInputBody,
  SendSessionInputResult,
  SessionResponse
} from './schemas.js'
import type { SessionEventRepository } from './event-repository.js'
import { SessionRepository, type StoredSession } from './repository.js'

const liveStatuses = new Set<AgentSession['status']>(['starting', 'idle', 'running', 'waiting'])

export class SessionService {
  private readonly observers = new Map<SessionId, Promise<void>>()

  constructor(
    private readonly repository: SessionRepository,
    private readonly eventsRepository: SessionEventRepository,
    private readonly projects: ProjectRepository,
    private readonly runtime: RuntimeSessionManager,
    private readonly hostEnvironment: Record<string, string>,
    private readonly reportObserverError: (error: unknown, sessionId?: SessionId) => void
  ) {}

  recoverInterruptedSessions(): number {
    return this.repository.interruptActive()
  }

  async create(projectId: string, input: CreateSessionBody): Promise<CreateSessionResult> {
    const project = this.projects.findById(projectId)
    if (!project) throw new GatewayHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found')

    const model = input.model
      ? {
          model: input.model,
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
        }
      : undefined
    const snapshot = await this.runtime.createSession({
      projectId,
      host: { hostId: project.hostId, platform: process.platform, env: this.hostEnvironment },
      projectPath: project.path,
      adapterId: input.adapterId,
      installationPath: input.installationPath,
      providerProfileId: input.providerProfileId,
      model,
      mode: input.mode
    })
    const stored: StoredSession = {
      session: snapshot.session,
      ...(model ? { model } : {}),
      ...(input.mode ? { mode: input.mode } : {})
    }
    let observer: Promise<void> | undefined
    try {
      this.repository.create(stored)
      observer = this.observe(snapshot.session.id)
      this.runtime.setSessionTitle(snapshot.session.id, titleFromInput(input.initialInput.text))
      const receipt = await this.runtime.send(snapshot.session.id, input.initialInput)
      const current = this.runtime.getSession(snapshot.session.id).session
      this.repository.updateSnapshot(current)
      return { session: toResponse({ ...stored, session: current }), receipt }
    } catch (error) {
      await this.runtime.disposeSession(snapshot.session.id).catch(() => undefined)
      if (observer) await observer.catch(() => undefined)
      this.repository.delete(snapshot.session.id)
      this.eventsRepository.discardSession(snapshot.session.id)
      throw error
    }
  }

  async send(id: string, body: SendSessionInputBody): Promise<SendSessionInputResult> {
    const sessionId = asSessionId(id)
    if (!this.repository.findById(id)) {
      throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    }
    if (!this.runtime.listSessions().some((snapshot) => snapshot.session.id === sessionId)) {
      throw new GatewayHttpError(
        409,
        'SESSION_NOT_ACTIVE',
        'Session is not active in this Server process'
      )
    }
    return this.runtime.send(sessionId, body.input)
  }

  events(id: string, afterSequence = 0): AsyncIterable<RuntimeEvent> {
    const sessionId = asSessionId(id)
    if (!this.repository.findById(id)) {
      throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    }
    if (this.runtime.listSessions().some((snapshot) => snapshot.session.id === sessionId)) {
      return this.runtime.events(sessionId, afterSequence)
    }
    return replay(this.eventsRepository.listAfter(id, afterSequence))
  }

  list(projectId: string): SessionResponse[] {
    if (!this.projects.findById(projectId)) {
      throw new GatewayHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found')
    }
    this.refreshRuntimeSnapshots(projectId)
    return this.repository.listByProject(projectId).map(toResponse)
  }

  get(id: string): SessionResponse {
    const sessionId = asSessionId(id)
    const live = this.runtime.listSessions().find((snapshot) => snapshot.session.id === sessionId)
    if (live) this.repository.updateSnapshot(live.session)
    const stored = this.repository.findById(id)
    if (!stored) throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    return toResponse(stored)
  }

  async shutdown(): Promise<void> {
    const activeIds = this.runtime
      .listSessions()
      .filter((snapshot) => liveStatuses.has(snapshot.session.status))
      .map((snapshot) => snapshot.session.id)
    try {
      await this.runtime.disposeAllSessions()
    } catch (error) {
      this.reportObserverError(error)
    }
    await Promise.allSettled(this.observers.values())
    this.repository.interruptByIds(activeIds)
  }

  private observe(sessionId: SessionId): Promise<void> {
    const observer = this.consumeEvents(sessionId).finally(() => this.observers.delete(sessionId))
    this.observers.set(sessionId, observer)
    return observer
  }

  private async consumeEvents(sessionId: SessionId): Promise<void> {
    try {
      for await (const event of this.runtime.events(sessionId)) {
        void event
        this.repository.updateSnapshot(this.runtime.getSession(sessionId).session)
      }
    } catch (error) {
      this.reportObserverError(error, sessionId)
    }
  }

  private refreshRuntimeSnapshots(projectId: string): void {
    for (const snapshot of this.runtime.listSessions(projectId)) {
      this.repository.updateSnapshot(snapshot.session)
    }
  }
}

async function* replay(events: RuntimeEvent[]): AsyncGenerator<RuntimeEvent> {
  yield* events
}

function titleFromInput(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? text.trim()
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79)}…`
}

function toResponse(stored: StoredSession): SessionResponse {
  const { session } = stored
  return {
    id: session.id,
    projectId: session.projectId,
    hostId: session.hostId,
    adapterId: session.adapterId,
    ...(session.runtimeSessionId ? { runtimeSessionId: session.runtimeSessionId } : {}),
    ...(session.providerProfileId ? { providerProfileId: session.providerProfileId } : {}),
    ...(stored.model
      ? {
          model: stored.model.model,
          ...(stored.model.reasoningEffort
            ? { reasoningEffort: stored.model.reasoningEffort }
            : {})
        }
      : {}),
    ...(stored.mode ? { mode: stored.mode } : {}),
    status: session.status,
    ...(session.title ? { title: session.title } : {}),
    lastEventSequence: session.lastEventSequence,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}
