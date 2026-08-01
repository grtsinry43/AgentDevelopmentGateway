import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface RpcMessage {
  jsonrpc?: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface ServerRequest extends RpcMessage {
  id: number
  method: string
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
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
    lines.on('line', (line) => this.handleLine(line))
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
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch(
        (error: unknown) => {
          this.pending.delete(id)
          reject(toError(error))
        },
      )
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 5_000)
      this.child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    this.terminate(new Error('Codex app-server closed'))
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
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      void this.replyToServerRequest(message as ServerRequest)
      return
    }
    if (typeof message.method === 'string') this.onNotification(message)
  }

  private async replyToServerRequest(request: ServerRequest): Promise<void> {
    try {
      const result = await this.onServerRequest(request)
      await this.write({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      await this.write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32_000, message: toError(error).message },
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
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.onClose(error)
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
