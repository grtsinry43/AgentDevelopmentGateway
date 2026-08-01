import type { GatewaySession, RuntimeEventWire } from '@agent-gateway/shared'
import { PUSH_CHANNEL, type PushEvent } from '../../contract/bridge.js'

interface ActiveStream {
  controller: AbortController
  task: Promise<void>
}

export interface SessionStreamClient {
  session(sessionId: string): Promise<Pick<GatewaySession, 'status'>>
  events(
    sessionId: string,
    afterSequence: number,
    signal: AbortSignal,
    callbacks?: { onOpen?: () => void; onActivity?: () => void }
  ): AsyncIterable<RuntimeEventWire>
}

export interface StreamContents {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  send(channel: string, event: PushEvent): void
}

export interface SessionStreamRetryOptions {
  fastRetryDelaysMs: readonly number[]
  slowRetryDelayMs: number
}

const DEFAULT_RETRY_OPTIONS: SessionStreamRetryOptions = {
  fastRetryDelaysMs: [500, 1_000, 2_000, 4_000, 8_000],
  slowRetryDelayMs: 15_000
}

/** Owns one resumable event stream for each renderer and selected Session. */
export class SessionStreamRegistry {
  private readonly active = new Map<string, ActiveStream>()
  private readonly observedWebContents = new Set<number>()

  constructor(
    private readonly client: SessionStreamClient,
    private readonly retry: SessionStreamRetryOptions = DEFAULT_RETRY_OPTIONS
  ) {}

  watch(contents: StreamContents, sessionId: string, afterSequence: number): void {
    const key = streamKey(contents.id, sessionId)
    this.active.get(key)?.controller.abort()

    const controller = new AbortController()
    this.observeDestruction(contents)
    this.send(contents, { kind: 'session.stream', sessionId, state: 'connecting' })

    const entry: ActiveStream = {
      controller,
      task: this.consume(contents, sessionId, afterSequence, controller.signal).finally(() => {
        if (this.active.get(key) === entry) this.active.delete(key)
      })
    }
    this.active.set(key, entry)
  }

  unwatch(contents: StreamContents, sessionId: string): void {
    this.active.get(streamKey(contents.id, sessionId))?.controller.abort()
  }

  private async consume(
    contents: StreamContents,
    sessionId: string,
    afterSequence: number,
    signal: AbortSignal
  ): Promise<void> {
    let cursor = afterSequence
    let consecutiveFailures = 0

    while (!signal.aborted) {
      try {
        for await (const event of this.client.events(sessionId, cursor, signal, {
          onOpen: () => {
            this.send(contents, { kind: 'session.stream', sessionId, state: 'connected' })
          },
          onActivity: () => {
            consecutiveFailures = 0
          }
        })) {
          consecutiveFailures = 0
          cursor = Math.max(cursor, event.sequence)
          this.send(contents, { kind: 'session.event', event })
          if (isClosedSessionEvent(event)) {
            this.send(contents, { kind: 'session.stream', sessionId, state: 'closed' })
            return
          }
        }
        if (signal.aborted) return

        const session = await this.client.session(sessionId)
        if (!isLiveSessionStatus(session.status)) {
          this.send(contents, { kind: 'session.stream', sessionId, state: 'closed' })
          return
        }
        throw new Error('Session event stream closed unexpectedly')
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return
        if (!isRetryable(error)) {
          this.send(contents, {
            kind: 'session.stream',
            sessionId,
            state: 'error',
            message: errorMessage(error)
          })
          return
        }

        consecutiveFailures += 1
        const delay = retryDelay(consecutiveFailures, this.retry)
        const slowRetry = consecutiveFailures > this.retry.fastRetryDelaysMs.length
        this.send(contents, {
          kind: 'session.stream',
          sessionId,
          state: 'retrying',
          message: slowRetry
            ? `${errorMessage(error)}；实时事件流仍未恢复，将在后台继续重连`
            : `${errorMessage(error)}；正在尝试重新连接实时事件流`,
          attempt: consecutiveFailures,
          retryAt: Date.now() + delay
        })
        if (!(await waitForRetry(delay, signal))) return
      }
    }
  }

  private observeDestruction(contents: StreamContents): void {
    if (this.observedWebContents.has(contents.id)) return
    this.observedWebContents.add(contents.id)
    contents.once('destroyed', () => {
      this.observedWebContents.delete(contents.id)
      const prefix = `${contents.id}:`
      for (const [key, entry] of this.active) {
        if (key.startsWith(prefix)) entry.controller.abort()
      }
    })
  }

  private send(contents: StreamContents, event: PushEvent): void {
    if (!contents.isDestroyed()) contents.send(PUSH_CHANNEL, event)
  }
}

function streamKey(webContentsId: number, sessionId: string): string {
  return `${webContentsId}:${sessionId}`
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRetryable(error: unknown): boolean {
  return !(
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SESSION_NOT_FOUND'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Session event stream failed'
}

function isClosedSessionEvent(event: { type: string; payload: unknown }): boolean {
  return (
    event.type === 'session.status_changed' &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    'status' in event.payload &&
    event.payload.status === 'closed'
  )
}

function isLiveSessionStatus(status: GatewaySession['status']): boolean {
  return status === 'starting' || status === 'idle' || status === 'running' || status === 'waiting'
}

function retryDelay(attempt: number, options: SessionStreamRetryOptions): number {
  if (attempt > options.fastRetryDelaysMs.length) return options.slowRetryDelayMs
  return options.fastRetryDelaysMs[attempt - 1] ?? options.slowRetryDelayMs
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve(true)
    }, delayMs)
    const abort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
