import {
  asInteractionId,
  asSessionId,
  type AgentSession,
  type InteractionRequest,
  type InteractionResolution,
  type RuntimeEvent,
  type SessionId
} from '@agent-gateway/core'
import type { RuntimeSessionManager } from '@agent-gateway/runtime'
import { GatewayHttpError } from '../../http/errors.js'
import type { ProjectRepository } from '../projects/repository.js'
import type {
  CreateSessionBody,
  CreateSessionResult,
  CloseSessionBody,
  ForkSessionBody,
  InterruptSessionBody,
  ResolveInteractionBody,
  ResumeSessionBody,
  SendSessionInputBody,
  SendSessionInputResult,
  SessionControlResult,
  SessionResponse,
  SetExecutionSettingsBody,
  SetSessionModelBody,
  SetSessionTitleBody,
  SetWorkModeBody
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
      execution: input.execution
    })
    const stored: StoredSession = {
      session: snapshot.session,
      capabilities: snapshot.capabilities,
      taskState: snapshot.taskState
    }
    let observer: Promise<void> | undefined
    try {
      this.repository.create(stored)
      observer = this.observe(snapshot.session.id)
      this.runtime.setSessionTitle(snapshot.session.id, titleFromInput(input.initialInput.text))
      const receipt = await this.runtime.send(snapshot.session.id, input.initialInput)
      const current = this.runtime.getSession(snapshot.session.id)
      this.repository.updateSnapshot(current.session, current.capabilities, current.taskState)
      return {
        session: toResponse(
          {
            session: current.session,
            capabilities: current.capabilities,
            taskState: current.taskState
          },
          current.pendingInteractions
        ),
        receipt
      }
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

  async interrupt(id: string, body: InterruptSessionBody): Promise<void> {
    const sessionId = this.requireActive(id)
    await this.runtime.interrupt(sessionId, body)
  }

  async resolveInteraction(
    id: string,
    interactionId: string,
    body: ResolveInteractionBody
  ): Promise<void> {
    const sessionId = this.requireActive(id)
    if (body.resolution.id !== asInteractionId(interactionId)) {
      throw new GatewayHttpError(
        400,
        'INTERACTION_ID_MISMATCH',
        'Resolution id does not match the route interaction id'
      )
    }
    await this.runtime.resolveInteraction(sessionId, brandResolution(body.resolution))
  }

  async close(id: string, body: CloseSessionBody): Promise<SessionControlResult> {
    const sessionId = this.requireActive(id)
    const receipt = await this.runtime.closeSession(sessionId, body)
    const snapshot = this.runtime.getSession(sessionId)
    this.repository.updateSnapshot(snapshot.session, snapshot.capabilities, snapshot.taskState)
    return receipt
  }

  async resume(id: string, body: ResumeSessionBody): Promise<SessionResponse> {
    const stored = this.requireStored(id)
    if (!stored.session.runtimeSessionId) {
      throw new GatewayHttpError(409, 'SESSION_NOT_RESUMABLE', 'Session has no provider session id')
    }
    if (this.isActive(stored.session.id)) {
      throw new GatewayHttpError(409, 'SESSION_ALREADY_ACTIVE', 'Session is already active')
    }
    const project = this.projects.findById(stored.session.projectId)
    if (!project) throw new GatewayHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found')
    const snapshot = await this.runtime.resumeSession({
      sessionId: stored.session.id,
      projectId: stored.session.projectId,
      host: { hostId: project.hostId, platform: process.platform, env: this.hostEnvironment },
      projectPath: project.path,
      adapterId: stored.session.adapterId,
      installationPath: body.installationPath,
      providerProfileId: stored.session.providerProfileId,
      model: stored.session.model,
      execution: stored.session.execution.configured,
      runtimeSessionId: stored.session.runtimeSessionId,
      previousSession: stored.session,
      providerStateSnapshot: stored.session.providerStateSnapshot,
      taskState: stored.taskState
    })
    this.repository.updateSnapshot(snapshot.session, snapshot.capabilities, snapshot.taskState)
    this.observe(snapshot.session.id)
    return toResponse(
      {
        session: snapshot.session,
        capabilities: snapshot.capabilities,
        taskState: snapshot.taskState
      },
      snapshot.pendingInteractions
    )
  }

  async fork(id: string, body: ForkSessionBody): Promise<SessionResponse> {
    const sourceId = this.requireActive(id)
    const snapshot = await this.runtime.forkSession({
      sourceSessionId: sourceId,
      forkPoint: body.forkPoint,
      execution: body.execution
    })
    const stored = {
      session: snapshot.session,
      capabilities: snapshot.capabilities,
      taskState: snapshot.taskState
    }
    try {
      this.repository.create(stored)
      this.observe(snapshot.session.id)
      return toResponse(stored, snapshot.pendingInteractions)
    } catch (error) {
      await this.runtime.disposeSession(snapshot.session.id).catch(() => undefined)
      this.repository.delete(snapshot.session.id)
      this.eventsRepository.discardSession(snapshot.session.id)
      throw error
    }
  }

  async setTitle(id: string, body: SetSessionTitleBody): Promise<SessionControlResult> {
    const sessionId = this.requireActive(id)
    return this.runtime.renameSession(sessionId, body.title, body)
  }

  async setModel(id: string, body: SetSessionModelBody): Promise<SessionControlResult> {
    const sessionId = this.requireActive(id)
    return this.runtime.setModel(
      sessionId,
      {
        model: body.model,
        ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {})
      },
      body
    )
  }

  async setWorkMode(id: string, body: SetWorkModeBody): Promise<SessionControlResult> {
    return this.runtime.setWorkMode(this.requireActive(id), body.workMode, body)
  }

  async setExecutionSettings(
    id: string,
    body: SetExecutionSettingsBody
  ): Promise<SessionControlResult> {
    return this.runtime.setExecutionSettings(this.requireActive(id), body.execution, body)
  }

  events(id: string, afterSequence = 0): AsyncIterable<RuntimeEvent> {
    const sessionId = asSessionId(id)
    if (!this.repository.findById(id)) {
      throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    }
    const history = this.eventsRepository.listAfter(id, afterSequence)
    const active = this.runtime
      .listSessions()
      .some(
        (snapshot) =>
          snapshot.session.id === sessionId && liveStatuses.has(snapshot.session.status)
      )
    if (!active) return replay(history)

    const tailCursor = history.at(-1)?.sequence ?? afterSequence
    return replayThenFollow(history, this.runtime.events(sessionId, tailCursor))
  }

  list(projectId: string): SessionResponse[] {
    if (!this.projects.findById(projectId)) {
      throw new GatewayHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found')
    }
    this.refreshRuntimeSnapshots(projectId)
    return this.repository.listByProject(projectId).map((stored) => toResponse(stored))
  }

  get(id: string): SessionResponse {
    const sessionId = asSessionId(id)
    const live = this.runtime.listSessions().find((snapshot) => snapshot.session.id === sessionId)
    if (live) this.repository.updateSnapshot(live.session, live.capabilities, live.taskState)
    const stored = this.repository.findById(id)
    if (!stored) throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    return toResponse(stored, live?.pendingInteractions)
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
    const observer = this.consumeEvents(sessionId)
    const tracked = observer.finally(() => {
      if (this.observers.get(sessionId) === tracked) this.observers.delete(sessionId)
    })
    this.observers.set(sessionId, tracked)
    return tracked
  }

  private async consumeEvents(sessionId: SessionId): Promise<void> {
    try {
      for await (const event of this.runtime.events(sessionId)) {
        void event
        const snapshot = this.runtime.getSession(sessionId)
        this.repository.updateSnapshot(snapshot.session, snapshot.capabilities, snapshot.taskState)
      }
    } catch (error) {
      this.reportObserverError(error, sessionId)
    }
  }

  private refreshRuntimeSnapshots(projectId: string): void {
    for (const snapshot of this.runtime.listSessions(projectId)) {
      this.repository.updateSnapshot(snapshot.session, snapshot.capabilities, snapshot.taskState)
    }
  }

  private requireStored(id: string): StoredSession {
    const stored = this.repository.findById(id)
    if (!stored) throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    return stored
  }

  private requireActive(id: string): SessionId {
    const sessionId = asSessionId(id)
    if (!this.repository.findById(id)) {
      throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    }
    if (!this.isActive(sessionId)) {
      throw new GatewayHttpError(409, 'SESSION_NOT_ACTIVE', 'Session is not active in this Server process')
    }
    return sessionId
  }

  private isActive(sessionId: SessionId): boolean {
    return this.runtime
      .listSessions()
      .some(
        (snapshot) =>
          snapshot.session.id === sessionId && liveStatuses.has(snapshot.session.status)
      )
  }
}

