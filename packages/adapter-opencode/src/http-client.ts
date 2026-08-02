import { AdapterError } from '@agent-gateway/core'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

export class OpenCodeHttpClient {
  constructor(readonly baseUrl: string) {}

  async json(path: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.request(path, options)
    try {
      return await response.json()
    } catch (error) {
      throw protocolError(`OpenCode ${options.method ?? 'GET'} ${path} returned invalid JSON`, error)
    }
  }

  async void(path: string, options: RequestOptions): Promise<void> {
    await this.request(path, options)
  }

  async stream(path: string, options: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request(path, {
      ...options,
      signal: options.signal,
    }, { accept: 'text/event-stream' })
    if (!response.body) {
      throw protocolError(`OpenCode ${options.method ?? 'GET'} ${path} returned no SSE body`)
    }
    return response.body
  }

  private async request(
    path: string,
    options: RequestOptions,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    let response: Response
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          ...extraHeaders,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new AdapterError({
        code: 'connection',
        layer: 'transport',
        retriable: true,
        message: `OpenCode ${options.method ?? 'GET'} ${url.pathname} disconnected: ${errorMessage(error)}`,
      })
    }
    if (!response.ok) throw await httpError(response, url.pathname)
    return response
  }
}

async function httpError(response: Response, path: string): Promise<AdapterError> {
  const body = await response.text()
  return new AdapterError({
    code: response.status === 404 ? 'connection' : 'protocol',
    layer: 'transport',
    nativeCode: `opencode.http.${response.status}`,
    retriable: response.status >= 500,
    message:
      body ||
      (response.status === 404
        ? `OpenCode v2 route not found: ${path}`
        : `OpenCode returned HTTP ${response.status} for ${path}`),
  })
}

function protocolError(message: string, cause?: unknown): AdapterError {
  return new AdapterError({
    code: 'protocol',
    layer: 'transport',
    message: cause === undefined ? message : `${message}: ${errorMessage(cause)}`,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
