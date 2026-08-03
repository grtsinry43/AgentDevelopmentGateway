import { normalize, parse } from 'node:path'
import {
  adaptersResponseSchema,
  createProjectRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  closeSessionRequestSchema,
  controlReceiptSchema,
  forkSessionRequestSchema,
  gatewayErrorResponseSchema,
  gitCommitRequestSchema,
  gitCommitResponseSchema,
  gitDiffQuerySchema,
  gitDiffResponseSchema,
  gitEventSchema,
  gitPathsRequestSchema,
  gitRepositoryStateSchema,
  inputAdmissionReceiptSchema,
  listModelsQuerySchema,
  modelCatalogSchema,
  slashCommandsSchema,
  reorderQueuedInputsRequestSchema,
  replaceQueuedInputRequestSchema,
  interruptSessionRequestSchema,
  projectListResponseSchema,
  projectSchema,
  runtimeEventWireSchema,
  sendSessionInputRequestSchema,
  resolveInteractionRequestSchema,
  resumeSessionRequestSchema,
  setExecutionSettingsRequestSchema,
  setSessionModelRequestSchema,
  setSessionTitleRequestSchema,
  setWorkModeRequestSchema,
  hostDirectoryResponseSchema,
  serverInfoSchema,
  serverStatusSchema,
  sessionListResponseSchema,
  sessionSchema,
  workspaceDirectoryResponseSchema,
  workspaceFileContentResponseSchema,
  workspaceFileEventSchema,
  workspaceFileSubscriptionSchema,
  createTerminalRequestSchema,
  terminalDescriptorSchema,
  terminalListResponseSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type CloseSessionRequest,
  type ForkSessionRequest,
  type GatewayAdapterAvailability,
  type GatewayAdapterId,
  type GatewayModelCatalog,
  type GatewaySlashCommands,
  type GatewayProject,
  type GatewayServerInfo,
  type HostDirectoryResponse,
  type ServerStatus,
  type GatewaySession,
  type GitChangeArea,
  type GitCommitResponse,
  type GitDiffResponse,
  type GitEvent,
  type GitRepositoryState,
  type InputAdmissionReceipt,
  type ListModelsQuery,
  type ReorderQueuedInputsRequest,
  type ReplaceQueuedInputRequest,
  type InterruptSessionRequest,
  type ResolveInteractionRequest,
  type ResumeSessionRequest,
  type RuntimeControlReceipt,
  type RuntimeEventWire,
  type SendSessionInputRequest,
  type SetExecutionSettingsRequest,
  type SetSessionModelRequest,
  type SetSessionTitleRequest,
  type SetWorkModeRequest,
  type WorkspaceDirectoryResponse,
  type WorkspaceFileContentResponse,
  type WorkspaceFileEvent,
  eventsHistoryResponseSchema,
  type EventsHistoryResponse,
  sessionItemsResponseSchema,
  type SessionItemsResponse,
  type CreateTerminalRequest,
  type TerminalDescriptor
} from '@agent-gateway/shared'
import { net } from 'electron'

interface Schema<T> {
  parse(value: unknown): T
}

export const LOCAL_SERVER_URL = 'http://127.0.0.1:3000'

export class GatewayServerError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'GatewayServerError'
  }
}

export class GatewayServerClient {
  constructor(
    private readonly baseUrl = LOCAL_SERVER_URL,
    private readonly authToken?: string
  ) {}

  serverInfo(): Promise<GatewayServerInfo> {
    return this.request('/api/v1/server', serverInfoSchema)
  }

  /** 主机运行状态(资源占用 + 版本),远程连接状态面板用。 */
  serverStatus(): Promise<ServerStatus> {
    return this.request('/api/v1/server/status', serverStatusSchema)
  }

  /** 浏览主机目录(新建远程工程选工程根)。 */
  hostDirectory(path: string): Promise<HostDirectoryResponse> {
    return this.request(
      `/api/v1/host/files?path=${encodeURIComponent(path)}`,
      hostDirectoryResponseSchema
    )
  }

