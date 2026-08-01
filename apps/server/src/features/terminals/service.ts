import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { SerializeAddon } from '@xterm/addon-serialize'
import headlessPackage from '@xterm/headless'
import type { Terminal as HeadlessTerminalInstance } from '@xterm/headless'
import type {
  CreateTerminalRequest,
  TerminalDescriptor,
  TerminalServerMessage
} from '@agent-gateway/shared'
import { GatewayHttpError } from '../../http/errors.js'
import { TerminalOutputBuffer, type TerminalOutputChunk } from './output-buffer.js'
import {
  NodePtyFactory,
  type TerminalPty,
  type TerminalPtyDisposable,
  type TerminalPtyFactory
} from './pty.js'

const HeadlessTerminal = (
  headlessPackage as unknown as { Terminal: typeof import('@xterm/headless').Terminal }
).Terminal

export const TERMINAL_OUTPUT_BUFFER_BYTES = 2 * 1024 * 1024
export const TERMINAL_RETENTION_MS = 30 * 60 * 1000
export const TERMINAL_SCROLLBACK_ROWS = 10_000
export const TERMINAL_HIGH_WATERMARK_CHARS = 100_000
export const TERMINAL_LOW_WATERMARK_CHARS = 5_000
export const TERMINAL_TAKEN_OVER_CLOSE_CODE = 4001
export const TERMINAL_NOT_FOUND_CLOSE_CODE = 4004

export interface TerminalAttachment {
  send(message: TerminalServerMessage): void
  close(code: number, reason: string): void
}

export interface TerminalScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

interface DeliveredChunk {
  sequence: number
  chars: number
}

interface ActiveAttachment {
  transport: TerminalAttachment
  ready: boolean
  delivered: DeliveredChunk[]
  unacknowledgedChars: number
}

interface TerminalSession {
  descriptor: TerminalDescriptor
  pty: TerminalPty
  headless: HeadlessTerminalInstance
  serializer: SerializeAddon
  output: TerminalOutputBuffer
  sequence: number
  queue: Promise<void>
  paused: boolean
  disposables: TerminalPtyDisposable[]
  attachment?: ActiveAttachment
  retentionTimer?: unknown
}

export interface TerminalServiceOptions {
  projects: TerminalProjectService
  environment: Record<string, string>
  ptyFactory?: TerminalPtyFactory
  scheduler?: TerminalScheduler
  retentionMs?: number
  outputBufferBytes?: number
  scrollbackRows?: number
  highWatermarkChars?: number
  lowWatermarkChars?: number
}

export interface TerminalProjectService {
  require(id: string): unknown
  get(id: string): Promise<{
    path: string
    availability: 'available' | 'missing' | 'unreachable'
  }>
}

