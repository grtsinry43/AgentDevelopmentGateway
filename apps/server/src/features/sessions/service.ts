import {
  asInteractionId,
  asSessionId,
  type AgentSession,
  type InteractionRequest,
  type InteractionResolution,
  type ModelCatalog,
  type RuntimeEvent,
  type SessionId
} from '@agent-gateway/core'
import {
  type RuntimeSlashCommands
} from '@agent-gateway/runtime'
import { projectDurableRuntimeState, type RuntimeSessionManager } from '@agent-gateway/runtime'
import { GatewayHttpError } from '../../http/errors.js'
import type { ProjectRepository } from '../projects/repository.js'
import type {
  CreateSessionBody,
  CreateSessionResult,
  CloseSessionBody,
  ForkSessionBody,
  InterruptSessionBody,
  ResolveInteractionBody,
  ReorderQueuedInputsBody,
  ReplaceQueuedInputBody,
  ResumeSessionBody,
  RewindSessionBody,
  RewindSessionResult,
  SendSessionInputBody,
  SendSessionInputResult,
  SessionControlResult,
  SessionResponse,
  SetExecutionSettingsBody,
  SetSessionModelBody,
  SetSessionTitleBody,
  SetWorkModeBody,
  EventsHistoryResponse,
  SessionItemsResponse
} from './schemas.js'
import type { SessionEventRepository } from './event-repository.js'
import type { SessionItemRepository } from './item-repository.js'
import type { SessionItemizer } from './session-itemizer.js'
import { SessionRepository, type StoredSession } from './repository.js'

const liveStatuses = new Set<AgentSession['status']>(['starting', 'idle', 'running', 'waiting'])

export class SessionService {
  private readonly observers = new Map<SessionId, Promise<void>>()

  constructor(
    private readonly repository: SessionRepository,
    private readonly eventsRepository: SessionEventRepository,
    private readonly itemsRepository: SessionItemRepository,
    private readonly itemizer: SessionItemizer,
    private readonly projects: ProjectRepository,
    private readonly runtime: RuntimeSessionManager,
    private readonly hostEnvironment: Record<string, string>,
    private readonly reportObserverError: (error: unknown, sessionId?: SessionId) => void
  ) {}

