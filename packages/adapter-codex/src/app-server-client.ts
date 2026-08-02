import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type RequestId = string | number

export interface RpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface RpcMessage {
  id?: RequestId
  method?: string
  params?: unknown
  result?: unknown
  error?: RpcErrorBody
}

export interface ServerRequest extends RpcMessage {
  id: RequestId
  method: string
}

export class CodexRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(error: RpcErrorBody) {
    super(error.message)
    this.name = 'CodexRpcError'
    this.code = error.code
    if (error.data !== undefined) this.data = error.data
  }
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private nextId = 1
  private closed = false
  private stderr = ''

  constructor(
    executable: string,
    env: Record<string, string | undefined>,
    private readonly onNotification: (message: RpcMessage) => void,
    private readonly onServerRequest: (request: ServerRequest) => Promise<unknown>,
    private readonly onClose: (error: Error) => void,
  ) {
    this.child = spawn(executable, ['app-server'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8')
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      try {
        this.handleLine(line)
      } catch (error) {
        this.terminate(toError(error))
      }
    })
    this.child.once('error', (error) => this.terminate(error))
    this.child.once('exit', (code, signal) => {
      this.terminate(
        new Error(
          `Codex app-server exited (${code ?? signal ?? 'unknown'})${this.stderr ? `: ${this.stderr}` : ''}`,
        ),
      )
    })
  }

  async initialize(version: string): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'agent-development-gateway', title: 'Agent Gateway', version },
      capabilities: { experimentalApi: true },
    })
    await this.notify('initialized')
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject })
      this.write({ id, method, ...(params === undefined ? {} : { params }) }).catch(
        (error: unknown) => {
          this.pending.delete(String(id))
          reject(toError(error))
        },
      )
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'))
    return this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const closeError = new Error('Codex app-server closed')
    this.rejectPending(closeError)
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        this.child.kill('SIGKILL')
        forceTimeout = setTimeout(resolve, 1_000)
      }, 5_000)
      let forceTimeout: NodeJS.Timeout | undefined
      this.child.once('exit', () => {
        clearTimeout(timeout)
        if (forceTimeout) clearTimeout(forceTimeout)
        resolve()
      })
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    let message: RpcMessage
    try {
      message = JSON.parse(trimmed) as RpcMessage
    } catch {
      return
    }
    if (isRequestId(message.id) && !message.method) {
      const key = String(message.id)
      const pending = this.pending.get(key)
      if (!pending) return
      this.pending.delete(key)
      if (message.error) pending.reject(new CodexRpcError(message.error))
      else pending.resolve(message.result)
      return
    }
    if (isRequestId(message.id) && typeof message.method === 'string') {
      void this.replyToServerRequest(message as ServerRequest).catch((error: unknown) => {
        this.terminate(toError(error))
      })
      return
    }
    if (typeof message.method === 'string') this.onNotification(message)
  }

  private async replyToServerRequest(request: ServerRequest): Promise<void> {
    try {
      const result = await this.onServerRequest(request)
      await this.write({ id: request.id, result })
    } catch (error) {
      await this.write({
        id: request.id,
        error: rpcErrorFrom(error),
      })
    }
  }

  private write(message: RpcMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  private terminate(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(error)
    this.onClose(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function rpcErrorFrom(value: unknown): RpcErrorBody {
  if (value instanceof CodexRpcError) {
    return {
      code: value.code,
      message: value.message,
      ...(value.data === undefined ? {} : { data: value.data }),
    }
  }
  const error = toError(value)
  return { code: -32_000, message: error.message }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
