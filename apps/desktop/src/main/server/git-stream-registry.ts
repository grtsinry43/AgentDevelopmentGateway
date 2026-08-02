import type { GitEvent } from '@agent-gateway/shared'
import { PUSH_CHANNEL, type PushEvent } from '../../contract/bridge.js'

interface ActiveGitStream {
  client: GitStreamClient
  controller: AbortController
  projectId: string
  projectKey: string
  task: Promise<void>
}

export interface GitStreamClient {
  gitEvents(
    projectId: string,
    signal: AbortSignal,
    onOpen?: () => void
  ): AsyncIterable<GitEvent>
}

export interface GitStreamContents {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  send(channel: string, event: PushEvent): void
}

const FAST_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const
const SLOW_RETRY_DELAY_MS = 15_000

export class GitStreamRegistry {
  private readonly active = new Map<string, ActiveGitStream>()
  private readonly observedWebContents = new Set<number>()

  watch(
    contents: GitStreamContents,
    client: GitStreamClient,
    projectKey: string,
    projectId: string
  ): void {
    const key = streamKey(contents.id, projectKey)
    this.active.get(key)?.controller.abort()
    const controller = new AbortController()
    this.observeDestruction(contents)
    this.send(contents, { kind: 'git.stream', projectKey, state: 'connecting' })
    const entry: ActiveGitStream = {
      client,
      controller,
      projectId,
      projectKey,
      task: Promise.resolve()
    }
    entry.task = this.consume(contents, entry).finally(() => {
      if (this.active.get(key) === entry) this.active.delete(key)
    })
    this.active.set(key, entry)
  }

  unwatch(contents: GitStreamContents, projectKey: string): void {
    this.active.get(streamKey(contents.id, projectKey))?.controller.abort()
  }

  retry(contents: GitStreamContents, projectKey: string): void {
    const entry = this.active.get(streamKey(contents.id, projectKey))
    if (!entry) throw new Error('Git 事件流尚未启动')
    this.watch(contents, entry.client, entry.projectKey, entry.projectId)
  }

  private async consume(contents: GitStreamContents, entry: ActiveGitStream): Promise<void> {
    let consecutiveFailures = 0
    while (!entry.controller.signal.aborted) {
      try {
        for await (const event of entry.client.gitEvents(
          entry.projectId,
          entry.controller.signal,
          () => {
            consecutiveFailures = 0
            this.send(contents, {
              kind: 'git.stream',
              projectKey: entry.projectKey,
              state: 'connected'
            })
            this.send(contents, { kind: 'git.invalidated', projectKey: entry.projectKey })
          }
        )) {
          if (event.type !== 'workspace.git.changed') continue
          consecutiveFailures = 0
          this.send(contents, { kind: 'git.invalidated', projectKey: entry.projectKey })
        }
        if (entry.controller.signal.aborted) return
        throw new Error('Git event stream closed unexpectedly')
      } catch (error) {
        if (entry.controller.signal.aborted || isAbortError(error)) return
        if (!isRetryable(error)) {
          this.send(contents, {
            kind: 'git.stream',
            projectKey: entry.projectKey,
            state: 'error',
            message: errorMessage(error)
          })
          return
        }
        consecutiveFailures += 1
        const delay = retryDelay(consecutiveFailures)
        this.send(contents, {
          kind: 'git.stream',
          projectKey: entry.projectKey,
          state: 'retrying',
          message: `${errorMessage(error)}；正在后台重新连接 Git 事件流`,
          attempt: consecutiveFailures,
          retryAt: Date.now() + delay
        })
        if (!(await waitForRetry(delay, entry.controller.signal))) return
      }
    }
  }

  private observeDestruction(contents: GitStreamContents): void {
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

  private send(contents: GitStreamContents, event: PushEvent): void {
    if (!contents.isDestroyed()) contents.send(PUSH_CHANNEL, event)
  }
}

function streamKey(webContentsId: number, projectKey: string): string {
  return `${webContentsId}:${projectKey}`
}

function retryDelay(attempt: number): number {
  return FAST_RETRY_DELAYS_MS[attempt - 1] ?? SLOW_RETRY_DELAY_MS
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve(true)
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRetryable(error: unknown): boolean {
  return !(
    hasCode(error, 'PROJECT_NOT_FOUND') ||
    hasCode(error, 'PROJECT_UNAVAILABLE') ||
    hasCode(error, 'GIT_NOT_REPOSITORY') ||
    hasCode(error, 'GIT_UNAVAILABLE') ||
    hasCode(error, 'CAPABILITY_UNSUPPORTED')
  )
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Git event stream failed'
}