  recoverInterruptedSessions(): number {
    this.repairDurableProjections()
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
      ...(input.providerConfig ? { providerConfig: { ...input.providerConfig } } : {}),
      model,
      execution: input.execution
    })
    const stored: StoredSession = {
      session: snapshot.session,
      capabilities: snapshot.capabilities,
      taskState: snapshot.taskState,
      subagentRuns: snapshot.subagentRuns,
      inputQueue: snapshot.inputQueue
    }
    let observer: Promise<void> | undefined
    try {
      this.repository.create(stored)
      observer = this.observe(snapshot.session.id)
      this.runtime.setSessionTitle(snapshot.session.id, titleFromInput(input.initialInput.text))
      const receipt = await this.runtime.send(snapshot.session.id, input.initialInput)
      const current = this.runtime.getSession(snapshot.session.id)
      this.persistSnapshot(current)
      return {
        session: toResponse(
          {
            session: current.session,
            capabilities: current.capabilities,
            taskState: current.taskState,
            subagentRuns: current.subagentRuns,
            inputQueue: current.inputQueue
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
      this.itemizer.discardSession(snapshot.session.id)
      throw error
    }
  }

  async send(id: string, body: SendSessionInputBody): Promise<SendSessionInputResult> {
    const sessionId = this.requireActive(id)
    return this.runtime.send(sessionId, body.input)
  }

  async replaceQueuedInput(
    id: string,
    inputId: string,
    body: ReplaceQueuedInputBody
  ): Promise<void> {
    const sessionId = this.requireQueuedInput(id, inputId)
    if (body.input.clientMessageId !== inputId) {
      throw new GatewayHttpError(
        400,
        'INPUT_ID_MISMATCH',
        'Input id does not match the route input id'
      )
    }
    await this.runtime.replaceQueuedInput(sessionId, body.input)
  }

  async reorderQueuedInputs(id: string, body: ReorderQueuedInputsBody): Promise<void> {
    const sessionId = this.requireActive(id)
    const snapshot = this.runtime.getSession(sessionId)
    const pendingIds = new Set(snapshot.inputQueue.map((entry) => entry.id))
    if (
      body.inputIds.length !== pendingIds.size ||
      new Set(body.inputIds).size !== body.inputIds.length ||
      body.inputIds.some((inputId) => !pendingIds.has(inputId))
    ) {
      throw new GatewayHttpError(
        409,
        'INPUT_QUEUE_CHANGED',
        'Input order must contain every currently queued input exactly once'
      )
    }
    await this.runtime.reorderQueuedInputs(sessionId, body.inputIds)
  }

  async cancelQueuedInput(id: string, inputId: string): Promise<void> {
    const sessionId = this.requireQueuedInput(id, inputId)
    await this.runtime.cancelQueuedInput(sessionId, inputId)
  }

  async sendQueuedInputNow(id: string, inputId: string): Promise<void> {
    const sessionId = this.requireQueuedInput(id, inputId)
    await this.runtime.sendQueuedInputNow(sessionId, inputId)
  }

  async interrupt(id: string, body: InterruptSessionBody): Promise<void> {
    const sessionId = this.requireActive(id)
    await this.runtime.interrupt(sessionId, body)
  }

  /** 回退:原生优先、fork 备份(preview/apply)。removedMessageCount 由 itemizer 物化块统计。 */
  async rewind(id: string, body: RewindSessionBody): Promise<RewindSessionResult> {
    // 会话须在 Server 进程内活跃:历史会话由桌面端先 resume(会注入 providerConfig),
    // server 内自行 resume 拿不到中继/API key,provider 起不来。
    const sessionId = this.requireActive(id)
    this.itemizer.ensureMaterialized(sessionId)
    const item = this.itemsRepository.findById(sessionId, body.target.messageUuid)
    const targetSequence = item?.sequence
    const target =
      item?.itemKind === 'message'
        ? {
            ...body.target,
            ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
            ...(item.text ? { text: item.text } : {}),
          }
        : body.target
    const result = await this.runtime.rewindSession({
      sessionId,
      target,
      mode: body.mode,
      preferFork: body.preferFork,
    })
    // 原生 apply:真正截断会话记录(内存事件流 + durable 事件 + 物化块),否则对话视图不变。
    if (body.mode === 'apply' && result.strategy === 'native' && targetSequence !== undefined) {
      this.runtime.truncateSession(sessionId, targetSequence)
      this.eventsRepository.truncateAfter(sessionId, targetSequence)
      this.itemsRepository.truncateAfter(sessionId, targetSequence)
      this.itemizer.reset(sessionId)
      const snapshot = this.runtime.getSession(sessionId)
      this.persistSnapshot(snapshot)
    }
    return {
      ...result,
      removedMessageCount:
        result.removedMessageCount > 0
          ? result.removedMessageCount
          : targetSequence === undefined
            ? 0
            : this.itemsRepository.countMessagesAfter(sessionId, targetSequence),
    }
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
    this.persistSnapshot(snapshot)
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
    const durable = projectDurableRuntimeState(this.eventsRepository.listAfter(id))
    // Repair crash windows where session_events advanced but sessions.last_event_sequence did not.
    const lastEventSequence = this.eventsRepository.durableCursor(
      id,
      stored.session.lastEventSequence
    )
    const previousSession = {
      ...stored.session,
      lastEventSequence
    }
    const snapshot = await this.runtime.resumeSession({
      sessionId: stored.session.id,
      projectId: stored.session.projectId,
      host: { hostId: project.hostId, platform: process.platform, env: this.hostEnvironment },
      projectPath: project.path,
      adapterId: stored.session.adapterId,
      installationPath: body.installationPath,
      providerProfileId: body.providerProfileId ?? stored.session.providerProfileId,
      ...(body.providerConfig ? { providerConfig: { ...body.providerConfig } } : {}),
      model: stored.session.model,
      execution: stored.session.execution.configured,
      runtimeSessionId: stored.session.runtimeSessionId,
      previousSession,
      providerStateSnapshot: stored.session.providerStateSnapshot,
      taskState: stored.taskState,
      subagentRuns: durable.subagentRuns,
      inputQueue: durable.inputQueue,
      inputAdmissions: durable.inputAdmissions
    })
    this.persistSnapshot(snapshot)
    this.observe(snapshot.session.id)
    return toResponse(
      {
        session: snapshot.session,
        capabilities: snapshot.capabilities,
        taskState: snapshot.taskState,
        subagentRuns: snapshot.subagentRuns,
        inputQueue: snapshot.inputQueue
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
      taskState: snapshot.taskState,
      subagentRuns: snapshot.subagentRuns,
      inputQueue: snapshot.inputQueue
    }
    try {
      this.repository.create(stored)
      this.observe(snapshot.session.id)
      return toResponse(stored, snapshot.pendingInteractions)
    } catch (error) {
      await this.runtime.disposeSession(snapshot.session.id).catch(() => undefined)
      this.repository.delete(snapshot.session.id)
      this.eventsRepository.discardSession(snapshot.session.id)
      this.itemizer.discardSession(snapshot.session.id)
      throw error
    }
  }

  async setTitle(id: string, body: SetSessionTitleBody): Promise<SessionControlResult> {
    const stored = this.requireStored(id)
    if (this.isActive(stored.session.id)) {
      return this.runtime.renameSession(stored.session.id, body.title, body)
    }
    // Closed/archived session: the provider session is gone, so persist the title in the
    // gateway store (authoritative) + a durable event so resume/restart keep the rename.
    if (
      body.expectedRevision !== undefined &&
      body.expectedRevision !== stored.session.controlRevision
    ) {
      throw new GatewayHttpError(
        409,
        'SESSION_REVISION_CONFLICT',
        `Session revision is ${stored.session.controlRevision}, expected ${body.expectedRevision}`
      )
    }
    const previousEvents = this.eventsRepository.listAfter(id)
    const now = Date.now()
    const controlRevision = stored.session.controlRevision + 1
    const sequence =
      this.eventsRepository.durableCursor(id, stored.session.lastEventSequence) + 1
    const session: AgentSession = {
      ...stored.session,
      title: body.title,
      controlRevision,
      lastEventSequence: sequence,
      updatedAt: now
    }
    this.repository.updateSnapshot(
      session,
      stored.capabilities,
      stored.taskState,
      stored.subagentRuns,
      stored.inputQueue
    )
    this.eventsRepository.append({
      id: (previousEvents.at(-1)?.id ?? 0) + 1,
      sequence,
      sessionId: session.id,
      adapterId: session.adapterId,
      timestamp: now,
      type: 'session.title_changed',
      payload: { title: body.title, source: 'user' }
    })
    return { controlRevision }
  }

  async setModel(id: string, body: SetSessionModelBody): Promise<SessionControlResult> {
    const stored = this.requireStored(id)
    if (this.isActive(stored.session.id)) {
      return this.runtime.setModel(
        stored.session.id,
        {
          model: body.model,
          ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {})
        },
        body
      )
    }
    if (stored.capabilities.modelSwitch === 'unsupported') {
      throw new GatewayHttpError(422, 'CAPABILITY_UNSUPPORTED', 'Model switching is unsupported')
    }
    if (
      body.expectedRevision !== undefined &&
      body.expectedRevision !== stored.session.controlRevision
    ) {
      throw new GatewayHttpError(
        409,
        'SESSION_REVISION_CONFLICT',
        `Session revision is ${stored.session.controlRevision}, expected ${body.expectedRevision}`
      )
    }
    const catalog = await this.listModels(id)
    const model = catalog.models.find((candidate) => candidate.id === body.model)
    if (!model) {
      throw new GatewayHttpError(422, 'VALIDATION_ERROR', `Unknown model: ${body.model}`)
    }
    if (
      body.reasoningEffort &&
      !model.reasoningEfforts.some((effort) => effort.id === body.reasoningEffort)
    ) {
      throw new GatewayHttpError(
        422,
        'VALIDATION_ERROR',
        `Model ${body.model} does not support reasoning effort ${body.reasoningEffort}`
      )
    }

    const previousEvents = this.eventsRepository.listAfter(id)
    const now = Date.now()
    const controlRevision = stored.session.controlRevision + 1
    const sequence =
      this.eventsRepository.durableCursor(id, stored.session.lastEventSequence) + 1
    const selection = {
      model: body.model,
      ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {})
    }
    const session: AgentSession = {
      ...stored.session,
      model: selection,
      controlRevision,
      lastEventSequence: sequence,
      updatedAt: now
    }
    this.repository.updateSnapshot(
      session,
      stored.capabilities,
      stored.taskState,
      stored.subagentRuns,
      stored.inputQueue
    )
    this.eventsRepository.append({
      id: (previousEvents.at(-1)?.id ?? 0) + 1,
      sequence,
      sessionId: session.id,
      adapterId: session.adapterId,
      timestamp: now,
      type: 'session.model_changed',
      payload: { model: selection, controlRevision }
    })
    return { controlRevision }
  }

  listModels(id: string): Promise<ModelCatalog> {
    const stored = this.requireStored(id)
    if (this.isActive(stored.session.id)) {
      return this.runtime.listSessionModels(stored.session.id)
    }
    const project = this.projects.findById(stored.session.projectId)
    if (!project) throw new GatewayHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found')
    return this.runtime.listModels({
      host: { hostId: project.hostId, platform: process.platform, env: this.hostEnvironment },
      projectPath: project.path,
      adapterId: stored.session.adapterId
    })
  }

  listCommands(id: string): Promise<RuntimeSlashCommands> {
    const stored = this.requireStored(id)
    if (this.isActive(stored.session.id)) {
      return this.runtime.listSessionCommands(stored.session.id)
    }
    const project = this.projects.findById(stored.session.projectId)
    if (!project) throw new GatewayHttpError(404, 'PROJECT_NOT_FOUND', 'Project was not found')
    return this.runtime.listCommands({
      host: { hostId: project.hostId, platform: process.platform, env: this.hostEnvironment },
      projectPath: project.path,
      adapterId: stored.session.adapterId
    })
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

  /** 渐进加载的历史窗口:取 `sequence < before` 的最多 limit 条持久化事件(升序)。 */
  historyWindow(id: string, before: number | undefined, limit: number): EventsHistoryResponse {
    if (!this.repository.findById(id)) {
      throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    }
    const cursor = before ?? this.eventsRepository.maxSequence(id) + 1
    const candidates = this.eventsRepository.listBefore(id, cursor, limit + 1)
    const hasMore = candidates.length > limit
    // candidates 升序;slice(-limit) 取最新 limit 条,避免把最新一条丢给「探查」项。
    const events = hasMore ? candidates.slice(-limit) : candidates
    return {
      events: events.map((event) => ({ ...event })) as EventsHistoryResponse['events'],
      oldestSequence: events[0]?.sequence ?? 0,
      hasMore,
    }
  }

  /** 物化成品块分页:取 `sequence < before` 的最多 limit 条(升序),附已物化到的 head。 */
  itemsWindow(id: string, before: number | undefined, limit: number): SessionItemsResponse {
    if (!this.repository.findById(id)) {
      throw new GatewayHttpError(404, 'SESSION_NOT_FOUND', 'Session was not found')
    }
    // 首次访问回填:把历史(含存量会话)物化到 session_items,之后分页读成品。
    this.itemizer.ensureMaterialized(id)
    const cursor = before ?? Number.MAX_SAFE_INTEGER
    const candidates = this.itemsRepository.listBefore(id, cursor, limit + 1)
    const hasMore = candidates.length > limit
    // candidates 升序;slice(-limit) 取最新 limit 条,避免把最新一条丢给「探查」项。
    const items = hasMore ? candidates.slice(-limit) : candidates
    return {
      items,
      oldestSequence: items[0]?.sequence ?? 0,
      hasMore,
      headSequence: this.itemsRepository.headSequence(id),
    }
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
    if (live) this.persistSnapshot(live)
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
        this.persistSnapshot(snapshot)
      }
    } catch (error) {
      this.reportObserverError(error, sessionId)
    }
  }

  private refreshRuntimeSnapshots(projectId: string): void {
    for (const snapshot of this.runtime.listSessions(projectId)) {
      this.persistSnapshot(snapshot)
    }
  }

  private persistSnapshot(snapshot: ReturnType<RuntimeSessionManager['getSession']>): void {
    this.repository.updateSnapshot(
      snapshot.session,
      snapshot.capabilities,
      snapshot.taskState,
      snapshot.subagentRuns,
      snapshot.inputQueue
    )
  }

  private repairDurableProjections(): void {
    for (const stored of this.repository.listAll()) {
      const events = this.eventsRepository.listAfter(stored.session.id)
      if (events.length === 0) continue
      const durable = projectDurableRuntimeState(events)
      this.repository.updateSnapshot(
        stored.session,
        stored.capabilities,
        stored.taskState,
        durable.subagentRuns,
        durable.inputQueue
      )
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

  private requireQueuedInput(id: string, inputId: string): SessionId {
    const sessionId = this.requireActive(id)
    const queued = this.runtime
      .getSession(sessionId)
      .inputQueue.some((entry) => entry.id === inputId)
    if (!queued) {
      throw new GatewayHttpError(404, 'QUEUED_INPUT_NOT_FOUND', 'Queued input was not found')
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
    subagentRuns: stored.subagentRuns,
    inputQueue: stored.inputQueue,
    status: session.status,
    ...(session.title ? { title: session.title } : {}),
    lastEventSequence: session.lastEventSequence,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }
}
