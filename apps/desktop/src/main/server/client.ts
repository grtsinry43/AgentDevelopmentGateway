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
  inputAdmissionReceiptSchema,
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
  serverInfoSchema,
  sessionListResponseSchema,
  sessionSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type CloseSessionRequest,
  type ForkSessionRequest,
  type GatewayAdapterAvailability,
  type GatewayProject,
  type GatewayServerInfo,
  type GatewaySession,
  type InputAdmissionReceipt,
  type InterruptSessionRequest,
  type ResolveInteractionRequest,
  type ResumeSessionRequest,
  type RuntimeControlReceipt,
  type RuntimeEventWire,
  type SendSessionInputRequest,
  type SetExecutionSettingsRequest,
  type SetSessionModelRequest,
  type SetSessionTitleRequest,
  type SetWorkModeRequest
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
  constructor(private readonly baseUrl = LOCAL_SERVER_URL) {}

  serverInfo(): Promise<GatewayServerInfo> {
    return this.request('/api/v1/server', serverInfoSchema)
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

  async sessions(projectId: string): Promise<GatewaySession[]> {
    return (await this.request(`/api/v1/projects/${projectId}/sessions`, sessionListResponseSchema))
      .sessions
  }

  session(sessionId: string): Promise<GatewaySession> {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, sessionSchema)
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
    onOpen?: () => void
  ): AsyncGenerator<RuntimeEventWire> {
    const response = await net.fetch(
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSequence}`,
      { signal, headers: { accept: 'text/event-stream' } }
    )
    if (!response.ok) throw await this.responseError(response)
    if (!response.body) throw new Error('Server returned an empty Session event stream')

    onOpen?.()
    yield* parseEventStream(response.body)
  }

  private async request<T>(
    path: string,
    schema: Schema<T>,
    options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {}
  ): Promise<T> {
    const response = await net.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      ...(options.body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options.body)
          })
    })
    if (!response.ok) throw await this.responseError(response)
    return schema.parse(await response.json())
  }

  private async requestVoid(
    path: string,
    options: { method: 'POST' | 'PATCH'; body?: unknown }
  ): Promise<void> {
    const response = await net.fetch(`${this.baseUrl}${path}`, {
      method: options.method,
      ...(options.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) })
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

async function* parseEventStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<RuntimeEventWire> {
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
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield runtimeEventWireSchema.parse(JSON.parse(data))
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