const defaultScheduler: TerminalScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly nextOrdinalByProject = new Map<string, number>()
  private readonly ptyFactory: TerminalPtyFactory
  private readonly scheduler: TerminalScheduler
  private readonly retentionMs: number
  private readonly outputBufferBytes: number
  private readonly scrollbackRows: number
  private readonly highWatermarkChars: number
  private readonly lowWatermarkChars: number

  constructor(private readonly options: TerminalServiceOptions) {
    this.ptyFactory = options.ptyFactory ?? new NodePtyFactory()
    this.scheduler = options.scheduler ?? defaultScheduler
    this.retentionMs = options.retentionMs ?? TERMINAL_RETENTION_MS
    this.outputBufferBytes = options.outputBufferBytes ?? TERMINAL_OUTPUT_BUFFER_BYTES
    this.scrollbackRows = options.scrollbackRows ?? TERMINAL_SCROLLBACK_ROWS
    this.highWatermarkChars = options.highWatermarkChars ?? TERMINAL_HIGH_WATERMARK_CHARS
    this.lowWatermarkChars = options.lowWatermarkChars ?? TERMINAL_LOW_WATERMARK_CHARS
    if (this.lowWatermarkChars >= this.highWatermarkChars) {
      throw new Error('Terminal low watermark must be smaller than the high watermark')
    }
  }

  list(projectId: string): TerminalDescriptor[] {
    this.options.projects.require(projectId)
    return [...this.sessions.values()]
      .filter((session) => session.descriptor.projectId === projectId)
      .sort((left, right) => left.descriptor.createdAt - right.descriptor.createdAt)
      .map((session) => ({ ...session.descriptor }))
  }

  async create(projectId: string, input: CreateTerminalRequest): Promise<TerminalDescriptor> {
    const project = await this.options.projects.get(projectId)
    if (project.availability !== 'available') {
      throw new GatewayHttpError(409, 'PROJECT_UNAVAILABLE', 'Project path is not available')
    }

    const shell = defaultShell(this.options.environment)
    const now = Date.now()
    const ordinal = (this.nextOrdinalByProject.get(projectId) ?? 0) + 1
    this.nextOrdinalByProject.set(projectId, ordinal)
    const descriptor: TerminalDescriptor = {
      id: randomUUID(),
      projectId,
      title: `${basename(shell)} ${ordinal}`,
      shell,
      cwd: project.path,
      status: 'running',
      cols: input.cols,
      rows: input.rows,
      createdAt: now,
      updatedAt: now
    }
    const pty = this.ptyFactory.spawn({
      shell,
      args: [],
      cwd: project.path,
      env: terminalEnvironment(this.options.environment),
      cols: input.cols,
      rows: input.rows,
      name: 'xterm-256color'
    })
    const headless = new HeadlessTerminal({
      cols: input.cols,
      rows: input.rows,
      scrollback: this.scrollbackRows,
      // SerializeAddon reads the public buffer API, which xterm marks as proposed.
      allowProposedApi: true
    })
    const serializer = new SerializeAddon()
    headless.loadAddon(serializer)
    const session: TerminalSession = {
      descriptor,
      pty,
      headless,
      serializer,
      output: new TerminalOutputBuffer(this.outputBufferBytes),
      sequence: 0,
      queue: Promise.resolve(),
      paused: false,
      disposables: []
    }
    session.disposables.push(
      pty.onData((data) => this.enqueue(session, () => this.recordOutput(session, data))),
      pty.onExit((event) =>
        this.enqueue(session, () => this.recordExit(session, event.exitCode, event.signal))
      )
    )
    this.sessions.set(descriptor.id, session)
    return { ...descriptor }
  }

  close(terminalId: string): void {
    this.disposeSession(this.require(terminalId), 1000, 'terminal_closed', true)
  }

  attach(
    terminalId: string,
    transport: TerminalAttachment,
    afterSequence: number | undefined,
    cols: number,
    rows: number
  ): Promise<void> {
    const session = this.require(terminalId)
    return this.enqueue(session, async () => {
      if (!this.sessions.has(terminalId)) {
        transport.close(TERMINAL_NOT_FOUND_CLOSE_CODE, 'terminal_not_found')
        return
      }
      if (session.attachment?.transport !== transport) {
        this.releaseAttachment(session, TERMINAL_TAKEN_OVER_CLOSE_CODE, 'terminal_taken_over')
      }
      session.attachment = { transport, ready: true, delivered: [], unacknowledgedChars: 0 }
      this.clearRetention(session)
      this.resizeSession(session, cols, rows)
      const replay =
        afterSequence === undefined
          ? undefined
          : session.output.after(afterSequence, session.sequence)
      if (replay) {
        transport.send({
          type: 'terminal.ready',
          terminal: { ...session.descriptor },
          sequence: afterSequence ?? session.sequence
        })
        for (const chunk of replay) this.deliver(session, chunk)
      } else {
        transport.send({
          type: 'terminal.snapshot',
          terminal: { ...session.descriptor },
          sequence: session.sequence,
          data: session.serializer.serialize({ scrollback: this.scrollbackRows })
        })
      }
      if (session.descriptor.status === 'exited') {
        transport.send({
          type: 'terminal.exit',
          exitCode: session.descriptor.exitCode ?? null,
          signal: session.descriptor.signal ?? null
        })
        this.releaseAttachment(session, 1000, 'terminal_exited')
        this.scheduleRetention(session)
      }
    })
  }

  detach(terminalId: string, transport: TerminalAttachment): void {
    const session = this.sessions.get(terminalId)
    if (!session || session.attachment?.transport !== transport) return
    this.releaseAttachment(session)
    this.scheduleRetention(session)
  }

  write(terminalId: string, transport: TerminalAttachment, data: string): void {
    const session = this.requireController(terminalId, transport)
    if (session.descriptor.status === 'running') session.pty.write(data)
  }

  resize(
    terminalId: string,
    transport: TerminalAttachment,
    cols: number,
    rows: number
  ): void {
    const session = this.requireController(terminalId, transport)
    this.enqueue(session, () => {
      if (this.sessions.has(terminalId)) this.resizeSession(session, cols, rows)
    })
  }

  acknowledge(terminalId: string, transport: TerminalAttachment, sequence: number): void {
    const session = this.requireController(terminalId, transport)
    if (sequence > session.sequence) return
    const attachment = session.attachment
    if (!attachment || !attachment.ready) return
    let removedChars = 0
    while (attachment.delivered[0] && attachment.delivered[0].sequence <= sequence) {
      removedChars += attachment.delivered.shift()?.chars ?? 0
    }
    attachment.unacknowledgedChars = Math.max(0, attachment.unacknowledgedChars - removedChars)
    if (session.paused && attachment.unacknowledgedChars <= this.lowWatermarkChars) {
      session.pty.resume()
      session.paused = false
    }
  }

  shutdown(): void {
    for (const session of [...this.sessions.values()]) {
      this.disposeSession(session, 1001, 'server_shutdown', true)
    }
  }

  private enqueue(session: TerminalSession, operation: () => void | Promise<void>): Promise<void> {
    const next = session.queue.then(operation)
    session.queue = next.catch(() => undefined)
    return next
  }

  private recordOutput(session: TerminalSession, data: string): Promise<void> {
    if (!this.sessions.has(session.descriptor.id) || data.length === 0) return Promise.resolve()
    return new Promise((resolve) => {
      session.headless.write(data, () => {
        if (this.sessions.has(session.descriptor.id)) {
          session.sequence += 1
          const chunk = session.output.append(session.sequence, data)
          if (chunk) this.deliver(session, chunk)
        }
        resolve()
      })
    })
  }

  private recordExit(session: TerminalSession, exitCode: number, signal?: number): void {
    if (!this.sessions.has(session.descriptor.id)) return
    session.descriptor = {
      ...session.descriptor,
      status: 'exited',
      exitCode,
      signal: signal ?? null,
      updatedAt: Date.now()
    }
    session.attachment?.transport.send({
      type: 'terminal.exit',
      exitCode,
      signal: signal ?? null
    })
    this.releaseAttachment(session, 1000, 'terminal_exited')
    this.scheduleRetention(session)
  }

  private deliver(session: TerminalSession, chunk: TerminalOutputChunk): void {
    const attachment = session.attachment
    if (!attachment || !attachment.ready) return
    attachment.transport.send({
      type: 'terminal.output',
      sequence: chunk.sequence,
      data: chunk.data
    })
    attachment.delivered.push({ sequence: chunk.sequence, chars: chunk.chars })
    attachment.unacknowledgedChars += chunk.chars
    if (!session.paused && attachment.unacknowledgedChars >= this.highWatermarkChars) {
      session.pty.pause()
      session.paused = true
    }
  }

  private resizeSession(session: TerminalSession, cols: number, rows: number): void {
    if (session.descriptor.cols === cols && session.descriptor.rows === rows) return
    session.headless.resize(cols, rows)
    if (session.descriptor.status === 'running') session.pty.resize(cols, rows)
    session.descriptor = { ...session.descriptor, cols, rows, updatedAt: Date.now() }
  }

  private require(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId)
    if (!session) throw new GatewayHttpError(404, 'TERMINAL_NOT_FOUND', 'Terminal was not found')
    return session
  }

  private requireController(terminalId: string, transport: TerminalAttachment): TerminalSession {
    const session = this.require(terminalId)
    if (session.attachment?.transport !== transport) {
      throw new GatewayHttpError(409, 'TERMINAL_NOT_ATTACHED', 'Terminal is not attached')
    }
    return session
  }

  private releaseAttachment(session: TerminalSession, code?: number, reason?: string): void {
    const attachment = session.attachment
    if (!attachment) return
    session.attachment = undefined
    if (code !== undefined && reason !== undefined) attachment.transport.close(code, reason)
    if (session.paused) {
      session.pty.resume()
      session.paused = false
    }
  }

  private scheduleRetention(session: TerminalSession): void {
    if (session.attachment || session.retentionTimer !== undefined) return
    session.retentionTimer = this.scheduler.setTimeout(() => {
      session.retentionTimer = undefined
      if (!session.attachment && this.sessions.has(session.descriptor.id)) {
        this.disposeSession(session, 1000, 'terminal_expired', true)
      }
    }, this.retentionMs)
  }

  private clearRetention(session: TerminalSession): void {
    if (session.retentionTimer === undefined) return
    this.scheduler.clearTimeout(session.retentionTimer)
    session.retentionTimer = undefined
  }

  private disposeSession(
    session: TerminalSession,
    closeCode: number,
    closeReason: string,
    kill: boolean
  ): void {
    if (!this.sessions.delete(session.descriptor.id)) return
    this.clearRetention(session)
    this.releaseAttachment(session, closeCode, closeReason)
    for (const disposable of session.disposables) disposable.dispose()
    session.disposables.length = 0
    session.serializer.dispose()
    session.headless.dispose()
    if (kill && session.descriptor.status === 'running') {
      try {
        session.pty.kill()
      } catch {
        // The process may have exited between the status check and kill.
      }
    }
  }
}

function defaultShell(environment: Record<string, string>): string {
  return process.platform === 'win32'
    ? (environment.COMSPEC ?? 'cmd.exe')
    : (environment.SHELL ?? '/bin/sh')
}

function terminalEnvironment(environment: Record<string, string>): Record<string, string> {
  return { ...environment, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}
