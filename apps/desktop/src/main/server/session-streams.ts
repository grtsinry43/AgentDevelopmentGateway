import type { WebContents } from 'electron'
import { PUSH_CHANNEL, type PushEvent } from '../../contract/bridge.js'
import { gatewayServer } from './gateway.js'

interface ActiveStream {
  controller: AbortController
  task: Promise<void>
}

/**
 * A stream belongs to one renderer and one Session. The main process owns the network
 * connection so renderer reloads and window destruction cannot leave orphaned requests.
 */
class SessionStreamRegistry {
  private readonly active = new Map<string, ActiveStream>()
  private readonly observedWebContents = new Set<number>()

  watch(contents: WebContents, sessionId: string, afterSequence: number): void {
    const key = streamKey(contents.id, sessionId)
    this.active.get(key)?.controller.abort()

    const controller = new AbortController()
    this.observeDestruction(contents)
    this.send(contents, {
      kind: 'session.stream',
      sessionId,
      state: 'connecting'
    })

    const entry: ActiveStream = {
      controller,
      task: this.consume(contents, sessionId, afterSequence, controller.signal).finally(() => {
        if (this.active.get(key) === entry) this.active.delete(key)
      })
    }
    this.active.set(key, entry)
  }

  unwatch(contents: WebContents, sessionId: string): void {
    this.active.get(streamKey(contents.id, sessionId))?.controller.abort()
  }

  private async consume(
    contents: WebContents,
    sessionId: string,
    afterSequence: number,
    signal: AbortSignal
  ): Promise<void> {
    try {
      for await (const event of gatewayServer.events(sessionId, afterSequence, signal, () => {
        this.send(contents, { kind: 'session.stream', sessionId, state: 'connected' })
      })) {
        this.send(contents, { kind: 'session.event', event })
      }
      if (!signal.aborted) {
        this.send(contents, { kind: 'session.stream', sessionId, state: 'closed' })
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return
      this.send(contents, {
        kind: 'session.stream',
        sessionId,
        state: 'error',
        message: error instanceof Error ? error.message : 'Session event stream failed'
      })
    }
  }

  private observeDestruction(contents: WebContents): void {
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

  private send(contents: WebContents, event: PushEvent): void {
    if (!contents.isDestroyed()) contents.send(PUSH_CHANNEL, event)
  }
}

function streamKey(webContentsId: number, sessionId: string): string {
  return `${webContentsId}:${sessionId}`
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export const sessionStreams = new SessionStreamRegistry()
