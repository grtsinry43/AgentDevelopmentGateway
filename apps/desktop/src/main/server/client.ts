import { normalize, parse } from 'node:path'
import {
  adaptersResponseSchema,
  createProjectRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  gatewayErrorResponseSchema,
  inputAdmissionReceiptSchema,
  projectListResponseSchema,
  projectSchema,
  runtimeEventWireSchema,
  sendSessionInputRequestSchema,
  serverInfoSchema,
  sessionListResponseSchema,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type GatewayAdapterAvailability,
  type GatewayProject,
  type GatewayServerInfo,
  type GatewaySession,
  type InputAdmissionReceipt,
  type RuntimeEventWire,
  type SendSessionInputRequest
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
    options: { method?: 'GET' | 'POST'; body?: unknown } = {}
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