function brandResolution(
  resolution: ResolveInteractionBody['resolution']
): InteractionResolution {
  return { ...resolution, id: asInteractionId(resolution.id) } as InteractionResolution
}

async function* replay(events: RuntimeEvent[]): AsyncGenerator<RuntimeEvent> {
  yield* events
}

async function* replayThenFollow(
  history: RuntimeEvent[],
  tail: AsyncIterable<RuntimeEvent>
): AsyncGenerator<RuntimeEvent> {
  yield* history
  yield* tail
}

function titleFromInput(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? text.trim()
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79)}…`
}

function toResponse(
  stored: StoredSession,
  pendingInteractions: InteractionRequest[] = []
): SessionResponse {
  const { session } = stored
  return {
    id: session.id,
    projectId: session.projectId,
    hostId: session.hostId,
    adapterId: session.adapterId,
    ...(session.runtimeSessionId ? { runtimeSessionId: session.runtimeSessionId } : {}),
    ...(session.providerProfileId ? { providerProfileId: session.providerProfileId } : {}),
    ...(session.model
      ? {
          model: session.model.model,
          ...(session.model.reasoningEffort
            ? { reasoningEffort: session.model.reasoningEffort }
            : {})
        }
      : {}),
    execution: session.execution,
    controlRevision: session.controlRevision,
    capabilities: stored.capabilities,
    pendingInteractions,
    taskState: stored.taskState,
    status: session.status,
    ...(session.title ? { title: session.title } : {}),
    lastEventSequence: session.lastEventSequence,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}