  /** 远程 server 启用 token 认证时,所有 /api 请求(含 WS upgrade)都要带。 */
  webSocketHeaders(): Record<string, string> {
    return this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}
  }

  async ensureProject(path: string, name?: string): Promise<GatewayProject> {
    const [server, listed] = await Promise.all([this.serverInfo(), this.listProjects()])
    const normalizedPath = normalizeProjectPath(path)
    const existing = listed.find(
      (project) => project.hostId === server.hostId && project.path === normalizedPath
    )
    if (existing) return existing

    try {
      return await this.request('/api/v1/projects', projectSchema, {
        method: 'POST',
        body: createProjectRequestSchema.parse({ path: normalizedPath, ...(name ? { name } : {}) })
      })
    } catch (error) {
      if (!(error instanceof GatewayServerError) || error.code !== 'PROJECT_CONFLICT') throw error
      const raced = (await this.listProjects()).find(
        (project) => project.hostId === server.hostId && project.path === normalizedPath
      )
      if (!raced) throw error
      return raced
    }
  }

  async listProjects(): Promise<GatewayProject[]> {
    return (await this.request('/api/v1/projects', projectListResponseSchema)).projects
  }

  async adapters(projectId: string): Promise<GatewayAdapterAvailability[]> {
    return (await this.request(`/api/v1/projects/${projectId}/agents`, adaptersResponseSchema))
      .adapters
  }

  projectModels(
    projectId: string,
    adapterId: GatewayAdapterId,
    query: ListModelsQuery = {}
  ): Promise<GatewayModelCatalog> {
    const parsed = listModelsQuerySchema.parse(query)
    const params = new URLSearchParams()
    if (parsed.installationPath) params.set('installationPath', parsed.installationPath)
    const suffix = params.size ? `?${params.toString()}` : ''
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(adapterId)}/models${suffix}`,
      modelCatalogSchema
    )
  }

  projectCommands(
    projectId: string,
    adapterId: GatewayAdapterId,
    query: ListModelsQuery = {}
  ): Promise<GatewaySlashCommands> {
    const parsed = listModelsQuerySchema.parse(query)
    const params = new URLSearchParams()
    if (parsed.installationPath) params.set('installationPath', parsed.installationPath)
    const suffix = params.size ? `?${params.toString()}` : ''
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(adapterId)}/commands${suffix}`,
      slashCommandsSchema
    )
  }

  async sessions(projectId: string): Promise<GatewaySession[]> {
    return (await this.request(`/api/v1/projects/${projectId}/sessions`, sessionListResponseSchema))
      .sessions
  }

  workspaceDirectory(projectId: string, path: string): Promise<WorkspaceDirectoryResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`,
      workspaceDirectoryResponseSchema
    )
  }

  workspaceFileContent(projectId: string, path: string): Promise<WorkspaceFileContentResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(path)}`,
      workspaceFileContentResponseSchema
    )
  }

  gitStatus(projectId: string): Promise<GitRepositoryState> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git`,
      gitRepositoryStateSchema
    )
  }

  gitDiff(projectId: string, path: string, area: GitChangeArea): Promise<GitDiffResponse> {
    const query = gitDiffQuerySchema.parse({ path, area })
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/diff?path=${encodeURIComponent(query.path)}&area=${encodeURIComponent(query.area)}`,
      gitDiffResponseSchema
    )
  }

  stageGit(projectId: string, paths: string[]): Promise<void> {
    return this.requestVoid(`/api/v1/projects/${encodeURIComponent(projectId)}/git/stage`, {
      method: 'POST',
      body: gitPathsRequestSchema.parse({ paths })
    })
  }

  unstageGit(projectId: string, paths: string[]): Promise<void> {
    return this.requestVoid(`/api/v1/projects/${encodeURIComponent(projectId)}/git/unstage`, {
      method: 'POST',
      body: gitPathsRequestSchema.parse({ paths })
    })
  }

  commitGit(projectId: string, message: string): Promise<GitCommitResponse> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/commit`,
      gitCommitResponseSchema,
      { method: 'POST', body: gitCommitRequestSchema.parse({ message }) }
    )
  }

  async *gitEvents(
    projectId: string,
    signal: AbortSignal,
    onOpen?: () => void
  ): AsyncGenerator<GitEvent> {
    const response = await net.fetch(
      `${this.baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/git/events`,
      { signal, headers: { accept: 'text/event-stream', ...this.webSocketHeaders() } }
    )
    if (!response.ok) throw await this.responseError(response)
    if (!response.body) throw new Error('Server returned an empty Git event stream')
    onOpen?.()
    yield* parseEventStream(response.body, gitEventSchema)
  }

  async terminals(projectId: string): Promise<TerminalDescriptor[]> {
    return (
      await this.request(
        `/api/v1/projects/${encodeURIComponent(projectId)}/terminals`,
        terminalListResponseSchema
      )
    ).terminals
  }

  createTerminal(projectId: string, input: CreateTerminalRequest): Promise<TerminalDescriptor> {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(projectId)}/terminals`,
      terminalDescriptorSchema,
      { method: 'POST', body: createTerminalRequestSchema.parse(input) }
    )
  }

  closeTerminal(terminalId: string): Promise<void> {
    return this.requestVoid(`/api/v1/terminals/${encodeURIComponent(terminalId)}`, {
      method: 'DELETE'
    })
  }

  terminalWebSocketUrl(terminalId: string): string {
    const url = new URL(
      `/api/v1/terminals/${encodeURIComponent(terminalId)}/attach`,
      this.baseUrl
    )
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  updateWorkspaceFileSubscription(
    projectId: string,
    subscriptionId: string,
    directories: string[]
  ): Promise<void> {
    return this.requestVoid(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: 'PUT', body: workspaceFileSubscriptionSchema.parse({ directories }) }
    )
  }

  async *workspaceFileEvents(
    projectId: string,
    subscriptionId: string,
    signal: AbortSignal,
    onOpen?: () => void
  ): AsyncGenerator<WorkspaceFileEvent> {
    const response = await net.fetch(
      `${this.baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/files/subscriptions/${encodeURIComponent(subscriptionId)}/events`,
      { signal, headers: { accept: 'text/event-stream', ...this.webSocketHeaders() } }
    )
    if (!response.ok) throw await this.responseError(response)
    if (!response.body) throw new Error('Server returned an empty workspace file event stream')
    onOpen?.()
    yield* parseEventStream(response.body, workspaceFileEventSchema)
  }

  session(sessionId: string): Promise<GatewaySession> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, sessionSchema)
  }

  sessionModels(sessionId: string): Promise<GatewayModelCatalog> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/models`,
      modelCatalogSchema
    )
  }

  sessionCommands(sessionId: string): Promise<GatewaySlashCommands> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      slashCommandsSchema
    )
  }

  createSession(projectId: string, input: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.request(
      `/api/v1/projects/${projectId}/sessions`,
      createSessionResponseSchema,
      { method: 'POST', body: createSessionRequestSchema.parse(input) }
    )
  }

  sendInput(sessionId: string, input: SendSessionInputRequest): Promise<InputAdmissionReceipt> {
    return this.request(`/api/v1/sessions/${sessionId}/inputs`, inputAdmissionReceiptSchema, {
      method: 'POST',
      body: sendSessionInputRequestSchema.parse(input)
    })
  }

  replaceQueuedInput(
    sessionId: string,
    inputId: string,
    input: ReplaceQueuedInputRequest
  ): Promise<void> {
    return this.requestVoid(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(inputId)}`,
      { method: 'PATCH', body: replaceQueuedInputRequestSchema.parse(input) }
    )
  }

  reorderQueuedInputs(sessionId: string, input: ReorderQueuedInputsRequest): Promise<void> {
    return this.requestVoid(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/input-queue/order`,
      { method: 'PUT', body: reorderQueuedInputsRequestSchema.parse(input) }
    )
  }

  cancelQueuedInput(sessionId: string, inputId: string): Promise<void> {
    return this.requestVoid(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(inputId)}`,
      { method: 'DELETE' }
    )
  }

  sendQueuedInputNow(sessionId: string, inputId: string): Promise<void> {
    return this.requestVoid(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(inputId)}/send`,
      { method: 'POST' }
    )
  }

  interruptSession(sessionId: string, input: InterruptSessionRequest): Promise<void> {
    return this.requestVoid(`/api/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
      body: interruptSessionRequestSchema.parse(input)
    })
  }

  resolveInteraction(
    sessionId: string,
    interactionId: string,
    input: ResolveInteractionRequest
  ): Promise<void> {
    return this.requestVoid(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/resolve`,
      { method: 'POST', body: resolveInteractionRequestSchema.parse(input) }
    )
  }

  closeSession(sessionId: string, input: CloseSessionRequest): Promise<RuntimeControlReceipt> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, controlReceiptSchema, {
      method: 'POST',
      body: closeSessionRequestSchema.parse(input)
    })
  }

  resumeSession(sessionId: string, input: ResumeSessionRequest): Promise<GatewaySession> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/resume`, sessionSchema, {
      method: 'POST',
      body: resumeSessionRequestSchema.parse(input)
    })
  }

  forkSession(sessionId: string, input: ForkSessionRequest): Promise<GatewaySession> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/forks`, sessionSchema, {
      method: 'POST',
      body: forkSessionRequestSchema.parse(input)
    })
  }

  setSessionTitle(sessionId: string, input: SetSessionTitleRequest): Promise<RuntimeControlReceipt> {
    return this.patchControl(sessionId, 'title', setSessionTitleRequestSchema.parse(input))
  }

  setSessionModel(sessionId: string, input: SetSessionModelRequest): Promise<RuntimeControlReceipt> {
    return this.patchControl(sessionId, 'model', setSessionModelRequestSchema.parse(input))
  }

  setWorkMode(sessionId: string, input: SetWorkModeRequest): Promise<RuntimeControlReceipt> {
    return this.patchControl(sessionId, 'work-mode', setWorkModeRequestSchema.parse(input))
  }

  setExecutionSettings(
    sessionId: string,
    input: SetExecutionSettingsRequest
  ): Promise<RuntimeControlReceipt> {
    return this.patchControl(
      sessionId,
      'execution-settings',
      setExecutionSettingsRequestSchema.parse(input)
    )
  }

  async *events(
    sessionId: string,
    afterSequence: number,
    signal: AbortSignal,
    callbacks: { onOpen?: () => void; onActivity?: () => void } = {}
  ): AsyncGenerator<RuntimeEventWire> {
    const response = await net.fetch(
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSequence}`,
      { signal, headers: { accept: 'text/event-stream', ...this.webSocketHeaders() } }
    )
    if (!response.ok) throw await this.responseError(response)
    if (!response.body) throw new Error('Server returned an empty Session event stream')

    callbacks.onOpen?.()
    yield* parseEventStream(response.body, runtimeEventWireSchema, callbacks.onActivity)
  }

  /** 渐进加载:取 `sequence < before` 的最多 limit 条持久化事件(升序)。 */
  eventsHistory(sessionId: string, before: number | undefined, limit: number): Promise<EventsHistoryResponse> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (before !== undefined) query.set('before', String(before))
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events/history?${query.toString()}`,
      eventsHistoryResponseSchema
    )
  }

  /** 渐进加载:物化成品块分页(读 read model)。 */
  async sessionItems(
    sessionId: string,
    before: number | undefined,
    limit: number
  ): Promise<SessionItemsResponse> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (before !== undefined) query.set('before', String(before))
    return (await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/items?${query.toString()}`,
      sessionItemsResponseSchema
    )) as SessionItemsResponse
  }

  private async request<T>(
    path: string,
    schema: Schema<T>,
    options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown } = {}
  ): Promise<T> {
    const response = await net.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      ...(options.body === undefined
        ? { headers: { ...this.webSocketHeaders() } }
        : {
            headers: { 'content-type': 'application/json', ...this.webSocketHeaders() },
            body: JSON.stringify(options.body)
          })
    })
    if (!response.ok) throw await this.responseError(response)
    return schema.parse(await response.json())
  }

  private async requestVoid(
    path: string,
    options: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }
  ): Promise<void> {
    const response = await net.fetch(`${this.baseUrl}${path}`, {
      method: options.method,
      ...(options.body === undefined
        ? { headers: { ...this.webSocketHeaders() } }
        : {
            headers: { 'content-type': 'application/json', ...this.webSocketHeaders() },
            body: JSON.stringify(options.body)
          })
    })
    if (!response.ok) throw await this.responseError(response)
  }

  private patchControl(
    sessionId: string,
    resource: string,
    body: unknown
  ): Promise<RuntimeControlReceipt> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/${resource}`,
      controlReceiptSchema,
      { method: 'PATCH', body }
    )
  }

  private async responseError(response: Response): Promise<Error> {
    const payload: unknown = await response.json().catch(() => undefined)
    const parsed = gatewayErrorResponseSchema.safeParse(payload)
    if (parsed.success) {
      return new GatewayServerError(response.status, parsed.data.error.code, parsed.data.error.message)
    }
    return new GatewayServerError(
      response.status,
      'INVALID_SERVER_RESPONSE',
      `Gateway Server returned HTTP ${response.status}`
    )
  }
}

async function* parseEventStream<T>(
  stream: ReadableStream<Uint8Array>,
  schema: Schema<T>,
  onActivity?: () => void
): AsyncGenerator<T> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true }).replaceAll('\r\n', '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        onActivity?.()
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield schema.parse(JSON.parse(data))
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function normalizeProjectPath(value: string): string {
  const normalized = normalize(value)
  return normalized === parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/, '')
}
